// Sessions list rendering, context menu, inline rename, popup
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
		el.innerHTML = buildSessionListHtml(cachedSessions);
		bindSessionItems(el);
	};

	function buildSessionListHtml(sessions) {
		var html = "";
		sessions.forEach(function (s) {
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
		return html;
	}

	function bindSessionItems(container) {
		container.querySelectorAll(".session-item").forEach(function (item) {
			var sid = item.dataset.sid;
			item.onclick = function () {
				resumeSession(sid);
			};
			item.oncontextmenu = function (e) {
				showCtxMenu(e, sid);
			};
		});
	}

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

	function showCtxMenu(e, sessionId, isArchived) {
		e.preventDefault();
		e.stopPropagation();
		var s = cachedSessions.find(function (x) {
			return x.id === sessionId;
		});
		var isOpen = openClaudeIds.has(sessionId);
		ctxTarget = { sessionId: sessionId, title: s ? s.title : "", isOpen: isOpen, isArchived: !!isArchived };

		var menu = document.getElementById("ctxMenu");
		var html = "";
		if (isArchived) {
			html += '<div class="ctx-menu-item" data-action="unarchive">Restore</div>';
			html += '<div class="ctx-menu-item danger" data-action="delete">Delete</div>';
		} else {
			html += '<div class="ctx-menu-item" data-action="rename">Rename</div>';
			if (isOpen) {
				html += '<div class="ctx-menu-item" data-action="close">Close session</div>';
			}
			html += '<div class="ctx-menu-sep"></div>';
			html += '<div class="ctx-menu-item" data-action="archive">Archive</div>';
			html += '<div class="ctx-menu-item danger" data-action="delete">Delete</div>';
		}
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
		} else if (action === "archive") {
			send("archive-session", { sessionId: sessionId });
		} else if (action === "unarchive") {
			send("unarchive-session", { sessionId: sessionId });
			// Reload archive list if open
			if (archiveOpen) {
				send("load-archived-sessions");
			}
		} else if (action === "delete") {
			showConfirm("Delete session permanently? This cannot be undone.", function () {
				send("delete-session", { sessionId: sessionId });
				// Reload archive list if the deleted session was archived
				if (ctxTarget && ctxTarget.isArchived && archiveOpen) {
					send("load-archived-sessions");
				}
			});
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
		switchMode("sessions");
		renderSessions(null);
	};

	window.showTerminalView = function () {
		switchMode("terminals");
	};

	// --- Header button listeners ---

	document.getElementById("btnRefresh").addEventListener("click", function () {
		send("refresh-sessions");
	});
	document.getElementById("btnNewChat").addEventListener("click", function () {
		send("new-claude-session");
	});
	document.getElementById("btnSettings").addEventListener("click", function () {
		showSettings();
	});
	document.getElementById("btnNewChat2").addEventListener("click", function () {
		send("new-claude-session");
	});
	document.getElementById("btnSettings2").addEventListener("click", function () {
		showSettings();
	});
	document.getElementById("btnSessionsList").addEventListener("click", function (e) {
		e.stopPropagation();
		var popup = document.getElementById("sessionsPopup");
		if (popup.style.display === "none") {
			loadSessionsPopup(0);
			popup.style.display = "";
		} else {
			popup.style.display = "none";
		}
	});

	// --- Sessions popup with lazy loading ---

	var popupOffset = 0;
	var popupLoading = false;

	window.loadSessionsPopup = function (offset) {
		popupOffset = offset;
		popupLoading = true;
		document.getElementById("sessionsPopupLoader").style.display = "";
		if (offset === 0) {
			document.getElementById("sessionsPopupList").innerHTML = "";
		}
		send("load-sessions", { offset: offset, limit: 10 });
	};

	window.renderSessionsPopup = function (sessions, offset, hasMore) {
		popupLoading = false;
		document.getElementById("sessionsPopupLoader").style.display = "none";

		var list = document.getElementById("sessionsPopupList");
		if (offset === 0) list.innerHTML = "";

		var html = buildSessionListHtml(sessions);
		var fragment = document.createElement("div");
		fragment.innerHTML = html;

		// Bind click handlers for popup items
		fragment.querySelectorAll(".session-item").forEach(function (item) {
			var sid = item.dataset.sid;
			item.onclick = function () {
				document.getElementById("sessionsPopup").style.display = "none";
				resumeSession(sid);
			};
		});

		while (fragment.firstChild) {
			list.appendChild(fragment.firstChild);
		}

		// Store hasMore for scroll handler
		list.dataset.hasMore = hasMore ? "1" : "0";
		popupOffset = offset + sessions.length;
	};

	// Scroll-to-load-more in popup
	document.getElementById("sessionsPopupScroll").addEventListener("scroll", function () {
		var el = this;
		var list = document.getElementById("sessionsPopupList");
		if (
			!popupLoading &&
			list.dataset.hasMore === "1" &&
			el.scrollTop + el.clientHeight >= el.scrollHeight - 30
		) {
			loadSessionsPopup(popupOffset);
		}
	});

	// --- Archive section ---

	var archiveOpen = false;
	var archiveLoaded = false;

	window.updateArchiveButton = function (count) {
		var section = document.getElementById("archiveSection");
		var countEl = document.getElementById("archiveCount");
		if (count > 0) {
			section.style.display = "";
			countEl.textContent = count;
		} else {
			section.style.display = "none";
			// Reset state when no archived sessions
			archiveOpen = false;
			archiveLoaded = false;
			document.getElementById("archiveList").style.display = "none";
			document.getElementById("archiveArrow").classList.remove("open");
		}
	};

	function toggleArchive() {
		archiveOpen = !archiveOpen;
		var list = document.getElementById("archiveList");
		var arrow = document.getElementById("archiveArrow");
		if (archiveOpen) {
			list.style.display = "";
			arrow.classList.add("open");
			if (!archiveLoaded) {
				list.innerHTML = '<div class="empty" style="padding:12px;font-size:12px">Loading...</div>';
				send("load-archived-sessions");
				archiveLoaded = true;
			}
		} else {
			list.style.display = "none";
			arrow.classList.remove("open");
		}
	}

	document.getElementById("archiveToggle").addEventListener("click", toggleArchive);

	window.renderArchivedSessions = function (sessions) {
		var list = document.getElementById("archiveList");
		if (!sessions || sessions.length === 0) {
			list.innerHTML = '<div class="empty" style="padding:12px;font-size:12px">No archived sessions</div>';
			return;
		}
		list.innerHTML = buildSessionListHtml(sessions);
		list.querySelectorAll(".session-item").forEach(function (item) {
			var sid = item.dataset.sid;
			item.onclick = function () {
				resumeSession(sid);
			};
			item.oncontextmenu = function (e) {
				showCtxMenu(e, sid, true);
			};
		});
		// Reset loaded flag so next toggle will reload fresh data
		archiveLoaded = true;
	};

})();
