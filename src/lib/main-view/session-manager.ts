import * as vscode from "vscode";
import * as log from "../log";
import * as state from "../state";
import { listSessions } from "../sessions";
import type { PtyManager } from "../pty-manager";
import type { ExtensionToWebviewMessage } from "../../types";

export class SessionManager {
	private readonly _ptyToClaudeId = new Map<number, string>();

	constructor(
		private readonly _wp: string,
		private readonly _ptyManager: PtyManager,
		private readonly _workspaceState: vscode.Memento | undefined,
		private readonly _postMessage: (msg: ExtensionToWebviewMessage) => void,
	) {}

	refreshClaudeSessions(): void {
		const sessions = listSessions(this._wp, 30);
		log.log(`refreshClaudeSessions: found ${sessions.length} sessions`);
		this._postMessage({ type: "sessions-list", sessions });
		this.sendOpenSessionIds();
	}

	startNewClaudeSession(resumeId?: string): void {
		const cli = vscode.workspace
			.getConfiguration("claudeCodeReview")
			.get<string>("cliCommand", "claude");
		const cmd = resumeId ? `${cli} --resume ${resumeId}` : cli;
		log.log(`startNewClaudeSession: resumeId=${resumeId || "none"}, cmd=${cmd}`);

		const info = this._ptyManager.createSession(
			resumeId ? `resume:${resumeId.slice(0, 8)}` : "new",
			cmd,
		);

		if (resumeId) {
			this._ptyToClaudeId.set(info.id, resumeId);
		}

		this._persistOpenSessions();
		this._postMessage({
			type: "terminal-session-created",
			sessionId: info.id,
			name: info.name,
			claudeId: resumeId || null,
		});
		this.sendOpenSessionIds();
		state.refreshAll();
	}

	findPtyByClaudeId(claudeId: string): number | null {
		for (const [ptyId, cId] of this._ptyToClaudeId) {
			if (cId === claudeId) return ptyId;
		}
		return null;
	}

	sendOpenSessionIds(): void {
		const openClaudeIds = [...this._ptyToClaudeId.values()];
		log.log(`sendOpenSessionIds: [${openClaudeIds.map((id) => id.slice(0, 8)).join(", ")}]`);
		this._postMessage({ type: "open-sessions-update", openClaudeIds });
	}

	removeOpenSession(ptySessionId: number): void {
		log.log(
			`removeOpenSession: pty=${ptySessionId}, claude=${this._ptyToClaudeId.get(ptySessionId) || "?"}`,
		);
		this._ptyToClaudeId.delete(ptySessionId);
		this._persistOpenSessions();
	}

	persistActiveSession(claudeId: string | null): void {
		log.log(`persistActiveSession: ${claudeId || "none"}`);
		this._workspaceState?.update("ccr.activeSession", claudeId || null);
	}

	restoreSessions(): void {
		const ids = this._workspaceState?.get<string[]>("ccr.openSessions") || [];
		const activeClaudeId = this._workspaceState?.get<string>("ccr.activeSession") || null;
		log.log(
			`restoreSessions: ${ids.length} sessions to restore: [${ids.join(", ")}], active=${activeClaudeId || "none"}`,
		);

		for (const claudeId of ids) {
			this.startNewClaudeSession(claudeId);
		}

		if (activeClaudeId) {
			const ptyId = this.findPtyByClaudeId(activeClaudeId);
			if (ptyId !== null) {
				log.log(`restoreSessions: activating saved active session pty #${ptyId}`);
				this._postMessage({
					type: "activate-terminal",
					sessionId: ptyId,
				});
			}
		}
	}

	getPtyToClaudeId(): Map<number, string> {
		return this._ptyToClaudeId;
	}

	private _persistOpenSessions(): void {
		const ids = [...this._ptyToClaudeId.values()];
		log.log(`persistOpenSessions: ${ids.length} sessions saved`);
		this._workspaceState?.update("ccr.openSessions", ids);
	}
}
