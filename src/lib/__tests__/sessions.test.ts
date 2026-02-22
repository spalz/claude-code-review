import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";

vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn() }));

const mockFs = vi.hoisted(() => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	unlinkSync: vi.fn(),
	existsSync: vi.fn().mockReturnValue(true),
	readdirSync: vi.fn().mockReturnValue([]),
	statSync: vi.fn(),
}));
vi.mock("fs", () => mockFs);

const mockOs = vi.hoisted(() => ({
	homedir: vi.fn().mockReturnValue("/home/test"),
}));
vi.mock("os", () => mockOs);

const mockExecSync = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execSync: mockExecSync }));

import {
	parseSessionMeta,
	loadCustomNames,
	renameSession,
	listSessions,
	archiveSession,
	unarchiveSession,
	deleteSession,
	listArchivedSessions,
	getSessionsDir,
} from "../sessions";

const WP = "/ws";
const DIR = path.join("/home/test", ".claude", "projects", "-ws");
const CCR_NAMES = path.join(DIR, "ccr-session-names.json");
const LEGACY_NAMES = path.join(DIR, "session-names.json");
const ARCHIVED = path.join(DIR, "archived-sessions.json");
const INVALID = path.join(DIR, "invalid-sessions.json");

/** Helper: create a JSONL line */
function jsonl(...objs: Record<string, unknown>[]): string {
	return objs.map((o) => JSON.stringify(o)).join("\n");
}

/** Path-based readFileSync mock setup */
function setupReadMock(files: Record<string, string>): void {
	mockFs.readFileSync.mockImplementation((p: string) => {
		if (files[p] !== undefined) return files[p];
		throw new Error(`ENOENT: ${p}`);
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFs.existsSync.mockReturnValue(true);
	mockFs.readdirSync.mockReturnValue([]);
	mockFs.readFileSync.mockImplementation(() => {
		throw new Error("ENOENT");
	});
});

// ─── parseSessionMeta ────────────────────────────────────────────────

describe("parseSessionMeta", () => {
	it("returns default meta for empty file", () => {
		mockFs.readFileSync.mockReturnValue("");
		const meta = parseSessionMeta("/tmp/empty.jsonl");
		expect(meta).toEqual({ title: null, messageCount: 0, branch: null });
	});

	it("extracts title from content array of first user message", () => {
		const data = jsonl({
			type: "user",
			message: { content: [{ type: "text", text: "Fix the login bug" }] },
		});
		mockFs.readFileSync.mockReturnValue(data);
		const meta = parseSessionMeta("/tmp/s.jsonl");
		expect(meta.title).toBe("Fix the login bug");
	});

	it("extracts title from string content", () => {
		const data = jsonl({
			type: "user",
			message: { content: "Hello Claude" },
		});
		mockFs.readFileSync.mockReturnValue(data);
		const meta = parseSessionMeta("/tmp/s.jsonl");
		expect(meta.title).toBe("Hello Claude");
	});

	it("skips IDE/system context tags", () => {
		const data = jsonl({
			type: "user",
			message: {
				content: [
					{ type: "text", text: "<ide>some context</ide>" },
					{ type: "text", text: "<system>info</system>" },
					{ type: "text", text: "Actual user prompt" },
				],
			},
		});
		mockFs.readFileSync.mockReturnValue(data);
		const meta = parseSessionMeta("/tmp/s.jsonl");
		expect(meta.title).toBe("Actual user prompt");
	});

	it("strips XML tags from title", () => {
		const data = jsonl({
			type: "user",
			message: {
				content: [{ type: "text", text: "Fix <b>this</b> bug please" }],
			},
		});
		mockFs.readFileSync.mockReturnValue(data);
		const meta = parseSessionMeta("/tmp/s.jsonl");
		expect(meta.title).toBe("Fix this bug please");
	});

	it("truncates title to 80 characters", () => {
		const longText = "A".repeat(120);
		const data = jsonl({
			type: "user",
			message: { content: [{ type: "text", text: longText }] },
		});
		mockFs.readFileSync.mockReturnValue(data);
		const meta = parseSessionMeta("/tmp/s.jsonl");
		expect(meta.title!.length).toBe(80);
	});

	it("counts user and assistant messages", () => {
		const data = jsonl(
			{ type: "user", message: { content: "msg1" } },
			{ type: "assistant", message: {} },
			{ type: "user", message: { content: "msg2" } },
			{ type: "assistant", message: {} },
		);
		mockFs.readFileSync.mockReturnValue(data);
		const meta = parseSessionMeta("/tmp/s.jsonl");
		expect(meta.messageCount).toBe(4);
	});

	it("summary overrides title", () => {
		const data = jsonl(
			{ type: "user", message: { content: "Original title" } },
			{ type: "summary", summary: "Summary title override" },
		);
		mockFs.readFileSync.mockReturnValue(data);
		const meta = parseSessionMeta("/tmp/s.jsonl");
		expect(meta.title).toBe("Summary title override");
	});

	it("extracts branch from gitBranch field", () => {
		const data = jsonl(
			{ type: "user", gitBranch: "feature/auth", message: { content: "test" } },
		);
		mockFs.readFileSync.mockReturnValue(data);
		const meta = parseSessionMeta("/tmp/s.jsonl");
		expect(meta.branch).toBe("feature/auth");
	});
});

// ─── loadCustomNames + renameSession (ccr migration) ─────────────────

describe("loadCustomNames + renameSession", () => {
	it("returns empty object when ccr file does not exist", () => {
		mockFs.existsSync.mockReturnValue(false);
		mockFs.readFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		const names = loadCustomNames(WP);
		expect(names).toEqual({});
	});

	it("reads from ccr-session-names.json", () => {
		const ccrData = JSON.stringify({ "abc-123": "My Session" });
		setupReadMock({ [CCR_NAMES]: ccrData });
		mockFs.existsSync.mockReturnValue(true); // ccr file exists
		const names = loadCustomNames(WP);
		expect(names).toEqual({ "abc-123": "My Session" });
	});

	it("migrates from session-names.json when ccr does not exist", () => {
		const legacyData = JSON.stringify({ "sess-1": "Legacy Name" });
		// ccr file does NOT exist, but legacy does
		mockFs.existsSync.mockImplementation((p: string) => p !== CCR_NAMES);
		setupReadMock({ [LEGACY_NAMES]: legacyData });
		// After migration, readFileSync for CCR will be called — simulate it now exists
		const writtenData: Record<string, string> = {};
		mockFs.writeFileSync.mockImplementation((p: string, data: string) => {
			writtenData[p] = data;
		});
		// Override readFileSync to return written data after migration
		mockFs.readFileSync.mockImplementation((p: string) => {
			if (p === LEGACY_NAMES) return legacyData;
			if (p === CCR_NAMES && writtenData[CCR_NAMES]) return writtenData[CCR_NAMES];
			throw new Error("ENOENT");
		});

		const names = loadCustomNames(WP);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			CCR_NAMES,
			expect.any(String),
			"utf8",
		);
		expect(names).toEqual({ "sess-1": "Legacy Name" });
	});

	it("skips migration when ccr file already exists", () => {
		const ccrData = JSON.stringify({ "s1": "Existing" });
		setupReadMock({ [CCR_NAMES]: ccrData });
		mockFs.existsSync.mockReturnValue(true);
		loadCustomNames(WP);
		// writeFileSync should NOT be called for migration
		expect(mockFs.writeFileSync).not.toHaveBeenCalled();
	});

	it("renameSession writes to ccr file", () => {
		// ccr file exists with empty content
		setupReadMock({ [CCR_NAMES]: "{}" });
		mockFs.existsSync.mockReturnValue(true);
		renameSession(WP, "sess-1", "New Name");
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			CCR_NAMES,
			expect.stringContaining("New Name"),
			"utf8",
		);
	});

	it("renameSession deletes entry when name is empty", () => {
		const existing = JSON.stringify({ "sess-1": "Old Name" });
		setupReadMock({ [CCR_NAMES]: existing });
		mockFs.existsSync.mockReturnValue(true);
		renameSession(WP, "sess-1", "");
		const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
		expect(written["sess-1"]).toBeUndefined();
	});
});

// ─── listSessions ────────────────────────────────────────────────────

describe("listSessions", () => {
	function setupSessionFiles(
		files: Array<{ name: string; size: number; mtime: number; content: string }>,
		opts: { customNames?: Record<string, string>; archived?: string[]; invalid?: string[] } = {},
	) {
		mockFs.existsSync.mockImplementation((p: string) => {
			if (p === CCR_NAMES && opts.customNames) return true;
			if (p === DIR) return true;
			return true;
		});
		mockFs.readdirSync.mockReturnValue(files.map((f) => f.name));
		mockFs.statSync.mockImplementation((p: string) => {
			const f = files.find((ff) => p.endsWith(ff.name));
			return { mtimeMs: f?.mtime ?? 0, size: f?.size ?? 0 };
		});
		const fileMap: Record<string, string> = {};
		for (const f of files) {
			fileMap[path.join(DIR, f.name)] = f.content;
		}
		if (opts.customNames) {
			fileMap[CCR_NAMES] = JSON.stringify(opts.customNames);
		}
		if (opts.archived) {
			fileMap[ARCHIVED] = JSON.stringify(opts.archived);
		}
		if (opts.invalid) {
			fileMap[INVALID] = JSON.stringify(opts.invalid);
		}
		setupReadMock(fileMap);
	}

	it("returns empty when directory does not exist", () => {
		mockFs.existsSync.mockReturnValue(false);
		const result = listSessions(WP);
		expect(result).toEqual({ sessions: [], hasMore: false, archivedCount: 0 });
	});

	it("sorts sessions by mtime descending", () => {
		const userMsg = jsonl({ type: "user", message: { content: "test" } }, { type: "assistant" });
		setupSessionFiles([
			{ name: "old.jsonl", size: 5000, mtime: 1000, content: userMsg },
			{ name: "new.jsonl", size: 5000, mtime: 3000, content: userMsg },
			{ name: "mid.jsonl", size: 5000, mtime: 2000, content: userMsg },
		]);
		const result = listSessions(WP);
		expect(result.sessions.map((s) => s.id)).toEqual(["new", "mid", "old"]);
	});

	it("skips invalid sessions", () => {
		const userMsg = jsonl({ type: "user", message: { content: "test" } });
		setupSessionFiles(
			[
				{ name: "good.jsonl", size: 5000, mtime: 1000, content: userMsg },
				{ name: "bad.jsonl", size: 5000, mtime: 2000, content: userMsg },
			],
			{ invalid: ["bad"] },
		);
		const result = listSessions(WP);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].id).toBe("good");
	});

	it("skips archived sessions and counts them", () => {
		const userMsg = jsonl({ type: "user", message: { content: "test" } });
		setupSessionFiles(
			[
				{ name: "active.jsonl", size: 5000, mtime: 2000, content: userMsg },
				{ name: "arch.jsonl", size: 5000, mtime: 1000, content: userMsg },
			],
			{ archived: ["arch"] },
		);
		const result = listSessions(WP);
		expect(result.sessions).toHaveLength(1);
		expect(result.archivedCount).toBe(1);
	});

	it("skips small files (< 3KB) without custom name", () => {
		const userMsg = jsonl({ type: "user", message: { content: "test" } });
		setupSessionFiles([
			{ name: "small.jsonl", size: 100, mtime: 1000, content: userMsg },
			{ name: "big.jsonl", size: 5000, mtime: 2000, content: userMsg },
		]);
		const result = listSessions(WP);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].id).toBe("big");
	});

	it("includes small files with custom name", () => {
		const userMsg = jsonl({ type: "user", message: { content: "test" } });
		setupSessionFiles(
			[{ name: "small.jsonl", size: 100, mtime: 1000, content: userMsg }],
			{ customNames: { small: "My Small Session" } },
		);
		const result = listSessions(WP);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].title).toBe("My Small Session");
	});

	it("paginates with limit and offset", () => {
		const userMsg = jsonl({ type: "user", message: { content: "test" } });
		setupSessionFiles([
			{ name: "s1.jsonl", size: 5000, mtime: 3000, content: userMsg },
			{ name: "s2.jsonl", size: 5000, mtime: 2000, content: userMsg },
			{ name: "s3.jsonl", size: 5000, mtime: 1000, content: userMsg },
		]);
		const result = listSessions(WP, 2, 0);
		expect(result.sessions).toHaveLength(2);
		expect(result.hasMore).toBe(true);

		const page2 = listSessions(WP, 2, 2);
		expect(page2.sessions).toHaveLength(1);
		expect(page2.hasMore).toBe(false);
	});

	it("uses custom name over meta.title", () => {
		const userMsg = jsonl({ type: "user", message: { content: "Auto title" } });
		setupSessionFiles(
			[{ name: "sess.jsonl", size: 5000, mtime: 1000, content: userMsg }],
			{ customNames: { sess: "Custom Name" } },
		);
		const result = listSessions(WP);
		expect(result.sessions[0].title).toBe("Custom Name");
	});
});

// ─── archiveSession / unarchiveSession ───────────────────────────────

describe("archiveSession / unarchiveSession", () => {
	it("adds session to archived-sessions.json", () => {
		setupReadMock({ [ARCHIVED]: "[]" });
		archiveSession(WP, "sess-1");
		const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
		expect(written).toContain("sess-1");
	});

	it("removes session from archived-sessions.json", () => {
		setupReadMock({ [ARCHIVED]: JSON.stringify(["sess-1", "sess-2"]) });
		unarchiveSession(WP, "sess-1");
		const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
		expect(written).not.toContain("sess-1");
		expect(written).toContain("sess-2");
	});

	it("creates file when it does not exist (archiveSession)", () => {
		mockFs.readFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		archiveSession(WP, "sess-new");
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			ARCHIVED,
			expect.stringContaining("sess-new"),
			"utf8",
		);
	});

	it("creates file when it does not exist (unarchiveSession)", () => {
		mockFs.readFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		unarchiveSession(WP, "sess-missing");
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			ARCHIVED,
			expect.any(String),
			"utf8",
		);
	});
});

// ─── deleteSession ───────────────────────────────────────────────────

describe("deleteSession", () => {
	it("deletes the .jsonl file", () => {
		setupReadMock({
			[CCR_NAMES]: "{}",
			[ARCHIVED]: "[]",
			[INVALID]: "[]",
		});
		mockFs.existsSync.mockReturnValue(true);
		deleteSession(WP, "sess-1");
		expect(mockFs.unlinkSync).toHaveBeenCalledWith(path.join(DIR, "sess-1.jsonl"));
	});

	it("cleans up from ccr-session-names.json", () => {
		setupReadMock({
			[CCR_NAMES]: JSON.stringify({ "sess-1": "Name" }),
			[ARCHIVED]: "[]",
			[INVALID]: "[]",
		});
		mockFs.existsSync.mockReturnValue(true);
		deleteSession(WP, "sess-1");
		const nameWrites = mockFs.writeFileSync.mock.calls.filter(
			(c: unknown[]) => c[0] === CCR_NAMES,
		);
		expect(nameWrites).toHaveLength(1);
		const written = JSON.parse(nameWrites[0][1] as string);
		expect(written["sess-1"]).toBeUndefined();
	});

	it("cleans up from archived-sessions.json", () => {
		setupReadMock({
			[CCR_NAMES]: "{}",
			[ARCHIVED]: JSON.stringify(["sess-1"]),
			[INVALID]: "[]",
		});
		mockFs.existsSync.mockReturnValue(true);
		deleteSession(WP, "sess-1");
		const archWrites = mockFs.writeFileSync.mock.calls.filter(
			(c: unknown[]) => c[0] === ARCHIVED,
		);
		expect(archWrites).toHaveLength(1);
		const written = JSON.parse(archWrites[0][1] as string);
		expect(written).not.toContain("sess-1");
	});

	it("cleans up from invalid-sessions.json", () => {
		setupReadMock({
			[CCR_NAMES]: "{}",
			[ARCHIVED]: "[]",
			[INVALID]: JSON.stringify(["sess-1"]),
		});
		mockFs.existsSync.mockReturnValue(true);
		deleteSession(WP, "sess-1");
		const invWrites = mockFs.writeFileSync.mock.calls.filter(
			(c: unknown[]) => c[0] === INVALID,
		);
		expect(invWrites).toHaveLength(1);
		const written = JSON.parse(invWrites[0][1] as string);
		expect(written).not.toContain("sess-1");
	});
});

// ─── listArchivedSessions ────────────────────────────────────────────

describe("listArchivedSessions", () => {
	it("returns empty array when no archived sessions", () => {
		setupReadMock({ [CCR_NAMES]: "{}", [ARCHIVED]: "[]" });
		mockFs.existsSync.mockReturnValue(true);
		const result = listArchivedSessions(WP);
		expect(result).toEqual([]);
	});

	it("returns archived sessions sorted by time", () => {
		setupReadMock({
			[CCR_NAMES]: "{}",
			[ARCHIVED]: JSON.stringify(["old", "new"]),
			[path.join(DIR, "old.jsonl")]: jsonl({ type: "user", message: { content: "old" } }),
			[path.join(DIR, "new.jsonl")]: jsonl({ type: "user", message: { content: "new" } }),
		});
		mockFs.existsSync.mockReturnValue(true);
		mockFs.statSync.mockImplementation((p: string) => ({
			mtimeMs: (p as string).includes("new") ? 2000 : 1000,
			size: 5000,
		}));
		const result = listArchivedSessions(WP);
		expect(result).toHaveLength(2);
		expect(result[0].id).toBe("new");
		expect(result[1].id).toBe("old");
	});

	it("skips archived sessions with missing .jsonl file", () => {
		setupReadMock({
			[CCR_NAMES]: "{}",
			[ARCHIVED]: JSON.stringify(["exists", "missing"]),
			[path.join(DIR, "exists.jsonl")]: jsonl({ type: "user", message: { content: "x" } }),
		});
		mockFs.existsSync.mockImplementation((p: string) => {
			if ((p as string).includes("missing.jsonl")) return false;
			return true;
		});
		mockFs.statSync.mockReturnValue({ mtimeMs: 1000, size: 5000 });
		const result = listArchivedSessions(WP);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("exists");
	});
});

// ─── getSessionsDir ─────────────────────────────────────────────────

describe("getSessionsDir", () => {
	it("encodes workspace path to project key", () => {
		const dir = getSessionsDir("/Users/spals/projects/foo");
		expect(dir).toBe(path.join("/home/test", ".claude", "projects", "-Users-spals-projects-foo"));
	});
});
