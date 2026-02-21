// Output channel logger — visible in Output panel
const vscode = require("vscode");

let channel = null;

function init() {
    channel = vscode.window.createOutputChannel("Claude Code Review");
}

function log(...args) {
    const msg = args
        .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
        .join(" ");
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] ${msg}`;
    channel?.appendLine(line);
    console.log("[ccr]", ...args);
}

function show() {
    channel?.show(true);
}

module.exports = { init, log, show };
