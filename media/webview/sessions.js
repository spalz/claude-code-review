// Sessions list rendering, context menu, inline rename
(function () {
	"use strict";

	var cachedSessions = [];
	var openClaudeIds = new Set();
	var ctxTarget = null;

	window.updateOpenClaudeIds = function (ids) {
		openClaudeIds = new Set(ids || []);
	};

	window.getCachedSessions = function () {
		return cachedSessions;
	};

	// --- Sessions rendering ---

	window.renderSessions = function (sessions) {
		if (sessions) cachedSessions = sessions;
		var el = document.getElementById("sessionsList");
		if (!cachedSessions || cachedSessions.length === 0) {
			el.innerHTML =
				'<div class="empty">No sessions found<br><span class="sub">Click + to start a new Claude session</span></div>';
			return;
		}
		var html = "";
		cachedSessions.forEach(function (s) {
			var date = new Date(s.timestamp);
			var ago = timeAgo(date);
			var msgs = s.messageCount ? s.messageCount + " msgs" : "";
			var meta = [ago, msgs].filter(Boolean).join(" \u00b7 ");
			var isOpen = openClaudeIds.has(s.id);
			html +=
				'<div class="session-item' + (isOpen ? " open" : "") + '" data-sid="' + s.id + '">';
			html += '<span class="dot ' + (isOpen ? "active" : "past") + '"></span>';
			html += '<div class="info"><div class="session-title">' + esc(s.title) + "</div>";
			html +=
				'<div class="session-meta">' +
				esc(meta) +
				(isOpen ? " &middot; running" : "") +
				"</div></div>";
			if (s.branch) html += '<span class="branch">' + esc(s.branch) + "</span>";
			html += "</div>";
		});
		el.innerHTML = html;

		el.querySelectorAll(".session-item").forEach(function (item) {
			var sid = item.dataset.sid;
			item.onclick = function () {
				resumeSession(sid);
			};
			item.oncontextmenu = function (e) {
				showCtxMenu(e, sid);
			};
		});
	};

	function timeAgo(date) {
		var sec = Math.floor((Date.now() - date.getTime()) / 1000);
		if (sec < 60) return "just now";
		if (sec < 3600) return Math.floor(sec / 60) + "m ago";
		if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
		return Math.floor(sec / 86400) + "d ago";
	}

	function resumeSession(claudeId) {
		var item = document.querySelector('.session-item[data-sid="' + claudeId + '"]');
		if (item) item.style.opacity = "0.5";
		var el = document.getElementById("sessionsList");
		var loader = document.createElement("div");
		loader.className = "loading-bar";
		loader.id = "sessionLoader";
		el.parentElement.insertBefore(loader, el);
		send("resume-claude-session", { claudeSessionId: claudeId });
	}

	// --- Context menu ---

	function showCtxMenu(e, sessionId) {
		e.preventDefault();
		e.stopPropagation();
		var s = cachedSessions.find(function (x) {
			return x.id === sessionId;
		});
		var isOpen = openClaudeIds.has(sessionId);
		ctxTarget = { sessionId: sessionId, title: s ? s.title : "", isOpen: isOpen };

		var menu = document.getElementById("ctxMenu");
		var html = '<div class="ctx-menu-item" data-action="rename">Rename</div>';
		if (isOpen) {
			html += '<div class="ctx-menu-item" data-action="close">Close session</div>';
		}
		html += '<div class="ctx-menu-sep"></div>';
		html += '<div class="ctx-menu-item danger" data-action="hide">Hide from list</div>';
		menu.innerHTML = html;

		var rect = document.body.getBoundingClientRect();
		var x = e.clientX,
			y = e.clientY;
		menu.style.display = "block";
		if (x + menu.offsetWidth > rect.width) x = rect.width - menu.offsetWidth - 4;
		if (y + menu.offsetHeight > rect.height) y = rect.height - menu.offsetHeight - 4;
		menu.style.left = x + "px";
		menu.style.top = y + "px";

		menu.querySelectorAll(".ctx-menu-item").forEach(function (item) {
			item.onclick = function (ev) {
				ev.stopPropagation();
				handleCtxAction(item.dataset.action);
			};
		});
	}

	function hideCtxMenu() {
		document.getElementById("ctxMenu").style.display = "none";
	}

	document.addEventListener("click", hideCtxMenu);
	document.addEventListener("contextmenu", function (e) {
		if (!e.target.closest(".session-item")) hideCtxMenu();
	});

	function handleCtxAction(action) {
		hideCtxMenu();
		if (!ctxTarget) return;
		var sessionId = ctxTarget.sessionId;
		var title = ctxTarget.title;

		if (action === "rename") {
			startInlineRename(sessionId, title);
		} else if (action === "close") {
			send("close-session-by-claude-id", { claudeSessionId: sessionId });
		} else if (action === "hide") {
			send("hide-session", { sessionId: sessionId });
		}
	}

	// --- Inline rename ---

	function startInlineRename(sessionId, currentTitle) {
		var item = document.querySelector('.session-item[data-sid="' + sessionId + '"]');
		if (!item) return;
		var titleEl = item.querySelector(".session-title");
		if (!titleEl) return;

		var input = document.createElement("input");
		input.type = "text";
		input.className = "inline-edit";
		input.value = currentTitle;
		titleEl.replaceWith(input);
		input.focus();
		input.select();

		item.onclick = null;

		var committed = false;
		function commit() {
			var newName = input.value.trim();
			if (newName && newName !== currentTitle) {
				send("rename-session", { sessionId: sessionId, newName: newName });
				if (window.renameTerminalTab) window.renameTerminalTab(sessionId, newName);
			} else {
				renderSessions(null);
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
				renderSessions(null);
			}
		};
	}

	// --- View toggle ---

	window.showSessionsList = function () {
		var loader = document.getElementById("sessionLoader");
		if (loader) loader.remove();
		document.getElementById("sessionsView").classList.remove("hidden");
		document.getElementById("terminalView").classList.remove("active");
		renderSessions(null);
	};

	window.showTerminalView = function () {
		document.getElementById("sessionsView").classList.add("hidden");
		document.getElementById("terminalView").classList.add("active");
		if (window.fitActiveTerminal) setTimeout(window.fitActiveTerminal, 100);
	};

	// Static button listeners
	document.getElementById("btnRefreshSessions").addEventListener("click", function () {
		send("refresh-sessions");
	});
	document.getElementById("btnNewSession").addEventListener("click", function () {
		send("new-claude-session");
	});
	document.getElementById("btnBackToSessions").addEventListener("click", function () {
		showSessionsList();
	});
	document.getElementById("btnNewTerminal").addEventListener("click", function () {
		send("new-claude-session");
	});
})();
