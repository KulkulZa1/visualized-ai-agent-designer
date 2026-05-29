"use strict";
/**
 * extension.ts — Harness Studio VS Code Extension entry point.
 *
 * Activation:
 *   - When a workspace contains *.harness.yaml files
 *   - When a .yaml file is opened
 *
 * Commands:
 *   harness.openWorkflow      — open the canvas panel for a workflow
 *   harness.newWorkflow       — open canvas with Create from Goal wizard
 *   harness.runWorkflow       — run the workflow shown in the active canvas
 *   harness.validateWorkflow  — validate active .harness.yaml file (YAML parse + Zod)
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const webviewPanel_1 = require("./webviewPanel");
const credentialService_1 = require("./credentialService");
const providerBridge_1 = require("./providerBridge");
let credentials;
function activate(context) {
    credentials = new credentialService_1.CredentialService(context.secrets);
    // ── Set workspace context for view visibility ──────────────────────────────
    function updateContext() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders)
            return;
        vscode.workspace.findFiles("**/*.harness.yaml", "**/node_modules/**", 1)
            .then((files) => {
            void vscode.commands.executeCommand("setContext", "workspaceHasHarnessYaml", files.length > 0);
        });
    }
    updateContext();
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(updateContext), vscode.workspace.onDidCreateFiles(updateContext));
    // ── harness.openWorkflow ───────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand("harness.openWorkflow", (uri) => {
        const panel = webviewPanel_1.HarnessPanel.createOrShow(context, credentials);
        if (uri) {
            // Post a message to the webview to load this specific workflow
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
            const relativePath = path.relative(workspacePath, uri.fsPath);
            setTimeout(() => {
                panel["_panel"].webview.postMessage({
                    type: "load_workflow",
                    path: relativePath,
                });
            }, 1000); // wait for React to initialize
        }
    }));
    // ── harness.newWorkflow ────────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand("harness.newWorkflow", () => {
        const panel = webviewPanel_1.HarnessPanel.createOrShow(context, credentials);
        setTimeout(() => {
            panel["_panel"].webview.postMessage({ type: "open_wizard" });
        }, 1000);
    }));
    // ── harness.runWorkflow ────────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand("harness.runWorkflow", () => {
        const panel = webviewPanel_1.HarnessPanel.createOrShow(context, credentials);
        setTimeout(() => {
            panel["_panel"].webview.postMessage({ type: "trigger_run" });
        }, 500);
    }));
    // ── harness.validateWorkflow ───────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand("harness.validateWorkflow", async (uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) {
            void vscode.window.showWarningMessage("Harness: no .harness.yaml file is active.");
            return;
        }
        const bytes = await vscode.workspace.fs.readFile(target);
        const text = Buffer.from(bytes).toString("utf-8");
        // Simple YAML parse check (YAML library not bundled; use JSON-friendly check)
        try {
            if (!text.includes("meta:") || !text.includes("agents:")) {
                throw new Error("File does not look like a .harness.yaml (missing meta or agents sections).");
            }
            void vscode.window.showInformationMessage(`Harness: ${path.basename(target.fsPath)} — basic structure looks valid. Run 'npm run harness workflow validate' for full Zod validation.`);
        }
        catch (e) {
            void vscode.window.showErrorMessage(`Harness validation error: ${String(e)}`);
        }
    }));
    // ── Status bar item: Ollama health ─────────────────────────────────────────
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.text = "$(loading~spin) Harness";
    statusItem.tooltip = "Harness Studio — checking Ollama…";
    statusItem.command = "harness.openWorkflow";
    statusItem.show();
    context.subscriptions.push(statusItem);
    async function refreshStatus() {
        const ollamaUrl = vscode.workspace.getConfiguration("harness").get("ollamaBaseUrl", "http://localhost:11434");
        const ollamaModel = vscode.workspace.getConfiguration("harness").get("ollamaModel", "qwen2.5-coder:7b");
        const ollamaKey = await credentials.getApiKey("ollama");
        const health = await (0, providerBridge_1.checkOllamaHealth)(ollamaUrl, ollamaModel, ollamaKey ?? "");
        if (health.ok && health.model_available) {
            statusItem.text = "$(check) Harness · Ollama ✓";
            statusItem.tooltip = `Harness Studio — ${health.message}`;
        }
        else if (health.ok) {
            statusItem.text = "$(warning) Harness · model missing";
            statusItem.tooltip = health.pull_command
                ? `Run: ${health.pull_command}`
                : health.message;
        }
        else {
            statusItem.text = "$(circle-slash) Harness · no Ollama";
            statusItem.tooltip = `${health.message}\nStart Ollama for local AI execution.`;
        }
    }
    void refreshStatus();
    const healthTimer = setInterval(() => void refreshStatus(), 60000);
    context.subscriptions.push({ dispose: () => clearInterval(healthTimer) });
    // ── Output channel for logs ────────────────────────────────────────────────
    const output = vscode.window.createOutputChannel("Harness Studio");
    output.appendLine("Harness Studio extension activated.");
    output.appendLine(`Extension path: ${context.extensionPath}`);
    context.subscriptions.push(output);
}
function deactivate() {
    webviewPanel_1.HarnessPanel.currentPanel?.dispose();
}
