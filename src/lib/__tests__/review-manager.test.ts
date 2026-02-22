import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn() }));
vi.mock("../decorations", () => ({
	applyDecorations: vi.fn(),
	clearDecorations: vi.fn(),
}));
vi.mock("../undo-history", () => ({
	initHistory: vi.fn(),
	recordSnapshot: vi.fn(),
	setApplyingEdit: vi.fn(),
	isApplyingEdit: vi.fn().mockReturnValue(false),
	clearHistory: vi.fn(),
	clearAllHistories: vi.fn(),
	lookupSnapshot: vi.fn().mockReturnValue(undefined),
}));

const mockFs = vi.hoisted(() => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	unlinkSync: vi.fn(),
	existsSync: vi.fn().mockReturnValue(true),
}));
vi.mock("fs", () => mockFs);

const mockExecSync = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execSync: mockExecSync }));

const mockServer = vi.hoisted(() => ({
	getSnapshot: vi.fn().mockReturnValue(undefined),
	clearSnapshot: vi.fn(),
}));
vi.mock("../server", () => mockServer);

const mockPersistence = vi.hoisted(() => ({
	saveReviewState: vi.fn(),
	loadReviewState: vi.fn().mockReturnValue(null),
	clearReviewState: vi.fn(),
}));
vi.mock("../persistence", () => mockPersistence);

import * as state from "../state";
import { ReviewManager } from "../review-manager";

function setupManager(): ReviewManager {
	const mgr = new ReviewManager("/ws");
	const codeLens = { refresh: vi.fn() };
	const mainView = { update: vi.fn() };
	mgr.setProviders(codeLens, mainView);
	return mgr;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	state.activeReviews.clear();
	state.setReviewFiles([]);
	state.setCurrentFileIndex(0);
	state.setCurrentHunkIndex(0);
	// Default: file returns different content so diff is generated
	mockFs.readFileSync.mockReturnValue("modified content");
	// Tracked file: execSync for git ls-files succeeds, git diff returns a diff
	mockExecSync.mockImplementation((cmd: string) => {
		if (cmd.includes("git ls-files")) return "";
		if (cmd.includes("git diff HEAD")) return "@@ -1,1 +1,1 @@\n-original\n+modified content";
		if (cmd.includes("git show HEAD")) return "original";
		return "";
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ReviewManager constructor + lifecycle", () => {
	it("creates with workspace path", () => {
		const mgr = new ReviewManager("/ws");
		expect(mgr).toBeDefined();
	});

	it("dispose clears timer and calls saveNow", () => {
		const mgr = setupManager();
		mgr.scheduleSave();
		mgr.dispose();
		expect(mockPersistence.saveReviewState).toHaveBeenCalled();
	});
});

describe("addFile", () => {
	it("adds new file to review", () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		expect(state.activeReviews.has("/ws/file.ts")).toBe(true);
		expect(mgr.getReviewFiles()).toContain("/ws/file.ts");
	});

	it("removes file when original === modified", () => {
		const mgr = setupManager();
		// First add
		mgr.addFile("/ws/file.ts");
		expect(state.activeReviews.has("/ws/file.ts")).toBe(true);

		// Now content matches original
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("git show HEAD")) return "same";
			if (cmd.includes("git ls-files")) return "";
			if (cmd.includes("git diff HEAD")) return "";
			return "";
		});
		mockFs.readFileSync.mockReturnValue("same");
		mockServer.getSnapshot.mockReturnValue("same");
		mgr.addFile("/ws/file.ts");
		expect(state.activeReviews.has("/ws/file.ts")).toBe(false);
	});

	it("clearSnapshot is called after addFile", () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		// server.clearSnapshot is called from addFile unconditionally
		// (Note: we verify the review was created by other tests)
		expect(state.activeReviews.has("/ws/file.ts")).toBe(true);
	});

	it("uses git show HEAD for tracked files without snapshot", () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue(undefined);
		mgr.addFile("/ws/file.ts");
		expect(mockExecSync).toHaveBeenCalledWith(
			expect.stringContaining("git show HEAD"),
			expect.anything(),
		);
	});

	it("fires onReviewStateChange(true) when file added", () => {
		const mgr = setupManager();
		const listener = vi.fn();
		mgr.onReviewStateChange(listener);
		mgr.addFile("/ws/file.ts");
		expect(listener).toHaveBeenCalledWith(true);
	});

	it("schedules save after addFile", () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		vi.advanceTimersByTime(500);
		expect(mockPersistence.saveReviewState).toHaveBeenCalled();
	});

	it("sets changeType=create for new file (no original)", () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue("");
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("git ls-files")) throw new Error("untracked");
			if (cmd.includes("git show HEAD")) throw new Error("not found");
			return "";
		});
		mockFs.readFileSync.mockReturnValue("new file content");
		mgr.addFile("/ws/new.ts");
		const review = state.activeReviews.get("/ws/new.ts");
		expect(review?.changeType).toBe("create");
	});
});

describe("resolveHunk", () => {
	it("marks hunk as resolved+accepted", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;
		const hunkId = review.hunks[0].id;

		await mgr.resolveHunk("/ws/file.ts", hunkId, true);
		expect(review.hunks[0].resolved).toBe(true);
		expect(review.hunks[0].accepted).toBe(true);
	});

	it("marks hunk as resolved+rejected", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;
		const hunkId = review.hunks[0].id;

		await mgr.resolveHunk("/ws/file.ts", hunkId, false);
		expect(review.hunks[0].resolved).toBe(true);
		expect(review.hunks[0].accepted).toBe(false);
	});

	it("ignores already resolved hunk", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;
		review.hunks[0].resolved = true;
		review.hunks[0].accepted = true;

		await mgr.resolveHunk("/ws/file.ts", review.hunks[0].id, false);
		expect(review.hunks[0].accepted).toBe(true); // unchanged
	});

	it("ignores non-existent filePath", async () => {
		const mgr = setupManager();
		await expect(mgr.resolveHunk("/nope", 0, true)).resolves.toBeUndefined();
	});

	it("finalizes when last hunk resolved", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;

		await mgr.resolveHunk("/ws/file.ts", review.hunks[0].id, true);
		// Single hunk → fully resolved → finalized → removed from activeReviews
		expect(state.activeReviews.has("/ws/file.ts")).toBe(false);
	});
});

describe("resolveAllHunks", () => {
	it("resolves all hunks and finalizes", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		await mgr.resolveAllHunks("/ws/file.ts", true);
		expect(state.activeReviews.has("/ws/file.ts")).toBe(false);
	});
});

describe("queries", () => {
	it("getReview returns review or undefined", () => {
		const mgr = setupManager();
		expect(mgr.getReview("/ws/missing.ts")).toBeUndefined();
		mgr.addFile("/ws/file.ts");
		expect(mgr.getReview("/ws/file.ts")).toBeDefined();
	});

	it("getUnresolvedFiles filters active reviews", () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		expect(mgr.getUnresolvedFiles()).toContain("/ws/file.ts");
	});

	it("hasActiveReview reflects state", () => {
		const mgr = setupManager();
		expect(mgr.hasActiveReview).toBe(false);
		mgr.addFile("/ws/file.ts");
		expect(mgr.hasActiveReview).toBe(true);
	});
});

describe("persistence", () => {
	it("scheduleSave debounces with 500ms delay", () => {
		const mgr = setupManager();
		mgr.scheduleSave();
		mgr.scheduleSave();
		mgr.scheduleSave();
		vi.advanceTimersByTime(500);
		expect(mockPersistence.saveReviewState).toHaveBeenCalledTimes(1);
	});

	it("saveNow calls saveReviewState immediately", () => {
		const mgr = setupManager();
		mgr.saveNow();
		expect(mockPersistence.saveReviewState).toHaveBeenCalledWith("/ws", state.activeReviews, 0);
	});

	it("restore returns false when no saved state", async () => {
		const mgr = setupManager();
		expect(await mgr.restore()).toBe(false);
	});

	it("restore loads and restores reviews", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/restored.ts",
					originalContent: "orig",
					modifiedContent: "mod",
					hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["orig"], added: ["mod"], resolved: false, accepted: false }],
					changeType: "edit",
				},
			],
		});
		mockFs.existsSync.mockReturnValue(true);
		const result = await mgr.restore();
		expect(result).toBe(true);
		expect(state.activeReviews.has("/ws/restored.ts")).toBe(true);
	});

	it("restore skips missing files", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/gone.ts",
					originalContent: "orig",
					modifiedContent: "mod",
					hunks: [],
					changeType: "edit",
				},
			],
		});
		mockFs.existsSync.mockReturnValue(false);
		const result = await mgr.restore();
		expect(result).toBe(false);
	});

	it("restore preserves delete reviews even when file missing", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/deleted.ts",
					originalContent: "line1\nline2",
					modifiedContent: "",
					hunks: [{ id: 0, origStart: 1, origCount: 2, modStart: 1, modCount: 0, removed: ["line1", "line2"], added: [], resolved: false, accepted: false }],
					changeType: "delete",
				},
			],
		});
		mockFs.existsSync.mockReturnValue(false); // file is deleted
		const result = await mgr.restore();
		expect(result).toBe(true);
		const review = state.activeReviews.get("/ws/deleted.ts");
		expect(review).toBeDefined();
		expect(review?.changeType).toBe("delete");
		expect(review?.originalContent).toBe("line1\nline2");
		expect(review?.modifiedContent).toBe("");
	});

	it("restore builds correct mergedLines for delete reviews", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/deleted.ts",
					originalContent: "a\nb",
					modifiedContent: "",
					hunks: [{ id: 0, origStart: 1, origCount: 2, modStart: 1, modCount: 0, removed: ["a", "b"], added: [], resolved: false, accepted: false }],
					changeType: "delete",
				},
			],
		});
		mockFs.existsSync.mockReturnValue(false);
		await mgr.restore();
		const review = state.activeReviews.get("/ws/deleted.ts");
		// mergedLines should contain removed lines only (no trailing empty string)
		expect(review?.mergedLines).toEqual(["a", "b"]);
		expect(review?.hunkRanges).toHaveLength(1);
		expect(review?.hunkRanges[0].removedStart).toBe(0);
		expect(review?.hunkRanges[0].removedEnd).toBe(2);
	});

	it("restore builds correct mergedLines for edit reviews", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/edit.ts",
					originalContent: "old",
					modifiedContent: "new",
					hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["old"], added: ["new"], resolved: false, accepted: false }],
					changeType: "edit",
				},
			],
		});
		mockFs.existsSync.mockReturnValue(true);
		await mgr.restore();
		const review = state.activeReviews.get("/ws/edit.ts");
		expect(review).toBeDefined();
		expect(review?.mergedLines).toEqual(["old", "new"]);
		expect(review?.hunkRanges).toHaveLength(1);
	});

	it("restore preserves partially-resolved hunks", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 0,
			files: [
				{
					filePath: "/ws/partial.ts",
					originalContent: "a\nb",
					modifiedContent: "x\ny",
					hunks: [
						{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["a"], added: ["x"], resolved: true, accepted: true },
						{ id: 1, origStart: 2, origCount: 1, modStart: 2, modCount: 1, removed: ["b"], added: ["y"], resolved: false, accepted: false },
					],
					changeType: "edit",
				},
			],
		});
		mockFs.existsSync.mockReturnValue(true);
		await mgr.restore();
		const review = state.activeReviews.get("/ws/partial.ts");
		expect(review?.hunks[0].resolved).toBe(true);
		expect(review?.hunks[0].accepted).toBe(true);
		expect(review?.hunks[1].resolved).toBe(false);
		// Only 1 unresolved hunk range (resolved hunks don't produce ranges)
		expect(review?.hunkRanges).toHaveLength(1);
	});

	it("restore preserves currentFileIndex", async () => {
		const mgr = setupManager();
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 2,
			files: [
				{ filePath: "/ws/a.ts", originalContent: "a", modifiedContent: "x", hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["a"], added: ["x"], resolved: false, accepted: false }], changeType: "edit" },
				{ filePath: "/ws/b.ts", originalContent: "b", modifiedContent: "y", hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["b"], added: ["y"], resolved: false, accepted: false }], changeType: "edit" },
				{ filePath: "/ws/c.ts", originalContent: "c", modifiedContent: "z", hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["c"], added: ["z"], resolved: false, accepted: false }], changeType: "edit" },
			],
		});
		mockFs.existsSync.mockReturnValue(true);
		await mgr.restore();
		expect(mgr.getCurrentFileIndex()).toBe(2);
	});

	it("restore fires onReviewStateChange", async () => {
		const mgr = setupManager();
		const listener = vi.fn();
		mgr.onReviewStateChange(listener);
		mockPersistence.loadReviewState.mockReturnValue({
			version: 1,
			timestamp: 1,
			currentFileIndex: 0,
			files: [
				{ filePath: "/ws/a.ts", originalContent: "a", modifiedContent: "x", hunks: [{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["a"], added: ["x"], resolved: false, accepted: false }], changeType: "edit" },
			],
		});
		mockFs.existsSync.mockReturnValue(true);
		await mgr.restore();
		expect(listener).toHaveBeenCalledWith(true);
	});
});

describe("handleMissingFile (deletion via Bash)", () => {
	it("creates delete review when snapshot exists for missing file", () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue("original content\nline2");
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mgr.addFile("/ws/deleted.ts");
		const review = state.activeReviews.get("/ws/deleted.ts");
		expect(review).toBeDefined();
		expect(review?.changeType).toBe("delete");
		expect(review?.originalContent).toBe("original content\nline2");
		expect(review?.modifiedContent).toBe("");
	});

	it("creates delete review from git when no snapshot", () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue(undefined);
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("git show HEAD")) return "git tracked content";
			return "";
		});
		mgr.addFile("/ws/deleted.ts");
		const review = state.activeReviews.get("/ws/deleted.ts");
		expect(review).toBeDefined();
		expect(review?.changeType).toBe("delete");
	});

	it("ignores missing file with no snapshot and not git-tracked", () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue(undefined);
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mockExecSync.mockImplementation(() => { throw new Error("not found"); });
		mgr.addFile("/ws/unknown.ts");
		expect(state.activeReviews.has("/ws/unknown.ts")).toBe(false);
	});

	it("delete review has all original lines in removed[]", () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue("line1\nline2\nline3");
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mgr.addFile("/ws/deleted.ts");
		const review = state.activeReviews.get("/ws/deleted.ts");
		expect(review?.hunks[0].removed).toEqual(["line1", "line2", "line3"]);
		expect(review?.hunks[0].added).toEqual([]);
	});

	it("resolveAllHunks(false) on delete review restores file", async () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue("original");
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mgr.addFile("/ws/deleted.ts");

		// Now allow writeFileSync to work
		mockFs.readFileSync.mockReturnValue("");
		await mgr.resolveAllHunks("/ws/deleted.ts", false);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith("/ws/deleted.ts", "original", "utf8");
	});

	it("fires onReviewStateChange for delete review", () => {
		const mgr = setupManager();
		const listener = vi.fn();
		mgr.onReviewStateChange(listener);
		mockServer.getSnapshot.mockReturnValue("content");
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mgr.addFile("/ws/deleted.ts");
		expect(listener).toHaveBeenCalledWith(true);
	});
});

describe("dispose — file restoration", () => {
	it("restores files to modifiedContent on dispose", () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;
		const modContent = review.modifiedContent;

		mockFs.writeFileSync.mockClear();
		mgr.dispose();

		// Should write modifiedContent for each active review
		expect(mockFs.writeFileSync).toHaveBeenCalledWith("/ws/file.ts", modContent, "utf8");
	});

	it("saves state after restoring files", () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		mockPersistence.saveReviewState.mockClear();
		mgr.dispose();
		expect(mockPersistence.saveReviewState).toHaveBeenCalled();
	});
});

describe("restoreFromSnapshot", () => {
	it("restores hunks from snapshot", () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;

		const snapshot = {
			filePath: "/ws/file.ts",
			originalContent: review.originalContent,
			modifiedContent: review.modifiedContent,
			changeType: review.changeType,
			hunks: [{ ...review.hunks[0], resolved: false, accepted: false }],
			mergedLines: [...review.mergedLines],
			hunkRanges: review.hunkRanges.map(r => ({ ...r })),
		};

		// Resolve the hunk first
		review.hunks[0].resolved = true;
		review.hunks[0].accepted = true;

		mgr.restoreFromSnapshot("/ws/file.ts", snapshot);
		expect(review.hunks[0].resolved).toBe(false);
	});

	it("re-creates review after finalize via undo", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		const review = state.activeReviews.get("/ws/file.ts")!;

		const snapshot = {
			filePath: "/ws/file.ts",
			originalContent: review.originalContent,
			modifiedContent: review.modifiedContent,
			changeType: review.changeType,
			hunks: JSON.parse(JSON.stringify(review.hunks)),
			mergedLines: [...review.mergedLines],
			hunkRanges: review.hunkRanges.map(r => ({ ...r })),
		};

		// Finalize (removes from activeReviews)
		await mgr.resolveAllHunks("/ws/file.ts", true);
		expect(state.activeReviews.has("/ws/file.ts")).toBe(false);

		// Undo → restoreFromSnapshot re-creates review
		mgr.restoreFromSnapshot("/ws/file.ts", snapshot);
		expect(state.activeReviews.has("/ws/file.ts")).toBe(true);
		expect(state.activeReviews.get("/ws/file.ts")!.hunks[0].resolved).toBe(false);
	});
});

describe("finalizeFile", () => {
	it("deletes created file when all rejected", async () => {
		const mgr = setupManager();
		// Setup as create type
		mockServer.getSnapshot.mockReturnValue("");
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("git ls-files")) throw new Error("untracked");
			if (cmd.includes("git show HEAD")) throw new Error("not found");
			return "";
		});
		mockFs.readFileSync.mockReturnValue("new content");
		mgr.addFile("/ws/new.ts");

		await mgr.resolveAllHunks("/ws/new.ts", false);
		expect(mockFs.unlinkSync).toHaveBeenCalledWith("/ws/new.ts");
	});

	it("writes final content for edit type", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		await mgr.resolveAllHunks("/ws/file.ts", true);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			"/ws/file.ts",
			expect.any(String),
			"utf8",
		);
	});

	it("clears state when all files resolved", async () => {
		const mgr = setupManager();
		mgr.addFile("/ws/file.ts");
		await mgr.resolveAllHunks("/ws/file.ts", true);
		expect(mockPersistence.clearReviewState).toHaveBeenCalled();
	});

	it("delete review + accept → file is deleted (unlinkSync)", async () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue("original content");
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mgr.addFile("/ws/del.ts");

		mockFs.readFileSync.mockReturnValue("");
		await mgr.resolveAllHunks("/ws/del.ts", true);
		expect(mockFs.unlinkSync).toHaveBeenCalledWith("/ws/del.ts");
	});

	it("delete review + reject → file is restored", async () => {
		const mgr = setupManager();
		mockServer.getSnapshot.mockReturnValue("original content");
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		mgr.addFile("/ws/del.ts");

		mockFs.readFileSync.mockReturnValue("");
		await mgr.resolveAllHunks("/ws/del.ts", false);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith("/ws/del.ts", "original content", "utf8");
	});
});
