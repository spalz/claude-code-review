// ReviewManager — central orchestrator for review lifecycle
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as log from "./log";
import * as state from "./state";
import { getSnapshot, clearSnapshot } from "./server";
import { saveReviewState, loadReviewState, clearReviewState } from "./persistence";
import { FileReview, buildMergedContent, buildFinalContent, rebuildMerged } from "./review";
import { computeDiff } from "./diff";
import { applyDecorations, clearDecorations } from "./decorations";
import { initHistory, recordSnapshot, setApplyingEdit, clearHistory, clearAllHistories } from "./undo-history";
import type { ChangeType, ReviewSnapshot } from "../types";

interface ICodeLensProvider {
	refresh(): void;
}
interface IMainView {
	update(): void;
}

export class ReviewManager implements vscode.Disposable {
	private reviewFiles: string[] = [];
	private currentFileIndex = 0;
	private currentHunkIndex = 0;
	private persistTimer: NodeJS.Timeout | null = null;
	private codeLens: ICodeLensProvider | null = null;
	private mainView: IMainView | null = null;
	private readonly _onReviewStateChange = new vscode.EventEmitter<boolean>();
	readonly onReviewStateChange = this._onReviewStateChange.event;

	constructor(private readonly wp: string) {}

	// --- Providers ---

	setProviders(codeLens: ICodeLensProvider, mainView: IMainView): void {
		this.codeLens = codeLens;
		this.mainView = mainView;
	}

	// --- File addition (called from hook) ---

	addFile(absFilePath: string): void {
		log.log(`ReviewManager.addFile: ${absFilePath}`);

		// Read modified content from disk
		let modifiedContent: string;
		try {
			modifiedContent = fs.readFileSync(absFilePath, "utf8");
		} catch {
			// File doesn't exist — possibly deleted via Bash rm
			this.handleMissingFile(absFilePath);
			return;
		}

		// Get "before" content via fallback chain.
		// Preserve existing review's original before deleting it.
		const existingOriginal = state.activeReviews.get(absFilePath)?.originalContent;
		const originalContent = this.getOriginalContent(absFilePath, existingOriginal);

		if (originalContent === modifiedContent) {
			// No actual change — remove from review if present
			if (state.activeReviews.has(absFilePath)) {
				state.activeReviews.delete(absFilePath);
				this.reviewFiles = this.reviewFiles.filter((f) => f !== absFilePath);
				this.syncState();
				this.refreshUI();
			}
			return;
		}

		// Determine change type
		const changeType: ChangeType = !originalContent
			? "create"
			: !modifiedContent
				? "delete"
				: "edit";

		// Remove old review — we rebuild it with fresh content
		if (state.activeReviews.has(absFilePath)) {
			state.activeReviews.delete(absFilePath);
		}

		const hunks = computeDiff(originalContent, modifiedContent, absFilePath, this.wp);
		if (hunks.length === 0) {
			log.log(`ReviewManager.addFile: no reviewable hunks in ${absFilePath}`);
			return;
		}

		const modLines = modifiedContent.split("\n");
		const { lines, ranges } = buildMergedContent(modLines, hunks);

		const review = new FileReview(
			absFilePath,
			originalContent,
			modifiedContent,
			hunks,
			changeType,
		);
		review.mergedLines = lines;
		review.hunkRanges = ranges;
		state.activeReviews.set(absFilePath, review);

		if (!this.reviewFiles.includes(absFilePath)) {
			this.reviewFiles.push(absFilePath);
		}

		// Consume the snapshot after use
		clearSnapshot(absFilePath);

		log.log(
			`ReviewManager.addFile: added ${absFilePath}, ${hunks.length} hunks, type=${changeType}`,
		);
		this.syncState();
		this.refreshUI();
		this.scheduleSave();
		this._onReviewStateChange.fire(true);

		// Apply to already-open editor
		this.applyToOpenEditor(absFilePath, review);
	}

	private applyToOpenEditor(filePath: string, review: import("../types").IFileReview): void {
		initHistory(filePath);
		recordSnapshot(filePath, review);
		this.applyContentViaEdit(filePath, review.mergedLines.join("\n"));
	}

	private async applyContentViaEdit(filePath: string, newContent: string): Promise<void> {
		const editor = vscode.window.visibleTextEditors.find(
			(e) => e.document.uri.fsPath === filePath,
		);
		if (!editor) {
			fs.writeFileSync(filePath, newContent, "utf8");
			return;
		}

		setApplyingEdit(filePath, true);
		try {
			const doc = editor.document;
			const lastLine = doc.lineCount - 1;
			const fullRange = new vscode.Range(
				0, 0,
				lastLine, doc.lineAt(lastLine).text.length,
			);
			await editor.edit(
				(eb) => eb.replace(fullRange, newContent),
				{ undoStopBefore: true, undoStopAfter: true },
			);
		} finally {
			setApplyingEdit(filePath, false);
		}

		const review = state.activeReviews.get(filePath);
		if (review) applyDecorations(editor, review);
		this.syncState();
		this.refreshUI();
	}

	// --- Resolve hunks ---

	async resolveHunk(filePath: string, hunkId: number, accept: boolean): Promise<void> {
		const review = state.activeReviews.get(filePath);
		if (!review) return;
		const hunk = review.hunks.find((h) => h.id === hunkId);
		if (!hunk || hunk.resolved) return;

		recordSnapshot(filePath, review);

		hunk.resolved = true;
		hunk.accepted = accept;

		if (review.isFullyResolved) {
			await this.finalizeFile(filePath);
		} else {
			rebuildMerged(review as FileReview);
			const newCount = review.hunkRanges.length;
			if (this.currentHunkIndex >= newCount) {
				this.currentHunkIndex = Math.max(0, newCount - 1);
			}
			recordSnapshot(filePath, review);
			await this.applyContentViaEdit(filePath, review.mergedLines.join("\n"));
		}
		this.scheduleSave();
	}

	async resolveAllHunks(filePath: string, accept: boolean): Promise<void> {
		const review = state.activeReviews.get(filePath);
		if (!review) return;
		for (const h of review.hunks) {
			if (!h.resolved) {
				h.resolved = true;
				h.accepted = accept;
			}
		}
		await this.finalizeFile(filePath);
		this.scheduleSave();
	}

	// --- Navigation ---

	navigateHunk(delta: number): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;
		const review = state.activeReviews.get(editor.document.uri.fsPath);
		if (!review) return;
		const ranges = review.hunkRanges;
		if (ranges.length === 0) return;

		this.currentHunkIndex = (this.currentHunkIndex + delta + ranges.length) % ranges.length;
		const range = ranges[this.currentHunkIndex];
		const line = range.removedStart < range.removedEnd ? range.removedStart : range.addedStart;
		editor.revealRange(
			new vscode.Range(line, 0, line, 0),
			vscode.TextEditorRevealType.InCenter,
		);
		editor.selection = new vscode.Selection(line, 0, line, 0);
		this.syncState();
		this.refreshUI();
	}

	async navigateFile(delta: number): Promise<void> {
		const files = this.reviewFiles.filter((f) => state.activeReviews.has(f));
		if (files.length === 0) return;
		const current = this.reviewFiles[this.currentFileIndex];
		const curIdx = files.indexOf(current);
		const newIdx = (curIdx + delta + files.length) % files.length;
		await this.openFileForReview(files[newIdx]);
	}

	async reviewNextUnresolved(): Promise<void> {
		const next = this.reviewFiles.find((f) => state.activeReviews.has(f));
		if (next) {
			await this.openFileForReview(next);
		}
	}

	async openFileForReview(filePath: string): Promise<void> {
		const review = state.activeReviews.get(filePath);
		if (!review) return;

		initHistory(filePath);
		recordSnapshot(filePath, review);

		const mergedContent = review.mergedLines.join("\n");
		fs.writeFileSync(filePath, mergedContent, "utf8");
		const doc = await vscode.workspace.openTextDocument(filePath);
		const editor = await vscode.window.showTextDocument(doc, {
			preview: false,
			viewColumn: vscode.ViewColumn.One,
		});
		applyDecorations(editor, review);

		const firstRange = review.hunkRanges[0];
		if (firstRange) {
			const line =
				firstRange.removedStart < firstRange.removedEnd
					? firstRange.removedStart
					: firstRange.addedStart;
			editor.revealRange(
				new vscode.Range(line, 0, line, 0),
				vscode.TextEditorRevealType.InCenterIfOutsideViewport,
			);
		}

		this.currentFileIndex = this.reviewFiles.indexOf(filePath);
		this.currentHunkIndex = 0;
		this.syncState();
		this.refreshUI();
	}

	// --- Queries ---

	getReview(filePath: string) {
		return state.activeReviews.get(filePath);
	}

	getUnresolvedFiles(): string[] {
		return this.reviewFiles.filter((f) => state.activeReviews.has(f));
	}

	get hasActiveReview(): boolean {
		return state.activeReviews.size > 0;
	}

	getReviewFiles(): string[] {
		return this.reviewFiles;
	}

	getCurrentFileIndex(): number {
		return this.currentFileIndex;
	}

	getCurrentHunkIndex(): number {
		return this.currentHunkIndex;
	}

	// --- Persistence ---

	scheduleSave(): void {
		if (this.persistTimer) clearTimeout(this.persistTimer);
		this.persistTimer = setTimeout(() => {
			saveReviewState(this.wp, state.activeReviews, this.currentFileIndex);
		}, 500);
	}

	saveNow(): void {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		saveReviewState(this.wp, state.activeReviews, this.currentFileIndex);
	}

	async restore(): Promise<boolean> {
		const saved = loadReviewState(this.wp);
		if (!saved || saved.files.length === 0) return false;

		log.log(`ReviewManager.restore: restoring ${saved.files.length} files`);

		for (const pf of saved.files) {
			// Check file still exists for edit/create types
			if (pf.changeType !== "delete" && !fs.existsSync(pf.filePath)) {
				log.log(`ReviewManager.restore: skip missing file ${pf.filePath}`);
				continue;
			}

			const review = new FileReview(
				pf.filePath,
				pf.originalContent,
				pf.modifiedContent,
				pf.hunks,
				pf.changeType,
			);
			// For delete reviews, modifiedContent is "" — use empty array to match handleDeletion behavior
			const modLines = pf.changeType === "delete" ? [] : pf.modifiedContent.split("\n");
			const { lines, ranges } = buildMergedContent(modLines, pf.hunks);
			review.mergedLines = lines;
			review.hunkRanges = ranges;
			state.activeReviews.set(pf.filePath, review);
			this.reviewFiles.push(pf.filePath);
		}

		this.currentFileIndex = Math.min(saved.currentFileIndex, this.reviewFiles.length - 1);
		this.syncState();
		this.refreshUI();
		this._onReviewStateChange.fire(this.hasActiveReview);
		return this.reviewFiles.length > 0;
	}

	// --- Private helpers ---

	private handleMissingFile(absFilePath: string): void {
		// Try to find original content from snapshot or existing review
		const snapshot = getSnapshot(absFilePath);
		const existingOrig = state.activeReviews.get(absFilePath)?.originalContent;
		const origContent = snapshot ?? existingOrig;

		if (origContent) {
			this.handleDeletion(absFilePath, origContent);
			return;
		}

		// Try git show HEAD
		try {
			const relPath = path.relative(this.wp, absFilePath);
			if (!relPath.startsWith("..")) {
				const gitContent = execSync(`git show HEAD:"${relPath}"`, {
					cwd: this.wp,
					encoding: "utf8",
					timeout: 5000,
					stdio: "pipe",
				});
				this.handleDeletion(absFilePath, gitContent);
				return;
			}
		} catch {}

		log.log(`ReviewManager.addFile: cannot read ${absFilePath}`);
	}

	private handleDeletion(absFilePath: string, originalContent: string): void {
		// Remove old review if present
		if (state.activeReviews.has(absFilePath)) {
			state.activeReviews.delete(absFilePath);
		}

		// Create a single hunk with all lines removed
		const origLines = originalContent.split("\n");
		const hunk: import("../types").Hunk = {
			id: 0,
			origStart: 1,
			origCount: origLines.length,
			modStart: 1,
			modCount: 0,
			removed: origLines,
			added: [],
			resolved: false,
			accepted: false,
		};

		const review = new FileReview(absFilePath, originalContent, "", [hunk], "delete");
		// For delete reviews, merged content shows all lines as removed
		const { lines, ranges } = buildMergedContent([], [hunk]);
		review.mergedLines = lines;
		review.hunkRanges = ranges;

		state.activeReviews.set(absFilePath, review);
		if (!this.reviewFiles.includes(absFilePath)) {
			this.reviewFiles.push(absFilePath);
		}

		clearSnapshot(absFilePath);
		log.log(`ReviewManager.handleDeletion: ${absFilePath}, type=delete`);
		this.syncState();
		this.refreshUI();
		this.scheduleSave();
		this._onReviewStateChange.fire(true);
	}

	private getOriginalContent(absFilePath: string, existingOriginal?: string): string {
		// 1. PreToolUse snapshot (most accurate — file content right before Claude's edit)
		const snapshot = getSnapshot(absFilePath);
		if (snapshot !== undefined) {
			log.log(`ReviewManager: using PreToolUse snapshot for ${absFilePath}`);
			return snapshot;
		}

		// 2. Existing review's original (preserved from earlier addFile call)
		// This covers re-edits when PreToolUse hook didn't fire or timed out.
		if (existingOriginal !== undefined) {
			log.log(`ReviewManager: using existing review original for ${absFilePath}`);
			return existingOriginal;
		}

		// 3. git show HEAD:path (only for files inside the workspace)
		try {
			const relPath = path.relative(this.wp, absFilePath);
			if (!relPath.startsWith("..")) {
				const content = execSync(`git show HEAD:"${relPath}"`, {
					cwd: this.wp,
					encoding: "utf8",
					timeout: 5000,
					stdio: "pipe",
				});
				return content;
			}
		} catch {}

		// 4. Empty string (new file or external file without snapshot)
		return "";
	}

	private async finalizeFile(filePath: string): Promise<void> {
		const review = state.activeReviews.get(filePath);
		if (!review) return;

		recordSnapshot(filePath, review);

		const changeType = review.changeType;
		const allRejected = review.hunks.every((h) => !h.accepted);

		state.activeReviews.delete(filePath);

		if (changeType === "create" && allRejected) {
			// Undo file creation = delete the file
			try {
				fs.unlinkSync(filePath);
				log.log(`ReviewManager: deleted created file ${filePath}`);
			} catch {}
		} else if (changeType === "delete" && allRejected) {
			// Undo file deletion = restore original content
			fs.writeFileSync(filePath, review.originalContent, "utf8");
			log.log(`ReviewManager: restored deleted file ${filePath}`);
		} else if (changeType === "delete" && !allRejected) {
			// Accept deletion = ensure file is removed
			try {
				fs.unlinkSync(filePath);
				log.log(`ReviewManager: confirmed deletion of ${filePath}`);
			} catch {}
		} else {
			const finalContent = buildFinalContent(review);
			await this.applyContentViaEdit(filePath, finalContent);
		}

		const editor = vscode.window.visibleTextEditors.find(
			(e) => e.document.uri.fsPath === filePath,
		);
		if (editor) {
			clearDecorations(editor);
		}

		this.refreshUI();

		// Move to next unresolved file
		const next = this.reviewFiles.find((f) => state.activeReviews.has(f));
		if (next) {
			this.currentFileIndex = this.reviewFiles.indexOf(next);
			await this.openFileForReview(next);
		} else {
			vscode.window.showInformationMessage("Claude Code Review: all files reviewed.");
			this.reviewFiles = [];
			this.currentFileIndex = 0;
			clearReviewState(this.wp);
			this.syncState();
			this.refreshUI();
			this._onReviewStateChange.fire(false);
		}
	}

	restoreFromSnapshot(fsPath: string, snapshot: ReviewSnapshot): void {
		let review = state.activeReviews.get(fsPath);
		if (!review) {
			// Undo after finalize — re-enter review
			review = new FileReview(
				snapshot.filePath,
				snapshot.originalContent,
				snapshot.modifiedContent,
				JSON.parse(JSON.stringify(snapshot.hunks)),
				snapshot.changeType,
			);
			state.activeReviews.set(fsPath, review);
			if (!this.reviewFiles.includes(fsPath)) this.reviewFiles.push(fsPath);
			this._onReviewStateChange.fire(true);
		}

		review.hunks = JSON.parse(JSON.stringify(snapshot.hunks));
		(review as FileReview).mergedLines = [...snapshot.mergedLines];
		(review as FileReview).hunkRanges = snapshot.hunkRanges.map((r) => ({ ...r }));

		const editor = vscode.window.visibleTextEditors.find(
			(e) => e.document.uri.fsPath === fsPath,
		);
		if (editor) applyDecorations(editor, review);
		this.syncState();
		this.refreshUI();
		this.scheduleSave();
	}

	private syncState(): void {
		// Keep state.ts in sync for backward compat with mainView/statusBar
		state.setReviewFiles(this.reviewFiles);
		state.setCurrentFileIndex(this.currentFileIndex);
		state.setCurrentHunkIndex(this.currentHunkIndex);
	}

	private refreshUI(): void {
		this.codeLens?.refresh();
		this.mainView?.update();
		state.refreshReview();
	}

	dispose(): void {
		// Restore files to modifiedContent before saving — prevents merged content on disk
		for (const [fp, review] of state.activeReviews) {
			try {
				fs.writeFileSync(fp, review.modifiedContent, "utf8");
			} catch {}
		}
		this.saveNow();
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		clearAllHistories();
		this._onReviewStateChange.dispose();
	}
}
