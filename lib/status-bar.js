// Review StatusBar — context-sensitive navigation with two modes
const vscode = require("vscode");
const path = require("path");
const state = require("./state");
const log = require("./log");

// Mode 1: not in a review file
let reviewNextItem;

// Mode 2: in a review file
let hunkPrevItem;
let hunkCounterItem;
let hunkNextItem;
let sep1Item;
let keepFileItem;
let undoFileItem;
let sep2Item;
let filePrevItem;
let fileCounterItem;
let fileNextItem;

let _workspacePath;
let _editorDisposable;

function createReviewStatusBar(context, workspacePath) {
    _workspacePath = workspacePath;

    // Mode 1
    reviewNextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5);
    reviewNextItem.command = "ccr.reviewNextUnresolved";

    // Mode 2: hunk navigation
    hunkPrevItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    hunkPrevItem.text = "$(chevron-left)";
    hunkPrevItem.tooltip = "Previous change in this file";
    hunkPrevItem.command = "ccr.prevHunk";

    hunkCounterItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
    hunkCounterItem.tooltip = "Changes in current file";

    hunkNextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8);
    hunkNextItem.text = "$(chevron-right)";
    hunkNextItem.tooltip = "Next change in this file";
    hunkNextItem.command = "ccr.nextHunk";

    // Separator
    sep1Item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 7);
    sep1Item.text = "|";

    // Mode 2: file actions
    keepFileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 6);
    keepFileItem.text = "$(check) Keep";
    keepFileItem.tooltip = "Accept all changes in this file";
    keepFileItem.command = "ccr.keepCurrentFile";
    keepFileItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");

    undoFileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5);
    undoFileItem.text = "$(discard) Undo";
    undoFileItem.tooltip = "Reject all changes in this file";
    undoFileItem.command = "ccr.undoCurrentFile";

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
        reviewNextItem, hunkPrevItem, hunkCounterItem, hunkNextItem,
        sep1Item, keepFileItem, undoFileItem, sep2Item,
        filePrevItem, fileCounterItem, fileNextItem,
    ];
    for (const item of allItems) {
        context.subscriptions.push(item);
    }

    // React to editor changes
    _editorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
        updateReviewStatusBar();
    });
    context.subscriptions.push(_editorDisposable);

    log.log("Review StatusBar created");
}

function hideAll() {
    reviewNextItem.hide();
    hideMode2();
}

function hideMode2() {
    hunkPrevItem.hide();
    hunkCounterItem.hide();
    hunkNextItem.hide();
    sep1Item.hide();
    keepFileItem.hide();
    undoFileItem.hide();
    sep2Item.hide();
    filePrevItem.hide();
    fileCounterItem.hide();
    fileNextItem.hide();
}

function showMode1(remaining) {
    hideMode2();
    reviewNextItem.text = `$(play) Review next file (${remaining.length} remaining)`;
    reviewNextItem.tooltip = "Open the next file with unresolved changes";
    reviewNextItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    reviewNextItem.show();
}

function showMode2(filePath, review, remaining) {
    reviewNextItem.hide();

    // Hunk navigation
    const hunkCount = review.hunkRanges.length;
    let hunkIdx = state.getCurrentHunkIndex();
    if (hunkIdx >= hunkCount) hunkIdx = Math.max(0, hunkCount - 1);
    state.setCurrentHunkIndex(hunkIdx);

    hunkCounterItem.text = hunkCount > 0
        ? `${hunkIdx + 1}/${hunkCount} changes`
        : "0 changes";

    // File info
    const relName = path.relative(_workspacePath, filePath);
    const fileIdx = remaining.indexOf(filePath);
    fileCounterItem.text = `$(file) ${relName} (${fileIdx + 1}/${remaining.length})`;

    // Show all Mode 2 items
    hunkPrevItem.show();
    hunkCounterItem.show();
    hunkNextItem.show();
    sep1Item.show();
    keepFileItem.show();
    undoFileItem.show();
    sep2Item.show();
    filePrevItem.show();
    fileCounterItem.show();
    fileNextItem.show();
}

function updateReviewStatusBar() {
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
        showMode2(activeFilePath, review, remaining);
    } else {
        showMode1(remaining);
    }
}

function dispose() {
    _editorDisposable?.dispose();
}

module.exports = { createReviewStatusBar, updateReviewStatusBar, dispose };
