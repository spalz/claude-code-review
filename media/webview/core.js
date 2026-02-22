// Core utilities — loaded first, provides globals for other webview modules
(function () {
	"use strict";

	const vsc = acquireVsCodeApi();

	window.send = function (type, data) {
		vsc.postMessage({ type, ...(data || {}) });
	};

	window.esc = function (s) {
		return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	};

	window.escAttr = function (s) {
		return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
	};

	// Tab management
	window.activeTab = "claude";

	document.querySelectorAll(".tab").forEach(function (t) {
		t.addEventListener("click", function () {
			switchTab(t.dataset.tab);
		});
	});

	window.switchTab = function (tab) {
		window.activeTab = tab;
		document.querySelectorAll(".tab").forEach(function (t) {
			t.classList.toggle("active", t.dataset.tab === tab);
		});
		document.querySelectorAll(".panel").forEach(function (p) {
			p.classList.toggle("active", p.id === "panel-" + tab);
		});
		if (tab === "claude" && window.fitActiveTerminal) {
			window.fitActiveTerminal();
		}
	};
})();
