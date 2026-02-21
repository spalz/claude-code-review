// Shared state — reviews + session tracking
const activeReviews = new Map();
let reviewFiles = [];
let currentFileIndex = 0;
let currentHunkIndex = 0;

let codeLensProvider = null;
let mainView = null;

function setCodeLensProvider(p) {
    codeLensProvider = p;
}
function setMainView(p) {
    mainView = p;
}

function getReviewFiles() {
    return reviewFiles;
}
function setReviewFiles(files) {
    reviewFiles = files;
}
function getCurrentFileIndex() {
    return currentFileIndex;
}
function setCurrentFileIndex(idx) {
    currentFileIndex = idx;
}

function getCurrentHunkIndex() {
    return currentHunkIndex;
}
function setCurrentHunkIndex(idx) {
    currentHunkIndex = idx;
}

function refreshAll() {
    codeLensProvider?.refresh();
    mainView?.update();
}

function refreshReview() {
    codeLensProvider?.refresh();
    mainView?.update();
}

module.exports = {
    activeReviews,
    getReviewFiles,
    setReviewFiles,
    getCurrentFileIndex,
    setCurrentFileIndex,
    getCurrentHunkIndex,
    setCurrentHunkIndex,
    setCodeLensProvider,
    setMainView,
    get codeLensProvider() {
        return codeLensProvider;
    },
    refreshAll,
    refreshReview,
};
