export interface Hunk {
	id: number;
	origStart: number;
	origCount: number;
	modStart: number;
	modCount: number;
	removed: string[];
	added: string[];
	resolved: boolean;
	accepted: boolean;
}

export interface HunkRange {
	hunkId: number;
	removedStart: number;
	removedEnd: number;
	addedStart: number;
	addedEnd: number;
}

export interface MergedResult {
	lines: string[];
	ranges: HunkRange[];
}

export interface IFileReview {
	filePath: string;
	originalContent: string;
	modifiedContent: string;
	hunks: Hunk[];
	mergedLines: string[];
	hunkRanges: HunkRange[];
	readonly unresolvedCount: number;
	readonly isFullyResolved: boolean;
}
