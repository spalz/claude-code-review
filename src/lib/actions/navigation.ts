import * as vscode from "vscode";
import * as state from "../state";
import { openFileForReview, resolveAllHunks } from "./review-actions";

export async function navigateHunk(direction: number): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}
	const filePath = editor.document.uri.fsPath;
	const review = state.activeReviews.get(filePath);
	if (!review) {
		return;
	}
	const ranges = review.hunkRanges;
	if (ranges.length === 0) {
		return;
	}
	let idx = state.getCurrentHunkIndex();
	idx = (idx + direction + ranges.length) % ranges.length;
	state.setCurrentHunkIndex(idx);

	const range = ranges[idx];
	const line = range.removedStart < range.removedEnd ? range.removedStart : range.addedStart;
	editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
	editor.selection = new vscode.Selection(line, 0, line, 0);
	state.refreshReview();
}

export async function keepCurrentFile(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}
	await resolveAllHunks(editor.document.uri.fsPath, true);
}

export async function undoCurrentFile(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}
	await resolveAllHunks(editor.document.uri.fsPath, false);
}

export async function reviewNextUnresolved(): Promise<void> {
	const files = state.getReviewFiles();
	const next = files.find((f) => state.activeReviews.has(f));
	if (next) {
		state.setCurrentFileIndex(files.indexOf(next));
		await openFileForReview(next);
	}
}

export async function navigateFile(direction: number): Promise<void> {
	const files = state.getReviewFiles().filter((f) => state.activeReviews.has(f));
	if (files.length === 0) {
		return;
	}
	const current = state.getReviewFiles()[state.getCurrentFileIndex()];
	const curIdx = files.indexOf(current);
	const newIdx = (curIdx + direction + files.length) % files.length;
	await openFileForReview(files[newIdx]);
}
