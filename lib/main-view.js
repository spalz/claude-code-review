// Main WebviewViewProvider — secondary sidebar with Claude CLI sessions
const vscode = require("vscode");
const path = require("path");
const state = require("./state");
const log = require("./log");
const {
  listSessions,
  renameSession,
  markSessionInvalid,
} = require("./sessions");

class MainViewProvider {
  constructor(workspacePath, extensionUri, ptyManager, workspaceState) {
    this._wp = workspacePath;
    this._extensionUri = extensionUri;
    this._ptyManager = ptyManager;
    this._state = workspaceState;
    this._view = null;
    this._webviewReady = false;
    this._pendingHookStatus = null;
    // Map PTY session ID → Claude session UUID (for persistence)
    this._ptyToClaudeId = new Map();
  }

  resolveWebviewView(webviewView) {
    log.log("webview resolved");
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this._extensionUri,
        vscode.Uri.file(vscode.env.appRoot),
      ],
    };

    const webview = webviewView.webview;
    webviewView.webview.html = this._buildHtml(webview);

    webviewView.webview.onDidReceiveMessage((msg) => this._handleMessage(msg));
  }

  refreshClaudeSessions() {
    const sessions = listSessions(this._wp, 30);
    log.log(`refreshClaudeSessions: found ${sessions.length} sessions`);
    this._postMessage({ type: "sessions-list", sessions });
    this._sendOpenSessionIds();
  }

  startNewClaudeSession(resumeId) {
    const cli = vscode.workspace
      .getConfiguration("claudeCodeReview")
      .get("cliCommand", "claude");
    const cmd = resumeId ? `${cli} --resume ${resumeId}` : cli;
    log.log(
      `startNewClaudeSession: resumeId=${resumeId || "none"}, cmd=${cmd}`,
    );
    const info = this._ptyManager.createSession(
      resumeId ? `resume:${resumeId.slice(0, 8)}` : "new",
      cmd,
    );
    // Track PTY → Claude session mapping
    if (resumeId) {
      this._ptyToClaudeId.set(info.id, resumeId);
    }
    this._persistOpenSessions();
    this._postMessage({
      type: "terminal-session-created",
      sessionId: info.id,
      name: info.name,
      claudeId: resumeId || null,
    });
    this._sendOpenSessionIds();
    state.refreshAll();
  }

  _findPtyByClaudeId(claudeId) {
    for (const [ptyId, cId] of this._ptyToClaudeId) {
      if (cId === claudeId) return ptyId;
    }
    return null;
  }

  _sendOpenSessionIds() {
    const openClaudeIds = [...this._ptyToClaudeId.values()];
    log.log(
      `sendOpenSessionIds: [${openClaudeIds.map((id) => id.slice(0, 8)).join(", ")}]`,
    );
    this._postMessage({ type: "open-sessions-update", openClaudeIds });
  }

  removeOpenSession(ptySessionId) {
    log.log(
      `removeOpenSession: pty=${ptySessionId}, claude=${this._ptyToClaudeId.get(ptySessionId) || "?"}`,
    );
    this._ptyToClaudeId.delete(ptySessionId);
    this._persistOpenSessions();
  }

  _persistOpenSessions() {
    const ids = [...this._ptyToClaudeId.values()];
    log.log(`persistOpenSessions: ${ids.length} sessions saved`);
    this._state?.update("ccr.openSessions", ids);
  }

  _persistActiveSession(claudeId) {
    log.log(`persistActiveSession: ${claudeId || "none"}`);
    this._state?.update("ccr.activeSession", claudeId || null);
  }

  _restoreSessions() {
    const ids = this._state?.get("ccr.openSessions") || [];
    const activeClaudeId = this._state?.get("ccr.activeSession") || null;
    log.log(
      `restoreSessions: ${ids.length} sessions to restore: [${ids.join(", ")}], active=${activeClaudeId || "none"}`,
    );
    for (const claudeId of ids) {
      this.startNewClaudeSession(claudeId);
    }
    // Activate the previously active session after all are restored
    if (activeClaudeId) {
      const ptyId = this._findPtyByClaudeId(activeClaudeId);
      if (ptyId !== null) {
        log.log(`restoreSessions: activating saved active session pty #${ptyId}`);
        this._postMessage({ type: "activate-terminal", sessionId: ptyId });
      }
    }
  }

  _handleMessage(msg) {
    log.log(`webview msg: ${msg.type}`);
    switch (msg.type) {
      case "webview-ready":
        log.log("webview ready, sending sessions list + restoring");
        this._webviewReady = true;
        this.refreshClaudeSessions();
        this._restoreSessions();
        // Send current CLI setting + keybindings
        this._postMessage({
          type: "settings-init",
          cliCommand: vscode.workspace
            .getConfiguration("claudeCodeReview")
            .get("cliCommand", "claude"),
          keybindings: this._getKeybindings(),
        });
        // Send pending hook status
        if (this._pendingHookStatus) {
          log.log(`sending pending hook status: ${this._pendingHookStatus}`);
          this._postMessage({
            type: "hook-status",
            status: this._pendingHookStatus,
          });
          this._pendingHookStatus = null;
        }
        break;
      // Claude sessions
      case "new-claude-session":
        this.startNewClaudeSession();
        break;
      case "resume-claude-session": {
        // If already open, switch to it instead of creating new
        const existingPtyId = this._findPtyByClaudeId(msg.claudeSessionId);
        if (existingPtyId !== null) {
          log.log(
            `resume: session ${msg.claudeSessionId.slice(0, 8)} already open as pty #${existingPtyId}, activating`,
          );
          this._postMessage({
            type: "activate-terminal",
            sessionId: existingPtyId,
          });
        } else {
          log.log(`resume: opening session ${msg.claudeSessionId.slice(0, 8)}`);
          this.startNewClaudeSession(msg.claudeSessionId);
        }
        break;
      }
      case "refresh-sessions":
        this.refreshClaudeSessions();
        break;
      case "rename-session":
        log.log(`rename: ${msg.sessionId.slice(0, 8)} → "${msg.newName}"`);
        renameSession(this._wp, msg.sessionId, msg.newName);
        this.refreshClaudeSessions();
        break;
      case "hide-session":
        log.log(`hide: ${msg.sessionId.slice(0, 8)}`);
        markSessionInvalid(this._wp, msg.sessionId);
        this.refreshClaudeSessions();
        break;
      // Terminal I/O
      case "terminal-input":
        this._ptyManager.writeToSession(msg.sessionId, msg.data);
        break;
      case "terminal-resize":
        this._ptyManager.resizeSession(msg.sessionId, msg.cols, msg.rows);
        break;
      case "close-terminal":
        log.log(`close-terminal: pty #${msg.sessionId}`);
        this._ptyManager.closeSession(msg.sessionId);
        this._ptyToClaudeId.delete(msg.sessionId);
        this._persistOpenSessions();
        this._postMessage({
          type: "terminal-session-closed",
          sessionId: msg.sessionId,
        });
        this._sendOpenSessionIds();
        state.refreshAll();
        break;
      case "close-session-by-claude-id": {
        const ptyId = this._findPtyByClaudeId(msg.claudeSessionId);
        if (ptyId !== null) {
          this._ptyManager.closeSession(ptyId);
          this._ptyToClaudeId.delete(ptyId);
          this._persistOpenSessions();
          this._postMessage({
            type: "terminal-session-closed",
            sessionId: ptyId,
          });
          this._sendOpenSessionIds();
          state.refreshAll();
        }
        break;
      }
      // File dropped from Explorer
      case "file-dropped": {
        const uri = msg.uri.trim().split("\n")[0];
        log.log(`file-dropped: session #${msg.sessionId}, uri=${uri}`);
        try {
          const fileUri = vscode.Uri.parse(uri);
          const relativePath = vscode.workspace.asRelativePath(fileUri);
          log.log(`file-dropped: resolved to ${relativePath}`);
          this._ptyManager.writeToSession(msg.sessionId, relativePath);
        } catch (err) {
          log.log(`file-dropped: error — ${err.message}`);
        }
        break;
      }
      // Review
      case "start-review":
        vscode.commands.executeCommand("ccr.openReview");
        break;
      case "accept-file":
        this._reviewAction("resolveAllHunks", msg.filePath, true);
        break;
      case "reject-file":
        this._reviewAction("resolveAllHunks", msg.filePath, false);
        break;
      case "go-to-file":
        this._reviewAction("openFileForReview", msg.filePath);
        break;
      case "prev-file":
        this._reviewAction("navigateFile", -1);
        break;
      case "next-file":
        this._reviewAction("navigateFile", 1);
        break;
      case "accept-all":
        vscode.commands.executeCommand("ccr.acceptAll");
        break;
      case "reject-all":
        vscode.commands.executeCommand("ccr.rejectAll");
        break;
      // Stats actions
      case "open-terminal":
        vscode.commands.executeCommand(
          "workbench.action.terminal.toggleTerminal",
        );
        break;
      case "git-status":
        vscode.commands
          .executeCommand("workbench.action.terminal.new")
          .then(() => {
            setTimeout(() => {
              const t = vscode.window.activeTerminal;
              if (t) t.sendText("git status");
            }, 200);
          });
        break;
      case "paste-image": {
        const os = require("os");
        const fs = require("fs");
        const imgPath = require("path");
        const ext =
          msg.mimeType === "image/png"
            ? ".png"
            : msg.mimeType === "image/jpeg"
              ? ".jpg"
              : ".png";
        const tmpFile = imgPath.join(
          os.tmpdir(),
          `ccr-paste-${Date.now()}${ext}`,
        );
        try {
          fs.writeFileSync(tmpFile, Buffer.from(msg.data, "base64"));
          log.log(`paste-image: saved to ${tmpFile}`);
          this._ptyManager.writeToSession(msg.sessionId, tmpFile);
        } catch (err) {
          log.log(`paste-image error: ${err.message}`);
        }
        break;
      }
      case "install-hook":
        vscode.commands.executeCommand("ccr.installHook");
        break;
      case "open-keybindings":
        log.log("open-keybindings: opening VS Code keyboard shortcuts");
        vscode.commands.executeCommand(
          "workbench.action.openGlobalKeybindings",
          "Claude Code Review",
        );
        break;
      case "set-active-session": {
        const claudeId = msg.claudeId || null;
        this._persistActiveSession(claudeId);
        break;
      }
      case "set-cli-command":
        log.log(`set-cli-command: ${msg.value}`);
        vscode.workspace
          .getConfiguration("claudeCodeReview")
          .update("cliCommand", msg.value, true);
        break;
    }
  }

  async _reviewAction(method, ...args) {
    const actions = require("./actions");
    if (method === "resolveAllHunks") {
      await actions.resolveAllHunks(args[0], args[1]);
    } else if (method === "openFileForReview") {
      await actions.openFileForReview(args[0]);
    } else if (method === "navigateFile") {
      await actions.navigateFile(args[0]);
    }
  }

  _getKeybindings() {
    const isMac = process.platform === "darwin";
    const ext = vscode.extensions.getExtension("local.claude-code-review");
    const bindings = ext?.packageJSON?.contributes?.keybindings || [];
    const descriptions = {
      "ccr.togglePanel": "Toggle panel",
      "ccr.sendSelection": "Send selection to active session",
    };
    log.log(
      `_getKeybindings: found ${bindings.length} bindings, isMac=${isMac}`,
    );
    return bindings.map((b) => ({
      key: this._formatKey(isMac ? b.mac || b.key : b.key),
      desc: descriptions[b.command] || b.command,
    }));
  }

  _formatKey(keyStr) {
    const isMac = process.platform === "darwin";
    const parts = keyStr.toLowerCase().split("+");
    const modMap = isMac
      ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", meta: "⌘" }
      : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Win", meta: "Win" };
    const mods = [];
    let main = "";
    for (const p of parts) {
      if (modMap[p]) mods.push(modMap[p]);
      else main = p.toUpperCase();
    }
    return isMac ? mods.join("") + main : [...mods, main].join("+");
  }

  sendHookStatus(status) {
    log.log(`sendHookStatus: ${status}, webviewReady=${this._webviewReady}`);
    if (this._webviewReady) {
      this._postMessage({ type: "hook-status", status });
    } else {
      this._pendingHookStatus = status;
    }
  }

  sendSelectionToTerminal(text) {
    this._postMessage({ type: "insert-text", text });
  }

  sendTerminalOutput(sessionId, data) {
    // Detect "No conversation found" error from Claude CLI
    const plain = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    if (plain.includes("No conversation found")) {
      log.log(
        `Terminal error detected: session=${sessionId}, "No conversation found"`,
      );
      const claudeId = this._ptyToClaudeId.get(sessionId);
      if (claudeId) markSessionInvalid(this._wp, claudeId);
      this._postMessage({
        type: "terminal-error",
        sessionId,
        error: "session-not-found",
      });
    }
    this._postMessage({ type: "terminal-output", sessionId, data });
  }

  sendTerminalExit(sessionId, code) {
    this._postMessage({ type: "terminal-exit", sessionId, exitCode: code });
  }

  update() {
    this._sendStateUpdate();
  }

  _sendStateUpdate() {
    const files = state.getReviewFiles();
    const idx = state.getCurrentFileIndex();
    const remaining = files.filter((f) => state.activeReviews.has(f)).length;
    const currentFile = files[idx];
    const review = currentFile ? state.activeReviews.get(currentFile) : null;

    const fileList = files.map((f, i) => {
      const r = state.activeReviews.get(f);
      const relName = path.relative(this._wp, f);
      const isExternal = relName.startsWith("..");
      return {
        path: f,
        name: isExternal ? f : relName,
        external: isExternal,
        active: i === idx,
        done: !r,
        unresolved: r ? r.unresolvedCount : 0,
        total: r ? r.hunks.length : 0,
      };
    });

    this._postMessage({
      type: "state-update",
      review: {
        remaining,
        total: files.length,
        currentFile: currentFile ? path.relative(this._wp, currentFile) : null,
        unresolvedHunks: review ? review.unresolvedCount : 0,
        totalHunks: review ? review.hunks.length : 0,
        files: fileList,
      },
      activeSessions: this._ptyManager.getSessions(),
    });
  }

  _postMessage(msg) {
    this._view?.webview?.postMessage(msg);
  }

  _buildHtml(webview) {
    const xtermCss = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "xterm.css"),
    );
    const xtermJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "xterm.min.js"),
    );
    const fitJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "addon-fit.min.js"),
    );
    // Codicon font from VS Code / Cursor internals
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        vscode.Uri.file(vscode.env.appRoot),
        "out",
        "media",
        "codicon.ttf",
      ),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
  style-src ${webview.cspSource} 'unsafe-inline';
  script-src 'unsafe-inline' ${webview.cspSource};
  font-src ${webview.cspSource};">
<link rel="stylesheet" href="${xtermCss}">
<style>
@font-face{font-family:'codicon';src:url('${codiconUri}') format('truetype')}
.codicon{font-family:'codicon';font-size:16px;font-weight:normal;font-style:normal;display:inline-block;text-decoration:none;text-rendering:auto;-webkit-font-smoothing:antialiased;line-height:1}
.codicon-close::before{content:'\\ea76'}
.codicon-refresh::before{content:'\\eb37'}
.codicon-add::before{content:'\\ea60'}
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:var(--vscode-sideBar-background,#1e1e1e);
  --fg:var(--vscode-foreground,#ccc);
  --border:rgba(128,128,128,.2);
  --accent:var(--vscode-button-background,#0e639c);
  --accent-fg:var(--vscode-button-foreground,#fff);
  --hover:rgba(128,128,128,.12);
  --green:rgba(40,167,69,.25);
  --green-border:rgba(40,167,69,.5);
  --red:rgba(220,53,69,.25);
  --red-border:rgba(220,53,69,.5);
}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--fg);font:var(--vscode-font-size,13px) var(--vscode-font-family,system-ui)}

.tab-bar{display:flex;border-bottom:1px solid var(--border);background:var(--bg);flex-shrink:0;padding-left:6px}
.tab{padding:8px 14px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;opacity:.6;user-select:none;white-space:nowrap}
.tab:hover{opacity:.8;background:var(--hover)}
.tab.active{opacity:1;border-bottom-color:var(--accent);font-weight:600}

.content{flex:1;overflow:hidden;display:flex;flex-direction:column}
.panel{display:none;flex:1;overflow:auto;flex-direction:column}
.panel.active{display:flex}

/* Sessions list */
.sessions-header{display:flex;align-items:center;gap:6px;padding:8px;border-bottom:1px solid var(--border)}
.sessions-header .title{font-size:12px;text-transform:uppercase;letter-spacing:.5px;opacity:.5;flex:1}
.icon-btn{border:none;background:transparent;color:var(--fg);cursor:pointer;font-size:15px;padding:2px 6px;border-radius:3px;opacity:.5}
.icon-btn:hover{opacity:1;background:var(--hover)}

.sessions-list{flex:1;overflow:auto;padding:4px 0}
.session-item{display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;border-bottom:1px solid transparent}
.session-item:hover{background:var(--hover)}
.session-item .dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.session-item .dot.active{background:#4caf50}
.session-item .dot.past{background:rgba(128,128,128,.3)}
.session-item .info{flex:1;overflow:hidden}
.session-item .session-title{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.session-item .session-meta{font-size:11px;opacity:.4;margin-top:1px}
.session-item .branch{font-size:11px;opacity:.3;background:rgba(128,128,128,.15);padding:1px 4px;border-radius:2px;flex-shrink:0}
.session-item.open{background:rgba(128,128,128,.08);border-left:2px solid var(--accent)}

/* Context menu */
.ctx-menu{position:fixed;z-index:100;background:var(--vscode-menu-background,#252526);border:1px solid var(--border);border-radius:4px;padding:4px 0;min-width:150px;box-shadow:0 4px 12px rgba(0,0,0,.4)}
.ctx-menu-item{padding:5px 12px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:6px}
.ctx-menu-item:hover{background:var(--vscode-menu-selectionBackground,var(--accent));color:var(--vscode-menu-selectionForeground,#fff)}
.ctx-menu-sep{height:1px;background:var(--border);margin:4px 0}
.ctx-menu-item.danger{color:#e55}
.ctx-menu-item.danger:hover{background:rgba(220,53,69,.3);color:#f77}

/* Inline edit */
.inline-edit{background:var(--vscode-input-background,#3c3c3c);color:var(--fg);border:1px solid var(--accent);border-radius:2px;padding:1px 4px;font-size:13px;width:100%;outline:none;font-family:inherit}
.tab-inline-edit{background:var(--vscode-input-background,#3c3c3c);color:var(--fg);border:1px solid var(--accent);border-radius:2px;padding:1px 4px;font-size:12px;width:140px;max-width:140px;outline:none;font-family:inherit}
.loading-bar{height:2px;background:var(--accent);animation:loading 1.2s ease-in-out infinite;flex-shrink:0}
@keyframes loading{0%{opacity:.3;transform:scaleX(.3);transform-origin:left}50%{opacity:1;transform:scaleX(1);transform-origin:left}100%{opacity:.3;transform:scaleX(.3);transform-origin:right}}

/* Active terminal tabs */
.terminal-bar{display:flex;align-items:center;border-bottom:1px solid var(--border);flex-shrink:0;min-height:32px;overflow-x:auto;overflow-y:hidden;padding:2px 0 2px 4px;gap:2px}
.terminal-tab{padding:3px 6px 3px 10px;font-size:12px;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:4px;flex-shrink:1;flex-grow:0;border-radius:4px;margin:0;background:rgba(128,128,128,.1);color:var(--fg);opacity:.65;user-select:none;min-width:0;overflow:hidden}
.terminal-tab:hover{opacity:1;background:rgba(128,128,128,.2)}
.terminal-tab.active{opacity:1;background:var(--accent);color:var(--accent-fg)}
.terminal-tab>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;max-width:140px}
.terminal-tab .close-btn{opacity:.5;cursor:pointer;padding:1px 2px;flex-shrink:0;border-radius:3px}
.terminal-tab .close-btn:hover{opacity:1;background:rgba(128,128,128,.3)}
.terminal-tab.active .close-btn{color:var(--accent-fg)}
.terminal-tab.active .close-btn:hover{background:rgba(255,255,255,.2)}
.back-btn{padding:4px 8px;font-size:13px;cursor:pointer;opacity:.4}
.back-btn:hover{opacity:1}
.terminal-bar-add{margin-left:auto;padding:4px 8px;cursor:pointer;opacity:.4;flex-shrink:0}
.terminal-bar-add:hover{opacity:1;background:var(--hover)}

.terminals-area{flex:1;position:relative;overflow:hidden}
.term-container{position:absolute;inset:0;display:none}
.term-container.active{display:block}
.term-container .xterm{height:100%}

/* Views: sessions-view (list) and terminal-view (active terminals) */
.claude-sessions-view{display:flex;flex-direction:column;flex:1;overflow:hidden}
.claude-terminal-view{display:none;flex-direction:column;flex:1;overflow:hidden}
.claude-terminal-view.active{display:flex}
.claude-sessions-view.hidden{display:none}

/* Review */
.review-content{padding:8px;overflow:auto;flex:1}
.r-header{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.r-info{font-size:13px;opacity:.6;margin-bottom:6px}
.btn{border:1px solid var(--border);border-radius:3px;padding:4px 10px;font-size:13px;cursor:pointer;background:transparent;color:var(--fg)}
.btn:hover:not(:disabled){background:var(--hover)}.btn:disabled{opacity:.3;cursor:default}
.btn.primary{background:var(--accent);color:var(--accent-fg);border:none}
.btn.primary:hover{opacity:.85}
.btn.keep{background:var(--green);border-color:var(--green-border)}
.btn.keep:hover:not(:disabled){background:rgba(40,167,69,.4)}
.btn.undo{background:var(--red);border-color:var(--red-border)}
.btn.undo:hover:not(:disabled){background:rgba(220,53,69,.4)}
.btn.nav{font-size:14px;padding:4px 8px;font-weight:700}
.actions{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px}
.sep{height:1px;background:var(--border);margin:8px 0}
.file-list-title{font-size:12px;text-transform:uppercase;letter-spacing:.5px;opacity:.4;margin-bottom:4px}
.file{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:4px;cursor:pointer;margin-bottom:1px}
.file:hover{background:var(--hover)}
.file.active{background:rgba(128,128,128,.15);font-weight:600}
.file.done{opacity:.35}
.file-icon{font-size:9px;width:16px;text-align:center;flex-shrink:0;color:#4caf50}
.file.done .file-icon{color:rgba(128,128,128,.4)}
.file-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.file-status{font-size:12px;opacity:.5;flex-shrink:0}
.fb{border:none;background:transparent;cursor:pointer;font-size:13px;padding:2px 4px;border-radius:2px;opacity:.4;flex-shrink:0;color:var(--fg)}
.fb:hover{opacity:1;background:rgba(128,128,128,.2)}
.fb.keep-btn{color:#28a745}.fb.undo-btn{color:#dc3545}
.empty{text-align:center;padding:24px 12px;opacity:.4;line-height:1.6}
.empty .sub{font-size:12px}

.term-error-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.85);z-index:10}
.term-error-box{text-align:center;padding:24px;border-radius:8px;background:var(--bg);border:1px solid var(--border);max-width:280px}
.term-container.drop-active{outline:2px dashed var(--accent);outline-offset:-2px}
.term-reopen-bar{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);z-index:10;display:flex;gap:6px}
.term-reopen-bar .btn{box-shadow:0 2px 8px rgba(0,0,0,.4);font-size:12px;padding:6px 14px}

/* Settings */
.settings-content{padding:10px;overflow:auto;flex:1}
.settings-section{margin-bottom:16px}
.settings-title{font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.4;margin-bottom:6px;font-weight:600}
.settings-row{display:flex;align-items:center;gap:8px;padding:6px 0}
.settings-row .label{font-size:13px;flex:1}
.settings-row .value{font-size:12px;opacity:.5}
.hook-status{display:flex;align-items:center;gap:8px;padding:8px;border-radius:4px;border:1px solid var(--border);margin-bottom:6px}
.hook-status .hook-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.hook-status .hook-dot.ok{background:#4caf50}
.hook-status .hook-dot.warn{background:#e8a838}
.hook-status .hook-dot.err{background:#dc3545}
.hook-status .hook-info{flex:1;font-size:12px}
.hook-status .hook-info .sub{font-size:11px;opacity:.5;margin-top:1px}
.select-wrap{position:relative}
.select-wrap select{appearance:none;background:var(--vscode-input-background,#3c3c3c);color:var(--fg);border:1px solid var(--border);border-radius:3px;padding:4px 24px 4px 8px;font-size:12px;cursor:pointer;outline:none;font-family:inherit}
.select-wrap::after{content:'\\25BE';position:absolute;right:8px;top:50%;transform:translateY(-50%);pointer-events:none;opacity:.5;font-size:10px}
.shortcut-row{display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px}
.shortcut-row .keys{background:rgba(128,128,128,.15);padding:2px 6px;border-radius:3px;font-family:monospace;font-size:11px;flex-shrink:0}
.shortcut-row .desc{opacity:.7;flex:1}
</style>
</head>
<body>
<div style="display:flex;flex-direction:column;height:100%">

<div class="tab-bar">
    <div class="tab active" data-tab="claude" onclick="switchTab('claude')">Claude Code</div>
    <div class="tab" data-tab="review" onclick="switchTab('review')">Review</div>
    <div class="tab" data-tab="settings" onclick="switchTab('settings')">Settings</div>
</div>

<div class="content">
<!-- Claude Code panel -->
<div class="panel active" id="panel-claude">
    <!-- Sessions list view -->
    <div class="claude-sessions-view" id="sessionsView">
        <div class="sessions-header">
            <span class="title">Sessions</span>
            <button class="icon-btn" onclick="send('refresh-sessions')" title="Refresh"><span class="codicon codicon-refresh"></span></button>
            <button class="icon-btn" onclick="send('new-claude-session')" title="New session"><span class="codicon codicon-add"></span></button>
        </div>
        <div class="sessions-list" id="sessionsList">
            <div class="empty">Loading sessions...</div>
        </div>
        <div class="ctx-menu" id="ctxMenu" style="display:none"></div>
    </div>
    <!-- Terminal view (shown when a session is active) -->
    <div class="claude-terminal-view" id="terminalView">
        <div class="terminal-bar" id="terminalBar">
            <span class="back-btn" onclick="showSessionsList()" title="Back to sessions">&larr;</span>
            <!-- tabs inserted here by JS -->
            <span class="terminal-bar-add" onclick="send('new-claude-session')" title="New session"><span class="codicon codicon-add"></span></span>
        </div>
        <div class="terminals-area" id="terminalsArea"></div>
    </div>
</div>

<!-- Review panel -->
<div class="panel" id="panel-review">
    <div class="review-content" id="reviewContent">
        <div class="empty">No changes from Claude yet<br><span class="sub">Changes will appear here automatically</span></div>
    </div>
</div>

<!-- Settings panel -->
<div class="panel" id="panel-settings">
    <div class="settings-content">
        <div class="settings-section">
            <div class="settings-title">Review Hook</div>
            <div class="hook-status" id="hookStatusBox">
                <span class="hook-dot warn" id="hookDot"></span>
                <div class="hook-info">
                    <div id="hookStatusText">Checking...</div>
                    <div class="sub" id="hookStatusSub"></div>
                </div>
                <button class="btn primary" id="hookActionBtn" onclick="send('install-hook')" style="display:none">Install</button>
            </div>
        </div>
        <div class="settings-section">
            <div class="settings-title">CLI Command</div>
            <div class="settings-row">
                <span class="label">Command for sessions</span>
                <div class="select-wrap">
                    <select id="cliSelect" onchange="send('set-cli-command',{value:this.value})">
                        <option value="claude">claude</option>
                        <option value="happy">happy</option>
                    </select>
                </div>
            </div>
        </div>
        <div class="settings-section">
            <div class="settings-title" style="display:flex;align-items:center;justify-content:space-between">
                <span>Keyboard Shortcuts</span>
                <button class="btn" style="font-size:10px;padding:2px 6px;text-transform:none;letter-spacing:0" onclick="send('open-keybindings')">Customize</button>
            </div>
            <div id="shortcutsContainer"><div style="font-size:12px;opacity:.4">Loading...</div></div>
            <div class="settings-title" style="margin-top:10px">Tips</div>
            <div style="font-size:12px;opacity:.6;line-height:1.5">
                Select code in editor and use the shortcut above to send file:line reference to the active Claude session.<br><br>
                Right-click a file in Explorer &rarr; <b>Send to Claude Session</b> to insert its path.<br><br>
                Paste an image (<b>Cmd+V</b>) into the terminal to send it as a file path.
            </div>
        </div>
    </div>
</div>
</div>
</div>

<script src="${xtermJs}"></script>
<script src="${fitJs}"></script>
<script>
(function(){
const vsc = acquireVsCodeApi();
function send(type, data) { vsc.postMessage({ type, ...(data||{}) }); }

// === Tab management ===
let activeTab = 'claude';
window.switchTab = function(tab) {
    activeTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
    if (tab === 'claude') fitActiveTerminal();
};

// === Sessions view / Terminal view toggle ===
window.showSessionsList = function() {
    const loader = document.getElementById('sessionLoader');
    if (loader) loader.remove();
    document.getElementById('sessionsView').classList.remove('hidden');
    document.getElementById('terminalView').classList.remove('active');
    // Re-render to reset any stale inline styles (opacity etc.)
    renderSessions(null);
};

function showTerminalView() {
    document.getElementById('sessionsView').classList.add('hidden');
    document.getElementById('terminalView').classList.add('active');
    setTimeout(fitActiveTerminal, 100);
}

// === Sessions rendering ===
let cachedSessions = [];
let openClaudeIds = new Set();

function renderSessions(sessions) {
    if (sessions) cachedSessions = sessions;
    const el = document.getElementById('sessionsList');
    if (!cachedSessions || cachedSessions.length === 0) {
        el.innerHTML = '<div class="empty">No sessions found<br><span class="sub">Click + to start a new Claude session</span></div>';
        return;
    }
    let html = '';
    cachedSessions.forEach(s => {
        const date = new Date(s.timestamp);
        const ago = timeAgo(date);
        const msgs = s.messageCount ? s.messageCount + ' msgs' : '';
        const meta = [ago, msgs].filter(Boolean).join(' · ');
        const isOpen = openClaudeIds.has(s.id);
        html += '<div class="session-item' + (isOpen ? ' open' : '') + '" data-sid="' + s.id + '">';
        html += '<span class="dot ' + (isOpen ? 'active' : 'past') + '"></span>';
        html += '<div class="info"><div class="session-title">' + esc(s.title) + '</div>';
        html += '<div class="session-meta">' + esc(meta) + (isOpen ? ' &middot; running' : '') + '</div></div>';
        if (s.branch) html += '<span class="branch">' + esc(s.branch) + '</span>';
        html += '</div>';
    });
    el.innerHTML = html;

    // Attach event listeners
    el.querySelectorAll('.session-item').forEach(item => {
        const sid = item.dataset.sid;
        item.onclick = () => resumeSession(sid);
        item.oncontextmenu = (e) => showCtxMenu(e, sid);
    });
}

function timeAgo(date) {
    const sec = Math.floor((Date.now() - date.getTime()) / 1000);
    if (sec < 60) return 'just now';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
    return Math.floor(sec / 86400) + 'd ago';
}

function resumeSession(claudeId) {
    const item = document.querySelector('.session-item[data-sid="' + claudeId + '"]');
    if (item) { item.style.opacity = '0.5'; }
    const el = document.getElementById('sessionsList');
    const loader = document.createElement('div');
    loader.className = 'loading-bar';
    loader.id = 'sessionLoader';
    el.parentElement.insertBefore(loader, el);
    send('resume-claude-session', { claudeSessionId: claudeId });
}

// === Context menu ===
let ctxTarget = null;

function showCtxMenu(e, sessionId) {
    e.preventDefault();
    e.stopPropagation();
    const s = cachedSessions.find(x => x.id === sessionId);
    const isOpen = openClaudeIds.has(sessionId);
    ctxTarget = { sessionId, title: s ? s.title : '', isOpen };

    const menu = document.getElementById('ctxMenu');
    let html = '<div class="ctx-menu-item" data-action="rename">Rename</div>';
    if (isOpen) {
        html += '<div class="ctx-menu-item" data-action="close">Close session</div>';
    }
    html += '<div class="ctx-menu-sep"></div>';
    html += '<div class="ctx-menu-item danger" data-action="hide">Hide from list</div>';
    menu.innerHTML = html;

    // Position
    const rect = document.body.getBoundingClientRect();
    let x = e.clientX, y = e.clientY;
    menu.style.display = 'block';
    if (x + menu.offsetWidth > rect.width) x = rect.width - menu.offsetWidth - 4;
    if (y + menu.offsetHeight > rect.height) y = rect.height - menu.offsetHeight - 4;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // Attach menu item handlers
    menu.querySelectorAll('.ctx-menu-item').forEach(item => {
        item.onclick = (ev) => { ev.stopPropagation(); handleCtxAction(item.dataset.action); };
    });
}

function hideCtxMenu() { document.getElementById('ctxMenu').style.display = 'none'; }
document.addEventListener('click', hideCtxMenu);
document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.session-item')) hideCtxMenu();
});

function handleCtxAction(action) {
    hideCtxMenu();
    if (!ctxTarget) return;
    const { sessionId, title, isOpen } = ctxTarget;

    if (action === 'rename') {
        startInlineRename(sessionId, title);
    } else if (action === 'close') {
        send('close-session-by-claude-id', { claudeSessionId: sessionId });
    } else if (action === 'hide') {
        send('hide-session', { sessionId });
    }
}

function startInlineRename(sessionId, currentTitle) {
    const item = document.querySelector('.session-item[data-sid="' + sessionId + '"]');
    if (!item) return;
    const titleEl = item.querySelector('.session-title');
    if (!titleEl) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-edit';
    input.value = currentTitle;
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    // Prevent click from triggering resume
    item.onclick = null;

    const commit = () => {
        const newName = input.value.trim();
        if (newName && newName !== currentTitle) {
            send('rename-session', { sessionId, newName });
            // Also update matching terminal tab
            terminals.forEach(t => {
                if (t.claudeId === sessionId) {
                    t.name = newName;
                    const span = t.tabEl.querySelector('span:first-child');
                    if (span) span.textContent = newName;
                }
            });
        } else {
            renderSessions(null);
        }
    };

    let committed = false;
    input.onblur = () => { if (!committed) { committed = true; commit(); } };
    input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); committed = true; commit(); }
        if (e.key === 'Escape') { e.preventDefault(); committed = true; renderSessions(null); }
    };
}

window.closeErrorTerminal = function(sessionId) {
    send('close-terminal', { sessionId: sessionId });
};

function reopenTerminal(sessionId) {
    const t = terminals.get(sessionId);
    if (!t || !t.claudeId) return;
    const claudeId = t.claudeId;
    send('close-terminal', { sessionId: sessionId });
    setTimeout(() => { send('resume-claude-session', { claudeSessionId: claudeId }); }, 200);
}

// === Terminal management ===
const terminals = new Map();
let activeTerminalId = null;

function addTerminal(id, name, claudeId) {
    // Use session title for tab name if available
    let displayName = name;
    if (claudeId) {
        const s = cachedSessions.find(x => x.id === claudeId);
        if (s) displayName = s.title;
    }

    // Tab
    const tab = document.createElement('div');
    tab.className = 'terminal-tab';
    tab.dataset.tid = id;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = displayName;
    nameSpan.onclick = () => activateTerminal(id);
    nameSpan.ondblclick = (e) => { e.stopPropagation(); startTabRename(id); };

    const closeSpan = document.createElement('span');
    closeSpan.className = 'close-btn codicon codicon-close';
    closeSpan.title = 'Close';
    closeSpan.onclick = (e) => { e.stopPropagation(); send('close-terminal', { sessionId: id }); };

    tab.appendChild(nameSpan);
    tab.appendChild(closeSpan);
    const bar = document.getElementById('terminalBar');
    const addBtn = bar.querySelector('.terminal-bar-add');
    bar.insertBefore(tab, addBtn);

    // Container
    const container = document.createElement('div');
    container.className = 'term-container';
    container.id = 'term-' + id;
    document.getElementById('terminalsArea').appendChild(container);

    // Drag & drop files from Explorer
    container.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        container.classList.add('drop-active');
    });
    container.addEventListener('dragleave', () => {
        container.classList.remove('drop-active');
    });
    container.addEventListener('drop', (e) => {
        e.preventDefault();
        container.classList.remove('drop-active');
        const types = [...e.dataTransfer.types];
        console.log('[ccr] drop types:', types.join(', '));
        // Try multiple data formats (VS Code Explorer may use different types)
        const uri = e.dataTransfer.getData('text/uri-list')
            || e.dataTransfer.getData('text/plain')
            || e.dataTransfer.getData('text');
        console.log('[ccr] drop data:', uri);
        if (uri) {
            send('file-dropped', { sessionId: id, uri });
        } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            // Fallback: File objects from OS drag
            const filePath = e.dataTransfer.files[0].path || e.dataTransfer.files[0].name;
            console.log('[ccr] drop file object:', filePath);
            if (filePath) {
                send('file-dropped', { sessionId: id, uri: 'file://' + filePath });
            }
        }
    });

    // xterm
    const term = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: "'Menlo','Monaco','Courier New',monospace",
        theme: {
            background: getComputedStyle(document.body).getPropertyValue('--vscode-sideBar-background').trim() || '#1e1e1e',
            foreground: '#cccccc', cursor: '#ffffff',
            selectionBackground: '#264f78',
        },
        scrollback: 10000,
        convertEol: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    // Block dangerous keys — prevent exiting Claude CLI
    let lastCtrlC = 0;
    term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true;
        // Ctrl+C — allow once (cancel generation), block rapid double (exits CLI)
        if (event.ctrlKey && event.key === 'c') {
            const now = Date.now();
            if (now - lastCtrlC < 2000) return false;
            lastCtrlC = now;
            return true;
        }
        // Ctrl+D — block (EOF, closes shell)
        if (event.ctrlKey && event.key === 'd') return false;
        // Ctrl+Z — block (suspend process)
        if (event.ctrlKey && event.key === 'z') return false;
        // Ctrl+\\ — block (SIGQUIT)
        if (event.ctrlKey && event.key === '\\\\') return false;
        return true;
    });

    // Intercept Cmd+V / Ctrl+V to detect image paste
    container.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                e.stopPropagation();
                const blob = item.getAsFile();
                if (!blob) return;
                const reader = new FileReader();
                reader.onload = () => {
                    const base64 = reader.result.split(',')[1];
                    send('paste-image', { sessionId: id, data: base64, mimeType: item.type });
                };
                reader.readAsDataURL(blob);
                return;
            }
        }
        // Non-image paste: let xterm handle it normally
    });

    term.onData((data) => send('terminal-input', { sessionId: id, data }));
    term.onResize(({ cols, rows }) => send('terminal-resize', { sessionId: id, cols, rows }));

    const entry = { id, name: displayName, claudeId, term, fitAddon, container, tabEl: tab };
    terminals.set(id, entry);

    activateTerminal(id);
    showTerminalView();
    updateTabWidths();
    // Multiple fit calls to ensure correct size after layout settles
    [100, 300, 800].forEach(ms => setTimeout(fitActiveTerminal, ms));
}

function removeTerminal(id) {
    const t = terminals.get(id);
    if (!t) return;
    t.term.dispose();
    t.container.remove();
    t.tabEl.remove();
    terminals.delete(id);
    updateTabWidths();

    if (activeTerminalId === id) {
        const remaining = [...terminals.keys()];
        if (remaining.length > 0) activateTerminal(remaining[remaining.length - 1]);
        else {
            activeTerminalId = null;
            showSessionsList();
        }
    }
}

function updateTabWidths() {
    const count = terminals.size;
    const maxW = count <= 1 ? '80%' : '33%';
    terminals.forEach(t => { t.tabEl.style.maxWidth = maxW; });
}

function activateTerminal(id) {
    activeTerminalId = id;
    terminals.forEach((t, tid) => {
        t.container.classList.toggle('active', tid === id);
        t.tabEl.classList.toggle('active', tid === id);
    });
    // Persist active session
    const active = terminals.get(id);
    send('set-active-session', { claudeId: active?.claudeId || null });
    fitActiveTerminal();
}

function fitActiveTerminal() {
    if (!activeTerminalId) return;
    const t = terminals.get(activeTerminalId);
    if (t && activeTab === 'claude') {
        setTimeout(() => { try { t.fitAddon.fit(); } catch {} }, 50);
    }
}

const ro = new ResizeObserver(() => {
    clearTimeout(ro._t);
    ro._t = setTimeout(fitActiveTerminal, 100);
});
ro.observe(document.getElementById('terminalsArea'));

// === Tab inline rename (double-click) ===
function startTabRename(termId) {
    const t = terminals.get(termId);
    if (!t) return;
    const nameSpan = t.tabEl.querySelector('span:first-child');
    if (!nameSpan) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tab-inline-edit';
    input.value = t.name;
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    const restoreSpan = (text) => {
        const span = document.createElement('span');
        span.textContent = text;
        span.onclick = () => activateTerminal(termId);
        span.ondblclick = (e) => { e.stopPropagation(); startTabRename(termId); };
        input.replaceWith(span);
    };

    const commit = () => {
        const newName = input.value.trim();
        if (newName && newName !== t.name) {
            t.name = newName;
            restoreSpan(newName);
            if (t.claudeId) send('rename-session', { sessionId: t.claudeId, newName });
        } else {
            restoreSpan(t.name);
        }
    };

    let committed = false;
    input.onblur = () => { if (!committed) { committed = true; commit(); } };
    input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); committed = true; commit(); }
        if (e.key === 'Escape') { e.preventDefault(); committed = true; restoreSpan(t.name); }
    };
}

// === Review rendering ===
function renderReview(data) {
    if (!data) return;
    const el = document.getElementById('reviewContent');
    const { remaining, total, currentFile, unresolvedHunks, totalHunks, files } = data;
    const noReview = remaining === 0 && files.length === 0;

    // Update Review tab badge
    const reviewTab = document.querySelector('.tab[data-tab="review"]');
    if (reviewTab) {
        reviewTab.textContent = remaining > 0 ? 'Review (' + remaining + ')' : 'Review';
        reviewTab.dataset.tab = 'review';
    }

    let html = '';

    if (noReview) {
        html += '<div class="empty">No changes from Claude yet<br><span class="sub">Changes will appear here automatically</span></div>';
    } else {
        if (currentFile) {
            html += '<div class="r-info">' + esc(currentFile) + ' &mdash; ' + unresolvedHunks + '/' + totalHunks + ' changes</div>';
            html += '<div class="actions">';
            html += '<button class="btn nav" onclick="send(\\'prev-file\\')">&lsaquo;</button>';
            html += '<button class="btn nav" onclick="send(\\'next-file\\')">&rsaquo;</button>';
            html += '<button class="btn keep" onclick="acceptCurrentFile()">&#10003; Accept File</button>';
            html += '<button class="btn undo" onclick="rejectCurrentFile()">&#10007; Reject File</button>';
            html += '</div>';
        }
        html += '<div class="r-info">' + remaining + '/' + total + ' files remaining</div>';
        html += '<div class="actions">';
        html += '<button class="btn keep" onclick="send(\\'accept-all\\')" ' + (remaining===0?'disabled':'') + '>Accept All</button>';
        html += '<button class="btn undo" onclick="send(\\'reject-all\\')" ' + (remaining===0?'disabled':'') + '>Reject All</button>';
        html += '</div>';
        html += '<div class="sep"></div><div class="file-list-title">Files</div>';
        files.forEach((f) => {
            const cls = f.active ? 'file active' : f.done ? 'file done' : 'file';
            const status = f.done ? 'done' : f.unresolved + '/' + f.total;
            const extIcon = f.external ? '<span style="color:#e8a838;margin-right:2px" title="External file">&#9888;</span>' : '';
            html += '<div class="' + cls + '" onclick="goToFile(\\'' + escAttr(f.path) + '\\')">';
            html += '<span class="file-icon">' + (f.done ? '&#10003;' : '&#9679;') + '</span>';
            html += extIcon + '<span class="file-name">' + esc(f.name) + '</span>';
            html += '<span class="file-status">' + status + '</span>';
            if (!f.done) {
                html += '<button class="fb keep-btn" onclick="event.stopPropagation();acceptFile(\\'' + escAttr(f.path) + '\\')" title="Accept">&#10003;</button>';
                html += '<button class="fb undo-btn" onclick="event.stopPropagation();rejectFile(\\'' + escAttr(f.path) + '\\')" title="Reject">&#10007;</button>';
            }
            html += '</div>';
        });
    }
    el.innerHTML = html;
}

function updateShortcuts(bindings) {
    const el = document.getElementById('shortcutsContainer');
    if (!bindings || bindings.length === 0) {
        el.innerHTML = '<div style="font-size:12px;opacity:.4">No shortcuts configured</div>';
        return;
    }
    let html = '';
    bindings.forEach(b => {
        html += '<div class="shortcut-row">';
        html += '<span class="keys">' + esc(b.key) + '</span>';
        html += '<span class="desc">' + esc(b.desc) + '</span>';
        html += '</div>';
    });
    el.innerHTML = html;
}

function updateHookUI(status) {
    const dot = document.getElementById('hookDot');
    const text = document.getElementById('hookStatusText');
    const sub = document.getElementById('hookStatusSub');
    const btn = document.getElementById('hookActionBtn');
    if (status === 'installed') {
        dot.className = 'hook-dot ok';
        text.textContent = 'Hook installed';
        sub.textContent = 'Changes by Claude Code are tracked automatically';
        btn.style.display = 'none';
    } else if (status === 'outdated') {
        dot.className = 'hook-dot warn';
        text.textContent = 'Hook outdated';
        sub.textContent = 'Update required for latest features';
        btn.textContent = 'Update';
        btn.style.display = '';
    } else {
        dot.className = 'hook-dot err';
        text.textContent = 'Hook not installed';
        sub.textContent = 'Required to track changes by Claude Code';
        btn.textContent = 'Install';
        btn.style.display = '';
    }
}

// === Global helpers ===
let currentFilePath = null;
window.send = send;
window.goToFile = function(fp) { send('go-to-file', { filePath: fp }); };
window.acceptFile = function(fp) { send('accept-file', { filePath: fp }); };
window.rejectFile = function(fp) { send('reject-file', { filePath: fp }); };
window.acceptCurrentFile = function() { if (currentFilePath) send('accept-file', { filePath: currentFilePath }); };
window.rejectCurrentFile = function() { if (currentFilePath) send('reject-file', { filePath: currentFilePath }); };

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return String(s).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'"); }

// === Message handler ===
window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
        case 'sessions-list':
            renderSessions(msg.sessions);
            break;
        case 'open-sessions-update':
            openClaudeIds = new Set(msg.openClaudeIds || []);
            renderSessions(null);
            break;
        case 'activate-terminal':
            if (terminals.has(msg.sessionId)) {
                activateTerminal(msg.sessionId);
                showTerminalView();
            }
            break;
        case 'terminal-session-created': {
            const loader = document.getElementById('sessionLoader');
            if (loader) loader.remove();
            addTerminal(msg.sessionId, msg.name, msg.claudeId);
            break;
        }
        case 'terminal-session-closed':
            removeTerminal(msg.sessionId);
            break;
        case 'terminal-output': {
            const t = terminals.get(msg.sessionId);
            if (t) {
                t.term.write(msg.data);
                t.term.scrollToBottom();
            }
            break;
        }
        case 'terminal-exit': {
            const t = terminals.get(msg.sessionId);
            if (t) {
                t.term.write('\\r\\n[Process exited with code ' + msg.exitCode + ']\\r\\n');
                t.exited = true;
                const bar = document.createElement('div');
                bar.className = 'term-reopen-bar';
                if (t.claudeId) {
                    const reopenBtn = document.createElement('button');
                    reopenBtn.className = 'btn primary';
                    reopenBtn.textContent = 'Reopen session';
                    reopenBtn.onclick = () => { reopenTerminal(msg.sessionId); };
                    bar.appendChild(reopenBtn);
                }
                const closeBtn = document.createElement('button');
                closeBtn.className = 'btn';
                closeBtn.textContent = 'Close';
                closeBtn.onclick = () => { send('close-terminal', { sessionId: msg.sessionId }); };
                bar.appendChild(closeBtn);
                t.container.appendChild(bar);
            }
            break;
        }
        case 'terminal-error': {
            const te = terminals.get(msg.sessionId);
            if (te) {
                const overlay = document.createElement('div');
                overlay.className = 'term-error-overlay';
                overlay.innerHTML = '<div class="term-error-box">' +
                    '<div style="font-size:28px;margin-bottom:12px">&#9888;</div>' +
                    '<div style="font-size:13px;font-weight:600;margin-bottom:8px">Session not found</div>' +
                    '<div style="font-size:11px;opacity:.6;margin-bottom:16px">This conversation was deleted or is no longer available in Claude CLI</div>' +
                    '<button class="btn primary" onclick="closeErrorTerminal(' + msg.sessionId + ')">Back to sessions</button>' +
                    '</div>';
                te.container.appendChild(overlay);
            }
            break;
        }
        case 'insert-text': {
            if (activeTerminalId) {
                const t = terminals.get(activeTerminalId);
                if (t) {
                    switchTab('claude');
                    showTerminalView();
                    activateTerminal(activeTerminalId);
                    send('terminal-input', { sessionId: activeTerminalId, data: msg.text });
                    setTimeout(() => { t.term.focus(); }, 100);
                }
            }
            break;
        }
        case 'hook-status':
            updateHookUI(msg.status);
            break;
        case 'settings-init':
            if (msg.cliCommand) {
                document.getElementById('cliSelect').value = msg.cliCommand;
            }
            if (msg.keybindings) {
                updateShortcuts(msg.keybindings);
            }
            break;
        case 'state-update':
            currentFilePath = msg.review?.files?.find(f => f.active && !f.done)?.path || null;
            renderReview(msg.review);
            break;
    }
});

// Signal extension that webview JS is ready
send('webview-ready');

})();
</script>
</body>
</html>`;
  }
}

module.exports = { MainViewProvider };
