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

let globalContext;

const USER_ID = getUserIdFromFile();

// helper to post logs using that USER_ID
async function sendLogToDB(source, message) {
  if (!USER_ID) return;

  const payload = {
    user_id: Number(USER_ID),
    source,
    message,
  };

  try {
    await axios.post("https://php.niiti.com/api/store_app_logs", payload, {
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": "JGIp4AWFmI",
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
    "HuTouch Extension Logs"
  );
  outputChannel.show(true); // Show the output channel when the extension is activated

  const originalAppend = outputChannel.appendLine.bind(outputChannel);

  // 3) override it to also call sendLogToDB
  outputChannel.appendLine = (line) => {
    // write to the VS Code pane
    originalAppend(line);

    // forward the exact same line to your DB
    sendLogToDB("Extension", line);
  };

  // outputChannel.appendLine(
  //   `HuTouch File Analysis server starting on port ${PORT}...`
  // );

  // Create the status bar item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = `$(robot) HuTouch`; // Display a rocket icon with text
  statusBarItem.tooltip = "HuTouch is running"; // Tooltip message
  statusBarItem.command = "extension.showStatus"; // Optional command when clicked
  statusBarItem.show(); // Show the status bar item
  // outputChannel.appendLine("Status bar item created and displayed.");

  // Register the command that the status bar item will trigger
  outputChannel.appendLine(
    "HuTouch extension is active in the current workspace"
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("extension.showStatus", () => {
      vscode.window.showInformationMessage("HuTouch is Active and Running!");
      // outputChannel.appendLine("Status bar item clicked: HuTouch is Active and Running.");
    })
  );
  var line = "HuTouch is Active and Running for user ID: ${USER_ID}";

  try {
    sendLogToDB("Extension", line);
  } catch (error) {
    outputChannel.appendLine(`Error sending log to DB: ${error.message}`);
  }

  // // Start the server
  // startServer();

  // Check and create the editor.json file
  checkAndCreateEditorJson(context);

  // Check if this instance should start the server
  manageServerActivation(context);

  // Display a message when the extension is activated
  // vscode.window.showInformationMessage(`HuTouch File Analysis server started on port ${PORT}`);
  // outputChannel.appendLine(
  //   `HuTouch File Analysis server started on port ${PORT}`
  // );
  const platformName =
    {
      win32: "Windows",
      darwin: "macOS",
      linux: "Linux",
    }[process.platform] || process.platform;

  outputChannel.appendLine(`🖥️ Extension is running on: ${platformName}`);
  try {
    let line = `🖥️ Extension is running on: ${platformName}`;
    sendLogToDB("Extension", line);
  } catch (error) {
    outputChannel.appendLine(`Error sending log to DB: ${error.message}`);
  }
  // Add the status bar item and output channel to context subscriptions to ensure cleanup on deactivation
  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(outputChannel);
}

async function deactivate() {
  outputChannel.appendLine("Deactivating extension and disposing resources.");

  // Delete the editor.json file on deactivate/uninstall
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

  // outputChannel.appendLine(`Checking if should exclude: ${fileOrDir} -> ${isExcluded ? 'Excluded' : 'Included'}`);
  return isExcluded;
}

function groupConsecutiveLines(selectedLines, diagnostics, fileLines) {
  if (!selectedLines || selectedLines.length === 0) return [];

  // Sort the selected lines in ascending order
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
      // Consecutive line, add to current group
      currentGroup.end_line = lineNumber;
      currentGroup.content += `\n${fileLines[lineNumber - 1] || ""}`;
    } else {
      // Non-consecutive line, push current group and start a new one
      groups.push(currentGroup);
      currentGroup = {
        start_line: lineNumber,
        end_line: lineNumber,
        content: fileLines[lineNumber - 1] || "",
        errors: [],
      };
    }
  }

  // Push the last group
  groups.push(currentGroup);

  // Assign diagnostics to each group
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
    // outputChannel.appendLine(`Reading directory: ${dir}`);

    list.forEach(function (file) {
      const fullPath = path.resolve(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory() && !shouldExclude(fullPath)) {
        // outputChannel.appendLine(` folder found: ${fullPath} `);
        results = results.concat(getFilesRecursive(fullPath));
      } else if (stat.isFile() && !shouldExclude(fullPath)) {
        // outputChannel.appendLine(`File found: ${fullPath} - Adding to results.`);
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
  // outputChannel.appendLine(`Finding multiple file details for: ${fileNames.join(", ")} in root path: ${rootPath}`);
  const allFiles = getFilesRecursive(rootPath);
  // outputChannel.appendLine(`All files found: ${allFiles.join(", ")}`); // Log all found files
  const fileDetails = [];

  for (const fileName of fileNames) {
    const fileFullPath = allFiles.find(
      (f) => path.basename(f).toLowerCase() === fileName.toLowerCase()
    );
    // outputChannel.appendLine(`File full path for ${fileName}: ${fileFullPath ? fileFullPath : 'Not found'}`); // Log file path

    if (!fileFullPath) {
      const errorMessage = `File not found in the project: ${fileName}`;
      outputChannel.appendLine(errorMessage);
      throw new Error(errorMessage);
    }

    try {
      const fileContent = fs.readFileSync(fileFullPath, "utf8");
      outputChannel.appendLine(`Reading file content for: ${fileName}`);

      // Add the main file content
      fileDetails.push({
        file_path: fileFullPath,
        content: fileContent,
        imports: [], // Imports || [],
        dependencies: [], // Dependencies || [],
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

  // Determine base config directory:
  // • Windows:   %LOCALAPPDATA% or fallback to ~/AppData/Local
  // • macOS:     ~/Library/Application Support
  // • Linux / *: $XDG_CONFIG_HOME or fallback to ~/.config
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

    // Traverse the directory tree
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

        // Exclude items based on shouldExclude
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
          // Log and add directory to result
          result += `${newPrefix}${item}/\n`;
          console.log(`Directory: ${fullPath}`);
          traverse(fullPath, currentPrefix + (isLast ? "    " : "│   "));
        } else if (stat.isFile()) {
          // Log and add file to result
          result += `${newPrefix}${item}\n`;
          console.log(`File: ${fullPath}`);
        }
      });
    }

    // Add the root folder name (`lib` or `src`) to the structure
    result += `${prefix}${path.basename(targetDir)}/\n`;
    traverse(targetDir, prefix + "    ");

    // Write the result to a file if outputFile is provided
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
    // outputChannel.appendLine(`Directory contents of ${dir}: ${list.join(", ")}`);

    list.forEach((file) => {
      const fullPath = path.resolve(dir, file);
      const stat = fs.statSync(fullPath);
      const relativePath = path.join(baseDir, file);

      if (stat.isFile()) {
        // outputChannel.appendLine(`Asset file found: ${relativePath}`);
        results.push(relativePath);
      } else if (stat.isDirectory()) {
        // outputChannel.appendLine(`Directory found: ${fullPath} - Recursing into directory.`);
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
    // Match .NET: use LocalApplicationData = %LOCALAPPDATA%
    basePath = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  } else if (process.platform === "darwin") {
    // Match .NET: ~/Library/Application Support
    basePath = path.join(home, "Library", "Application Support");
  } else {
    throw new Error("Unsupported OS for HuTouch extension");
  }

  const folderPath = path.join(basePath, "HuTouchAi");
  const editorJsonPath = path.join(folderPath, "editor.json");

  return { folderPath, editorJsonPath };
}

function checkAndCreateEditorJson(context) {
  // const folderPath = path.join(os.homedir(), "HuTouchAi");
  const { folderPath, editorJsonPath: filePath } = getEditorJsonPath();

  // Ensure the directory exists
  if (!fs.existsSync(folderPath)) {
    try {
      fs.mkdirSync(folderPath, { recursive: true });
      // outputChannel.appendLine(`Created directory: ${folderPath}`);
    } catch (error) {
      // outputChannel.appendLine(`Error creating directory: ${error.message}`);
      return;
    }
  }

  // Check if editor.json exists
  if (!fs.existsSync(filePath)) {
    // File doesn't exist; create with default data
    const jsonData = { ide: "vs-code" };
    try {
      fs.writeFileSync(filePath, JSON.stringify(jsonData, null, 2), "utf8");
      // outputChannel.appendLine(`Created editor.json successfully at ${filePath}`);
    } catch (error) {
      outputChannel.appendLine(`Error writing editor.json: ${error.message}`);
    }
  } else {
    // File exists; read and update if needed
    try {
      const fileContent = fs.readFileSync(filePath, "utf8");
      let jsonData = JSON.parse(fileContent);
      if (jsonData.ide === "android-studio") {
        jsonData.ide = "vs-code";
        fs.writeFileSync(filePath, JSON.stringify(jsonData, null, 2), "utf8");
        // outputChannel.appendLine("Updated editor.json: Changed ide from 'android-studio' to 'vs-code'.");
      } else {
        // outputChannel.appendLine("editor.json already exists and does not need updating.");
      }
    } catch (error) {
      // outputChannel.appendLine(`Error reading or updating editor.json: ${error.message}`);
    }
  }
}
let server;

async function manageServerActivation(context) {
  // Identify this workspace (fallbacks are defensive)
  const currentWindowId =
    (context.storageUri && context.storageUri.fsPath) ||
    (vscode.workspace.workspaceFolders &&
      vscode.workspace.workspaceFolders[0] &&
      vscode.workspace.workspaceFolders[0].uri.fsPath) ||
    "unknown";

  // 1) Is someone already running the server on this machine?
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

  // 2) If another window is active, ask the user before switching
  if (serverIsRunning) {
    const choice = await vscode.window.showInformationMessage(
      "HuTouch is already active in another VS Code window. Do you want to switch it to this project?",
      { modal: true },
      "Switch to this project",
      "Stay with previous project"
    );

    if (choice !== "Switch to this project") {
      // User chose to keep the old project active — do NOT switch
      outputChannel.appendLine(
        "User opted to stay with the previously active project. This window will remain inactive."
      );
      try {
        await sendLogToDB(
          "Extension",
          "User declined switch; keeping previous project active."
        );
      } catch (_) {}

      // Visually mark this window as inactive
      statusBarItem.text = `$(error) HuTouch`;
      statusBarItem.tooltip =
        "Inactive: another workspace is running HuTouch (you chose to stay on the old project).";
      statusBarItem.color = new vscode.ThemeColor("errorForeground");
      statusBarItem.command = undefined;
      return; // <- IMPORTANT: do not start a server here
    }

    // 3) User approved switching — ask the old window to shut down, then wait
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

  // 4) Start *this* window's server
  startServer(context);
  context.globalState.update("activeWindow", currentWindowId);

  // 5) Update status bar to running
  statusBarItem.text = `$(robot) HuTouch`;
  statusBarItem.tooltip = "HuTouch is running";
  statusBarItem.color = undefined;
}

// Function to deactivate the server
function deactivateServer(context) {
  if (server) {
    server.close(() => {
      server = null;
      context.globalState.update("activeWindow", null);
      vscode.window.showInformationMessage("HuTouch server deactivated.");
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
          // error means connection refused ⇒ port is free
          resolve();
        })
        .once("connect", () => {
          sock.end();
          if (Date.now() - start > timeout) {
            // Give up after timeout
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
    return; // Skip starting a new server
  }

  const app = express();
  app.use(express.json());
  // outputChannel.appendLine("Starting the Hutouch server...");

  // Initialize diagnostics cache
  const diagnosticsCache = {};

  // Listen to diagnostic changes to invalidate cache
  vscode.languages.onDidChangeDiagnostics((event) => {
    event.uris.forEach((uri) => {
      const filePath = uri.fsPath;
      if (diagnosticsCache[filePath]) {
        delete diagnosticsCache[filePath];
        // outputChannel.appendLine(
        //   `Diagnostics cache invalidated for: ${filePath}`
        // );
      }
    });
  });

  app.post(
    "/modify-code",
    asyncHandler(async (req, res) => {
      console.log("Received request for /modify-code");

      // Validate the request payload.
      const { updatedCode } = req.body;
      if (!updatedCode) {
        return res
          .status(400)
          .json({ error: "The updatedCode field is required." });
      }

      // Get the active text editor.
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return res.status(400).json({ error: "No active editor found." });
      }

      // Use the current selection as the original code.
      const selection = editor.selection;
      if (selection.isEmpty) {
        return res
          .status(400)
          .json({ error: "Please select some code first." });
      }
      const doc = editor.document;

      // Define the marker text and build the inserted text.
      const marker = "\n/* HuTouch GENERATED CODE BELOW */\n";
      const insertedText = marker + updatedCode;

      // Insert the marker and updated code below the selected code.
      await editor.edit((editBuilder) => {
        const insertPosition = selection.end;
        editBuilder.insert(insertPosition, insertedText);
      });

      // Compute the inserted range (covering marker + updated code).
      const insertedStart = selection.end; // Start exactly at selection.end.
      const insertedEnd = doc.positionAt(
        doc.offsetAt(insertedStart) + insertedText.length
      );
      const insertedRange = new vscode.Range(insertedStart, insertedEnd);

      // Create decorations for visual comparison.
      const originalDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: "rgba(255,0,0,0.2)",
        isWholeLine: true,
      });
      const newDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: "rgba(0,255,0,0.2)",
        isWholeLine: true,
      });

      // Apply decorations: original code (red) and inserted updated code (green).
      editor.setDecorations(originalDecoration, [selection]);
      editor.setDecorations(newDecoration, [insertedRange]);

      // Generate unique command IDs to avoid duplicate registration.
      const uniqueSuffix = new Date().getTime();
      const acceptCommandId = `extension.acceptChanges.${uniqueSuffix}`;
      const rejectCommandId = `extension.rejectChanges.${uniqueSuffix}`;

      // Create sticky buttons with unique command IDs.
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

      // Register unique command for accepting changes.
      context.subscriptions.push(
        vscode.commands.registerCommand(acceptCommandId, async () => {
          // Cleanup decorations and buttons.
          originalDecoration.dispose();
          newDecoration.dispose();
          acceptButton.dispose();
          rejectButton.dispose();

          // Prepend an inline comment indicating the update.
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

      // Register unique command for rejecting changes.
      context.subscriptions.push(
        vscode.commands.registerCommand(rejectCommandId, async () => {
          // Cleanup decorations and buttons.
          originalDecoration.dispose();
          newDecoration.dispose();
          acceptButton.dispose();
          rejectButton.dispose();

          // Remove the inserted updated code block (including marker).
          await editor.edit((editBuilder) => {
            editBuilder.delete(insertedRange);
          });
          vscode.window.showInformationMessage("Changes rejected.");
          return res.status(200).json({
            message: "Changes rejected. Original code remains unchanged.",
          });
        })
      );

      // Optionally, scroll the editor to reveal the inserted block.
      editor.revealRange(insertedRange);
    })
  );

  app.get(
    "/addMarketTocode",
    asyncHandler(async (req, res) => {
      console.log("Received request for /addMarketTocode");

      // Access the active text editor
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return res.status(400).json({ error: "No active editor found." });
      }

      const document = editor.document;
      const filePath = document.uri.fsPath;
      const fileName = path.basename(filePath);

      // Retrieve all selections from the editor.
      const selections = editor.selections;
      if (!selections || selections.length === 0) {
        return res.status(400).json({ error: "No lines selected." });
      }

      // Check if any selection is empty (i.e., a cursor without a selection).
      const hasEmptySelection = selections.some(
        (selection) => selection.isEmpty
      );
      if (hasEmptySelection) {
        return res.status(400).json({
          error:
            "One or more selections are empty. Please select the desired code.",
        });
      }

      // Marker comments to be added.
      const markerStart = "/* SELECTED CODE START */";
      const markerEnd = "/* SELECTED CODE END */";

      // Array to collect updated code snippets (for API response).
      let updatedSnippets = [];

      // Apply an edit to wrap each selection with marker comments.
      const editSuccess = await editor.edit((editBuilder) => {
        selections.forEach((selection) => {
          // Get the selected text.
          const selectedText = document.getText(selection);

          // Build the new text with marker comments.
          const wrappedText = `${markerStart}\n${selectedText}\n${markerEnd}`;

          // Queue the replacement in the editor.
          editBuilder.replace(selection, wrappedText);

          // Store the wrapped text.
          updatedSnippets.push(wrappedText);
        });
      });

      if (!editSuccess) {
        return res
          .status(500)
          .json({ error: "Failed to update the code in the editor." });
      }

      // Combine all wrapped snippets into one code string (separated by newlines).
      const combinedCode = updatedSnippets.join("\n");

      // Return the filename and the combined code snippet.
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

      // Initialize response structure
      let response = {
        selected: false,
        file_name: "",
        file_path: "",
        project_path: "",
        message: "",
        data: [],
      };

      // Get the root project path from the first workspace folder
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        response.project_path = workspaceFolders[0].uri.fsPath; // Root project path
      }

      // Access the active text editor
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
      // const relativePath = path.relative(response.project_path, filePath);
      response.file_path = filePath;

      const selections = editor.selections; // Array of selections

      if (selections.length === 0) {
        const errorMessage = "No lines selected.";
        outputChannel.appendLine(`Error: ${errorMessage}`);
        response.message = errorMessage;
        return res.status(200).send(response);
      }

      // Check if any selection is empty (i.e., cursor without selection)
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
      // outputChannel.appendLine(`Retrieved content from ${filePath}`);

      // Retrieve diagnostics for the file, utilizing cache
      let diagnostics = diagnosticsCache[filePath];
      if (!diagnostics) {
        diagnostics = vscode.languages.getDiagnostics(document.uri);
        diagnosticsCache[filePath] = diagnostics;
        // outputChannel.appendLine(`Cached diagnostics for ${filePath}`);
      }

      // Extract all selected line numbers
      const selectedLineNumbers = selections.flatMap((selection) => {
        const start = selection.start.line + 1;
        const end = selection.end.line + 1;
        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
      });

      // Group consecutive lines
      const groupedData = groupConsecutiveLines(
        selectedLineNumbers,
        diagnostics,
        fileLines
      );

      // Assign to response
      if (groupedData.length > 0) {
        response.selected = true;
        response.data = groupedData;
      }

      // outputChannel.appendLine(`Processed selected lines. Sending response.`);
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

        // outputChannel.appendLine("Sending response for /multiple-file-contents");
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
          // outputChannel.appendLine("Role identified as Flutter, searching in 'lib' directory.");
          allFiles = getFilesRecursive(path.join(rootPath, "lib"));
        } else if (
          typeof role === "string" &&
          role.toLowerCase().includes("react native")
        ) {
          // outputChannel.appendLine("Role identified as React Native, searching in 'src' directory.");
          allFiles = getFilesRecursive(path.join(rootPath, "src"));
        } else {
          // outputChannel.appendLine("Searching in the root directory.");
          allFiles = getFilesRecursive(rootPath);
        }

        const fileDetails = allFiles.map((filePath) => ({
          file_path: filePath,
          content: fs.readFileSync(filePath, "utf8"),
        }));

        const folderStructure = generateFolderStructure(rootPath);
        // outputChannel.appendLine(`Generated folder structure for: ${rootPath}`);
        fileDetails.push({
          file_path: "Readme.txt",
          content: folderStructure,
        });

        // outputChannel.appendLine("Sending response for /all-files");
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

      // Define potential asset folders
      const potentialFolders = ["assets", "asset", "image"];
      let assetsPath = "";

      // Check if any of these folders exist
      for (const folderName of potentialFolders) {
        const folderPath = path.join(rootPath, folderName);
        if (fs.existsSync(folderPath)) {
          outputChannel.appendLine(`Asset folder found: ${folderPath}`);
          assetsPath = folderPath;
          break;
        }
      }

      // If no valid folder is found, return an error
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

        const allFiles = getFilesRecursive(rootPath); // Search the entire workspace
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
          // outputChannel.appendLine("Server shut down via /shutdown request");
          outputChannel.clear();
          outputChannel.appendLine(
            "HuTouch extension is active in another workspace"
          );
          statusBarItem.text = `$(error) HuTouch`;
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
      // outputChannel.appendLine(`Server error: ${err.message}`);
      let err_msg = err.message;
      if (err_msg.includes("listen EADDRINUSE: address already in use")) {
        outputChannel.clear();
        outputChannel.appendLine(
          "HuTouch extension is active in another project"
        );
      } else {
        outputChannel.appendLine(`Server error: ${err.message}`);
      }
      vscode.window.showErrorMessage(
        `Some error occurred starting HuTouch server. Please check if another VS Code window is running the server.`
      );

      // Update the status bar item to indicate an error
      if (statusBarItem) {
        // Change the icon and text
        statusBarItem.text = `$(error) HuTouch`;
        // Optionally, change tooltip
        let err_msg = err.message;
        if (err_msg.includes("listen EADDRINUSE: address already in use")) {
          statusBarItem.tooltip = `Extension is inactive (Please verify if it's active in another project or workspace.)`;
        } else {
          statusBarItem.tooltip = `Server encountered an error: ${err.message}`;
        }

        // You can also change the color if desired
        statusBarItem.color = new vscode.ThemeColor("errorForeground");
        statusBarItem.command =
          "HuTouch might be active in another VS Code instance. If not please reinstall the extension and restart the IDE."; // Optional command when clicked
      }
    });
}

exports.activate = activate;
exports.deactivate = deactivate;
