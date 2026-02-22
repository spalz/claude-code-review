import * as vscode from "vscode";

export function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const mediaUri = (file: string): vscode.Uri =>
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", file));
	const webviewUri = (file: string): vscode.Uri =>
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview", file));
	const codiconUri = webview.asWebviewUri(
		vscode.Uri.joinPath(vscode.Uri.file(vscode.env.appRoot), "out", "media", "codicon.ttf"),
	);

	const xtermCss = mediaUri("xterm.css");
	const xtermJs = mediaUri("xterm.min.js");
	const fitJs = mediaUri("addon-fit.min.js");
	const stylesCss = webviewUri("styles.css");
	const coreJs = webviewUri("core.js");
	const sessionsJs = webviewUri("sessions.js");
	const terminalsJs = webviewUri("terminals.js");
	const reviewJs = webviewUri("review.js");
	const settingsJs = webviewUri("settings.js");
	const messageRouterJs = webviewUri("message-router.js");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
  style-src ${webview.cspSource} 'unsafe-inline';
  script-src ${webview.cspSource};
  font-src ${webview.cspSource};">
<link rel="stylesheet" href="${xtermCss}">
<link rel="stylesheet" href="${stylesCss}">
<style>
@font-face{font-family:'codicon';src:url('${codiconUri}') format('truetype')}
.codicon{font-family:'codicon';font-size:16px;font-weight:normal;font-style:normal;display:inline-block;text-decoration:none;text-rendering:auto;-webkit-font-smoothing:antialiased;line-height:1}
.codicon-close::before{content:'\\ea76'}
.codicon-refresh::before{content:'\\eb37'}
.codicon-add::before{content:'\\ea60'}
</style>
</head>
<body>
<div style="display:flex;flex-direction:column;height:100%">
<div class="tab-bar">
    <div class="tab active" data-tab="claude">Claude Code</div>
    <div class="tab" data-tab="review">Review</div>
    <div class="tab" data-tab="settings">Settings</div>
</div>
<div class="content">
<div class="panel active" id="panel-claude">
    <div class="claude-sessions-view" id="sessionsView">
        <div class="sessions-header">
            <span class="title">Sessions</span>
            <button class="icon-btn" id="btnRefreshSessions" title="Refresh"><span class="codicon codicon-refresh"></span></button>
            <button class="icon-btn" id="btnNewSession" title="New session"><span class="codicon codicon-add"></span></button>
        </div>
        <div class="sessions-list" id="sessionsList"><div class="empty">Loading sessions...</div></div>
        <div class="ctx-menu" id="ctxMenu" style="display:none"></div>
    </div>
    <div class="claude-terminal-view" id="terminalView">
        <div class="terminal-bar" id="terminalBar">
            <span class="back-btn" id="btnBackToSessions" title="Back to sessions">&larr;</span>
            <span class="terminal-bar-add" id="btnNewTerminal" title="New session"><span class="codicon codicon-add"></span></span>
        </div>
        <div class="terminals-area" id="terminalsArea"></div>
    </div>
</div>
<div class="panel" id="panel-review">
    <div class="review-content" id="reviewContent">
        <div class="empty">No changes from Claude yet<br><span class="sub">Changes will appear here automatically</span></div>
    </div>
</div>
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
                <button class="btn primary" id="hookActionBtn" style="display:none">Install</button>
            </div>
        </div>
        <div class="settings-section">
            <div class="settings-title">CLI Command</div>
            <div class="settings-row">
                <span class="label">Command for sessions</span>
                <div class="select-wrap">
                    <select id="cliSelect">
                        <option value="claude">claude</option>
                        <option value="happy">happy</option>
                    </select>
                </div>
            </div>
        </div>
        <div class="settings-section">
            <div class="settings-title" style="display:flex;align-items:center;justify-content:space-between">
                <span>Keyboard Shortcuts</span>
                <button class="btn" id="btnCustomizeKeys" style="font-size:10px;padding:2px 6px;text-transform:none;letter-spacing:0">Customize</button>
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
<script src="${coreJs}"></script>
<script src="${sessionsJs}"></script>
<script src="${terminalsJs}"></script>
<script src="${reviewJs}"></script>
<script src="${settingsJs}"></script>
<script src="${messageRouterJs}"></script>
</body>
</html>`;
}
