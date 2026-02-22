import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFs = vi.hoisted(() => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

vi.mock("fs", () => mockFs);
vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn() }));

import {
	getPostHookScript,
	getPreHookScript,
	installHook,
	isHookInstalled,
	checkAndPrompt,
} from "../hook-manager";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("hook scripts", () => {
	it("getPostHookScript contains HOOK_VERSION 5.0", () => {
		expect(getPostHookScript()).toContain("v5.0");
	});

	it("getPostHookScript contains curl to /changed", () => {
		expect(getPostHookScript()).toContain("27182/changed");
	});

	it("getPreHookScript contains curl to /snapshot", () => {
		expect(getPreHookScript()).toContain("27182/snapshot");
	});

	it("getPreHookScript contains base64 encoding", () => {
		expect(getPreHookScript()).toMatch(/base64 < "\$FILE_PATH"/);
	});

	it("both scripts filter by Edit|Write", () => {
		expect(getPostHookScript()).toContain("Edit");
		expect(getPostHookScript()).toContain("Write");
		expect(getPreHookScript()).toContain("Edit");
		expect(getPreHookScript()).toContain("Write");
	});

	it("postHookScript contains Bash branch", () => {
		expect(getPostHookScript()).toContain('"Bash"');
	});

	it("preHookScript contains Bash branch", () => {
		expect(getPreHookScript()).toContain('"Bash"');
	});

	it("postHookScript Bash branch sends command in JSON", () => {
		const script = getPostHookScript();
		expect(script).toContain("'tool':'Bash'");
		expect(script).toContain("'command':cmd");
	});

	it("preHookScript Bash branch sends to /snapshot", () => {
		const script = getPreHookScript();
		expect(script).toContain("27182/snapshot");
		expect(script).toContain("'tool':'Bash'");
	});
});

describe("installHook", () => {
	it("creates hooks directory and writes scripts", () => {
		// Mock readFileSync for settings (registerHooksInSettings reads existing)
		mockFs.readFileSync.mockReturnValue("{}");
		installHook("/ws");
		expect(mockFs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining("hooks"), { recursive: true });
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			expect.stringContaining("ccr-review-hook.sh"),
			expect.stringContaining("PostToolUse"),
			{ mode: 0o755 },
		);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			expect.stringContaining("ccr-pre-hook.sh"),
			expect.stringContaining("PreToolUse"),
			{ mode: 0o755 },
		);
	});

	it("registers hooks in settings.local.json", () => {
		mockFs.readFileSync.mockReturnValue("{}");
		installHook("/ws");
		// Last writeFileSync call should be settings
		const settingsCall = mockFs.writeFileSync.mock.calls.find(
			(c) => typeof c[0] === "string" && c[0].includes("settings.local.json"),
		);
		expect(settingsCall).toBeDefined();
		const settings = JSON.parse(settingsCall![1] as string);
		expect(settings.hooks.PostToolUse).toHaveLength(1);
		expect(settings.hooks.PreToolUse).toHaveLength(1);
	});

	it("uses Edit|Write|Bash matcher in settings", () => {
		mockFs.readFileSync.mockReturnValue("{}");
		installHook("/ws");
		const settingsCall = mockFs.writeFileSync.mock.calls.find(
			(c) => typeof c[0] === "string" && c[0].includes("settings.local.json"),
		);
		const settings = JSON.parse(settingsCall![1] as string);
		expect(settings.hooks.PostToolUse[0].matcher).toBe("Edit|Write|Bash");
		expect(settings.hooks.PreToolUse[0].matcher).toBe("Edit|Write|Bash");
	});
});

describe("isHookInstalled", () => {
	function setupInstalled() {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockImplementation((p: string) => {
			if (p.includes("ccr-review-hook.sh")) return getPostHookScript();
			if (p.includes("ccr-pre-hook.sh")) return getPreHookScript();
			if (p.includes("settings.local.json"))
				return JSON.stringify({
					hooks: {
						PostToolUse: [{ matcher: "Edit|Write|Bash", hooks: [{ type: "command", command: "ccr-review-hook.sh" }] }],
						PreToolUse: [{ matcher: "Edit|Write|Bash", hooks: [{ type: "command", command: "ccr-pre-hook.sh" }] }],
					},
				});
			return "";
		});
	}

	it("returns true when all files and settings correct", () => {
		setupInstalled();
		expect(isHookInstalled("/ws")).toBe(true);
	});

	it("returns false when post hook file missing", () => {
		mockFs.existsSync.mockImplementation((p: string) => !p.includes("ccr-review-hook"));
		expect(isHookInstalled("/ws")).toBe(false);
	});

	it("returns false when pre hook file missing", () => {
		mockFs.existsSync.mockImplementation((p: string) => !p.includes("ccr-pre-hook"));
		expect(isHookInstalled("/ws")).toBe(false);
	});

	it("returns false when content mismatch", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue("wrong content");
		expect(isHookInstalled("/ws")).toBe(false);
	});

	it("returns false when settings missing hook entries", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockImplementation((p: string) => {
			if (p.includes("ccr-review-hook.sh")) return getPostHookScript();
			if (p.includes("ccr-pre-hook.sh")) return getPreHookScript();
			return JSON.stringify({ hooks: {} });
		});
		expect(isHookInstalled("/ws")).toBe(false);
	});
});

describe("checkAndPrompt", () => {
	it("returns 'installed' for correct hooks", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockImplementation((p: string) => {
			if (p.includes("ccr-review-hook.sh")) return getPostHookScript();
			if (p.includes("ccr-pre-hook.sh")) return getPreHookScript();
			return JSON.stringify({
				hooks: {
					PostToolUse: [{ matcher: "Edit|Write|Bash", hooks: [{ type: "command", command: "ccr-review-hook.sh" }] }],
					PreToolUse: [{ matcher: "Edit|Write|Bash", hooks: [{ type: "command", command: "ccr-pre-hook.sh" }] }],
				},
			});
		});
		const cb = vi.fn();
		expect(checkAndPrompt("/ws", cb)).toBe("installed");
		expect(cb).toHaveBeenCalledWith("installed");
	});

	it("returns 'missing' when hooks don't exist", () => {
		mockFs.existsSync.mockReturnValue(false);
		mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		const cb = vi.fn();
		expect(checkAndPrompt("/ws", cb)).toBe("missing");
		expect(cb).toHaveBeenCalledWith("missing");
	});

	it("returns 'outdated' when hook files exist but are not current", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue("old content");
		const cb = vi.fn();
		expect(checkAndPrompt("/ws", cb)).toBe("outdated");
		expect(cb).toHaveBeenCalledWith("outdated");
	});
});
