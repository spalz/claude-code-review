// Claude Code with Review v8.0 — hook-based review + activitybar + Claude CLI sessions
const vscode = require("vscode");
const fs = require("fs");

const state = require("./lib/state");
const { ReviewCodeLensProvider } = require("./lib/codelens");
const { MainViewProvider } = require("./lib/main-view");
const { PtyManager } = require("./lib/pty-manager");
const { applyDecorations } = require("./lib/decorations");
const { startServer, stopServer, setAddFileHandler } = require("./lib/server");
const { listSessions } = require("./lib/sessions");
const { checkAndPrompt, doInstall } = require("./lib/hook-manager");
const { createReviewStatusBar, updateReviewStatusBar } = require("./lib/status-bar");
const actions = require("./lib/actions");
const log = require("./lib/log");

function activate(context) {
    log.init();
    log.log("activating...");

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
        log.log("no workspace folder, skipping activation");
        return;
    }

    try {
        // --- PTY manager ---
        const ptyManager = new PtyManager(workspacePath);
        log.log("PtyManager created");

        // --- Providers ---
        const codeLens = new ReviewCodeLensProvider();
        const mainView = new MainViewProvider(
            workspacePath,
            context.extensionUri,
            ptyManager,
            context.workspaceState,
        );

        state.setCodeLensProvider(codeLens);
        state.setMainView(mainView);

        // Wire pty output to webview
        ptyManager.setHandlers(
            (sessionId, data) => mainView.sendTerminalOutput(sessionId, data),
            (sessionId, code) => {
                mainView.sendTerminalExit(sessionId, code);
                mainView.removeOpenSession(sessionId);
                state.refreshAll();
            },
        );

        // --- Register providers ---
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider("ccr.main", mainView, {
                webviewOptions: { retainContextWhenHidden: true },
            }),
            vscode.languages.registerCodeLensProvider(
                { scheme: "file" },
                codeLens,
            ),
        );

        // --- Review StatusBar navigation (context-sensitive) ---
        createReviewStatusBar(context, workspacePath);

        // Patch state.refreshAll/refreshReview to also update StatusBar
        const origRefreshAll = state.refreshAll.bind(state);
        state.refreshAll = function () {
            origRefreshAll();
            updateReviewStatusBar();
        };
        const origRefreshReview = state.refreshReview.bind(state);
        state.refreshReview = function () {
            origRefreshReview();
            updateReviewStatusBar();
        };

        // --- Main status bar button ---
        const statusBar = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100,
        );
        statusBar.text = "$(layers) Claude Code Review";
        statusBar.tooltip =
            "Toggle Claude Code Review panel (Option+Ctrl+B)";
        statusBar.command = "ccr.togglePanel";
        statusBar.show();
        context.subscriptions.push(statusBar);

        // --- Commands ---
        const cmds = [
            [
                "ccr.togglePanel",
                () => vscode.commands.executeCommand("ccr.main.focus"),
            ],
            ["ccr.openReview", () => actions.startReviewSession(workspacePath)],
            [
                "ccr.openFileDiff",
                (item) =>
                    item?.filePath && actions.openFileForReview(item.filePath),
            ],
            ["ccr.acceptHunk", (fp, id) => actions.resolveHunk(fp, id, true)],
            ["ccr.rejectHunk", (fp, id) => actions.resolveHunk(fp, id, false)],
            [
                "ccr.acceptFile",
                (item) =>
                    item?.filePath &&
                    actions.resolveAllHunks(item.filePath, true),
            ],
            [
                "ccr.rejectFile",
                (item) =>
                    item?.filePath &&
                    actions.resolveAllHunks(item.filePath, false),
            ],
            [
                "ccr.acceptAll",
                async () => {
                    for (const f of [...state.getReviewFiles()])
                        if (state.activeReviews.has(f))
                            await actions.resolveAllHunks(f, true);
                },
            ],
            [
                "ccr.rejectAll",
                async () => {
                    for (const f of [...state.getReviewFiles()])
                        if (state.activeReviews.has(f))
                            await actions.resolveAllHunks(f, false);
                },
            ],
            [
                "ccr.prevFile",
                () => actions.navigateFile(-1),
            ],
            [
                "ccr.nextFile",
                () => actions.navigateFile(1),
            ],
            ["ccr.prevHunk", () => actions.navigateHunk(-1)],
            ["ccr.nextHunk", () => actions.navigateHunk(1)],
            ["ccr.keepCurrentFile", () => actions.keepCurrentFile()],
            ["ccr.undoCurrentFile", () => actions.undoCurrentFile()],
            ["ccr.reviewNextUnresolved", () => actions.reviewNextUnresolved()],
            [
                "ccr.sendFileToSession",
                async (uri, uris) => {
                    const selected = uris && uris.length > 0 ? uris : uri ? [uri] : [];
                    if (selected.length === 0) return;
                    const paths = selected.map((u) => vscode.workspace.asRelativePath(u));
                    const text = " " + paths.join(" ") + " ";
                    log.log(`sendFileToSession:${text}`);
                    mainView.sendSelectionToTerminal(text);
                    await vscode.commands.executeCommand("ccr.main.focus");
                },
            ],
            [
                "ccr.newSession",
                () => mainView.startNewClaudeSession(),
            ],
            [
                "ccr.refreshSessions",
                () => mainView.refreshClaudeSessions(),
            ],
            [
                "ccr.sendSelection",
                async () => {
                    const editor = vscode.window.activeTextEditor;
                    if (!editor) return;
                    const sel = editor.selection;
                    if (sel.isEmpty) return;
                    const relPath = vscode.workspace.asRelativePath(editor.document.uri);
                    const startLine = sel.start.line + 1;
                    const endLine = sel.end.line + 1;
                    const ref = startLine === endLine
                        ? `${relPath}:${startLine}`
                        : `${relPath}:${startLine}-${endLine}`;
                    log.log(`sendSelection: ${ref}`);
                    mainView.sendSelectionToTerminal(" " + ref + " ");
                    await vscode.commands.executeCommand("ccr.main.focus");
                },
            ],
        ];

        for (const [id, handler] of cmds) {
            context.subscriptions.push(
                vscode.commands.registerCommand(id, handler),
            );
        }

        // --- Re-apply decorations on tab switch ---
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (!editor) return;
                const review = state.activeReviews.get(
                    editor.document.uri.fsPath,
                );
                if (review) applyDecorations(editor, review);
            }),
        );

        // --- HTTP server + hook bridge ---
        setAddFileHandler((filePath) => {
            actions.addFileToReview(workspacePath, filePath);
        });
        startServer();
        context.subscriptions.push({
            dispose: () => {
                stopServer();
                ptyManager.dispose();
            },
        });

        // --- Hook manager: check & prompt for PostToolUse hook ---
        const hookStatusHandler = (status) => {
            mainView.sendHookStatus(status);
        };
        checkAndPrompt(workspacePath, hookStatusHandler);

        // Command to install hook from webview
        context.subscriptions.push(
            vscode.commands.registerCommand("ccr.installHook",
                () => doInstall(workspacePath, hookStatusHandler)),
        );

        // --- First-run tip: drag to secondary sidebar ---
        const SHOWN_KEY = "ccr.sidebarTipShown";
        if (!context.globalState.get(SHOWN_KEY)) {
            context.globalState.update(SHOWN_KEY, true);
            vscode.window
                .showInformationMessage(
                    "Tip: Drag the Claude Code Review icon from the left sidebar to the right secondary sidebar for the best experience.",
                    "Got it",
                )
                .then(() => {});
        }

        log.log("v8.0 activated successfully");
    } catch (err) {
        log.log("activation error:", err.message, err.stack);
        throw err;
    }
}

function deactivate() {
    for (const [fp, review] of state.activeReviews) {
        try {
            fs.writeFileSync(fp, review.modifiedContent, "utf8");
        } catch {}
    }
    stopServer();
}

module.exports = { activate, deactivate };
