// Review panel rendering — file list, actions, accept/reject
(function () {
	"use strict";

	var currentFilePath = null;

	window.getCurrentFilePath = function () {
		return currentFilePath;
	};
	window.setCurrentFilePath = function (fp) {
		currentFilePath = fp;
	};

	window.goToFile = function (fp) {
		send("go-to-file", { filePath: fp });
	};
	window.acceptFile = function (fp) {
		send("accept-file", { filePath: fp });
	};
	window.rejectFile = function (fp) {
		send("reject-file", { filePath: fp });
	};
	window.acceptCurrentFile = function () {
		if (currentFilePath) send("accept-file", { filePath: currentFilePath });
	};
	window.rejectCurrentFile = function () {
		if (currentFilePath) send("reject-file", { filePath: currentFilePath });
	};

	// Event delegation — one listener for all dynamic review buttons
	document.getElementById("reviewContent").addEventListener("click", function (e) {
		var btn = e.target.closest("[data-action]");
		if (btn) {
			e.stopPropagation();
			var action = btn.dataset.action;
			var fp = btn.dataset.path;
			if (action === "prev-file") send("prev-file");
			else if (action === "next-file") send("next-file");
			else if (action === "accept-current") acceptCurrentFile();
			else if (action === "reject-current") rejectCurrentFile();
			else if (action === "accept-all") send("accept-all");
			else if (action === "reject-all") send("reject-all");
			else if (action === "accept-file" && fp) acceptFile(fp);
			else if (action === "reject-file" && fp) rejectFile(fp);
			return;
		}
		var fileRow = e.target.closest(".file[data-path]");
		if (fileRow) goToFile(fileRow.dataset.path);
	});

	window.renderReview = function (data) {
		if (!data) return;
		var el = document.getElementById("reviewContent");
		var remaining = data.remaining;
		var total = data.total;
		var currentFile = data.currentFile;
		var unresolvedHunks = data.unresolvedHunks;
		var totalHunks = data.totalHunks;
		var files = data.files;
		var noReview = remaining === 0 && files.length === 0;

		// Update Review tab badge
		var reviewTab = document.querySelector('.tab[data-tab="review"]');
		if (reviewTab) {
			reviewTab.textContent = remaining > 0 ? "Review (" + remaining + ")" : "Review";
			reviewTab.dataset.tab = "review";
		}

		var html = "";

		if (noReview) {
			html +=
				'<div class="empty">No changes from Claude yet<br><span class="sub">Changes will appear here automatically</span></div>';
		} else {
			if (currentFile) {
				html +=
					'<div class="r-info">' +
					esc(currentFile) +
					" &mdash; " +
					unresolvedHunks +
					"/" +
					totalHunks +
					" changes</div>";
				html += '<div class="actions">';
				html += '<button class="btn nav" data-action="prev-file">&lsaquo;</button>';
				html += '<button class="btn nav" data-action="next-file">&rsaquo;</button>';
				html +=
					'<button class="btn keep" data-action="accept-current">&#10003; Accept File</button>';
				html +=
					'<button class="btn undo" data-action="reject-current">&#10007; Reject File</button>';
				html += "</div>";
			}
			html += '<div class="r-info">' + remaining + "/" + total + " files remaining</div>";
			html += '<div class="actions">';
			html +=
				'<button class="btn keep" data-action="accept-all" ' +
				(remaining === 0 ? "disabled" : "") +
				">Accept All</button>";
			html +=
				'<button class="btn undo" data-action="reject-all" ' +
				(remaining === 0 ? "disabled" : "") +
				">Reject All</button>";
			html += "</div>";
			html += '<div class="sep"></div><div class="file-list-title">Files</div>';
			files.forEach(function (f) {
				var cls = f.active ? "file active" : f.done ? "file done" : "file";
				var status = f.done ? "done" : f.unresolved + "/" + f.total;
				var extIcon = f.external
					? '<span style="color:#e8a838;margin-right:2px" title="External file">&#9888;</span>'
					: "";
				html += '<div class="' + cls + '" data-path="' + escAttr(f.path) + '">';
				html += '<span class="file-icon">' + (f.done ? "&#10003;" : "&#9679;") + "</span>";
				html += extIcon + '<span class="file-name">' + esc(f.name) + "</span>";
				html += '<span class="file-status">' + status + "</span>";
				if (!f.done) {
					html +=
						'<button class="fb keep-btn" data-action="accept-file" data-path="' +
						escAttr(f.path) +
						'" title="Accept">&#10003;</button>';
					html +=
						'<button class="fb undo-btn" data-action="reject-file" data-path="' +
						escAttr(f.path) +
						'" title="Reject">&#10007;</button>';
				}
				html += "</div>";
			});
		}
		el.innerHTML = html;
	};
})();
