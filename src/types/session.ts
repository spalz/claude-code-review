export interface SessionInfo {
	id: string;
	title: string;
	timestamp: string;
	size: number;
	messageCount: number;
	branch: string | null;
}

export interface SessionMeta {
	title: string | null;
	messageCount: number;
	branch: string | null;
}
