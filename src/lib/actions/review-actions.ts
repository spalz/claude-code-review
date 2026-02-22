import * as vscode from "vscode";
import * as fs from "fs";
import * as state from "../state";
import { buildFinalContent, rebuildMerged } from "../review";
import { applyDecorations, clearDecorations } from "../decorations";
import type { IFileReview } from "../../types";

async function writeAndRefresh(filePath: string, review: IFileReview): Promise<void> {
	fs.writeFileSync(filePath, review.mergedLines.join("\n"), "utf8");
	const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === filePath);
	if (editor) {
		await vscode.commands.executeCommand("workbench.action.files.revert");
		await new Promise<void>((r) => setTimeout(r, 100));
		const fresh = vscode.window.visibleTextEditors.find(
			(e) => e.document.uri.fsPath === filePath,
		);
		if (fresh) {
			applyDecorations(fresh, review);
		}
	}
	state.refreshReview();
}

async function finalizeFile(filePath: string): Promise<void> {
	const review = state.activeReviews.get(filePath);
	if (!review) {
		return;
	}
	const finalContent = buildFinalContent(review);
	fs.writeFileSync(filePath, finalContent, "utf8");
	state.activeReviews.delete(filePath);

	const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === filePath);
	if (editor) {
		clearDecorations(editor);
		await vscode.commands.executeCommand("workbench.action.files.revert");
	}
	state.refreshReview();

	const files = state.getReviewFiles();
	const next = files.find((f) => state.activeReviews.has(f));
	if (next) {
		state.setCurrentFileIndex(files.indexOf(next));
		await openFileForReview(next);
	} else {
		vscode.window.showInformationMessage("Claude Code Review: all files reviewed.");
		state.setReviewFiles([]);
		state.setCurrentFileIndex(0);
		state.refreshReview();
	}
}

export async function resolveHunk(
	filePath: string,
	hunkId: number,
	accept: boolean,
): Promise<void> {
	const review = state.activeReviews.get(filePath);
	if (!review) {
		return;
	}
	const hunk = review.hunks.find((h) => h.id === hunkId);
	if (!hunk || hunk.resolved) {
		return;
	}
	hunk.resolved = true;
	hunk.accepted = accept;

	if (review.isFullyResolved) {
		await finalizeFile(filePath);
	} else {
		rebuildMerged(review);
		const newCount = review.hunkRanges.length;
		if (state.getCurrentHunkIndex() >= newCount) {
			state.setCurrentHunkIndex(Math.max(0, newCount - 1));
		}
		await writeAndRefresh(filePath, review);
	}
}

export async function resolveAllHunks(filePath: string, accept: boolean): Promise<void> {
	const review = state.activeReviews.get(filePath);
	if (!review) {
		return;
	}
	for (const h of review.hunks) {
		if (!h.resolved) {
			h.resolved = true;
			h.accepted = accept;
		}
	}
	await finalizeFile(filePath);
}

export async function openFileForReview(filePath: string): Promise<void> {
	const review = state.activeReviews.get(filePath);
	if (!review) {
		return;
	}
	fs.writeFileSync(filePath, review.mergedLines.join("\n"), "utf8");
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
	state.setCurrentFileIndex(state.getReviewFiles().indexOf(filePath));
	state.setCurrentHunkIndex(0);
	state.refreshReview();
}
