// Claude CLI session discovery — reads JSONL files from ~/.claude/projects/
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import * as vscode from "vscode";
import type { SessionInfo, SessionMeta } from "../types";

function getProjectKey(workspacePath: string): string {
	// Claude CLI encodes paths: /Users/spals/projects/foo → -Users-spals-projects-foo
	return workspacePath.replace(/\//g, "-").replace(/^-/, "-");
}

function getSessionsDir(workspacePath: string): string {
	return path.join(os.homedir(), ".claude", "projects", getProjectKey(workspacePath));
}

function getNamesFile(workspacePath: string): string {
	return path.join(getSessionsDir(workspacePath), "session-names.json");
}

export function loadCustomNames(workspacePath: string): Record<string, string> {
	try {
		return JSON.parse(fs.readFileSync(getNamesFile(workspacePath), "utf8")) as Record<
			string,
			string
		>;
	} catch {
		return {};
	}
}

export function renameSession(workspacePath: string, sessionId: string, newName: string): void {
	const names = loadCustomNames(workspacePath);
	if (newName && newName.trim()) {
		names[sessionId] = newName.trim();
	} else {
		delete names[sessionId];
	}
	fs.writeFileSync(getNamesFile(workspacePath), JSON.stringify(names, null, 2), "utf8");
}

function getInvalidSessionsFile(workspacePath: string): string {
	return path.join(getSessionsDir(workspacePath), "invalid-sessions.json");
}

export function loadInvalidSessions(workspacePath: string): Set<string> {
	try {
		return new Set(
			JSON.parse(fs.readFileSync(getInvalidSessionsFile(workspacePath), "utf8")) as string[],
		);
	} catch {
		return new Set();
	}
}

export function markSessionInvalid(workspacePath: string, sessionId: string): void {
	const invalid = loadInvalidSessions(workspacePath);
	invalid.add(sessionId);
	fs.writeFileSync(
		getInvalidSessionsFile(workspacePath),
		JSON.stringify([...invalid], null, 2),
		"utf8",
	);
}

export function listSessions(workspacePath: string, limit = 20): SessionInfo[] {
	const dir = getSessionsDir(workspacePath);
	if (!fs.existsSync(dir)) return [];

	const customNames = loadCustomNames(workspacePath);
	const invalidSessions = loadInvalidSessions(workspacePath);

	const files = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => {
			const fp = path.join(dir, f);
			const stat = fs.statSync(fp);
			return { file: f, path: fp, mtime: stat.mtimeMs, size: stat.size };
		})
		.sort((a, b) => b.mtime - a.mtime);

	const result: SessionInfo[] = [];
	for (const f of files) {
		if (result.length >= limit) break;
		const sessionId = f.file.replace(".jsonl", "");

		// Skip sessions marked as invalid (deleted on server)
		if (invalidSessions.has(sessionId)) continue;

		// Quick skip: tiny files (< 3KB) are empty session stubs
		if (f.size < 3000 && !customNames[sessionId]) continue;

		const meta = parseSessionMeta(f.path);
		// Filter out sessions with no actual messages (abandoned starts)
		if (meta.messageCount === 0 && !customNames[sessionId]) continue;

		result.push({
			id: sessionId,
			title: customNames[sessionId] || meta.title || sessionId.slice(0, 8) + "...",
			timestamp: new Date(f.mtime).toISOString(),
			size: f.size,
			messageCount: meta.messageCount,
			branch: meta.branch,
		});
	}

	return result;
}

export function parseSessionMeta(filePath: string): SessionMeta {
	const result: SessionMeta = { title: null, messageCount: 0, branch: null };

	try {
		const content = fs.readFileSync(filePath, "utf8");
		const lines = content.split("\n").filter(Boolean);

		for (const line of lines) {
			try {
				const data = JSON.parse(line) as {
					type?: string;
					gitBranch?: string;
					summary?: unknown;
					message?: { content?: unknown };
				};
				const type = data.type;

				if (!result.branch && data.gitBranch) {
					result.branch = data.gitBranch;
				}

				if (type === "user") {
					result.messageCount++;
					if (!result.title) {
						const msg = data.message ?? {};
						const contentArr = msg.content;
						if (Array.isArray(contentArr)) {
							for (const item of contentArr as Array<{
								type?: string;
								text?: string;
							}>) {
								if (item.type !== "text" || !item.text) continue;
								const raw = item.text.trim();
								// Skip IDE/system context tags
								if (
									/^<(ide|system|context|auto|vscode|git|local|environment|command|user-prompt)/.test(
										raw,
									)
								)
									continue;
								// Strip any remaining XML-like tags
								const clean = raw
									.replace(/<[^>]+>/g, "")
									.trim()
									.slice(0, 80);
								if (clean) {
									result.title = clean;
									break;
								}
							}
						} else if (typeof contentArr === "string") {
							const clean = contentArr
								.replace(/<[^>]+>/g, "")
								.trim()
								.slice(0, 80);
							if (clean) result.title = clean;
						}
					}
				} else if (type === "assistant") {
					result.messageCount++;
				}

				// summary field overrides title
				if (type === "summary" && data.summary) {
					result.title = String(data.summary).slice(0, 80);
				}
			} catch {}
		}
	} catch {}

	return result;
}

export function getActiveDaemonSessions(): unknown[] {
	try {
		const cli = vscode.workspace
			.getConfiguration("claudeCodeReview")
			.get("cliCommand", "claude");
		const output = execSync(`${cli} daemon list`, {
			encoding: "utf8",
			timeout: 5000,
			stdio: "pipe",
		});
		return JSON.parse(output) as unknown[];
	} catch {
		return [];
	}
}

export { getSessionsDir };
