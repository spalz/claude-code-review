// Settings panel — shortcuts display, hook status, CLI command
(function () {
	"use strict";

	window.updateShortcuts = function (bindings) {
		var el = document.getElementById("shortcutsContainer");
		if (!bindings || bindings.length === 0) {
			el.innerHTML = '<div style="font-size:12px;opacity:.4">No shortcuts configured</div>';
			return;
		}
		var html = "";
		bindings.forEach(function (b) {
			html += '<div class="shortcut-row">';
			html += '<span class="keys">' + esc(b.key) + "</span>";
			html += '<span class="desc">' + esc(b.desc) + "</span>";
			html += "</div>";
		});
		el.innerHTML = html;
	};

	// Static button listeners
	document.getElementById("hookActionBtn").addEventListener("click", function () {
		send("install-hook");
	});
	document.getElementById("cliSelect").addEventListener("change", function () {
		send("set-cli-command", { value: this.value });
	});
	document.getElementById("btnCustomizeKeys").addEventListener("click", function () {
		send("open-keybindings");
	});

	window.updateHookUI = function (status) {
		var dot = document.getElementById("hookDot");
		var text = document.getElementById("hookStatusText");
		var sub = document.getElementById("hookStatusSub");
		var btn = document.getElementById("hookActionBtn");
		if (status === "installed") {
			dot.className = "hook-dot ok";
			text.textContent = "Hook installed";
			sub.textContent = "Changes by Claude Code are tracked automatically";
			btn.style.display = "none";
		} else if (status === "outdated") {
			dot.className = "hook-dot warn";
			text.textContent = "Hook outdated";
			sub.textContent = "Update required for latest features";
			btn.textContent = "Update";
			btn.style.display = "";
		} else {
			dot.className = "hook-dot err";
			text.textContent = "Hook not installed";
			sub.textContent = "Required to track changes by Claude Code";
			btn.textContent = "Install";
			btn.style.display = "";
		}
	};
})();
