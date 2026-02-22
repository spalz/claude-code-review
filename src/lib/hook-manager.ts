// Hook manager — installs and maintains PostToolUse hook for Claude Code
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as log from "./log";
import type { HookStatus, HookStatusCallback } from "../types";

const HOOK_VERSION = "3.1";
const HOOK_FILENAME = "ccr-review-hook.sh";

export function getHookScript(): string {
	return `#!/usr/bin/env bash
# Claude Code Review — PostToolUse hook v${HOOK_VERSION}
# Managed by Claude Code Review extension. Do not edit manually.
# Sends changed file paths to the extension bridge for automatic review.

LOG="/tmp/ccr-hook.log"
echo "[ccr-hook] $(date +%H:%M:%S) --- hook invoked ---" >> "$LOG"

INPUT=$(cat)
echo "[ccr-hook] $(date +%H:%M:%S) raw input: $INPUT" >> "$LOG"

TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo "")
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null || echo "")

echo "[ccr-hook] $(date +%H:%M:%S) tool=$TOOL_NAME file=$FILE_PATH" >> "$LOG"

if [[ "$TOOL_NAME" != "Edit" && "$TOOL_NAME" != "Write" ]]; then
  echo "[ccr-hook] $(date +%H:%M:%S) skip: tool is not Edit/Write" >> "$LOG"
  exit 0
fi
if [[ -z "$FILE_PATH" ]]; then
  echo "[ccr-hook] $(date +%H:%M:%S) skip: empty file path" >> "$LOG"
  exit 0
fi

RESPONSE=$(curl -sf -w "\\n%{http_code}" -X POST -H "Content-Type: application/json" \\
  -d "{\\"file\\":\\"$FILE_PATH\\",\\"tool\\":\\"$TOOL_NAME\\"}" \\
  http://127.0.0.1:27182/changed 2>&1)
CURL_EXIT=$?
echo "[ccr-hook] $(date +%H:%M:%S) curl exit=$CURL_EXIT response=$RESPONSE" >> "$LOG"

exit 0
`;
}

function getClaudeSettingsPath(workspacePath: string): string {
	return path.join(workspacePath, ".claude", "settings.local.json");
}

function getHooksDir(workspacePath: string): string {
	return path.join(workspacePath, ".claude", "hooks");
}

export function getHookPath(workspacePath: string): string {
	return path.join(getHooksDir(workspacePath), HOOK_FILENAME);
}

/**
 * Validate hook: check script content exactly matches + settings use new matcher format.
 */
export function isHookInstalled(workspacePath: string): boolean {
	const hookPath = getHookPath(workspacePath);

	// 1. Check file exists
	if (!fs.existsSync(hookPath)) {
		log.log("isHookInstalled: script file missing");
		return false;
	}

	// 2. Check script content matches exactly
	const actual = fs.readFileSync(hookPath, "utf8");
	const expected = getHookScript();
	if (actual !== expected) {
		log.log(
			`isHookInstalled: script content mismatch (expected ${expected.length} chars, got ${actual.length})`,
		);
		return false;
	}

	// 3. Check settings.local.json uses new matcher format
	const settingsPath = getClaudeSettingsPath(workspacePath);
	try {
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
			hooks?: {
				PostToolUse?: Array<{
					matcher?: string;
					type?: string;
					command?: string;
					hooks?: Array<{ type?: string; command?: string }>;
				}>;
			};
		};
		const entries = settings?.hooks?.PostToolUse;
		if (!Array.isArray(entries)) {
			log.log("isHookInstalled: PostToolUse is not an array");
			return false;
		}

		const hasCorrectEntry = entries.some(
			(entry) =>
				typeof entry.matcher === "string" &&
				Array.isArray(entry.hooks) &&
				entry.hooks.some(
					(h) => h.type === "command" && h.command && h.command.includes(HOOK_FILENAME),
				),
		);
		if (!hasCorrectEntry) {
			log.log("isHookInstalled: no valid matcher-format entry found in settings");
			return false;
		}
	} catch (err) {
		log.log(`isHookInstalled: settings read error: ${(err as Error).message}`);
		return false;
	}

	return true;
}

export function installHook(workspacePath: string): string {
	const hooksDir = getHooksDir(workspacePath);
	const hookPath = getHookPath(workspacePath);

	// Create .claude/hooks/ if needed
	fs.mkdirSync(hooksDir, { recursive: true });

	// Write hook script
	fs.writeFileSync(hookPath, getHookScript(), { mode: 0o755 });
	log.log(`Hook script written: ${hookPath}`);

	// Register in .claude/settings.local.json (new matcher format)
	registerHookInSettings(workspacePath, hookPath);

	return hookPath;
}

function registerHookInSettings(workspacePath: string, hookPath: string): void {
	const settingsPath = getClaudeSettingsPath(workspacePath);
	let settings: {
		hooks?: {
			PostToolUse?: Array<{
				matcher?: string;
				type?: string;
				command?: string;
				hooks?: Array<{ type: string; command: string }>;
			}>;
		};
	} = {};
	try {
		settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as typeof settings;
	} catch {}

	if (!settings.hooks) settings.hooks = {};
	if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];

	// Remove old-format entries (type+command at top level, no matcher)
	// Remove existing matcher entries for our hook (will re-add)
	settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter((entry) => {
		// Old format: { type: "command", command: "...ccr-review-hook.sh" }
		if (entry.type === "command" && entry.command && entry.command.includes(HOOK_FILENAME)) {
			log.log("registerHook: removing old-format entry");
			return false;
		}
		// New format with our hook
		if (
			entry.matcher &&
			Array.isArray(entry.hooks) &&
			entry.hooks.some((h) => h.command && h.command.includes(HOOK_FILENAME))
		) {
			log.log("registerHook: removing existing matcher entry (will re-add)");
			return false;
		}
		return true;
	});

	// Add new matcher-format entry
	settings.hooks.PostToolUse.push({
		matcher: "Edit|Write",
		hooks: [
			{
				type: "command",
				command: hookPath,
			},
		],
	});

	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4), "utf8");
	log.log(`Hook registered in ${settingsPath} (matcher format)`);
}

/**
 * Check hook status and notify via callback.
 * Returns "installed" | "missing" | "outdated"
 */
export function checkAndPrompt(
	workspacePath: string,
	onStatusChange?: HookStatusCallback,
): HookStatus {
	if (isHookInstalled(workspacePath)) {
		log.log("checkAndPrompt: hook is up to date");
		onStatusChange?.("installed");
		return "installed";
	}

	const exists = fs.existsSync(getHookPath(workspacePath));
	const status: HookStatus = exists ? "outdated" : "missing";
	log.log(`checkAndPrompt: hook ${status}`);

	onStatusChange?.(status);
	return status;
}

export function doInstall(workspacePath: string, onStatusChange?: HookStatusCallback): void {
	try {
		installHook(workspacePath);
		onStatusChange?.("installed");
		vscode.window.showInformationMessage(
			"Claude Code Review hook installed. Changes by Claude Code will now be tracked automatically.",
		);
	} catch (err) {
		log.log(`doInstall error: ${(err as Error).message}`);
		vscode.window.showErrorMessage(`Failed to install hook: ${(err as Error).message}`);
	}
}
