import * as vscode from "vscode";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as log from "../log";
import * as state from "../state";
import { renameSession, markSessionInvalid } from "../sessions";
import type { PtyManager } from "../pty-manager";
import type { SessionManager } from "./session-manager";
import type { KeybindingInfo, HookStatus, ExtensionToWebviewMessage } from "../../types";

export interface MessageContext {
	sessionMgr: SessionManager;
	ptyManager: PtyManager;
	wp: string;
	postMessage: (msg: ExtensionToWebviewMessage) => void;
	getKeybindings: () => KeybindingInfo[];
	webviewReady: boolean;
	pendingHookStatus: HookStatus | null;
}

export interface MessageResult {
	webviewReady: boolean;
	pendingHookStatus: HookStatus | null;
}

export function handleWebviewMessage(
	msg: Record<string, unknown>,
	ctx: MessageContext,
): MessageResult {
	log.log(`webview msg: ${msg.type as string}`);

	let webviewReady = ctx.webviewReady;
	let pendingHookStatus = ctx.pendingHookStatus;

	switch (msg.type) {
		case "webview-ready":
			log.log("webview ready, sending sessions list + restoring");
			webviewReady = true;
			ctx.sessionMgr.refreshClaudeSessions();
			ctx.sessionMgr.restoreSessions();
			ctx.postMessage({
				type: "settings-init",
				cliCommand: vscode.workspace
					.getConfiguration("claudeCodeReview")
					.get<string>("cliCommand", "claude"),
				keybindings: ctx.getKeybindings(),
			});
			if (pendingHookStatus) {
				log.log(`sending pending hook status: ${pendingHookStatus}`);
				ctx.postMessage({
					type: "hook-status",
					status: pendingHookStatus,
				});
				pendingHookStatus = null;
			}
			break;

		case "new-claude-session":
			ctx.sessionMgr.startNewClaudeSession();
			break;

		case "resume-claude-session": {
			const claudeSessionId = msg.claudeSessionId as string;
			const existingPtyId = ctx.sessionMgr.findPtyByClaudeId(claudeSessionId);
			if (existingPtyId !== null) {
				log.log(
					`resume: session ${claudeSessionId.slice(0, 8)} already open as pty #${existingPtyId}, activating`,
				);
				ctx.postMessage({
					type: "activate-terminal",
					sessionId: existingPtyId,
				});
			} else {
				log.log(`resume: opening session ${claudeSessionId.slice(0, 8)}`);
				ctx.sessionMgr.startNewClaudeSession(claudeSessionId);
			}
			break;
		}

		case "refresh-sessions":
			ctx.sessionMgr.refreshClaudeSessions();
			break;

		case "rename-session": {
			const sessionId = msg.sessionId as string;
			const newName = msg.newName as string;
			log.log(`rename: ${sessionId.slice(0, 8)} -> "${newName}"`);
			renameSession(ctx.wp, sessionId, newName);
			ctx.sessionMgr.refreshClaudeSessions();
			break;
		}

		case "hide-session": {
			const sessionId = msg.sessionId as string;
			log.log(`hide: ${sessionId.slice(0, 8)}`);
			markSessionInvalid(ctx.wp, sessionId);
			ctx.sessionMgr.refreshClaudeSessions();
			break;
		}

		case "terminal-input":
			ctx.ptyManager.writeToSession(msg.sessionId as number, msg.data as string);
			break;

		case "terminal-resize":
			ctx.ptyManager.resizeSession(
				msg.sessionId as number,
				msg.cols as number,
				msg.rows as number,
			);
			break;

		case "close-terminal": {
			const ptyId = msg.sessionId as number;
			log.log(`close-terminal: pty #${ptyId}`);
			ctx.ptyManager.closeSession(ptyId);
			ctx.sessionMgr.getPtyToClaudeId().delete(ptyId);
			ctx.sessionMgr.removeOpenSession(ptyId);
			ctx.postMessage({
				type: "terminal-session-closed",
				sessionId: ptyId,
			});
			ctx.sessionMgr.sendOpenSessionIds();
			state.refreshAll();
			break;
		}

		case "close-session-by-claude-id": {
			const claudeSessionId = msg.claudeSessionId as string;
			const ptyId = ctx.sessionMgr.findPtyByClaudeId(claudeSessionId);
			if (ptyId !== null) {
				ctx.ptyManager.closeSession(ptyId);
				ctx.sessionMgr.getPtyToClaudeId().delete(ptyId);
				ctx.sessionMgr.removeOpenSession(ptyId);
				ctx.postMessage({
					type: "terminal-session-closed",
					sessionId: ptyId,
				});
				ctx.sessionMgr.sendOpenSessionIds();
				state.refreshAll();
			}
			break;
		}

		case "file-dropped": {
			const uri = (msg.uri as string).trim().split("\n")[0];
			const sessionId = msg.sessionId as number;
			log.log(`file-dropped: session #${sessionId}, uri=${uri}`);
			try {
				const fileUri = vscode.Uri.parse(uri);
				const relativePath = vscode.workspace.asRelativePath(fileUri);
				log.log(`file-dropped: resolved to ${relativePath}`);
				ctx.ptyManager.writeToSession(sessionId, relativePath);
			} catch (err) {
				log.log(`file-dropped: error -- ${(err as Error).message}`);
			}
			break;
		}

		case "start-review":
			vscode.commands.executeCommand("ccr.openReview");
			break;

		case "accept-file": {
			const actions = require("../actions") as typeof import("../actions");
			actions.resolveAllHunks(msg.filePath as string, true);
			break;
		}

		case "reject-file": {
			const actions = require("../actions") as typeof import("../actions");
			actions.resolveAllHunks(msg.filePath as string, false);
			break;
		}

		case "go-to-file": {
			const actions = require("../actions") as typeof import("../actions");
			actions.openFileForReview(msg.filePath as string);
			break;
		}

		case "prev-file": {
			const actions = require("../actions") as typeof import("../actions");
			actions.navigateFile(-1);
			break;
		}

		case "next-file": {
			const actions = require("../actions") as typeof import("../actions");
			actions.navigateFile(1);
			break;
		}

		case "accept-all":
			vscode.commands.executeCommand("ccr.acceptAll");
			break;

		case "reject-all":
			vscode.commands.executeCommand("ccr.rejectAll");
			break;

		case "open-terminal":
			vscode.commands.executeCommand("workbench.action.terminal.toggleTerminal");
			break;

		case "git-status":
			vscode.commands.executeCommand("workbench.action.terminal.new").then(() => {
				setTimeout(() => {
					const t = vscode.window.activeTerminal;
					if (t) t.sendText("git status");
				}, 200);
			});
			break;

		case "paste-image": {
			const mimeType = msg.mimeType as string;
			const ext =
				mimeType === "image/png" ? ".png" : mimeType === "image/jpeg" ? ".jpg" : ".png";
			const tmpFile = path.join(os.tmpdir(), `ccr-paste-${Date.now()}${ext}`);
			try {
				fs.writeFileSync(tmpFile, Buffer.from(msg.data as string, "base64"));
				log.log(`paste-image: saved to ${tmpFile}`);
				ctx.ptyManager.writeToSession(msg.sessionId as number, tmpFile);
			} catch (err) {
				log.log(`paste-image error: ${(err as Error).message}`);
			}
			break;
		}

		case "install-hook":
			vscode.commands.executeCommand("ccr.installHook");
			break;

		case "open-keybindings":
			log.log("open-keybindings: opening VS Code keyboard shortcuts");
			vscode.commands.executeCommand(
				"workbench.action.openGlobalKeybindings",
				"Claude Code Review",
			);
			break;

		case "set-active-session": {
			const claudeId = (msg.claudeId as string | null) || null;
			ctx.sessionMgr.persistActiveSession(claudeId);
			break;
		}

		case "set-cli-command":
			log.log(`set-cli-command: ${msg.value as string}`);
			vscode.workspace
				.getConfiguration("claudeCodeReview")
				.update("cliCommand", msg.value as string, true);
			break;
	}

	return { webviewReady, pendingHookStatus };
}
