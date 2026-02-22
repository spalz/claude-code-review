// Undo history — content-keyed snapshots for VS Code undo/redo integration
import type { ReviewSnapshot, IFileReview } from "../types";

interface FileHistory {
	snapshots: Map<string, ReviewSnapshot>;
	applyingEdit: boolean;
}

const histories = new Map<string, FileHistory>();

// FNV-1a hash for fast content-based keys
function fnv1a(str: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = (hash * 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

export function initHistory(fsPath: string): void {
	if (!histories.has(fsPath)) {
		histories.set(fsPath, { snapshots: new Map(), applyingEdit: false });
	}
}

export function recordSnapshot(fsPath: string, review: IFileReview): void {
	const hist = histories.get(fsPath);
	if (!hist) return;

	const key = fnv1a(review.mergedLines.join("\n"));
	// Deep copy hunks and ranges to decouple from live state
	const snapshot: ReviewSnapshot = {
		filePath: review.filePath,
		originalContent: review.originalContent,
		modifiedContent: review.modifiedContent,
		changeType: review.changeType,
		hunks: JSON.parse(JSON.stringify(review.hunks)),
		mergedLines: [...review.mergedLines],
		hunkRanges: review.hunkRanges.map((r) => ({ ...r })),
	};
	hist.snapshots.set(key, snapshot);
}

export function lookupSnapshot(fsPath: string, content: string): ReviewSnapshot | undefined {
	const hist = histories.get(fsPath);
	if (!hist) return undefined;
	const key = fnv1a(content);
	return hist.snapshots.get(key);
}

export function setApplyingEdit(fsPath: string, value: boolean): void {
	const hist = histories.get(fsPath);
	if (hist) hist.applyingEdit = value;
}

export function isApplyingEdit(fsPath: string): boolean {
	return histories.get(fsPath)?.applyingEdit ?? false;
}

export function clearHistory(fsPath: string): void {
	histories.delete(fsPath);
}

export function clearAllHistories(): void {
	histories.clear();
}
