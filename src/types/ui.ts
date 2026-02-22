export interface ReviewFileInfo {
	path: string;
	name: string;
	external: boolean;
	active: boolean;
	done: boolean;
	unresolved: number;
	total: number;
}

export interface ReviewStateUpdate {
	remaining: number;
	total: number;
	currentFile: string | null;
	unresolvedHunks: number;
	totalHunks: number;
	files: ReviewFileInfo[];
}

export interface KeybindingInfo {
	key: string;
	desc: string;
}
