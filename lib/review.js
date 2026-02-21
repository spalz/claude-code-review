// FileReview model + merge/finalize logic
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { computeDiff } = require("./diff");
const state = require("./state");

class FileReview {
  constructor(filePath, originalContent, modifiedContent, hunks) {
    this.filePath = filePath;
    this.originalContent = originalContent;
    this.modifiedContent = modifiedContent;
    this.hunks = hunks;
    this.mergedLines = [];
    this.hunkRanges = [];
  }

  get unresolvedCount() {
    return this.hunks.filter((h) => !h.resolved).length;
  }

  get isFullyResolved() {
    return this.hunks.every((h) => h.resolved);
  }
}

function buildMergedContent(modifiedLines, hunks) {
  const result = [];
  const ranges = [];
  let modIdx = 0;
  const sorted = [...hunks].sort((a, b) => a.modStart - b.modStart);

  for (const hunk of sorted) {
    const modHunkStart = hunk.modStart - 1;

    while (modIdx < modHunkStart && modIdx < modifiedLines.length) {
      result.push(modifiedLines[modIdx]);
      modIdx++;
    }

    if (hunk.resolved) {
      const lines = hunk.accepted ? hunk.added : hunk.removed;
      for (const line of lines) result.push(line);
    } else {
      const removedStart = result.length;
      for (const line of hunk.removed) result.push(line);
      const removedEnd = result.length;

      const addedStart = result.length;
      for (const line of hunk.added) result.push(line);
      const addedEnd = result.length;

      ranges.push({
        hunkId: hunk.id,
        removedStart,
        removedEnd,
        addedStart,
        addedEnd,
      });
    }
    modIdx += hunk.added.length;
  }

  while (modIdx < modifiedLines.length) {
    result.push(modifiedLines[modIdx]);
    modIdx++;
  }

  return { lines: result, ranges };
}

async function enterReviewMode(filePath, workspacePath) {
  let originalContent = "";
  const relPath = path.relative(workspacePath, filePath);
  try {
    originalContent = execSync(`git show HEAD:"${relPath}"`, {
      cwd: workspacePath,
      encoding: "utf8",
      timeout: 5000,
      stdio: "pipe",
    });
  } catch {}

  let modifiedContent = "";
  try {
    modifiedContent = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  return createReview(
    filePath,
    originalContent,
    modifiedContent,
    workspacePath,
  );
}

function createReview(
  filePath,
  originalContent,
  modifiedContent,
  workspacePath,
) {
  if (originalContent === modifiedContent) return null;

  const hunks = computeDiff(
    originalContent,
    modifiedContent,
    filePath,
    workspacePath,
  );
  if (hunks.length === 0) return null;

  const modLines = modifiedContent.split("\n");
  const { lines, ranges } = buildMergedContent(modLines, hunks);

  const review = new FileReview(
    filePath,
    originalContent,
    modifiedContent,
    hunks,
  );
  review.mergedLines = lines;
  review.hunkRanges = ranges;
  state.activeReviews.set(filePath, review);
  return review;
}

function buildFinalContent(review) {
  const allAccepted = review.hunks.every((h) => h.accepted);
  if (allAccepted) return review.modifiedContent;

  const allRejected = review.hunks.every((h) => !h.accepted);
  if (allRejected) return review.originalContent;

  const origLines = review.originalContent.split("\n");
  const result = [];
  let oi = 0;

  for (const hunk of review.hunks) {
    const origHunkStart = hunk.origStart - 1;
    while (oi < origHunkStart) {
      result.push(origLines[oi]);
      oi++;
    }
    const lines = hunk.accepted ? hunk.added : hunk.removed;
    for (const line of lines) result.push(line);
    oi += hunk.removed.length;
  }

  while (oi < origLines.length) {
    result.push(origLines[oi]);
    oi++;
  }
  return result.join("\n");
}

function rebuildMerged(review) {
  const modLines = review.modifiedContent.split("\n");
  const { lines, ranges } = buildMergedContent(modLines, review.hunks);
  review.mergedLines = lines;
  review.hunkRanges = ranges;
}

module.exports = {
  FileReview,
  buildMergedContent,
  enterReviewMode,
  createReview,
  buildFinalContent,
  rebuildMerged,
};
