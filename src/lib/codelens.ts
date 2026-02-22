// CodeLens provider — "Review next file ›" after hunks
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
		let lastHunkLine = 0;

		for (const range of review.hunkRanges) {
			const hunk = review.hunks.find((h) => h.id === range.hunkId);
			if (!hunk || hunk.resolved) continue;

			lastHunkLine = Math.max(
				lastHunkLine,
				range.addedEnd > 0 ? range.addedEnd - 1 : range.removedEnd - 1,
			);
		}

		// "Review next file ›" after last hunk if more files remain
		const remaining = state.getReviewFiles().filter((f) => state.activeReviews.has(f));
		if (remaining.length > 1 && lastHunkLine > 0) {
			const nextLine = Math.min(lastHunkLine + 1, document.lineCount - 1);
			lenses.push(
				new vscode.CodeLens(new vscode.Range(nextLine, 0, nextLine, 0), {
					title: `Review next file › (${remaining.length - 1} remaining)`,
					tooltip: "Open the next file with unresolved changes",
					command: "ccr.reviewNextUnresolved",
				}),
			);
		}

		return lenses;
	}
}
