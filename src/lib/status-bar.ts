// Review StatusBar — context-sensitive navigation with two modes
import * as vscode from "vscode";
import * as path from "path";
import * as state from "./state";
import * as log from "./log";
import type { IFileReview } from "../types";

// Mode 1: not in a review file
let reviewNextItem: vscode.StatusBarItem = undefined!;

// Mode 2: in a review file
let hunkPrevItem: vscode.StatusBarItem = undefined!;
let hunkCounterItem: vscode.StatusBarItem = undefined!;
let hunkNextItem: vscode.StatusBarItem = undefined!;
let sep1Item: vscode.StatusBarItem = undefined!;
let keepFileItem: vscode.StatusBarItem = undefined!;
let undoFileItem: vscode.StatusBarItem = undefined!;
let sep2Item: vscode.StatusBarItem = undefined!;
let filePrevItem: vscode.StatusBarItem = undefined!;
let fileCounterItem: vscode.StatusBarItem = undefined!;
let fileNextItem: vscode.StatusBarItem = undefined!;

let _workspacePath: string = undefined!;
let _editorDisposable: vscode.Disposable | undefined;

export function createReviewStatusBar(
	context: vscode.ExtensionContext,
	workspacePath: string,
): void {
	_workspacePath = workspacePath;

	// Mode 1
	reviewNextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5);
	reviewNextItem.command = "ccr.reviewNextUnresolved";

	// Mode 2: hunk navigation
	hunkPrevItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
	hunkPrevItem.text = "$(chevron-left)";
	hunkPrevItem.tooltip = "Previous change (⌘[)";
	hunkPrevItem.command = "ccr.prevHunk";

	hunkCounterItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
	hunkCounterItem.tooltip = "Changes in current file";

	hunkNextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8);
	hunkNextItem.text = "$(chevron-right)";
	hunkNextItem.tooltip = "Next change (⌘])";
	hunkNextItem.command = "ccr.nextHunk";

	// Separator
	sep1Item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 7);
	sep1Item.text = "|";

	// Mode 2: file actions
	undoFileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 6);
	undoFileItem.text = "$(discard) Undo ⌘N";
	undoFileItem.tooltip = "Reject all changes in this file";
	undoFileItem.command = "ccr.undoCurrentFile";

	keepFileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5);
	keepFileItem.text = "$(check) Keep ⌘Y";
	keepFileItem.tooltip = "Accept all changes in this file";
	keepFileItem.command = "ccr.keepCurrentFile";
	keepFileItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");

	// Separator
	sep2Item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 4);
	sep2Item.text = "|";

	// Mode 2: file navigation
	filePrevItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 3);
	filePrevItem.text = "$(arrow-left)";
	filePrevItem.tooltip = "Previous file with changes";
	filePrevItem.command = "ccr.prevFile";

	fileCounterItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 2);
	fileCounterItem.tooltip = "Files with unresolved changes";

	fileNextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
	fileNextItem.text = "$(arrow-right)";
	fileNextItem.tooltip = "Next file with changes";
	fileNextItem.command = "ccr.nextFile";

	// Register disposables
	const allItems = [
		reviewNextItem,
		hunkPrevItem,
		hunkCounterItem,
		hunkNextItem,
		sep1Item,
		undoFileItem,
		keepFileItem,
		sep2Item,
		filePrevItem,
		fileCounterItem,
		fileNextItem,
	];
	for (const item of allItems) {
		context.subscriptions.push(item);
	}

	_editorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
		updateReviewStatusBar();
	});
	context.subscriptions.push(_editorDisposable);

	log.log("Review StatusBar created");
}

export function hideAll(): void {
	reviewNextItem.hide();
	hideMode2();
}

export function hideMode2(): void {
	hunkPrevItem.hide();
	hunkCounterItem.hide();
	hunkNextItem.hide();
	sep1Item.hide();
	undoFileItem.hide();
	keepFileItem.hide();
	sep2Item.hide();
	filePrevItem.hide();
	fileCounterItem.hide();
	fileNextItem.hide();
}

export function showMode1(remaining: string[]): void {
	hideMode2();
	reviewNextItem.text = `$(play) Review next file (${remaining.length} remaining)`;
	reviewNextItem.tooltip = "Open the next file with unresolved changes";
	reviewNextItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
	reviewNextItem.show();
}

export function showMode2(filePath: string, review: IFileReview, remaining: string[]): void {
	reviewNextItem.hide();

	const hunkCount = review.hunkRanges.length;
	let hunkIdx = state.getCurrentHunkIndex();
	if (hunkIdx >= hunkCount) hunkIdx = Math.max(0, hunkCount - 1);
	state.setCurrentHunkIndex(hunkIdx);

	hunkCounterItem.text = hunkCount > 0 ? `${hunkIdx + 1}/${hunkCount} changes` : "0 changes";

	const isExternal = filePath.startsWith("..") || !filePath.startsWith(_workspacePath);
	const relName = isExternal
		? `$(link-external) ${filePath}`
		: path.relative(_workspacePath, filePath);
	const fileIdx = remaining.indexOf(filePath);
	fileCounterItem.text = `$(file) ${relName} (${fileIdx + 1}/${remaining.length})`;

	hunkPrevItem.show();
	hunkCounterItem.show();
	hunkNextItem.show();
	sep1Item.show();
	undoFileItem.show();
	keepFileItem.show();
	sep2Item.show();
	filePrevItem.show();
	fileCounterItem.show();
	fileNextItem.show();
}

export function updateReviewStatusBar(): void {
	const files = state.getReviewFiles();
	const remaining = files.filter((f) => state.activeReviews.has(f));

	if (remaining.length === 0) {
		hideAll();
		return;
	}

	const activeEditor = vscode.window.activeTextEditor;
	const activeFilePath = activeEditor?.document?.uri?.fsPath;
	const review = activeFilePath ? state.activeReviews.get(activeFilePath) : null;

	if (review) {
		showMode2(activeFilePath!, review, remaining);
	} else {
		showMode1(remaining);
	}
}

export function dispose(): void {
	_editorDisposable?.dispose();
}
