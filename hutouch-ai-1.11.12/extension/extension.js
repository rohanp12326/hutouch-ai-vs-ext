const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const express = require("express");
require("dotenv").config();
const { default: OpenAI } = require("openai");

const PORT = 45678;
let statusBarItem; // Declare the status bar item globally
let outputChannel; // Declare the output channel globally

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function activate(context) {
  // Create the output channel for logging
  outputChannel = vscode.window.createOutputChannel("HuTouch AI Extension Logs");
  outputChannel.show(true); // Show the output channel when the extension is activated
  outputChannel.appendLine(`HuTouch AI File Analysis server starting on port ${PORT}...`);

  // Create the status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = `$(robot) HuTouch AI Active`; // Display a rocket icon with text
  statusBarItem.tooltip = "HuTouch AI File Analysis is running"; // Tooltip message
  statusBarItem.command = "extension.showStatus"; // Optional command when clicked
  statusBarItem.show(); // Show the status bar item
  outputChannel.appendLine("Status bar item created and displayed.");

  // Register the command that the status bar item will trigger
  context.subscriptions.push(
    vscode.commands.registerCommand("extension.showStatus", () => {
      vscode.window.showInformationMessage("HuTouch AI is Active and Running!");
      outputChannel.appendLine("Status bar item clicked: HuTouch AI is Active and Running.");
    })
  );

  // Start the server
  startServer();

  // Display a message when the extension is activated
  vscode.window.showInformationMessage(`HuTouch AI File Analysis server started on port ${PORT}`);
  outputChannel.appendLine(`HuTouch AI File Analysis server started on port ${PORT}`);

  // Add the status bar item and output channel to context subscriptions to ensure cleanup on deactivation
  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(outputChannel);
}

async function deactivate() {
  outputChannel.appendLine("Deactivating extension and disposing resources.");
  
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
    outputChannel.dispose(); // Dispose of the output channel when the extension is deactivated
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
  const isExcluded = EXCLUDED_DIRS.includes(name) || EXCLUDED_FILES.includes(name) || EXCLUDED_EXTENSIONS.includes(ext);

  outputChannel.appendLine(`Checking if should exclude: ${fileOrDir} -> ${isExcluded ? 'Excluded' : 'Included'}`);
  return isExcluded;
}

function getFilesRecursive(dir) {
  let results = [];
  try {
    const list = fs.readdirSync(dir);
    outputChannel.appendLine(`Reading directory: ${dir}`);
    
    list.forEach(function (file) {
      file = path.resolve(dir, file);
      const stat = fs.statSync(file);
      if (stat.isDirectory() && !shouldExclude(file)) {
        outputChannel.appendLine(`Directory found: ${file} - Recursing into directory.`);
        results = results.concat(getFilesRecursive(file));
      } else if (stat.isFile() && !shouldExclude(file)) {
        outputChannel.appendLine(`File found: ${file} - Adding to results.`);
        results.push(file);
      }
    });
  } catch (error) {
    outputChannel.appendLine(`Error reading directory ${dir}: ${error.message}`);
  }
  return results;
}

async function analyzeFileContent(content, fileName) {
  const fileType = path.extname(fileName).toLowerCase();
  outputChannel.appendLine(`Analyzing file content for: ${fileName} (Type: ${fileType})`);

  const prompt = `
    Analyze the following ${fileType} code & FORMAT IN PROPER JSON WITHOUT ANY TEST DESCRIPTION. List all import statements excluding system or standard library dependencies. 
    Then, Identify all files that are dependencies for this code:
    \n\n${content}
    \n\nList the imports and dependencies in the format:
    Imports:
    - <import statements>

    Dependencies:
    - <ONLY NAME OF FILE WITH EXTENSION>
   IMPORTANT: Ensure the response is a valid JSON object without any additional text or description.. DO NOT INCLUDE ANY TEXT/DESCRIPTION OTHER THAN THE IMPORTS AND DEPENDENCIES. GIVE FULL FILE NAME IN THE DEPENDENCIES WITH EXTENSION.
    `;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo-0125",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a helpful code analyser which returns only json output, and no extraneous text.",
        },
        { role: "user", content: prompt },
      ],
    });

    const text = completion.choices[0].message.content.trim();
    outputChannel.appendLine(`Received response from OpenAI for file: ${fileName}`);

    const analysis = JSON.parse(text);
    outputChannel.appendLine(`Parsed analysis JSON for file: ${fileName}`);
    return analysis;
  } catch (error) {
    outputChannel.appendLine(`Error parsing JSON from OpenAI response for file ${fileName}: ${error.message}`);
    throw new Error("Failed to parse JSON from OpenAI response");
  }
}

async function findFileDetails(fileName, rootPath) {
  outputChannel.appendLine(`Finding file details for: ${fileName} in root path: ${rootPath}`);
  const allFiles = getFilesRecursive(rootPath);
  outputChannel.appendLine(`All files found: ${allFiles.join(", ")}`); // Log all found files

  const fileFullPath = allFiles.find(
    (f) => path.basename(f).toLowerCase() === fileName.toLowerCase()
  );
  outputChannel.appendLine(`File full path: ${fileFullPath ? fileFullPath : 'Not found'}`); // Log file path

  if (!fileFullPath) {
    const errorMessage = `File not found in the project: ${fileName}`;
    outputChannel.appendLine(errorMessage);
    throw new Error(errorMessage);
  }

  try {
    const fileContent = fs.readFileSync(fileFullPath, "utf8");
    outputChannel.appendLine(`Reading file content for: ${fileName}`);

    const { Imports, Dependencies } = await analyzeFileContent(fileContent, fileName);
    outputChannel.appendLine(`File analyzed. Imports: ${Imports.length}, Dependencies: ${Dependencies.length}`);

    const fileDetails = [
      {
        file_path: fileFullPath,
        content: fileContent,
        imports: Imports || [],
        dependencies: Dependencies || [],
      },
    ];

    // Add the content of related files from dependencies
    for (const dependency of Dependencies) {
      const dependencyFileName = path.basename(dependency);
      const dependencyFilePath = allFiles.find(
        (f) => path.basename(f).toLowerCase() === dependencyFileName.toLowerCase()
      );
      if (dependencyFilePath && fs.existsSync(dependencyFilePath)) {
        outputChannel.appendLine(`Dependency file found: ${dependencyFileName} - Adding content.`);
        fileDetails.push({
          file_path: dependencyFilePath,
          content: fs.readFileSync(dependencyFilePath, "utf8"),
          imports: undefined,
          dependencies: undefined
        });
      } else {
        outputChannel.appendLine(`Dependency file not found: ${dependencyFileName}`);
      }
    }

    return fileDetails;
  } catch (error) {
    outputChannel.appendLine(`Error processing file ${fileName}: ${error.message}`);
    throw error;
  }
}

async function findMultipleFileDetails(fileNames, rootPath) {
  outputChannel.appendLine(`Finding multiple file details for: ${fileNames.join(", ")} in root path: ${rootPath}`);
  const allFiles = getFilesRecursive(rootPath);
  outputChannel.appendLine(`All files found: ${allFiles.join(", ")}`); // Log all found files
  const fileDetails = [];

  for (const fileName of fileNames) {
    const fileFullPath = allFiles.find(
      (f) => path.basename(f).toLowerCase() === fileName.toLowerCase()
    );
    outputChannel.appendLine(`File full path for ${fileName}: ${fileFullPath ? fileFullPath : 'Not found'}`); // Log file path

    if (!fileFullPath) {
      const errorMessage = `File not found in the project: ${fileName}`;
      outputChannel.appendLine(errorMessage);
      throw new Error(errorMessage);
    }

    try {
      const fileContent = fs.readFileSync(fileFullPath, "utf8");
      outputChannel.appendLine(`Reading file content for: ${fileName}`);

      // Placeholder for analyzing file content if needed in the future
      /*
      const { Imports, Dependencies } = await analyzeFileContent(
        fileContent,
        fileName
      );
      outputChannel.appendLine(`File analyzed. Imports: ${Imports.length}, Dependencies: ${Dependencies.length}`);
      */

      // Add the main file content
      fileDetails.push({
        file_path: fileFullPath,
        content: fileContent,
        imports: [], // Imports || [],
        dependencies: [], // Dependencies || [],
      });

      // Add the content of related files from dependencies (optional)
      // Uncomment the following block if you want to include dependencies
      /*
      for (const dependency of Dependencies) {
        const dependencyFileName = path.basename(dependency);
        const dependencyFilePath = allFiles.find(
          (f) => path.basename(f).toLowerCase() === dependencyFileName.toLowerCase()
        );
        if (dependencyFilePath && fs.existsSync(dependencyFilePath)) {
          outputChannel.appendLine(`Dependency file found: ${dependencyFileName} - Adding content.`);
          fileDetails.push({
            file_path: dependencyFilePath,
            content: fs.readFileSync(dependencyFilePath, "utf8"),
          });
        } else {
          outputChannel.appendLine(`Dependency file not found: ${dependencyFileName}`);
        }
      }
      */
    } catch (error) {
      outputChannel.appendLine(`Error processing file ${fileName}: ${error.message}`);
      throw error;
    }
  }

  return fileDetails;
}


function generateFolderStructure(dir, prefix = "") {
  let result = "";
  outputChannel.appendLine(`Generating folder structure for: ${dir}`);
  try {
    const list = fs.readdirSync(dir);
    outputChannel.appendLine(`Directory contents of ${dir}: ${list.join(", ")}`);

    list.forEach((file, index) => {
      const fullPath = path.resolve(dir, file);
      const stat = fs.statSync(fullPath);
      const isLast = index === list.length - 1;
      const newPrefix = prefix + (isLast ? "└── " : "├── ");

      if (stat.isDirectory() && !shouldExclude(fullPath)) {
        outputChannel.appendLine(`Directory found: ${fullPath} - Recursing into directory.`);
        result += `${newPrefix}${file}/\n`;
        result += generateFolderStructure(
          fullPath,
          prefix + (isLast ? "    " : "│   ")
        );
      } else if (stat.isFile() && !shouldExclude(fullPath)) {
        outputChannel.appendLine(`File found: ${fullPath} - Adding to structure.`);
        result += `${newPrefix}${file}\n`;
      }
    });
  } catch (error) {
    outputChannel.appendLine(`Error reading directory ${dir}: ${error.message}`);
  }
  return result;
}

function listAssetFiles(dir, baseDir = "") {
  let results = [];
  outputChannel.appendLine(`Listing asset files in: ${dir}`);
  try {
    const list = fs.readdirSync(dir);
    outputChannel.appendLine(`Directory contents of ${dir}: ${list.join(", ")}`);

    list.forEach((file) => {
      const fullPath = path.resolve(dir, file);
      const stat = fs.statSync(fullPath);
      const relativePath = path.join(baseDir, file);

      if (stat.isFile()) {
        outputChannel.appendLine(`Asset file found: ${relativePath}`);
        results.push(relativePath);
      } else if (stat.isDirectory()) {
        outputChannel.appendLine(`Directory found: ${fullPath} - Recursing into directory.`);
        results = results.concat(
          listAssetFiles(fullPath, relativePath)
        );
      }
    });
  } catch (error) {
    outputChannel.appendLine(`Error reading directory ${dir}: ${error.message}`);
  }
  return results;
}
let server;

function startServer() {
  const app = express();
  app.use(express.json());
  outputChannel.appendLine("Starting the Express server...");

  app.post("/file-content", async (req, res) => {
    const { fileName } = req.body;
    outputChannel.appendLine(`Received request for /file-content with fileName: ${fileName}`);

    if (!fileName) {
      const errorMessage = "fileName is required";
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
      const fileDetails = await findFileDetails(fileName, rootPath);
      outputChannel.appendLine(`File details retrieved for: ${fileName}`);

      const folderStructure = generateFolderStructure(rootPath);
      outputChannel.appendLine(`Generated folder structure for: ${rootPath}`);

      const response = fileDetails.map((file) => {
        const { imports, dependencies, ...rest } = file;
        return imports && dependencies ? { ...rest, imports, dependencies } : rest;
      });

      response.push({
        file_path: "Readme.txt",
        content: folderStructure,
      });

      outputChannel.appendLine("Sending response for /file-content");
      res.send(response);
    } catch (error) {
      outputChannel.appendLine(`Error finding file details: ${error.message}`);
      res.status(404).send({ error: error.message });
    }
  });

  app.post("/multiple-file-contents", async (req, res) => {
    const { fileNames } = req.body;
    outputChannel.appendLine(`Received request for /multiple-file-contents with fileNames: ${fileNames}`);

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
      outputChannel.appendLine(`File details retrieved for: ${fileNames.join(", ")}`);

      const folderStructure = generateFolderStructure(rootPath);
      outputChannel.appendLine(`Generated folder structure for: ${rootPath}`);

      fileDetails.push({
        file_path: "Readme.txt",
        content: folderStructure,
        imports: [],
        dependencies: [],
      });

      outputChannel.appendLine("Sending response for /multiple-file-contents");
      res.send(fileDetails);
    } catch (error) {
      outputChannel.appendLine(`Error finding file details: ${error.message}`);
      res.status(404).send({ error: error.message });
    }
  });

  app.get("/all-files", async (req, res) => {
    const { role } = req.query;
    outputChannel.appendLine(`Received request for /all-files with role: ${role}`);
  
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
      if (typeof role === "string" && role.toLowerCase().includes("flutter")) {
        outputChannel.appendLine("Role identified as Flutter, searching in 'lib' directory.");
        allFiles = getFilesRecursive(path.join(rootPath, "lib"));
      } else if (
        typeof role === "string" &&
        role.toLowerCase().includes("react native")
      ) {
        outputChannel.appendLine("Role identified as React Native, searching in 'src' directory.");
        allFiles = getFilesRecursive(path.join(rootPath, "src"));
      } else {
        outputChannel.appendLine("Searching in the root directory.");
        allFiles = getFilesRecursive(rootPath);
      }
  
      const fileDetails = allFiles.map((filePath) => ({
        file_path: filePath,
        content: fs.readFileSync(filePath, "utf8"),
      }));
  
      const folderStructure = generateFolderStructure(rootPath);
      outputChannel.appendLine(`Generated folder structure for: ${rootPath}`);
      fileDetails.push({
        file_path: "Readme.txt",
        content: folderStructure,
      });
  
      outputChannel.appendLine("Sending response for /all-files");
      res.send(fileDetails);
    } catch (error) {
      outputChannel.appendLine(`Error retrieving all files: ${error.message}`);
      res.status(500).send({ error: "Failed to retrieve all files" });
    }
  });
  
  app.get("/assets", async (req, res) => {
    outputChannel.appendLine("Received request for /assets");
  
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
  });


  server = app
  .listen(PORT, () => {
    outputChannel.appendLine(`HuTouch AI File Analysis server started on port ${PORT}`);
  })
  .on("error", (err) => {
    outputChannel.appendLine(`Server error: ${err.message}`);
  });
}

exports.activate = activate;
exports.deactivate = deactivate;
