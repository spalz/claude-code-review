// Editor decorations for inline diff rendering (buttons via CodeLens)
import * as vscode from "vscode";
import type { IFileReview } from "../types";

const decoAdded = vscode.window.createTextEditorDecorationType({
	backgroundColor: "rgba(40, 167, 69, 0.15)",
	isWholeLine: true,
	overviewRulerColor: "#28a745",
	overviewRulerLane: vscode.OverviewRulerLane.Left,
	borderWidth: "0 0 0 3px",
	borderStyle: "solid",
	borderColor: "#28a745",
});

const decoRemoved = vscode.window.createTextEditorDecorationType({
	backgroundColor: "rgba(220, 53, 69, 0.15)",
	isWholeLine: true,
	overviewRulerColor: "#dc3545",
	overviewRulerLane: vscode.OverviewRulerLane.Left,
	opacity: "0.6",
	textDecoration: "line-through",
	borderWidth: "0 0 0 3px",
	borderStyle: "solid",
	borderColor: "#dc3545",
});

const decoSeparator = vscode.window.createTextEditorDecorationType({
	borderWidth: "1px 0 0 0",
	borderStyle: "dashed",
	borderColor: "rgba(128, 128, 128, 0.4)",
});

export function applyDecorations(editor: vscode.TextEditor, review: IFileReview): void {
	const rm: vscode.Range[] = [];
	const ad: vscode.Range[] = [];
	const sep: vscode.Range[] = [];

	for (const range of review.hunkRanges) {
		const hunk = review.hunks.find((h) => h.id === range.hunkId);
		if (!hunk || hunk.resolved) continue;

		const firstLine =
			range.removedStart < range.removedEnd ? range.removedStart : range.addedStart;
		if (firstLine > 0) {
			sep.push(new vscode.Range(firstLine, 0, firstLine, 0));
		}

		for (let i = range.removedStart; i < range.removedEnd; i++) {
			rm.push(new vscode.Range(i, 0, i, 10000));
		}
		for (let i = range.addedStart; i < range.addedEnd; i++) {
			ad.push(new vscode.Range(i, 0, i, 10000));
		}
	}

	editor.setDecorations(decoRemoved, rm);
	editor.setDecorations(decoAdded, ad);
	editor.setDecorations(decoSeparator, sep);
}

export function clearDecorations(editor: vscode.TextEditor): void {
	editor.setDecorations(decoRemoved, []);
	editor.setDecorations(decoAdded, []);
	editor.setDecorations(decoSeparator, []);
}
