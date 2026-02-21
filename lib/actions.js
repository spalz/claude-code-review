// Review actions — resolve hunks, finalize files, navigate
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const state = require("./state");
const {
    enterReviewMode,
    createReview,
    buildFinalContent,
    rebuildMerged,
} = require("./review");
const log = require("./log");
const { applyDecorations, clearDecorations } = require("./decorations");

async function resolveHunk(filePath, hunkId, accept) {
    const review = state.activeReviews.get(filePath);
    if (!review) return;
    const hunk = review.hunks.find((h) => h.id === hunkId);
    if (!hunk || hunk.resolved) return;

    hunk.resolved = true;
    hunk.accepted = accept;

    if (review.isFullyResolved) {
        await finalizeFile(filePath);
    } else {
        rebuildMerged(review);
        // Clamp hunk index after ranges shrink
        const newCount = review.hunkRanges.length;
        if (state.getCurrentHunkIndex() >= newCount) {
            state.setCurrentHunkIndex(Math.max(0, newCount - 1));
        }
        await writeAndRefresh(filePath, review);
    }
}

async function resolveAllHunks(filePath, accept) {
    const review = state.activeReviews.get(filePath);
    if (!review) return;
    for (const h of review.hunks) {
        if (!h.resolved) {
            h.resolved = true;
            h.accepted = accept;
        }
    }
    await finalizeFile(filePath);
}

async function writeAndRefresh(filePath, review) {
    fs.writeFileSync(filePath, review.mergedLines.join("\n"), "utf8");

    const editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.fsPath === filePath,
    );
    if (editor) {
        await vscode.commands.executeCommand("workbench.action.files.revert");
        await new Promise((r) => setTimeout(r, 100));
        const fresh = vscode.window.visibleTextEditors.find(
            (e) => e.document.uri.fsPath === filePath,
        );
        if (fresh) applyDecorations(fresh, review);
    }
    state.refreshReview();
}

async function finalizeFile(filePath) {
    const review = state.activeReviews.get(filePath);
    if (!review) return;

    const finalContent = buildFinalContent(review);
    fs.writeFileSync(filePath, finalContent, "utf8");
    state.activeReviews.delete(filePath);

    const editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.fsPath === filePath,
    );
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

async function openFileForReview(filePath) {
    const review = state.activeReviews.get(filePath);
    if (!review) return;

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

async function navigateHunk(direction) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const filePath = editor.document.uri.fsPath;
    const review = state.activeReviews.get(filePath);
    if (!review) return;

    const ranges = review.hunkRanges;
    if (ranges.length === 0) return;

    let idx = state.getCurrentHunkIndex();
    idx = (idx + direction + ranges.length) % ranges.length;
    state.setCurrentHunkIndex(idx);

    const range = ranges[idx];
    const line = range.removedStart < range.removedEnd
        ? range.removedStart
        : range.addedStart;

    editor.revealRange(
        new vscode.Range(line, 0, line, 0),
        vscode.TextEditorRevealType.InCenter,
    );
    editor.selection = new vscode.Selection(line, 0, line, 0);

    state.refreshReview();
}

async function keepCurrentFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    await resolveAllHunks(editor.document.uri.fsPath, true);
}

async function undoCurrentFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    await resolveAllHunks(editor.document.uri.fsPath, false);
}

async function reviewNextUnresolved() {
    const files = state.getReviewFiles();
    const next = files.find((f) => state.activeReviews.has(f));
    if (next) {
        state.setCurrentFileIndex(files.indexOf(next));
        await openFileForReview(next);
    }
}

async function navigateFile(direction) {
    const files = state
        .getReviewFiles()
        .filter((f) => state.activeReviews.has(f));
    if (files.length === 0) return;
    const current = state.getReviewFiles()[state.getCurrentFileIndex()];
    const curIdx = files.indexOf(current);
    const newIdx = (curIdx + direction + files.length) % files.length;
    await openFileForReview(files[newIdx]);
}

function addFileToReview(workspacePath, absFilePath) {
    log.log(`addFileToReview: ${absFilePath}`);

    // Already in review? Rebuild diff with updated content
    if (state.activeReviews.has(absFilePath)) {
        log.log(`addFileToReview: updating existing review for ${absFilePath}`);
        const existing = state.activeReviews.get(absFilePath);
        let modifiedContent;
        try {
            modifiedContent = fs.readFileSync(absFilePath, "utf8");
        } catch {
            return;
        }
        if (existing.originalContent === modifiedContent) {
            // Changes reverted — remove from review
            state.activeReviews.delete(absFilePath);
            const files = state.getReviewFiles().filter((f) => f !== absFilePath);
            state.setReviewFiles(files);
            state.refreshAll();
            return;
        }
        // Recreate review with same baseline but new content
        state.activeReviews.delete(absFilePath);
        createReview(absFilePath, existing.originalContent, modifiedContent, workspacePath);
        state.refreshAll();
        return;
    }

    // Get baseline from git
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
        original = ""; // New/untracked/external file
    }

    // Read current content
    let modified;
    try {
        modified = fs.readFileSync(absFilePath, "utf8");
    } catch {
        log.log(`addFileToReview: cannot read ${absFilePath}`);
        return;
    }

    if (original === modified) {
        log.log(`addFileToReview: no changes in ${absFilePath}`);
        return;
    }

    // Create review
    const review = createReview(absFilePath, original, modified, workspacePath);
    if (!review) {
        log.log(`addFileToReview: no reviewable hunks in ${absFilePath}`);
        return;
    }

    // Add to review files list
    const files = state.getReviewFiles();
    if (!files.includes(absFilePath)) {
        files.push(absFilePath);
        state.setReviewFiles(files);
    }

    log.log(`addFileToReview: added ${absFilePath}, ${review.hunks.length} hunks`);
    state.refreshAll();
}

async function startReviewSession(workspacePath) {
    state.activeReviews.clear();
    state.setReviewFiles([]);
    state.setCurrentFileIndex(0);

    const changedFiles = new Set();
    try {
        const staged = execSync("git diff --name-only --cached", {
            cwd: workspacePath,
            encoding: "utf8",
            timeout: 10000,
            stdio: "pipe",
        }).trim();
        if (staged)
            staged
                .split("\n")
                .forEach((f) => changedFiles.add(path.join(workspacePath, f)));
    } catch {}
    try {
        const unstaged = execSync("git diff --name-only HEAD", {
            cwd: workspacePath,
            encoding: "utf8",
            timeout: 10000,
            stdio: "pipe",
        }).trim();
        if (unstaged)
            unstaged
                .split("\n")
                .forEach((f) => changedFiles.add(path.join(workspacePath, f)));
    } catch {}
    try {
        const untracked = execSync("git ls-files --others --exclude-standard", {
            cwd: workspacePath,
            encoding: "utf8",
            timeout: 10000,
            stdio: "pipe",
        }).trim();
        if (untracked)
            untracked
                .split("\n")
                .forEach((f) => changedFiles.add(path.join(workspacePath, f)));
    } catch {}

    if (changedFiles.size === 0) {
        vscode.window.showInformationMessage("No changes to review.");
        return;
    }

    for (const fp of changedFiles) {
        try {
            await enterReviewMode(fp, workspacePath);
        } catch (e) {
            console.error(`[ccr] skip ${fp}:`, e.message);
        }
    }

    const reviewable = [...changedFiles].filter((f) =>
        state.activeReviews.has(f),
    );
    if (reviewable.length === 0) {
        vscode.window.showInformationMessage("No reviewable changes found.");
        return;
    }

    state.setReviewFiles(reviewable);
    state.refreshAll();
    await openFileForReview(reviewable[0]);
}

module.exports = {
    resolveHunk,
    resolveAllHunks,
    openFileForReview,
    navigateFile,
    navigateHunk,
    keepCurrentFile,
    undoCurrentFile,
    reviewNextUnresolved,
    addFileToReview,
    startReviewSession,
};
