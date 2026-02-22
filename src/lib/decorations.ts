// Editor decorations for inline diff rendering + action buttons
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

// Button decoration types — Undo and Keep as right-aligned inline buttons
const decoUndoBtn = vscode.window.createTextEditorDecorationType({});
const decoKeepBtn = vscode.window.createTextEditorDecorationType({});

// Hunk counter decoration type — created per-apply since contentText varies
let hunkCounterType: vscode.TextEditorDecorationType | null = null;

export function applyDecorations(editor: vscode.TextEditor, review: IFileReview): void {
	const rm: vscode.Range[] = [];
	const ad: vscode.Range[] = [];
	const sep: vscode.Range[] = [];
	const undoDecos: vscode.DecorationOptions[] = [];
	const keepDecos: vscode.DecorationOptions[] = [];
	const hunkCounterDecos: vscode.DecorationOptions[] = [];

	// Dispose old hunk counter type to avoid stale decorations
	if (hunkCounterType) {
		hunkCounterType.dispose();
		hunkCounterType = null;
	}

	const unresolvedRanges = review.hunkRanges.filter((range) => {
		const hunk = review.hunks.find((h) => h.id === range.hunkId);
		return hunk && !hunk.resolved;
	});

	let hunkIdx = 0;
	for (const range of review.hunkRanges) {
		const hunk = review.hunks.find((h) => h.id === range.hunkId);
		if (!hunk || hunk.resolved) continue;
		hunkIdx++;

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

		// Button line: first added line, or first removed if no added
		const buttonLine =
			range.addedStart < range.addedEnd ? range.addedStart : range.removedStart;

		// Undo button (right-aligned, gray/red)
		undoDecos.push({
			range: new vscode.Range(buttonLine, 10000, buttonLine, 10000),
			renderOptions: {
				after: {
					contentText: " Undo ⌘N ",
					color: "#ffffff",
					backgroundColor: "#6e4040",
					margin: "0 0 0 3em",
					textDecoration: "none; border-radius: 3px; padding: 1px 6px; font-size: 0.85em",
				},
			},
		});

		// Keep button (right-aligned, blue)
		keepDecos.push({
			range: new vscode.Range(buttonLine, 10000, buttonLine, 10000),
			renderOptions: {
				after: {
					contentText: " Keep ⌘Y ",
					color: "#ffffff",
					backgroundColor: "#007acc",
					margin: "0 0 0 0.5em",
					textDecoration: "none; border-radius: 3px; padding: 1px 6px; font-size: 0.85em",
				},
			},
		});

		// Hunk counter on first line (if multiple hunks)
		if (unresolvedRanges.length > 1) {
			hunkCounterDecos.push({
				range: new vscode.Range(firstLine, 10000, firstLine, 10000),
				renderOptions: {
					after: {
						contentText: `  Change ${hunkIdx}/${unresolvedRanges.length}`,
						color: "rgba(128, 128, 128, 0.7)",
						fontStyle: "italic",
						margin: "0 0 0 1em",
					},
				},
			});
		}
	}

	editor.setDecorations(decoRemoved, rm);
	editor.setDecorations(decoAdded, ad);
	editor.setDecorations(decoSeparator, sep);
	editor.setDecorations(decoUndoBtn, undoDecos);
	editor.setDecorations(decoKeepBtn, keepDecos);

	// Apply hunk counter decorations
	if (hunkCounterDecos.length > 0) {
		hunkCounterType = vscode.window.createTextEditorDecorationType({});
		editor.setDecorations(hunkCounterType, hunkCounterDecos);
	}
}

export function clearDecorations(editor: vscode.TextEditor): void {
	editor.setDecorations(decoRemoved, []);
	editor.setDecorations(decoAdded, []);
	editor.setDecorations(decoSeparator, []);
	editor.setDecorations(decoUndoBtn, []);
	editor.setDecorations(decoKeepBtn, []);
	if (hunkCounterType) {
		editor.setDecorations(hunkCounterType, []);
		hunkCounterType.dispose();
		hunkCounterType = null;
	}
}
