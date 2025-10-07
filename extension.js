const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const express = require("express");
require("dotenv").config();
const asyncHandler = require("./asyncHandler");
const { diffLines } = require("diff");
const diffMatchPatch = require("diff-match-patch");
const JsDiff = require("diff");
const axios = require("axios");
const net = require("net");

const PORT = 45678;
let statusBarItem;
let outputChannel;

const vscodeConfig = vscode.workspace.getConfiguration("hutouch");
const LOG_API_KEY =
  vscodeConfig.get("apiKey") ||
  process.env.HUTOUCH_LOG_API_KEY ||
  process.env.HUTOUCH_EXTENSION_LOG_API_KEY ||
  process.env.HUTOUCH_API_KEY;
  
let logApiKeyWarningShown = false;

const USER_ID = getUserIdFromFile();

// -----------------
// Diff tracking for polling
// -----------------
/** Right-hand (modified) file paths of open diff tabs */
let diffRightFsPaths = new Set();
/** Has anything changed on any right-hand file since the last poll? */
let diffDirty = false;
/** Optional metadata for the last change */
let lastChangeInfo = null;

/** Safely coerce VS Code tab inputs into a Uri without using Uri.isUri */
function asUri(maybe) {
  try {
    // Case 1: already a Uri instance
    if (maybe instanceof vscode.Uri) {
      return maybe;
    }
    // Case 2: wrapper like { uri: Uri | Uri-like }
    if (maybe && typeof maybe === "object" && "uri" in maybe) {
      const inner = /** @type {any} */ (maybe).uri;
      if (inner instanceof vscode.Uri) return inner;
      if (
        inner &&
        typeof inner === "object" &&
        typeof inner.scheme === "string" &&
        (typeof inner.fsPath === "string" || typeof inner.path === "string")
      ) {
        return /** @type {import('vscode').Uri} */ (inner);
      }
    }
    // Case 3: duck-typed Uri-like (rare)
    if (
      maybe &&
      typeof maybe === "object" &&
      typeof maybe.scheme === "string" &&
      (typeof maybe.fsPath === "string" || typeof maybe.path === "string")
    ) {
      return /** @type {import('vscode').Uri} */ (maybe);
    }
    // (Optional) Case 4: string path → make a file Uri
    if (typeof maybe === "string") {
      return vscode.Uri.file(maybe);
    }
  } catch (_) {}
  return null;
}

/** Re-scan open tabs and collect all right-hand (modified) files */
function refreshDiffRightsFromTabs() {
  try {
    const next = new Set();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        // Guard against TS "unknown" by checking property existence
        if (
          input &&
          typeof input === "object" &&
          "modified" in input &&
          "original" in input
        ) {
          // TabInputTextDiff has { original, modified }, each is (or wraps) a Uri
          const rightUri = asUri(input.modified);
          if (rightUri?.fsPath) next.add(rightUri.fsPath);
        }
      }
    }
    diffRightFsPaths = next;
  } catch (e) {
    outputChannel?.appendLine(`refreshDiffRightsFromTabs error: ${e.message}`);
  }
}

/** True if a change happened on the right side of an open diff */
function isChangeOnRightDiffSide(uri) {
  return diffRightFsPaths.has(uri?.fsPath || uri?.path || "");
}

// helper to post logs using that USER_ID
async function sendLogToDB(source, message) {
  if (!USER_ID) return;

  if (!LOG_API_KEY) {
    if (!logApiKeyWarningShown) {
      const warning =
        "HuTouch log API key missing. Set HUTOUCH_LOG_API_KEY (or HUTOUCH_EXTENSION_LOG_API_KEY) in your environment or .env file.";
      console.warn(warning);
      vscode.window.showWarningMessage(warning);
      logApiKeyWarningShown = true;
    }
    return;
  }

  const payload = {
    user_id: Number(USER_ID),
    source,
    message,
  };

  try {
    await axios.post("https://php.niiti.com/api/store_app_logs", payload, {
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": LOG_API_KEY,
      },
    });
  } catch (err) {
    if (err.response) {
      console.error(
        `Log POST failed (${err.response.status}):`,
        err.response.data
      );
    } else {
      console.error("Log POST error:", err.message);
    }
  }
}


function activate(context) {
  // Create the output channel for logging
  outputChannel = vscode.window.createOutputChannel(
    "HuTouch AI Extension Logs"
  );
  outputChannel.show(true); // Show the output channel when the extension is activated

  const originalAppend = outputChannel.appendLine.bind(outputChannel);

  // override it to also call sendLogToDB
  outputChannel.appendLine = (line) => {
    originalAppend(line);
    sendLogToDB("Extension", line);
  };

  // Create the status bar item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = `$(robot) HuTouch AI`;
  statusBarItem.tooltip = "HuTouch AI Code is running";
  statusBarItem.command = "extension.showStatus";
  statusBarItem.show();

  outputChannel.appendLine(
    "HuTouch AI code extension is active in current workspace"
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("extension.showStatus", () => {
      vscode.window.showInformationMessage(
        "HuTouch AI Code is Active and Running!"
      );
    })
  );
  var line = "HuTouch AI Code is Active and Running for user ID: ${USER_ID}";

  try {
    sendLogToDB("Extension", line);
  } catch (error) {
    outputChannel.appendLine(`Error sending log to DB: ${error.message}`);
  }

  // Check and create the editor.json file
  checkAndCreateEditorJson(context);

  // Check if this instance should start the server
  manageServerActivation(context);

  const platformName =
    {
      win32: "Windows",
      darwin: "macOS",
      linux: "Linux",
    }[process.platform] || process.platform;

  outputChannel.appendLine(`🖥️ Extension is running on: ${platformName}`);
  try {
    let line2 = `🖥️ Extension is running on: ${platformName}`;
    sendLogToDB("Extension", line2);
  } catch (error) {
    outputChannel.appendLine(`Error sending log to DB: ${error.message}`);
  }

  // Add the status bar item and output channel to context subscriptions to ensure cleanup on deactivation
  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(outputChannel);

  // -----------------
  // Diff watchers (for polling endpoint)
  // -----------------
  refreshDiffRightsFromTabs();
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => refreshDiffRightsFromTabs()),
    vscode.window.onDidChangeActiveTextEditor(() => refreshDiffRightsFromTabs())
  );

  // Flag when the RIGHT side changes (accept-arrow or manual edit)
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((evt) => {
      try {
        const doc = evt?.document;
        if (!doc || doc.isClosed) return;
        if (!isChangeOnRightDiffSide(doc.uri)) return;

        diffDirty = true;
        lastChangeInfo = {
          file_path: doc.uri.fsPath,
          file_name: path.basename(doc.uri.fsPath),
          change_count: evt.contentChanges?.length ?? 0,
          ts: Date.now()
        };
      } catch (e) {
        outputChannel?.appendLine(`onDidChangeTextDocument diff notify error: ${e.message}`);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      try {
        if (!isChangeOnRightDiffSide(doc.uri)) return;
        diffDirty = true;
        lastChangeInfo = {
          file_path: doc.uri.fsPath,
          file_name: path.basename(doc.uri.fsPath),
          change_count: 0,
          ts: Date.now(),
          event: "save"
        };
      } catch (e) {
        outputChannel?.appendLine(`onDidSaveTextDocument diff notify error: ${e.message}`);
      }
    })
  );
}

async function deactivate() {
  outputChannel.appendLine("Deactivating extension and disposing resources.");

  const { editorJsonPath } = getEditorJsonPath();

  try {
    if (statusBarItem) {
      statusBarItem.dispose();
      outputChannel.appendLine("Status bar item disposed.");
    }

    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            outputChannel.appendLine(`Error closing server: ${err.message}`);
            reject(err);
          } else {
            outputChannel.appendLine("Server closed gracefully.");
            resolve();
          }
        });
      });
    }
  } catch (error) {
    outputChannel.appendLine(`Error during cleanup: ${error.message}`);
  }

  if (outputChannel) {
    outputChannel.dispose();
  }
}

const EXCLUDED_DIRS = [
  "nbproject",
  "node_modules",
  "bower_components",
  ".vscode-test",
  "debug",
  ".vscode",
  ".flutter-plugins",
  ".flutter-plugins-dependencies",
  ".plugin_symlinks",
  "ephemeral",
  "dist",
  "build",
  ".git",
  "coverage",
  "out",
  "bin",
  "obj",
  "Runner",
  "target",
  "__pycache__",
  ".idea",
  ".gradle",
  ".mvn",
  ".settings",
  ".classpath",
  ".project",
  "CMakeFiles",
  "CMakeCache.txt",
  ".vs",
  "packages",
  ".history",
  ".terraform",
  ".serverless",
  ".pytest_cache",
  ".venv",
  "Pods",
  "DerivedData",
  ".next",
  ".nuxt",
  "vendor",
  ".sass-cache",
  ".cache",
  ".parcel-cache",
  "elm-stuff",
  "_site",
  "public",
  ".docusaurus",
  "static",
  ".expo",
  ".cache-loader",
  ".dart_tool",
  "runner",
];
const EXCLUDED_FILES = [
  ".gitignore",
  "README.md",
  "yarn.lock",
  "package-lock.json",
  ".metadata",
  ".DS_Store",
  ".editorconfig",
  ".gitattributes",
  ".gitkeep",
  ".gitmodules",
  ".npmignore",
  ".prettierignore",
  ".prettierrc",
  ".stylelintrc",
  ".eslintignore",
  ".eslintrc",
  ".babelrc",
  "analysis_options.yaml",
];
const EXCLUDED_EXTENSIONS = [
  ".properties",
  ".lock",
  ".h",
  ".jpg",
  "iml",
  ".jpeg",
  ".iml",
  ".jar",
  ".png",
  ".lock",
  ".gif",
  ".bmp",
  ".svg",
  ".ico",
  ".webp",
  ".tif",
  ".tiff",
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".mp4",
  ".avi",
  ".mkv",
  ".mov",
  ".wmv",
  ".flv",
  ".webm",
  ".m4v",
  ".3gp",
  ".mpg",
  ".mpeg",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".epub",
  ".mobi",
  ".azw",
  ".azw3",
  ".lit",
  ".lrf",
  ".cbr",
  ".cbz",
  ".cb7",
  ".cbt",
  ".cba",
  ".psd",
  ".ai",
  ".eps",
  ".indd",
  ".xd",
  ".sketch",
  ".fig",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
  ".bz2",
  ".xz",
  ".iso",
  ".dmg",
  ".exe",
  ".msi",
  ".dll",
  ".deb",
  ".rpm",
  ".sh",
  ".bat",
  ".com",
  ".vbs",
  ".ps1",
  ".apk",
  ".ipa",
  ".jar",
  ".war",
  ".ear",
  ".phar",
  ".xcconfig",
];

function shouldExclude(fileOrDir) {
  const name = path.basename(fileOrDir);
  const ext = path.extname(fileOrDir).toLowerCase();
  const isExcluded =
    EXCLUDED_DIRS.includes(name) ||
    EXCLUDED_FILES.includes(name) ||
    EXCLUDED_EXTENSIONS.includes(ext);
  return isExcluded;
}

function groupConsecutiveLines(selectedLines, diagnostics, fileLines) {
  if (!selectedLines || selectedLines.length === 0) return [];

  const sortedLines = Array.from(new Set(selectedLines)).sort((a, b) => a - b);

  const groups = [];
  let currentGroup = {
    start_line: sortedLines[0],
    end_line: sortedLines[0],
    content: fileLines[sortedLines[0] - 1] || "",
    errors: [],
  };

  for (let i = 1; i < sortedLines.length; i++) {
    const lineNumber = sortedLines[i];

    if (lineNumber === currentGroup.end_line + 1) {
      currentGroup.end_line = lineNumber;
      currentGroup.content += `\n${fileLines[lineNumber - 1] || ""}`;
    } else {
      groups.push(currentGroup);
      currentGroup = {
        start_line: lineNumber,
        end_line: lineNumber,
        content: fileLines[lineNumber - 1] || "",
        errors: [],
      };
    }
  }

  groups.push(currentGroup);

  groups.forEach((group) => {
    diagnostics.forEach((diag) => {
      const diagStartLine = diag.range.start.line + 1;
      const diagEndLine = diag.range.end.line + 1;

      if (diagStartLine >= group.start_line && diagEndLine <= group.end_line) {
        group.errors.push({
          message: diag.message,
          severity:
            diag.severity === vscode.DiagnosticSeverity.Error
              ? "Error"
              : diag.severity === vscode.DiagnosticSeverity.Warning
              ? "Warning"
              : "Information",
          source: diag.source || "Unknown",
          range: {
            start: {
              line: diag.range.start.line + 1,
              character: diag.range.start.character,
            },
            end: {
              line: diag.range.end.line + 1,
              character: diag.range.end.character,
            },
          },
        });
      }
    });
  });

  return groups;
}

function getFilesRecursive(dir) {
  let results = [];
  try {
    const list = fs.readdirSync(dir);
    list.forEach(function (file) {
      const fullPath = path.resolve(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory() && !shouldExclude(fullPath)) {
        results = results.concat(getFilesRecursive(fullPath));
      } else if (stat.isFile() && !shouldExclude(fullPath)) {
        results.push(fullPath);
      }
    });
  } catch (error) {
    outputChannel.appendLine(
      `Error reading directory ${dir}: ${error.message}`
    );
  }
  return results;
}





async function findMultipleFileDetails(fileNames, rootPath) {
  const allFiles = getFilesRecursive(rootPath);
  const fileDetails = [];

  for (const fileName of fileNames) {
    const fileFullPath = allFiles.find(
      (f) => path.basename(f).toLowerCase() === fileName.toLowerCase()
    );

    if (!fileFullPath) {
      const errorMessage = `File not found in the project: ${fileName}`;
      outputChannel.appendLine(errorMessage);
      throw new Error(errorMessage);
    }

    try {
      const fileContent = fs.readFileSync(fileFullPath, "utf8");
      outputChannel.appendLine(`Reading file content for: ${fileName}`);

      fileDetails.push({
        file_path: fileFullPath,
        content: fileContent,
        imports: [],
        dependencies: [],
      });
    } catch (error) {
      outputChannel.appendLine(
        `Error processing file ${fileName}: ${error.message}`
      );
      throw error;
    }
  }

  return fileDetails;
}

function getUserIdFromFile() {
  const home = os.homedir();

  let configRoot;
  if (process.platform === "win32") {
    configRoot =
      process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  } else if (process.platform === "darwin") {
    configRoot = path.join(home, "Library", "Application Support");
  } else {
    configRoot = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  }

  const userIdFile = path.join(configRoot, "HuTouchAi", "userId.txt");
  try {
    const data = fs.readFileSync(userIdFile, "utf8");
    return data.trim();
  } catch (err) {
    console.warn(`Could not read userId.txt at ${userIdFile}:`, err.message);
    return null;
  }
}

// -----------------
/**
 * Identify the project type based on the presence of specific files.
 * @param {string} dir - The project root directory.
 * @returns {string|null} - Returns "flutter", "react-native", or null if undetermined.
 */
function identifyProjectType(dir) {
  try {
    if (fs.existsSync(path.join(dir, "pubspec.yaml"))) {
      return "flutter";
    }
    if (
      fs.existsSync(path.join(dir, "lib")) &&
      fs
        .readdirSync(path.join(dir, "lib"))
        .some((file) => file.endsWith(".dart"))
    ) {
      return "flutter";
    }
    if (fs.existsSync(path.join(dir, "package.json"))) {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(dir, "package.json"), "utf-8")
      );
      if (
        packageJson.dependencies &&
        packageJson.dependencies["react-native"]
      ) {
        return "react-native";
      }
    }
    return null; // Unknown project type
  } catch (error) {
    console.error(`Error identifying project type: ${error.message}`);
    return null;
  }
}

/**
 * Generate the folder structure as a tree-like string.
 * @param {string} dir - The project root directory.
 * @param {string} prefix - The current tree prefix for indentation.
 * @param {string|null} outputFile - File path to save the result, if specified.
 * @returns {string} - The generated folder structure as a string.
 */
function generateFolderStructure(dir, prefix = "", outputFile = null) {
  let result = "";

  try {
    console.log(`Starting folder structure generation for: ${dir}`);
    const projectType = identifyProjectType(dir);

    if (!projectType) {
      console.error(`Could not determine project type for directory: ${dir}`);
      return result;
    }

    const targetDir =
      projectType === "flutter"
        ? path.join(dir, "lib")
        : projectType === "react-native"
        ? path.join(dir, "src")
        : null;

    if (!targetDir || !fs.existsSync(targetDir)) {
      console.error(`Target directory (${targetDir}) does not exist.`);
      return result;
    }

    function traverse(directory, currentPrefix) {
      let items;
      try {
        items = fs.readdirSync(directory);
      } catch (error) {
        console.error(`Error reading directory ${directory}: ${error.message}`);
        return;
      }

      items.forEach((item, index) => {
        const fullPath = path.join(directory, item);

        if (shouldExclude(fullPath)) {
          console.log(`Excluded: ${fullPath}`);
          return;
        }

        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch (error) {
          console.error(`Error accessing ${fullPath}: ${error.message}`);
          return;
        }

        const isLast = index === items.length - 1;
        const newPrefix = currentPrefix + (isLast ? "└── " : "├── ");

        if (stat.isDirectory()) {
          result += `${newPrefix}${item}/\n`;
          console.log(`Directory: ${fullPath}`);
          traverse(fullPath, currentPrefix + (isLast ? "    " : "│   "));
        } else if (stat.isFile()) {
          result += `${newPrefix}${item}\n`;
          console.log(`File: ${fullPath}`);
        }
      });
    }

    result += `${prefix}${path.basename(targetDir)}/\n`;
    traverse(targetDir, prefix + "    ");

    if (outputFile) {
      try {
        fs.writeFileSync(outputFile, result, "utf-8");
        console.log(`Folder structure saved to: ${outputFile}`);
      } catch (error) {
        console.error(`Error writing to file ${outputFile}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`Unexpected error: ${error.message}`);
  }

  return result;
}

function listAssetFiles(dir, baseDir = "") {
  let results = [];
  outputChannel.appendLine(`Listing asset files in: ${dir}`);
  try {
    const list = fs.readdirSync(dir);

    list.forEach((file) => {
      const fullPath = path.resolve(dir, file);
      const stat = fs.statSync(fullPath);
      const relativePath = path.join(baseDir, file);

      if (stat.isFile()) {
        results.push(relativePath);
      } else if (stat.isDirectory()) {
        results = results.concat(listAssetFiles(fullPath, relativePath));
      }
    });
  } catch (error) {
    outputChannel.appendLine(
      `Error reading directory ${dir}: ${error.message}`
    );
  }
  return results;
}

function getEditorJsonPath() {
  const home = os.homedir();
  let basePath;

  if (process.platform === "win32") {
    basePath = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  } else if (process.platform === "darwin") {
    basePath = path.join(home, "Library", "Application Support");
  } else {
    throw new Error("Unsupported OS for HuTouch AI extension");
  }

  const folderPath = path.join(basePath, "HuTouchAi");
  const editorJsonPath = path.join(folderPath, "editor.json");

  return { folderPath, editorJsonPath };
}

function checkAndCreateEditorJson(context) {
  const { folderPath, editorJsonPath: filePath } = getEditorJsonPath();

  if (!fs.existsSync(folderPath)) {
    try {
      fs.mkdirSync(folderPath, { recursive: true });
    } catch (error) {
      return;
    }
  }

  if (!fs.existsSync(filePath)) {
    const jsonData = { ide: "vs-code" };
    try {
      fs.writeFileSync(filePath, JSON.stringify(jsonData, null, 2), "utf8");
    } catch (error) {
      outputChannel.appendLine(`Error writing editor.json: ${error.message}`);
    }
  } else {
    try {
      const fileContent = fs.readFileSync(filePath, "utf8");
      let jsonData = JSON.parse(fileContent);
      if (jsonData.ide === "android-studio") {
        jsonData.ide = "vs-code";
        fs.writeFileSync(filePath, JSON.stringify(jsonData, null, 2), "utf8");
      }
    } catch (error) {
    }
  }
}
let server;

async function manageServerActivation(context) {
  const currentWindowId =
    (context.storageUri && context.storageUri.fsPath) ||
    (vscode.workspace.workspaceFolders &&
      vscode.workspace.workspaceFolders[0] &&
      vscode.workspace.workspaceFolders[0].uri.fsPath) ||
    "unknown";

  const serverIsRunning = await new Promise((resolve) => {
    const sock = new net.Socket();
    sock
      .once("error", () => resolve(false))
      .once("connect", () => {
        sock.end();
        resolve(true);
      })
      .connect(PORT, "127.0.0.1");
  });

  if (serverIsRunning) {
    const choice = await vscode.window.showInformationMessage(
      "HuTouch AI is already active in another VS Code window. Do you want to switch it to this project?",
      { modal: true },
      "Switch to this project",
      "Stay with previous project"
    );

    if (choice !== "Switch to this project") {
      outputChannel.appendLine(
        "User opted to stay with the previously active project. This window will remain inactive."
      );
      try {
        await sendLogToDB(
          "Extension",
          "User declined switch; keeping previous project active."
        );
      } catch (_) {}

      statusBarItem.text = `$(error) HuTouch AI`;
      statusBarItem.tooltip =
        "Inactive: another workspace is running HuTouch (you chose to stay on the old project).";
      statusBarItem.color = new vscode.ThemeColor("errorForeground");
      statusBarItem.command = undefined;
      return;
    }

    try {
      await axios.post(`http://127.0.0.1:${PORT}/shutdown`);
    } catch (e) {
      outputChannel.appendLine(
        "⚠️ Could not contact existing HuTouch server for shutdown: " +
          e.message
      );
    }
    await waitForPortFree(PORT);
  }

  startServer(context);
  context.globalState.update("activeWindow", currentWindowId);

  statusBarItem.text = `$(robot) HuTouch AI`;
  statusBarItem.tooltip = "HuTouch AI Code is running";
  statusBarItem.color = undefined;
}

function deactivateServer(context) {
  if (server) {
    server.close(() => {
      server = null;
      context.globalState.update("activeWindow", null);
      vscode.window.showInformationMessage("HuTouch AI server deactivated.");
      outputChannel.appendLine("Server deactivated.");
    });
  } else {
    vscode.window.showWarningMessage("No server is currently running.");
    outputChannel.appendLine(
      "Attempted to deactivate server, but no server is running."
    );
  }
}

function waitForPortFree(
  port,
  host = "127.0.0.1",
  interval = 100,
  timeout = 5000
) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function check() {
      const sock = new net.Socket();
      sock
        .once("error", () => {
          resolve();
        })
        .once("connect", () => {
          sock.end();
          if (Date.now() - start > timeout) {
            resolve();
          } else {
            setTimeout(check, interval);
          }
        })
        .connect(port, host);
    })();
  });
}

// Function to start the Express server and define API routes
function startServer(context) {
  if (server) {
    outputChannel.appendLine("Server is already running.");
    return;
  }

  const app = express();
  app.use(express.json());

  // -----------------
  // Polling endpoint: return "modified" once per change, otherwise "same"
  // -----------------
  app.get("/diff-events", (req, res) => {
    try {
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (diffDirty) {
        diffDirty = false; // reset so subsequent polls return "same" until next change
        return res.status(200).json({ status: "modified" });
      }
      return res.status(200).json({ status: "same" });
    } catch (e) {
      outputChannel?.appendLine(`/diff-events error: ${e.message}`);
      return res.status(500).json({ status: "same" });
    }
  });

  // Initialize diagnostics cache
  const diagnosticsCache = {};

  // Listen to diagnostic changes to invalidate cache
  vscode.languages.onDidChangeDiagnostics((event) => {
    event.uris.forEach((uri) => {
      const filePath = uri.fsPath;
      if (diagnosticsCache[filePath]) {
        delete diagnosticsCache[filePath];
      }
    });
  });

  app.post(
    "/modify-code",
    asyncHandler(async (req, res) => {
      console.log("Received request for /modify-code");

      const { updatedCode } = req.body;
      if (!updatedCode) {
        return res
          .status(400)
          .json({ error: "The updatedCode field is required." });
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return res.status(400).json({ error: "No active editor found." });
      }

      const selection = editor.selection;
      if (selection.isEmpty) {
        return res
          .status(400)
          .json({ error: "Please select some code first." });
      }
      const doc = editor.document;

      const marker = "\n/* HuTouch AI GENERATED CODE BELOW */\n";
      const insertedText = marker + updatedCode;

      await editor.edit((editBuilder) => {
        const insertPosition = selection.end;
        editBuilder.insert(insertPosition, insertedText);
      });

      const insertedStart = selection.end;
      const insertedEnd = doc.positionAt(
        doc.offsetAt(insertedStart) + insertedText.length
      );
      const insertedRange = new vscode.Range(insertedStart, insertedEnd);

      const originalDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: "rgba(255,0,0,0.2)",
        isWholeLine: true,
      });
      const newDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: "rgba(0,255,0,0.2)",
        isWholeLine: true,
      });

      editor.setDecorations(originalDecoration, [selection]);
      editor.setDecorations(newDecoration, [insertedRange]);

      const uniqueSuffix = new Date().getTime();
      const acceptCommandId = `extension.acceptChanges.${uniqueSuffix}`;
      const rejectCommandId = `extension.rejectChanges.${uniqueSuffix}`;

      const acceptButton = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
      );
      acceptButton.text = `$(check) Accept Changes`;
      acceptButton.tooltip = "Click to accept the changes";
      acceptButton.command = acceptCommandId;
      acceptButton.show();

      const rejectButton = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
      );
      rejectButton.text = `$(x) Reject Changes`;
      rejectButton.tooltip = "Click to reject the changes";
      rejectButton.command = rejectCommandId;
      rejectButton.show();

      context.subscriptions.push(
        vscode.commands.registerCommand(acceptCommandId, async () => {
          originalDecoration.dispose();
          newDecoration.dispose();
          acceptButton.dispose();
          rejectButton.dispose();

          const replacement = `// Updated code by Hutouch\n${updatedCode}`;
          await editor.edit((editBuilder) => {
            editBuilder.replace(selection, replacement);
            editBuilder.delete(insertedRange);
          });
          vscode.window.showInformationMessage("Changes accepted!");
          return res.status(200).json({
            message:
              "Changes accepted! Original code replaced with updated code.",
          });
        })
      );

      context.subscriptions.push(
        vscode.commands.registerCommand(rejectCommandId, async () => {
          originalDecoration.dispose();
          newDecoration.dispose();
          acceptButton.dispose();
          rejectButton.dispose();

          await editor.edit((editBuilder) => {
            editBuilder.delete(insertedRange);
          });
          vscode.window.showInformationMessage("Changes rejected.");
          return res.status(200).json({
            message: "Changes rejected. Original code remains unchanged.",
          });
        })
      );

      editor.revealRange(insertedRange);
    })
  );

  app.get(
    "/addMarketTocode",
    asyncHandler(async (req, res) => {
      console.log("Received request for /addMarketTocode");

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return res.status(400).json({ error: "No active editor found." });
      }

      const document = editor.document;
      const filePath = document.uri.fsPath;
      const fileName = path.basename(filePath);

      const selections = editor.selections;
      if (!selections || selections.length === 0) {
        return res.status(400).json({ error: "No lines selected." });
      }

      const hasEmptySelection = selections.some(
        (selection) => selection.isEmpty
      );
      if (hasEmptySelection) {
        return res.status(400).json({
          error:
            "One or more selections are empty. Please select the desired code.",
        });
      }

      const markerStart = "/* SELECTED CODE START */";
      const markerEnd = "/* SELECTED CODE END */";

      let updatedSnippets = [];

      const editSuccess = await editor.edit((editBuilder) => {
        selections.forEach((selection) => {
          const selectedText = document.getText(selection);
          const wrappedText = `${markerStart}\n${selectedText}\n${markerEnd}`;
          editBuilder.replace(selection, wrappedText);
          updatedSnippets.push(wrappedText);
        });
      });

      if (!editSuccess) {
        return res
          .status(500)
          .json({ error: "Failed to update the code in the editor." });
      }

      const combinedCode = updatedSnippets.join("\n");

      res.status(200).json({
        file_name: fileName,
        code: combinedCode,
      });
    })
  );

  app.get(
    "/selected-lines",
    asyncHandler(async (req, res) => {
      outputChannel.appendLine("Received request for lines");

      let response = {
        selected: false,
        file_name: "",
        file_path: "",
        project_path: "",
        message: "",
        data: [],
      };

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        response.project_path = workspaceFolders[0].uri.fsPath;
      }

      const editor = vscode.window.activeTextEditor;

      if (!editor) {
        const errorMessage = "No active editor found.";
        outputChannel.appendLine(`Error: ${errorMessage}`);
        response.message = errorMessage;
        return res.status(200).send(response);
      }

      const document = editor.document;
      const filePath = document.uri.fsPath;
      const fileName = path.basename(filePath);
      response.file_name = fileName;
      response.file_path = filePath;

      const selections = editor.selections;

      if (selections.length === 0) {
        const errorMessage = "No lines selected.";
        outputChannel.appendLine(`Error: ${errorMessage}`);
        response.message = errorMessage;
        return res.status(200).send(response);
      }

      const hasEmptySelection = selections.some(
        (selection) => selection.isEmpty
      );

      if (hasEmptySelection) {
        const errorMessage = "Empty line selected.";
        outputChannel.appendLine(`info: ${errorMessage}`);
        response.message = errorMessage;
        return res.status(200).send(response);
      }

      const fileContent = document.getText();
      const fileLines = fileContent.split(/\r?\n/);

      const diagnosticsCache = {}; // ensure cache exists in this scope
      let diagnostics = diagnosticsCache[filePath];
      if (!diagnostics) {
        diagnostics = vscode.languages.getDiagnostics(document.uri);
        diagnosticsCache[filePath] = diagnostics;
      }

      const selectedLineNumbers = selections.flatMap((selection) => {
        const start = selection.start.line + 1;
        const end = selection.end.line + 1;
        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
      });

      const groupedData = groupConsecutiveLines(
        selectedLineNumbers,
        diagnostics,
        fileLines
      );

      if (groupedData.length > 0) {
        response.selected = true;
        response.data = groupedData;
      }

      res.status(200).send(response);
    })
  );

  app.post(
    "/multiple-file-contents",
    asyncHandler(async (req, res) => {
      const { fileNames } = req.body;
      outputChannel.appendLine(
        `Received request for /multiple-file-contents with fileNames: ${fileNames}`
      );

      if (!fileNames || !Array.isArray(fileNames)) {
        const errorMessage = "fileNames array is required";
        outputChannel.appendLine(`Error: ${errorMessage}`);
        return res.status(400).send({ error: errorMessage });
      }

      const rootPath = vscode.workspace.workspaceFolders
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : "";
      outputChannel.appendLine(`Workspace root path: ${rootPath}`);

      if (!rootPath) {
        const errorMessage = "No workspace folder open";
        outputChannel.appendLine(`Error: ${errorMessage}`);
        return res.status(400).send({ error: errorMessage });
      }

      try {
        const fileDetails = await findMultipleFileDetails(fileNames, rootPath);
        outputChannel.appendLine(
          `File details retrieved for: ${fileNames.join(", ")}`
        );

        const folderStructure = generateFolderStructure(rootPath);
        outputChannel.appendLine(`Generated folder structure for: ${rootPath}`);

        fileDetails.push({
          file_path: "Readme.txt",
          content: folderStructure,
          imports: [],
          dependencies: [],
        });

        res.send(fileDetails);
      } catch (error) {
        outputChannel.appendLine(
          `Error finding file details: ${error.message}`
        );
        res.status(404).send({ error: error.message });
      }
    })
  );

  app.get(
    "/all-files",
    asyncHandler(async (req, res) => {
      const { role } = req.query;
      outputChannel.appendLine(`Received request for files with role: ${role}`);

      const rootPath = vscode.workspace.workspaceFolders
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : "";
      outputChannel.appendLine(`Workspace root path: ${rootPath}`);

      if (!rootPath) {
        const errorMessage = "No workspace folder open";
        outputChannel.appendLine(`Error: ${errorMessage}`);
        return res.status(400).send({ error: errorMessage });
      }

      try {
        let allFiles;
        if (
          typeof role === "string" &&
          role.toLowerCase().includes("flutter")
        ) {
          allFiles = getFilesRecursive(path.join(rootPath, "lib"));
        } else if (
          typeof role === "string" &&
          role.toLowerCase().includes("react native")
        ) {
          allFiles = getFilesRecursive(path.join(rootPath, "src"));
        } else {
          allFiles = getFilesRecursive(rootPath);
        }

        const fileDetails = allFiles.map((filePath) => ({
          file_path: filePath,
          content: fs.readFileSync(filePath, "utf8"),
        }));

        const folderStructure = generateFolderStructure(rootPath);
        fileDetails.push({
          file_path: "Readme.txt",
          content: folderStructure,
        });

        res.send(fileDetails);
      } catch (error) {
        outputChannel.appendLine(
          `Error retrieving all files: ${error.message}`
        );
        res.status(500).send({ error: "Failed to retrieve all files" });
      }
    })
  );

  app.get(
    "/assets",
    asyncHandler(async (req, res) => {
      outputChannel.appendLine("Received request for project assets");

      let rootPath = vscode.workspace.workspaceFolders
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : "";
      outputChannel.appendLine(`Workspace root path: ${rootPath}`);

      if (!rootPath) {
        const errorMessage = "No workspace folder open";
        outputChannel.appendLine(`Error: ${errorMessage}`);
        return res.status(400).send({ error: errorMessage });
      }

      const potentialFolders = ["assets", "asset", "image"];
      let assetsPath = "";

      for (const folderName of potentialFolders) {
        const folderPath = path.join(rootPath, folderName);
        if (fs.existsSync(folderPath)) {
          outputChannel.appendLine(`Asset folder found: ${folderPath}`);
          assetsPath = folderPath;
          break;
        }
      }

      if (!assetsPath) {
        const errorMessage = "No asset, assets, or image folder found";
        outputChannel.appendLine(`Error: ${errorMessage}`);
        return res.status(404).send({ error: errorMessage });
      }

      try {
        const filesList = listAssetFiles(assetsPath, path.basename(assetsPath));
        outputChannel.appendLine(`Asset files listed in: ${assetsPath}`);
        res.send(filesList);
      } catch (error) {
        outputChannel.appendLine(`Error listing assets: ${error.message}`);
        res.status(500).send({ error: "Failed to list assets" });
      }
    })
  );

  app.post(
    "/compare-file",
    asyncHandler(async (req, res) => {
      const { fileName, newFilePath } = req.body;
      outputChannel.appendLine(
        `Received request for /compare-file with fileName: ${fileName} and newFilePath: ${newFilePath}`
      );

      if (!fileName || !newFilePath) {
        const errorMessage = "Both fileName and newFilePath are required.";
        outputChannel.appendLine(`Error: ${errorMessage}`);
        return res.status(400).send({ error: errorMessage });
      }

      const sanitizedFileName = path.basename(fileName);
      if (sanitizedFileName !== fileName) {
        const errorMessage = "Invalid fileName provided.";
        outputChannel.appendLine(`Error: ${errorMessage}`);
        return res.status(400).send({ error: errorMessage });
      }

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        const errorMessage = "No workspace folder open.";
        outputChannel.appendLine(`Error: ${errorMessage}`);
        return res.status(400).send({ error: errorMessage });
      }

      const rootPath = workspaceFolders[0].uri.fsPath;
      outputChannel.appendLine(`Workspace root path: ${rootPath}`);

      const absoluteNewFilePath = path.isAbsolute(newFilePath)
        ? newFilePath
        : path.resolve(rootPath, newFilePath);
      outputChannel.appendLine(`Resolved newFilePath: ${absoluteNewFilePath}`);

      if (!fs.existsSync(absoluteNewFilePath)) {
        const errorMessage = `New file does not exist at path: ${absoluteNewFilePath}`;
        outputChannel.appendLine(`Error: ${errorMessage}`);
        return res.status(400).send({ error: errorMessage });
      }

      const isSpecialFile = ["pubspec.yaml", "AndroidManifest.xml"].includes(
        sanitizedFileName
      );
      if (isSpecialFile) {
        outputChannel.appendLine(
          `Special file detected: ${sanitizedFileName}. Searching for first match by name...`
        );

        const allFiles = getFilesRecursive(rootPath);
        const matchingFile = allFiles.find(
          (f) =>
            path.basename(f).toLowerCase() ===
              sanitizedFileName.toLowerCase() &&
            path.normalize(f) !== path.normalize(absoluteNewFilePath)
        );

        if (matchingFile) {
          outputChannel.appendLine(
            `Found matching special file: ${matchingFile}`
          );
          await vscode.commands.executeCommand(
            "vscode.diff",
            vscode.Uri.file(absoluteNewFilePath),
            vscode.Uri.file(matchingFile),
            `HuTouch Comparison for ${sanitizedFileName}`
          );

          // Track right-hand doc & reset poll flag
          try {
            diffRightFsPaths.add(vscode.Uri.file(matchingFile).fsPath); // right = modified
            diffDirty = false;
          } catch {}

          vscode.window.showInformationMessage(
            `Compared: ${sanitizedFileName}`
          );
          return res.send({ message: "Special file compared successfully." });
        } else {
          outputChannel.appendLine(
            `No matching special file found. Opening new file instead.`
          );
          const docUri = vscode.Uri.file(absoluteNewFilePath);
          const document = await vscode.workspace.openTextDocument(docUri);
          await vscode.window.showTextDocument(document);
          vscode.window.showInformationMessage(
            `Opened special file: ${sanitizedFileName}.`
          );
          return res.send({ message: "Special file opened. No match found." });
        }
      }

      try {
        // Normal Flutter lib/ compare flow
        const flutterLibPath = path.join(rootPath, "lib");
        const parts = absoluteNewFilePath.split(path.sep);
        const libIndex = parts.indexOf("lib");
        if (libIndex === -1) {
          const errorMessage = "New file is not inside the lib/ folder.";
          outputChannel.appendLine(`Error: ${errorMessage}`);
          return res.status(400).send({ error: errorMessage });
        }
        const relativeNewLibPath = parts.slice(libIndex).join("/");

        const existingFiles = getFilesRecursive(flutterLibPath).filter(
          (f) =>
            path.basename(f).toLowerCase() === sanitizedFileName.toLowerCase()
        );
        outputChannel.appendLine(
          `Total matching files found: ${existingFiles.length}`
        );

        const match = existingFiles.find((f) => {
          const p = f.split(path.sep);
          const idx = p.indexOf("lib");
          if (idx === -1) return false;
          const rel = p.slice(idx).join("/");
          return (
            rel === relativeNewLibPath &&
            path.normalize(f) !== path.normalize(absoluteNewFilePath)
          );
        });

        if (match) {
          outputChannel.appendLine(`Matching file found: ${match}`);
          await vscode.commands.executeCommand(
            "vscode.diff",
            vscode.Uri.file(absoluteNewFilePath),
            vscode.Uri.file(match),
            `HuTouch Comparison for ${sanitizedFileName}`
          );

          // Track right-hand doc & reset poll flag
          try {
            diffRightFsPaths.add(vscode.Uri.file(match).fsPath); // right = modified
            diffDirty = false;
          } catch {}

          vscode.window.showInformationMessage(
            `Compared: ${relativeNewLibPath}`
          );
          return res.send({ message: "Files opened in compare mode." });
        } else {
          outputChannel.appendLine(`No match in lib/. Opening new file.`);
          const docUri = vscode.Uri.file(absoluteNewFilePath);
          const document = await vscode.workspace.openTextDocument(docUri);
          await vscode.window.showTextDocument(document);
          vscode.window.showInformationMessage(
            `Opened new file: ${sanitizedFileName}.`
          );
          return res.send({
            message: "New file opened. No matching lib/ file found.",
          });
        }
      } catch (error) {
        outputChannel.appendLine(`Error in /compare-file: ${error.message}`);
        vscode.window.showErrorMessage(
          `Failed to compare or open file: ${error.message}`
        );
        return res
          .status(500)
          .send({ error: "Failed to compare or open file." });
      }
    })
  );

  // Shutdown route: closes this server and marks statusbar inactive
  app.post("/shutdown", (req, res) => {
    res.json({ message: "Shutting down HuTouch server" });
    setTimeout(() => {
      if (server) {
        server.close(() => {
          outputChannel.clear();
          outputChannel.appendLine(
            "HuTouch AI code extension is active in another workspace"
          );
          statusBarItem.text = `$(error) HuTouch AI`;
          statusBarItem.tooltip =
            "Inactive: another workspace is running HuTouch";
          statusBarItem.color = new vscode.ThemeColor("errorForeground");
          statusBarItem.command = undefined;
          context.globalState.update("activeWindow", null);
        });
      }
    }, 100);
  });

  server = app
    .listen(PORT, () => {})
    .on("error", (err) => {
      let err_msg = err.message;
      if (err_msg.includes("listen EADDRINUSE: address already in use")) {
        outputChannel.clear();
        outputChannel.appendLine(
          "HuTouch AI extension is active in another project"
        );
      } else {
        outputChannel.appendLine(`Server error: ${err.message}`);
      }
      vscode.window.showErrorMessage(
        `Some error occurred starting HuTouch server. Please check if another VS Code window is running the server.`
      );

      if (statusBarItem) {
        statusBarItem.text = `$(error) HuTouch AI`;
        if (err_msg.includes("listen EADDRINUSE: address already in use")) {
          statusBarItem.tooltip = `Extension is inactive (Please verify if it's active in another project or workspace.)`;
        } else {
          statusBarItem.tooltip = `Server encountered an error: ${err.message}`;
        }
        statusBarItem.color = new vscode.ThemeColor("errorForeground");
        statusBarItem.command =
          "Hutouch-AI might be active in another VScode Instance. If not please reinstall extension and restart ide.";
      }
    });
}

exports.activate = activate;
exports.deactivate = deactivate;
