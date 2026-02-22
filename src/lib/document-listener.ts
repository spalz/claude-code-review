// Document listener — detects undo/redo and restores review state
import * as vscode from "vscode";
import { isApplyingEdit, lookupSnapshot, clearHistory } from "./undo-history";
import * as state from "./state";
import type { ReviewSnapshot } from "../types";

export function registerDocumentListener(
	context: vscode.ExtensionContext,
	onContentRestored: (fsPath: string, snapshot: ReviewSnapshot) => void,
): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];

	disposables.push(
		vscode.workspace.onDidChangeTextDocument((e) => {
			const fsPath = e.document.uri.fsPath;

			// Skip our own edits
			if (isApplyingEdit(fsPath)) return;

			// Only care about files we're tracking or have tracked
			if (!state.activeReviews.has(fsPath)) {
				// Could be an undo after finalize — check snapshot
			}

			const content = e.document.getText();
			const snapshot = lookupSnapshot(fsPath, content);
			if (snapshot) {
				onContentRestored(fsPath, snapshot);
			}
		}),
	);

	disposables.push(
		vscode.workspace.onDidCloseTextDocument((doc) => {
			clearHistory(doc.uri.fsPath);
		}),
	);

	const combined = vscode.Disposable.from(...disposables);
	context.subscriptions.push(combined);
	return combined;
}
