// Claude Code with Review v8.0 — hook-based review + activitybar + Claude CLI sessions
import * as vscode from "vscode";
import * as fs from "fs";
import * as state from "./lib/state";
import { ReviewCodeLensProvider } from "./lib/codelens";
import { MainViewProvider } from "./lib/main-view";
import { PtyManager } from "./lib/pty-manager";
import { applyDecorations } from "./lib/decorations";
import { startServer, stopServer, setAddFileHandler } from "./lib/server";
import { checkAndPrompt, doInstall } from "./lib/hook-manager";
import { createReviewStatusBar, updateReviewStatusBar } from "./lib/status-bar";
import * as actions from "./lib/actions";
import * as log from "./lib/log";
import type { HookStatus } from "./types";

export function activate(context: vscode.ExtensionContext): void {
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
			vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLens),
		);

		// --- Review StatusBar navigation (context-sensitive) ---
		createReviewStatusBar(context, workspacePath);

		// Wrap refreshAll/refreshReview to also update StatusBar
		state.setRefreshAll((base) => {
			base();
			updateReviewStatusBar();
		});
		state.setRefreshReview((base) => {
			base();
			updateReviewStatusBar();
		});

		// --- Main status bar button ---
		const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		statusBar.text = "$(layers) Claude Code Review";
		statusBar.tooltip = "Toggle Claude Code Review panel (Option+Ctrl+B)";
		statusBar.command = "ccr.togglePanel";
		statusBar.show();
		context.subscriptions.push(statusBar);

		// --- Commands ---
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const cmds: Array<[string, (...args: any[]) => any]> = [
			["ccr.togglePanel", () => vscode.commands.executeCommand("ccr.main.focus")],
			["ccr.openReview", () => actions.startReviewSession(workspacePath)],
			[
				"ccr.openFileDiff",
				(item: { filePath?: string } | undefined) =>
					item?.filePath && actions.openFileForReview(item.filePath),
			],
			["ccr.acceptHunk", (fp: string, id: number) => actions.resolveHunk(fp, id, true)],
			["ccr.rejectHunk", (fp: string, id: number) => actions.resolveHunk(fp, id, false)],
			[
				"ccr.acceptFile",
				(item: { filePath?: string } | undefined) =>
					item?.filePath && actions.resolveAllHunks(item.filePath, true),
			],
			[
				"ccr.rejectFile",
				(item: { filePath?: string } | undefined) =>
					item?.filePath && actions.resolveAllHunks(item.filePath, false),
			],
			[
				"ccr.acceptAll",
				async () => {
					for (const f of [...state.getReviewFiles()]) {
						if (state.activeReviews.has(f)) await actions.resolveAllHunks(f, true);
					}
				},
			],
			[
				"ccr.rejectAll",
				async () => {
					for (const f of [...state.getReviewFiles()]) {
						if (state.activeReviews.has(f)) await actions.resolveAllHunks(f, false);
					}
				},
			],
			["ccr.prevFile", () => actions.navigateFile(-1)],
			["ccr.nextFile", () => actions.navigateFile(1)],
			["ccr.prevHunk", () => actions.navigateHunk(-1)],
			["ccr.nextHunk", () => actions.navigateHunk(1)],
			["ccr.keepCurrentFile", () => actions.keepCurrentFile()],
			["ccr.undoCurrentFile", () => actions.undoCurrentFile()],
			["ccr.reviewNextUnresolved", () => actions.reviewNextUnresolved()],
			[
				"ccr.sendFileToSession",
				async (uri: vscode.Uri | undefined, uris: vscode.Uri[] | undefined) => {
					const selected = uris && uris.length > 0 ? uris : uri ? [uri] : [];
					if (selected.length === 0) return;
					const paths = selected.map((u) => vscode.workspace.asRelativePath(u));
					const text = " " + paths.join(" ") + " ";
					log.log(`sendFileToSession:${text}`);
					mainView.sendSelectionToTerminal(text);
					await vscode.commands.executeCommand("ccr.main.focus");
				},
			],
			["ccr.newSession", () => mainView.startNewClaudeSession()],
			["ccr.refreshSessions", () => mainView.refreshClaudeSessions()],
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
					const ref =
						startLine === endLine
							? `${relPath}:${startLine}`
							: `${relPath}:${startLine}-${endLine}`;
					log.log(`sendSelection: ${ref}`);
					mainView.sendSelectionToTerminal(" " + ref + " ");
					await vscode.commands.executeCommand("ccr.main.focus");
				},
			],
		];

		for (const [id, handler] of cmds) {
			context.subscriptions.push(vscode.commands.registerCommand(id, handler));
		}

		// --- Re-apply decorations on tab switch ---
		context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (!editor) return;
				const review = state.activeReviews.get(editor.document.uri.fsPath);
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
		const hookStatusHandler = (hookStatus: HookStatus) => {
			mainView.sendHookStatus(hookStatus);
		};
		checkAndPrompt(workspacePath, hookStatusHandler);

		// Command to install hook from webview
		context.subscriptions.push(
			vscode.commands.registerCommand("ccr.installHook", () =>
				doInstall(workspacePath, hookStatusHandler),
			),
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
		log.log("activation error:", (err as Error).message, (err as Error).stack);
		throw err;
	}
}

export function deactivate(): void {
	for (const [fp, review] of state.activeReviews) {
		try {
			fs.writeFileSync(fp, review.modifiedContent, "utf8");
		} catch {}
	}
	stopServer();
}
