// PTY session manager — spawns and manages pty processes via node-pty
const vscode = require("vscode");
const path = require("path");
const log = require("./log");

let nodePty = null;

function loadNodePty() {
    if (nodePty) return nodePty;

    const appRoot = vscode.env.appRoot;
    const candidates = [
        path.join(appRoot, "node_modules.asar", "node-pty"),
        path.join(appRoot, "node_modules", "node-pty"),
    ];

    for (const p of candidates) {
        try {
            nodePty = require(p);
            console.log("[ccr] node-pty loaded from:", p);
            return nodePty;
        } catch {}
    }
    throw new Error("node-pty not found in VS Code / Cursor internals");
}

class PtySession {
    constructor(id, name, workspacePath, onData, onExit, command) {
        this.id = id;
        this.name = name;

        const pty = loadNodePty();
        const shell =
            process.platform === "win32"
                ? "powershell.exe"
                : process.env.SHELL || "/bin/bash";

        const cmd = command || "claude";
        log.log(`PTY #${id} spawning: shell=${shell}, cmd=${cmd}, cwd=${workspacePath}`);

        this.process = pty.spawn(shell, ["-l", "-c", `exec ${cmd}`], {
            name: "xterm-256color",
            cols: 80,
            rows: 24,
            cwd: workspacePath,
            env: { ...process.env },
        });

        this.process.onData((data) => onData(this.id, data));
        this.process.onExit(({ exitCode }) => {
            log.log(`PTY #${id} exited with code ${exitCode}`);
            onExit(this.id, exitCode);
        });
    }

    write(data) {
        this.process.write(data);
    }

    resize(cols, rows) {
        try {
            this.process.resize(cols, rows);
        } catch {}
    }

    kill() {
        try {
            this.process.kill();
        } catch {}
    }
}

class PtyManager {
    constructor(workspacePath) {
        this._wp = workspacePath;
        this._sessions = new Map();
        this._counter = 0;
        this._onData = null;
        this._onExit = null;
    }

    setHandlers(onData, onExit) {
        this._onData = onData;
        this._onExit = onExit;
    }

    createSession(name, command) {
        const id = ++this._counter;
        const label = name || `Session ${id}`;
        log.log(`Creating session #${id}: name=${label}, command=${command || "claude"}`);

        const session = new PtySession(
            id,
            label,
            this._wp,
            (sid, data) => this._onData?.(sid, data),
            (sid, code) => {
                this._sessions.delete(sid);
                this._onExit?.(sid, code);
            },
            command,
        );

        this._sessions.set(id, session);
        return { id, name: label };
    }

    writeToSession(id, data) {
        this._sessions.get(id)?.write(data);
    }

    resizeSession(id, cols, rows) {
        this._sessions.get(id)?.resize(cols, rows);
    }

    closeSession(id) {
        log.log(`Closing session #${id}`);
        const s = this._sessions.get(id);
        if (s) {
            s.kill();
            this._sessions.delete(id);
        }
    }

    getSessions() {
        return [...this._sessions.values()].map((s) => ({
            id: s.id,
            name: s.name,
        }));
    }

    dispose() {
        for (const s of this._sessions.values()) s.kill();
        this._sessions.clear();
    }
}

module.exports = { PtyManager };
