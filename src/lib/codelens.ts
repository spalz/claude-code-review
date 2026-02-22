// CodeLens provider for per-hunk Keep/Undo buttons
import * as vscode from "vscode";
import * as state from "./state";

export class ReviewCodeLensProvider implements vscode.CodeLensProvider {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChange.event;

	refresh(): void {
		this._onDidChange.fire();
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const review = state.activeReviews.get(document.uri.fsPath);
		if (!review) return [];

		const lenses: vscode.CodeLens[] = [];
		for (const range of review.hunkRanges) {
			const hunk = review.hunks.find((h) => h.id === range.hunkId);
			if (!hunk || hunk.resolved) continue;

			const line =
				range.removedStart < range.removedEnd ? range.removedStart : range.addedStart;
			const pos = new vscode.Range(line, 0, line, 0);

			lenses.push(
				new vscode.CodeLens(pos, {
					title: "✓ Accept Change",
					tooltip: "Accept this change (keep modified code)",
					command: "ccr.acceptHunk",
					arguments: [document.uri.fsPath, hunk.id],
				}),
			);
			lenses.push(
				new vscode.CodeLens(pos, {
					title: "✗ Reject Change",
					tooltip: "Reject this change (revert to original)",
					command: "ccr.rejectHunk",
					arguments: [document.uri.fsPath, hunk.id],
				}),
			);
		}
		return lenses;
	}
}
