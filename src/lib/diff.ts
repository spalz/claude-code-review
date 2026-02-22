// Diff computation and unified diff parsing
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { Hunk } from "../types";

export function computeDiff(
	originalContent: string,
	modifiedContent: string,
	filePath: string,
	workspacePath: string,
): Hunk[] {
	const relPath = path.relative(workspacePath, filePath);
	let diffOutput = "";

	try {
		execSync(`git ls-files --error-unmatch "${relPath}"`, {
			cwd: workspacePath,
			encoding: "utf8",
			timeout: 3000,
			stdio: "pipe",
		});
		diffOutput = execSync(`git diff HEAD -- "${relPath}"`, {
			cwd: workspacePath,
			encoding: "utf8",
			timeout: 5000,
			stdio: "pipe",
		});
	} catch {
		if (!originalContent && modifiedContent) {
			const lines = modifiedContent.split("\n");
			return [
				{
					id: 0,
					origStart: 1,
					origCount: 0,
					modStart: 1,
					modCount: lines.length,
					removed: [],
					added: lines,
					resolved: false,
					accepted: false,
				},
			];
		}
		diffOutput = diffTempFiles(originalContent, modifiedContent);
	}

	if (!diffOutput) return [];
	return parseUnifiedDiff(diffOutput);
}

function diffTempFiles(original: string, modified: string): string {
	const tmpOrig = path.join(os.tmpdir(), `dp-orig-${Date.now()}`);
	const tmpMod = path.join(os.tmpdir(), `dp-mod-${Date.now()}`);
	try {
		fs.writeFileSync(tmpOrig, original, "utf8");
		fs.writeFileSync(tmpMod, modified, "utf8");
		try {
			return execSync(`git diff --no-index -- "${tmpOrig}" "${tmpMod}"`, {
				encoding: "utf8",
				timeout: 5000,
				stdio: "pipe",
			});
		} catch (e) {
			return (e as { stdout?: string })?.stdout ?? "";
		}
	} catch {
		return "";
	} finally {
		try {
			fs.unlinkSync(tmpOrig);
		} catch {}
		try {
			fs.unlinkSync(tmpMod);
		} catch {}
	}
}

export function parseUnifiedDiff(diffText: string): Hunk[] {
	const hunks: Hunk[] = [];
	const lines = diffText.split("\n");
	let i = 0;
	let hunkId = 0;

	while (i < lines.length && !lines[i].startsWith("@@")) i++;

	while (i < lines.length) {
		if (!lines[i].startsWith("@@")) {
			i++;
			continue;
		}
		const m = lines[i].match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
		if (!m) {
			i++;
			continue;
		}

		const origStart = parseInt(m[1]);
		const modStart = parseInt(m[3]);
		i++;

		let removed: string[] = [];
		let added: string[] = [];
		let hadContext = false;

		while (i < lines.length && !lines[i].startsWith("@@")) {
			const line = lines[i];
			if (line.startsWith("-")) {
				if (hadContext && (removed.length || added.length)) {
					hunks.push(makeHunk(hunkId++, origStart, modStart, removed, added));
					removed = [];
					added = [];
					hadContext = false;
				}
				removed.push(line.slice(1));
				hadContext = false;
			} else if (line.startsWith("+")) {
				added.push(line.slice(1));
				hadContext = false;
			} else if (line.startsWith(" ") || line === "") {
				if (removed.length || added.length) hadContext = true;
			}
			i++;
		}

		if (removed.length || added.length) {
			hunks.push(makeHunk(hunkId++, origStart, modStart, removed, added));
		}
	}

	return hunks;
}

function makeHunk(
	id: number,
	origStart: number,
	modStart: number,
	removed: string[],
	added: string[],
): Hunk {
	return {
		id,
		origStart,
		origCount: removed.length,
		modStart,
		modCount: added.length,
		removed: [...removed],
		added: [...added],
		resolved: false,
		accepted: false,
	};
}
