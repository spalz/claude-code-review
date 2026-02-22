// Hook manager — installs and maintains PreToolUse + PostToolUse hooks for Claude Code
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as log from "./log";
import type { HookStatus, HookStatusCallback } from "../types";

const HOOK_VERSION = "5.0";
const POST_HOOK_FILENAME = "ccr-review-hook.sh";
const PRE_HOOK_FILENAME = "ccr-pre-hook.sh";

export function getPostHookScript(): string {
	return `#!/usr/bin/env bash
# Claude Code Review — PostToolUse hook v${HOOK_VERSION}
# Managed by Claude Code Review extension. Do not edit manually.

LOG="/tmp/ccr-hook.log"
echo "[ccr-hook] $(date +%H:%M:%S) --- post hook invoked ---" >> "$LOG"

INPUT=$(cat)
echo "[ccr-hook] $(date +%H:%M:%S) raw input: $INPUT" >> "$LOG"

TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo "")
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null || echo "")

echo "[ccr-hook] $(date +%H:%M:%S) tool=$TOOL_NAME file=$FILE_PATH" >> "$LOG"

if [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]]; then
  if [[ -z "$FILE_PATH" ]]; then
    echo "[ccr-hook] $(date +%H:%M:%S) skip: empty file path" >> "$LOG"
    exit 0
  fi
  RESPONSE=$(curl -sf -w "\\n%{http_code}" -X POST -H "Content-Type: application/json" \\
    -d "{\\"file\\":\\"$FILE_PATH\\",\\"tool\\":\\"$TOOL_NAME\\"}" \\
    http://127.0.0.1:27182/changed 2>&1)
  CURL_EXIT=$?
  echo "[ccr-hook] $(date +%H:%M:%S) curl exit=$CURL_EXIT response=$RESPONSE" >> "$LOG"
elif [[ "$TOOL_NAME" == "Bash" ]]; then
  echo "[ccr-hook] $(date +%H:%M:%S) Bash tool detected, sending command" >> "$LOG"
  echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
cmd=d.get('tool_input',{}).get('command','')
print(json.dumps({'tool':'Bash','command':cmd}))
" 2>/dev/null | curl -sf -X POST -H "Content-Type: application/json" -d @- http://127.0.0.1:27182/changed >/dev/null 2>&1
else
  echo "[ccr-hook] $(date +%H:%M:%S) skip: tool is not Edit/Write/Bash" >> "$LOG"
fi

exit 0
`;
}

export function getPreHookScript(): string {
	return `#!/usr/bin/env bash
# Claude Code Review — PreToolUse hook v${HOOK_VERSION}
# Managed by Claude Code Review extension. Do not edit manually.
# Captures file content BEFORE Claude modifies it.

LOG="/tmp/ccr-hook.log"
echo "[ccr-pre-hook] $(date +%H:%M:%S) --- pre hook invoked ---" >> "$LOG"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo "")
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null || echo "")

echo "[ccr-pre-hook] $(date +%H:%M:%S) tool=$TOOL_NAME file=$FILE_PATH" >> "$LOG"

if [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]]; then
  if [[ -z "$FILE_PATH" ]]; then
    exit 0
  fi
  if [[ -f "$FILE_PATH" ]]; then
    CONTENT=$(base64 < "$FILE_PATH")
  else
    CONTENT=""
  fi
  curl -sf -X POST -H "Content-Type: application/json" \\
    -d "{\\"file\\":\\"$FILE_PATH\\",\\"content\\":\\"$CONTENT\\"}" \\
    http://127.0.0.1:27182/snapshot >/dev/null 2>&1
  echo "[ccr-pre-hook] $(date +%H:%M:%S) snapshot sent for $FILE_PATH" >> "$LOG"
elif [[ "$TOOL_NAME" == "Bash" ]]; then
  echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
cmd=d.get('tool_input',{}).get('command','')
print(json.dumps({'tool':'Bash','command':cmd}))
" 2>/dev/null | curl -sf -X POST -H "Content-Type: application/json" -d @- http://127.0.0.1:27182/snapshot >/dev/null 2>&1
  echo "[ccr-pre-hook] $(date +%H:%M:%S) Bash snapshot sent" >> "$LOG"
fi
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
	return path.join(getHooksDir(workspacePath), POST_HOOK_FILENAME);
}

export function getPreHookPath(workspacePath: string): string {
	return path.join(getHooksDir(workspacePath), PRE_HOOK_FILENAME);
}

export function isHookInstalled(workspacePath: string): boolean {
	const postHookPath = getHookPath(workspacePath);
	const preHookPath = getPreHookPath(workspacePath);

	if (!fs.existsSync(postHookPath) || !fs.existsSync(preHookPath)) {
		log.log("isHookInstalled: script file(s) missing");
		return false;
	}

	if (fs.readFileSync(postHookPath, "utf8") !== getPostHookScript()) {
		log.log("isHookInstalled: post hook content mismatch");
		return false;
	}

	if (fs.readFileSync(preHookPath, "utf8") !== getPreHookScript()) {
		log.log("isHookInstalled: pre hook content mismatch");
		return false;
	}

	const settingsPath = getClaudeSettingsPath(workspacePath);
	try {
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
			hooks?: {
				PostToolUse?: Array<{
					matcher?: string;
					hooks?: Array<{ type?: string; command?: string }>;
				}>;
				PreToolUse?: Array<{
					matcher?: string;
					hooks?: Array<{ type?: string; command?: string }>;
				}>;
			};
		};

		const hasPost = settings?.hooks?.PostToolUse?.some(
			(e) =>
				e.matcher &&
				e.hooks?.some(
					(h) => h.type === "command" && h.command?.includes(POST_HOOK_FILENAME),
				),
		);
		const hasPre = settings?.hooks?.PreToolUse?.some(
			(e) =>
				e.matcher &&
				e.hooks?.some(
					(h) => h.type === "command" && h.command?.includes(PRE_HOOK_FILENAME),
				),
		);

		if (!hasPost || !hasPre) {
			log.log("isHookInstalled: missing hook entries in settings");
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
	const postHookPath = getHookPath(workspacePath);
	const preHookPath = getPreHookPath(workspacePath);

	fs.mkdirSync(hooksDir, { recursive: true });

	fs.writeFileSync(postHookPath, getPostHookScript(), { mode: 0o755 });
	fs.writeFileSync(preHookPath, getPreHookScript(), { mode: 0o755 });
	log.log(`Hook scripts written: ${postHookPath}, ${preHookPath}`);

	registerHooksInSettings(workspacePath, postHookPath, preHookPath);
	return postHookPath;
}

function registerHooksInSettings(
	workspacePath: string,
	postHookPath: string,
	preHookPath: string,
): void {
	const settingsPath = getClaudeSettingsPath(workspacePath);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let settings: Record<string, any> = {};
	try {
		settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	} catch {}

	if (!settings.hooks) settings.hooks = {};

	// PostToolUse
	if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];
	settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(entry: any) => {
			if (entry.type === "command" && entry.command?.includes(POST_HOOK_FILENAME))
				return false;
			if (
				entry.hooks?.some((h: { command?: string }) =>
					h.command?.includes(POST_HOOK_FILENAME),
				)
			)
				return false;
			return true;
		},
	);
	settings.hooks.PostToolUse.push({
		matcher: "Edit|Write|Bash",
		hooks: [{ type: "command", command: postHookPath }],
	});

	// PreToolUse
	if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];
	settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(entry: any) => {
			if (entry.type === "command" && entry.command?.includes(PRE_HOOK_FILENAME))
				return false;
			if (
				entry.hooks?.some((h: { command?: string }) =>
					h.command?.includes(PRE_HOOK_FILENAME),
				)
			)
				return false;
			return true;
		},
	);
	settings.hooks.PreToolUse.push({
		matcher: "Edit|Write|Bash",
		hooks: [{ type: "command", command: preHookPath }],
	});

	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4), "utf8");
	log.log(`Hooks registered in ${settingsPath}`);
}

export function checkAndPrompt(
	workspacePath: string,
	onStatusChange?: HookStatusCallback,
): HookStatus {
	if (isHookInstalled(workspacePath)) {
		log.log("checkAndPrompt: hooks are up to date");
		onStatusChange?.("installed");
		return "installed";
	}

	const exists = fs.existsSync(getHookPath(workspacePath));
	const status: HookStatus = exists ? "outdated" : "missing";
	log.log(`checkAndPrompt: hooks ${status}`);
	onStatusChange?.(status);
	return status;
}

export function doInstall(workspacePath: string, onStatusChange?: HookStatusCallback): void {
	try {
		installHook(workspacePath);
		onStatusChange?.("installed");
		vscode.window.showInformationMessage(
			"Claude Code Review hooks installed. Changes by Claude Code will now be tracked automatically.",
		);
	} catch (err) {
		log.log(`doInstall error: ${(err as Error).message}`);
		vscode.window.showErrorMessage(`Failed to install hooks: ${(err as Error).message}`);
	}
}
