// Message router — handles messages from the extension to the webview
(function () {
	"use strict";

	window.addEventListener("message", function (event) {
		var msg = event.data;
		switch (msg.type) {
			case "sessions-list":
				renderSessions(msg.sessions);
				break;

			case "open-sessions-update":
				updateOpenClaudeIds(msg.openClaudeIds);
				renderSessions(null);
				break;

			case "activate-terminal": {
				var terminals = getTerminals();
				if (terminals.has(msg.sessionId)) {
					activateTerminal(msg.sessionId);
					showTerminalView();
				}
				break;
			}

			case "terminal-session-created": {
				var loader = document.getElementById("sessionLoader");
				if (loader) loader.remove();
				addTerminal(msg.sessionId, msg.name, msg.claudeId);
				break;
			}

			case "terminal-session-closed":
				removeTerminal(msg.sessionId);
				break;

			case "terminal-output": {
				var t = getTerminals().get(msg.sessionId);
				if (t) {
					t.term.write(msg.data);
					t.term.scrollToBottom();
				}
				break;
			}

			case "terminal-exit": {
				var te = getTerminals().get(msg.sessionId);
				if (te) {
					te.term.write("\r\n[Process exited with code " + msg.exitCode + "]\r\n");
					te.exited = true;
					var bar = document.createElement("div");
					bar.className = "term-reopen-bar";
					if (te.claudeId) {
						var reopenBtn = document.createElement("button");
						reopenBtn.className = "btn primary";
						reopenBtn.textContent = "Reopen session";
						reopenBtn.onclick = function () {
							reopenTerminal(msg.sessionId);
						};
						bar.appendChild(reopenBtn);
					}
					var closeBtn = document.createElement("button");
					closeBtn.className = "btn";
					closeBtn.textContent = "Close";
					closeBtn.onclick = function () {
						send("close-terminal", { sessionId: msg.sessionId });
					};
					bar.appendChild(closeBtn);
					te.container.appendChild(bar);
				}
				break;
			}

			case "terminal-error": {
				var ter = getTerminals().get(msg.sessionId);
				if (ter) {
					var overlay = document.createElement("div");
					overlay.className = "term-error-overlay";
					var box = document.createElement("div");
					box.className = "term-error-box";
					box.innerHTML =
						'<div style="font-size:28px;margin-bottom:12px">&#9888;</div>' +
						'<div style="font-size:13px;font-weight:600;margin-bottom:8px">Session not found</div>' +
						'<div style="font-size:11px;opacity:.6;margin-bottom:16px">This conversation was deleted or is no longer available in Claude CLI</div>';
					var errBtn = document.createElement("button");
					errBtn.className = "btn primary";
					errBtn.textContent = "Back to sessions";
					errBtn.addEventListener("click", function () {
						closeErrorTerminal(msg.sessionId);
					});
					box.appendChild(errBtn);
					overlay.appendChild(box);
					ter.container.appendChild(overlay);
				}
				break;
			}

			case "insert-text": {
				var activeId = getActiveTerminalId();
				if (activeId) {
					var ti = getTerminals().get(activeId);
					if (ti) {
						switchTab("claude");
						showTerminalView();
						activateTerminal(activeId);
						send("terminal-input", { sessionId: activeId, data: msg.text });
						setTimeout(function () {
							ti.term.focus();
						}, 100);
					}
				}
				break;
			}

			case "hook-status":
				updateHookUI(msg.status);
				break;

			case "settings-init":
				if (msg.cliCommand) {
					document.getElementById("cliSelect").value = msg.cliCommand;
				}
				if (msg.keybindings) {
					updateShortcuts(msg.keybindings);
				}
				break;

			case "state-update":
				if (msg.review) {
					var activeFile = null;
					if (msg.review.files) {
						for (var i = 0; i < msg.review.files.length; i++) {
							if (msg.review.files[i].active && !msg.review.files[i].done) {
								activeFile = msg.review.files[i].path;
								break;
							}
						}
					}
					setCurrentFilePath(activeFile);
					renderReview(msg.review);
				}
				break;
		}
	});

	// Signal extension that webview JS is ready
	send("webview-ready");
})();
