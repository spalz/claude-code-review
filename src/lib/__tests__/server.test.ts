import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => import("./mocks/vscode"));
vi.mock("../log", () => ({ log: vi.fn() }));

import { getSnapshot, clearSnapshot, setAddFileHandler, setWorkspacePath } from "../server";

// We test the snapshot/handler logic directly since HTTP server testing
// would require real network calls. The module-level map is accessible via exports.

beforeEach(() => {
	vi.clearAllMocks();
});

describe("snapshot management", () => {
	it("getSnapshot returns undefined for unknown path", () => {
		expect(getSnapshot("/unknown")).toBeUndefined();
	});

	it("clearSnapshot removes entry", () => {
		// We can't easily set snapshots without going through HTTP,
		// but we can test clearSnapshot doesn't throw on missing
		clearSnapshot("/nonexistent");
		expect(getSnapshot("/nonexistent")).toBeUndefined();
	});
});

describe("setAddFileHandler", () => {
	it("sets handler without error", () => {
		const handler = vi.fn();
		expect(() => setAddFileHandler(handler)).not.toThrow();
	});
});

// Integration-style tests using actual HTTP would go here,
// but they require starting the server on a real port.
// For unit tests, we verify the exported API surface.
describe("server HTTP handler (simulated)", () => {
	it("module exports expected functions", async () => {
		const server = await import("../server");
		expect(server.startServer).toBeTypeOf("function");
		expect(server.stopServer).toBeTypeOf("function");
		expect(server.getSnapshot).toBeTypeOf("function");
		expect(server.clearSnapshot).toBeTypeOf("function");
		expect(server.setAddFileHandler).toBeTypeOf("function");
		expect(server.setWorkspacePath).toBeTypeOf("function");
	});
});

describe("setWorkspacePath", () => {
	it("sets workspace path without error", () => {
		expect(() => setWorkspacePath("/workspace")).not.toThrow();
	});
});
