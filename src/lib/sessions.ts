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

function getCcrNamesFile(workspacePath: string): string {
	return path.join(getSessionsDir(workspacePath), "ccr-session-names.json");
}

function migrateCustomNamesIfNeeded(workspacePath: string): void {
	const ccrFile = getCcrNamesFile(workspacePath);
	if (fs.existsSync(ccrFile)) return;
	try {
		const legacyData = fs.readFileSync(getNamesFile(workspacePath), "utf8");
		const parsed = JSON.parse(legacyData) as Record<string, string>;
		if (Object.keys(parsed).length > 0) {
			fs.writeFileSync(ccrFile, JSON.stringify(parsed, null, 2), "utf8");
		}
	} catch {}
}

export function loadCustomNames(workspacePath: string): Record<string, string> {
	migrateCustomNamesIfNeeded(workspacePath);
	try {
		return JSON.parse(fs.readFileSync(getCcrNamesFile(workspacePath), "utf8")) as Record<
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
	fs.writeFileSync(getCcrNamesFile(workspacePath), JSON.stringify(names, null, 2), "utf8");
}

function getInvalidSessionsFile(workspacePath: string): string {
	return path.join(getSessionsDir(workspacePath), "invalid-sessions.json");
}

function loadInvalidSessions(workspacePath: string): Set<string> {
	try {
		return new Set(
			JSON.parse(fs.readFileSync(getInvalidSessionsFile(workspacePath), "utf8")) as string[],
		);
	} catch {
		return new Set();
	}
}

function getArchivedSessionsFile(workspacePath: string): string {
	return path.join(getSessionsDir(workspacePath), "archived-sessions.json");
}

function loadArchivedSessionIds(workspacePath: string): Set<string> {
	try {
		return new Set(
			JSON.parse(fs.readFileSync(getArchivedSessionsFile(workspacePath), "utf8")) as string[],
		);
	} catch {
		return new Set();
	}
}

export function archiveSession(workspacePath: string, sessionId: string): void {
	const archived = loadArchivedSessionIds(workspacePath);
	archived.add(sessionId);
	fs.writeFileSync(
		getArchivedSessionsFile(workspacePath),
		JSON.stringify([...archived], null, 2),
		"utf8",
	);
}

export function unarchiveSession(workspacePath: string, sessionId: string): void {
	const archived = loadArchivedSessionIds(workspacePath);
	archived.delete(sessionId);
	fs.writeFileSync(
		getArchivedSessionsFile(workspacePath),
		JSON.stringify([...archived], null, 2),
		"utf8",
	);
}

export function deleteSession(workspacePath: string, sessionId: string): void {
	const dir = getSessionsDir(workspacePath);
	const filePath = path.join(dir, sessionId + ".jsonl");
	try {
		fs.unlinkSync(filePath);
	} catch {}
	// Cleanup from ccr-session-names.json
	const names = loadCustomNames(workspacePath);
	if (names[sessionId]) {
		delete names[sessionId];
		fs.writeFileSync(getCcrNamesFile(workspacePath), JSON.stringify(names, null, 2), "utf8");
	}
	// Cleanup from archived-sessions.json
	const archived = loadArchivedSessionIds(workspacePath);
	if (archived.has(sessionId)) {
		archived.delete(sessionId);
		fs.writeFileSync(
			getArchivedSessionsFile(workspacePath),
			JSON.stringify([...archived], null, 2),
			"utf8",
		);
	}
	// Cleanup from invalid-sessions.json
	const invalid = loadInvalidSessions(workspacePath);
	if (invalid.has(sessionId)) {
		invalid.delete(sessionId);
		fs.writeFileSync(
			getInvalidSessionsFile(workspacePath),
			JSON.stringify([...invalid], null, 2),
			"utf8",
		);
	}
}

export function listSessions(
	workspacePath: string,
	limit = 20,
	offset = 0,
): { sessions: SessionInfo[]; hasMore: boolean; archivedCount: number } {
	const dir = getSessionsDir(workspacePath);
	if (!fs.existsSync(dir)) return { sessions: [], hasMore: false, archivedCount: 0 };

	const customNames = loadCustomNames(workspacePath);
	const invalidSessions = loadInvalidSessions(workspacePath);
	const archivedSessions = loadArchivedSessionIds(workspacePath);

	const files = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => {
			const fp = path.join(dir, f);
			const stat = fs.statSync(fp);
			return { file: f, path: fp, mtime: stat.mtimeMs, size: stat.size };
		})
		.sort((a, b) => b.mtime - a.mtime);

	const allValid: SessionInfo[] = [];
	let archivedCount = 0;
	for (const f of files) {
		const sessionId = f.file.replace(".jsonl", "");

		// Skip sessions marked as invalid (legacy hidden)
		if (invalidSessions.has(sessionId)) continue;

		// Quick skip: tiny files (< 3KB) are empty session stubs
		if (f.size < 3000 && !customNames[sessionId]) continue;

		const meta = parseSessionMeta(f.path);
		// Filter out sessions with no actual messages (abandoned starts)
		if (meta.messageCount === 0 && !customNames[sessionId]) continue;

		// Skip archived sessions from main list but count them
		if (archivedSessions.has(sessionId)) {
			archivedCount++;
			continue;
		}

		allValid.push({
			id: sessionId,
			title: customNames[sessionId] || meta.title || sessionId.slice(0, 8) + "...",
			timestamp: new Date(f.mtime).toISOString(),
			size: f.size,
			messageCount: meta.messageCount,
			branch: meta.branch,
		});
	}

	const sessions = allValid.slice(offset, offset + limit);
	const hasMore = offset + limit < allValid.length;
	return { sessions, hasMore, archivedCount };
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

export function listArchivedSessions(workspacePath: string): SessionInfo[] {
	const dir = getSessionsDir(workspacePath);
	if (!fs.existsSync(dir)) return [];

	const customNames = loadCustomNames(workspacePath);
	const archivedSessions = loadArchivedSessionIds(workspacePath);
	if (archivedSessions.size === 0) return [];

	const result: SessionInfo[] = [];
	for (const sessionId of archivedSessions) {
		const fp = path.join(dir, sessionId + ".jsonl");
		if (!fs.existsSync(fp)) continue;
		const stat = fs.statSync(fp);
		const meta = parseSessionMeta(fp);
		result.push({
			id: sessionId,
			title: customNames[sessionId] || meta.title || sessionId.slice(0, 8) + "...",
			timestamp: new Date(stat.mtimeMs).toISOString(),
			size: stat.size,
			messageCount: meta.messageCount,
			branch: meta.branch,
		});
	}

	return result.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
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
