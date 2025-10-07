/* scripts/uninstall.js */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

function getEditorJsonPath() {
  const home = os.homedir();
  let basePath;

  if (process.platform === "win32") {
    basePath = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  } else if (process.platform === "darwin") {
    basePath = path.join(home, "Library", "Application Support");
  } else {
    // If you later support Linux, add it here.
    return null;
  }

  const folderPath = path.join(basePath, "HuTouchAi");
  const editorJsonPath = path.join(folderPath, "editor.json");
  return { folderPath, editorJsonPath };
}

function rmdirIfEmpty(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    const contents = fs.readdirSync(dir);
    if (contents.length === 0) {
      fs.rmdirSync(dir);
      console.log(`Removed empty folder: ${dir}`);
    }
  } catch (e) {
    console.warn(`Could not remove folder ${dir}: ${e.message}`);
  }
}

(function run() {
  try {
    const paths = getEditorJsonPath();
    if (!paths) {
      console.log("Unsupported OS for uninstall cleanup; skipping.");
      return;
    }

    const { folderPath, editorJsonPath } = paths;

    if (fs.existsSync(editorJsonPath)) {
      fs.unlinkSync(editorJsonPath);
      console.log(`Deleted editor.json at: ${editorJsonPath}`);
    } else {
      console.log("editor.json not found; nothing to delete.");
    }

    // Optional: tidy up the parent folder if you created it and it's now empty.
    rmdirIfEmpty(folderPath);
  } catch (err) {
    // Log to console so VS Code can capture it in its uninstall output.
    console.error("HuTouch uninstall cleanup failed:", err.message);
  }
})();
