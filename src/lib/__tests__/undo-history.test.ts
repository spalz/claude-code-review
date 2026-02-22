import { describe, it, expect, beforeEach } from "vitest";
import {
	initHistory,
	recordSnapshot,
	lookupSnapshot,
	setApplyingEdit,
	isApplyingEdit,
	clearHistory,
	clearAllHistories,
} from "../undo-history";
import type { IFileReview, ChangeType } from "../../types";

function makeFakeReview(overrides?: Partial<IFileReview>): IFileReview {
	return {
		filePath: "/ws/file.ts",
		originalContent: "old",
		modifiedContent: "new",
		changeType: "edit" as ChangeType,
		hunks: [
			{ id: 0, origStart: 1, origCount: 1, modStart: 1, modCount: 1, removed: ["old"], added: ["new"], resolved: false, accepted: false },
		],
		mergedLines: ["old", "new"],
		hunkRanges: [{ hunkId: 0, removedStart: 0, removedEnd: 1, addedStart: 1, addedEnd: 2 }],
		get unresolvedCount() { return this.hunks.filter(h => !h.resolved).length; },
		get isFullyResolved() { return this.hunks.every(h => h.resolved); },
		...overrides,
	};
}

beforeEach(() => {
	clearAllHistories();
});

describe("undo-history", () => {
	it("recordSnapshot + lookupSnapshot round-trip", () => {
		initHistory("/ws/file.ts");
		const review = makeFakeReview();
		recordSnapshot("/ws/file.ts", review);

		const content = review.mergedLines.join("\n");
		const snapshot = lookupSnapshot("/ws/file.ts", content);
		expect(snapshot).toBeDefined();
		expect(snapshot!.filePath).toBe("/ws/file.ts");
		expect(snapshot!.hunks).toEqual(review.hunks);
		expect(snapshot!.mergedLines).toEqual(review.mergedLines);
	});

	it("deep copy — mutation of original does not affect snapshot", () => {
		initHistory("/ws/file.ts");
		const review = makeFakeReview();
		recordSnapshot("/ws/file.ts", review);

		// Mutate original
		review.hunks[0].resolved = true;
		review.mergedLines.push("extra");

		const content = "old\nnew"; // original content before mutation
		const snapshot = lookupSnapshot("/ws/file.ts", content);
		expect(snapshot!.hunks[0].resolved).toBe(false);
		expect(snapshot!.mergedLines).toEqual(["old", "new"]);
	});

	it("lookupSnapshot returns undefined for unknown content", () => {
		initHistory("/ws/file.ts");
		const review = makeFakeReview();
		recordSnapshot("/ws/file.ts", review);

		expect(lookupSnapshot("/ws/file.ts", "unknown content")).toBeUndefined();
	});

	it("lookupSnapshot returns undefined for unknown file", () => {
		expect(lookupSnapshot("/ws/nope.ts", "anything")).toBeUndefined();
	});

	it("clearHistory clears snapshots for a file", () => {
		initHistory("/ws/file.ts");
		const review = makeFakeReview();
		recordSnapshot("/ws/file.ts", review);

		clearHistory("/ws/file.ts");
		expect(lookupSnapshot("/ws/file.ts", review.mergedLines.join("\n"))).toBeUndefined();
	});

	it("clearAllHistories clears everything", () => {
		initHistory("/ws/a.ts");
		initHistory("/ws/b.ts");
		const review = makeFakeReview();
		recordSnapshot("/ws/a.ts", review);
		recordSnapshot("/ws/b.ts", review);

		clearAllHistories();
		expect(lookupSnapshot("/ws/a.ts", review.mergedLines.join("\n"))).toBeUndefined();
		expect(lookupSnapshot("/ws/b.ts", review.mergedLines.join("\n"))).toBeUndefined();
	});

	it("isApplyingEdit guard flag", () => {
		initHistory("/ws/file.ts");
		expect(isApplyingEdit("/ws/file.ts")).toBe(false);
		setApplyingEdit("/ws/file.ts", true);
		expect(isApplyingEdit("/ws/file.ts")).toBe(true);
		setApplyingEdit("/ws/file.ts", false);
		expect(isApplyingEdit("/ws/file.ts")).toBe(false);
	});

	it("isApplyingEdit returns false for unknown file", () => {
		expect(isApplyingEdit("/ws/nope.ts")).toBe(false);
	});

	it("multiple snapshots for one file", () => {
		initHistory("/ws/file.ts");

		const review1 = makeFakeReview({ mergedLines: ["state1"] });
		recordSnapshot("/ws/file.ts", review1);

		const review2 = makeFakeReview({ mergedLines: ["state2"] });
		recordSnapshot("/ws/file.ts", review2);

		expect(lookupSnapshot("/ws/file.ts", "state1")).toBeDefined();
		expect(lookupSnapshot("/ws/file.ts", "state2")).toBeDefined();
	});

	it("recordSnapshot without initHistory is a no-op", () => {
		const review = makeFakeReview();
		recordSnapshot("/ws/file.ts", review);
		expect(lookupSnapshot("/ws/file.ts", review.mergedLines.join("\n"))).toBeUndefined();
	});
});
