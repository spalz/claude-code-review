// Terminal management — xterm instances, tabs, drag&drop, paste, key handling
(function () {
	"use strict";

	var terminals = new Map();
	var activeTerminalId = null;

	window.getTerminals = function () {
		return terminals;
	};
	window.getActiveTerminalId = function () {
		return activeTerminalId;
	};

	window.addTerminal = function (id, name, claudeId) {
		var displayName = name;
		if (claudeId) {
			var s = getCachedSessions().find(function (x) {
				return x.id === claudeId;
			});
			if (s) displayName = s.title;
		}

		// Tab element — inserted into header's terminal bar
		var tab = document.createElement("div");
		tab.className = "terminal-tab";
		tab.dataset.tid = id;

		var nameSpan = document.createElement("span");
		nameSpan.textContent = displayName;
		nameSpan.onclick = function () {
			activateTerminal(id);
		};
		nameSpan.ondblclick = function (e) {
			e.stopPropagation();
			startTabRename(id);
		};

		var closeSpan = document.createElement("span");
		closeSpan.className = "close-btn codicon codicon-close";
		closeSpan.title = "Close";
		closeSpan.onclick = function (e) {
			e.stopPropagation();
			send("close-terminal", { sessionId: id });
		};

		tab.appendChild(nameSpan);
		tab.appendChild(closeSpan);
		document.getElementById("terminalBar").appendChild(tab);

		// Container
		var container = document.createElement("div");
		container.className = "term-container";
		container.id = "term-" + id;
		document.getElementById("terminalsArea").appendChild(container);

		setupDragDrop(container, id);

		// xterm
		var term = new Terminal({
			cursorBlink: true,
			fontSize: 12,
			fontFamily: "'Menlo','Monaco','Courier New',monospace",
			theme: {
				background:
					getComputedStyle(document.body)
						.getPropertyValue("--vscode-sideBar-background")
						.trim() || "#1e1e1e",
				foreground: "#cccccc",
				cursor: "#ffffff",
				selectionBackground: "#264f78",
			},
			scrollback: 10000,
			convertEol: true,
		});

		var fitAddon = new FitAddon.FitAddon();
		term.loadAddon(fitAddon);
		term.open(container);

		setupKeyHandler(term);
		setupPasteHandler(container, id);

		term.onData(function (data) {
			send("terminal-input", { sessionId: id, data: data });
		});
		term.onResize(function (size) {
			send("terminal-resize", { sessionId: id, cols: size.cols, rows: size.rows });
		});

		var entry = {
			id: id,
			name: displayName,
			claudeId: claudeId,
			term: term,
			fitAddon: fitAddon,
			container: container,
			tabEl: tab,
		};
		terminals.set(id, entry);

		activateTerminal(id);
		showTerminalView();
		updateTabWidths();
		[100, 300, 800].forEach(function (ms) {
			setTimeout(fitActiveTerminal, ms);
		});
	};

	window.removeTerminal = function (id) {
		var t = terminals.get(id);
		if (!t) return;
		t.term.dispose();
		t.container.remove();
		t.tabEl.remove();
		terminals.delete(id);
		updateTabWidths();

		if (activeTerminalId === id) {
			var remaining = Array.from(terminals.keys());
			if (remaining.length > 0) activateTerminal(remaining[remaining.length - 1]);
			else {
				activeTerminalId = null;
				showSessionsList();
			}
		}
	};

	function activateTerminal(id) {
		activeTerminalId = id;
		terminals.forEach(function (t, tid) {
			t.container.classList.toggle("active", tid === id);
			t.tabEl.classList.toggle("active", tid === id);
		});
		var active = terminals.get(id);
		send("set-active-session", { claudeId: active ? active.claudeId || null : null });
		fitActiveTerminal();
	}
	window.activateTerminal = activateTerminal;

	window.fitActiveTerminal = function () {
		if (!activeTerminalId) return;
		var t = terminals.get(activeTerminalId);
		if (t && window.viewMode === "terminals") {
			setTimeout(function () {
				try {
					t.fitAddon.fit();
				} catch (e) {
					/* ignore */
				}
			}, 50);
		}
	};

	function updateTabWidths() {
		var count = terminals.size;
		var maxW = count <= 1 ? "80%" : "33%";
		terminals.forEach(function (t) {
			t.tabEl.style.maxWidth = maxW;
		});
	}

	// Rename terminal tab for sessions rename sync
	window.renameTerminalTab = function (claudeId, newName) {
		terminals.forEach(function (t) {
			if (t.claudeId === claudeId) {
				t.name = newName;
				var span = t.tabEl.querySelector("span:first-child");
				if (span) span.textContent = newName;
			}
		});
	};

	// --- Tab inline rename ---

	function startTabRename(termId) {
		var t = terminals.get(termId);
		if (!t) return;
		var nameSpan = t.tabEl.querySelector("span:first-child");
		if (!nameSpan) return;

		var input = document.createElement("input");
		input.type = "text";
		input.className = "tab-inline-edit";
		input.value = t.name;
		nameSpan.replaceWith(input);
		input.focus();
		input.select();

		function restoreSpan(text) {
			var span = document.createElement("span");
			span.textContent = text;
			span.onclick = function () {
				activateTerminal(termId);
			};
			span.ondblclick = function (e) {
				e.stopPropagation();
				startTabRename(termId);
			};
			input.replaceWith(span);
		}

		var committed = false;
		function commit() {
			var newName = input.value.trim();
			if (newName && newName !== t.name) {
				t.name = newName;
				restoreSpan(newName);
				if (t.claudeId) send("rename-session", { sessionId: t.claudeId, newName: newName });
			} else {
				restoreSpan(t.name);
			}
		}

		input.onblur = function () {
			if (!committed) {
				committed = true;
				commit();
			}
		};
		input.onkeydown = function (e) {
			if (e.key === "Enter") {
				e.preventDefault();
				committed = true;
				commit();
			}
			if (e.key === "Escape") {
				e.preventDefault();
				committed = true;
				restoreSpan(t.name);
			}
		};
	}

	// --- Drag & drop ---

	function setupDragDrop(container, sessionId) {
		container.addEventListener("dragover", function (e) {
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
			container.classList.add("drop-active");
		});
		container.addEventListener("dragleave", function () {
			container.classList.remove("drop-active");
		});
		container.addEventListener("drop", function (e) {
			e.preventDefault();
			container.classList.remove("drop-active");
			var uri =
				e.dataTransfer.getData("text/uri-list") ||
				e.dataTransfer.getData("text/plain") ||
				e.dataTransfer.getData("text");
			if (uri) {
				send("file-dropped", { sessionId: sessionId, uri: uri });
			} else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
				var filePath = e.dataTransfer.files[0].path || e.dataTransfer.files[0].name;
				if (filePath)
					send("file-dropped", { sessionId: sessionId, uri: "file://" + filePath });
			}
		});
	}

	// --- Key handler ---

	function setupKeyHandler(term) {
		var lastCtrlC = 0;
		term.attachCustomKeyEventHandler(function (event) {
			if (event.type !== "keydown") return true;
			if (event.ctrlKey && event.key === "c") {
				var now = Date.now();
				if (now - lastCtrlC < 2000) return false;
				lastCtrlC = now;
				return true;
			}
			if (event.ctrlKey && event.key === "d") return false;
			if (event.ctrlKey && event.key === "z") return false;
			if (event.ctrlKey && event.key === "\\") return false;
			return true;
		});
	}

	// --- Image paste ---

	function setupPasteHandler(container, sessionId) {
		container.addEventListener("paste", function (e) {
			var items = e.clipboardData && e.clipboardData.items;
			if (!items) return;
			for (var i = 0; i < items.length; i++) {
				if (items[i].type.startsWith("image/")) {
					e.preventDefault();
					e.stopPropagation();
					var blob = items[i].getAsFile();
					if (!blob) return;
					var mimeType = items[i].type;
					var reader = new FileReader();
					reader.onload = function () {
						var base64 = reader.result.split(",")[1];
						send("paste-image", {
							sessionId: sessionId,
							data: base64,
							mimeType: mimeType,
						});
					};
					reader.readAsDataURL(blob);
					return;
				}
			}
		});
	}

	// --- Reopen / close error ---

	window.closeErrorTerminal = function (sessionId) {
		send("close-terminal", { sessionId: sessionId });
	};

	window.reopenTerminal = function (sessionId) {
		var t = terminals.get(sessionId);
		if (!t || !t.claudeId) return;
		var claudeId = t.claudeId;
		send("close-terminal", { sessionId: sessionId });
		setTimeout(function () {
			send("resume-claude-session", { claudeSessionId: claudeId });
		}, 200);
	};

	// --- ResizeObserver ---

	var ro = new ResizeObserver(function () {
		clearTimeout(ro._t);
		ro._t = setTimeout(fitActiveTerminal, 100);
	});
	ro.observe(document.getElementById("terminalsArea"));
})();
