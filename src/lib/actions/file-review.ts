import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as state from "../state";
import { createReview, enterReviewMode } from "../review";
import { log } from "../log";
import { openFileForReview } from "./review-actions";

export function addFileToReview(workspacePath: string, absFilePath: string): void {
	log(`addFileToReview: ${absFilePath}`);

	if (state.activeReviews.has(absFilePath)) {
		log(`addFileToReview: updating existing review for ${absFilePath}`);
		const existing = state.activeReviews.get(absFilePath)!;
		let modifiedContent: string;
		try {
			modifiedContent = fs.readFileSync(absFilePath, "utf8");
		} catch {
			return;
		}
		if (existing.originalContent === modifiedContent) {
			state.activeReviews.delete(absFilePath);
			const files = state.getReviewFiles().filter((f) => f !== absFilePath);
			state.setReviewFiles(files);
			state.refreshAll();
			return;
		}
		state.activeReviews.delete(absFilePath);
		createReview(absFilePath, existing.originalContent, modifiedContent, workspacePath);
		state.refreshAll();
		return;
	}

	let original = "";
	try {
		const relPath = path.relative(workspacePath, absFilePath);
		if (!relPath.startsWith("..")) {
			original = execSync(`git show HEAD:"${relPath}"`, {
				cwd: workspacePath,
				encoding: "utf8",
				timeout: 5000,
				stdio: "pipe",
			});
		}
	} catch {
		original = "";
	}

	let modified: string;
	try {
		modified = fs.readFileSync(absFilePath, "utf8");
	} catch {
		log(`addFileToReview: cannot read ${absFilePath}`);
		return;
	}

	if (original === modified) {
		log(`addFileToReview: no changes in ${absFilePath}`);
		return;
	}

	const review = createReview(absFilePath, original, modified, workspacePath);
	if (!review) {
		log(`addFileToReview: no reviewable hunks in ${absFilePath}`);
		return;
	}

	const files = state.getReviewFiles();
	if (!files.includes(absFilePath)) {
		files.push(absFilePath);
		state.setReviewFiles(files);
	}
	log(`addFileToReview: added ${absFilePath}, ${review.hunks.length} hunks`);
	state.refreshAll();
}

export async function startReviewSession(workspacePath: string): Promise<void> {
	state.activeReviews.clear();
	state.setReviewFiles([]);
	state.setCurrentFileIndex(0);

	const changedFiles = new Set<string>();

	try {
		const staged = execSync("git diff --name-only --cached", {
			cwd: workspacePath,
			encoding: "utf8",
			timeout: 10000,
			stdio: "pipe",
		}).trim();
		if (staged) {
			staged.split("\n").forEach((f) => changedFiles.add(path.join(workspacePath, f)));
		}
	} catch {}

	try {
		const unstaged = execSync("git diff --name-only HEAD", {
			cwd: workspacePath,
			encoding: "utf8",
			timeout: 10000,
			stdio: "pipe",
		}).trim();
		if (unstaged) {
			unstaged.split("\n").forEach((f) => changedFiles.add(path.join(workspacePath, f)));
		}
	} catch {}

	try {
		const untracked = execSync("git ls-files --others --exclude-standard", {
			cwd: workspacePath,
			encoding: "utf8",
			timeout: 10000,
			stdio: "pipe",
		}).trim();
		if (untracked) {
			untracked.split("\n").forEach((f) => changedFiles.add(path.join(workspacePath, f)));
		}
	} catch {}

	if (changedFiles.size === 0) {
		vscode.window.showInformationMessage("No changes to review.");
		return;
	}

	for (const fp of changedFiles) {
		try {
			await enterReviewMode(fp, workspacePath);
		} catch (e) {
			console.error(`[ccr] skip ${fp}:`, (e as Error).message);
		}
	}

	const reviewable = [...changedFiles].filter((f) => state.activeReviews.has(f));
	if (reviewable.length === 0) {
		vscode.window.showInformationMessage("No reviewable changes found.");
		return;
	}

	state.setReviewFiles(reviewable);
	state.refreshAll();
	await openFileForReview(reviewable[0]);
}
