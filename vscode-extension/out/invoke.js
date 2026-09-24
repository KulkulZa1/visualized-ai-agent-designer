"use strict";
/**
 * invoke.ts — VS Code adapter that replaces Tauri's invoke() function.
 *
 * The Harness Studio frontend calls `invoke("command_name", args)` for all
 * backend operations. In the Tauri app, this calls the Rust backend.
 * In the VS Code extension, we handle the same commands using Node.js APIs.
 *
 * The webview sends messages via postMessage; this module handles them in
 * the extension host and responds with postMessage back.
 *
 * Supported commands:
 *   call_ollama_api      — HTTP to local/remote Ollama
 *   call_openai_api      — HTTP to OpenAI (or compatible endpoint)
 *   call_claude_api      — HTTP to Anthropic
 *   get_provider_defaults — returns configured provider info
 *   check_provider_health — Ollama health check
 *   read_workspace_file  — vscode.workspace.fs read
 *   list_workspace_files — vscode.workspace.fs list
 *   get_workspace_path   — returns the open workspace root
 *   load_workflow_file   — YAML read + parse (for opening .harness.yaml files)
 *   save_workflow_file   — YAML write (for saving workflows)
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
exports.handleInvoke = handleInvoke;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const providerBridge_1 = require("./providerBridge");
// Workspace file helpers
/**
 * Resolves a webview-supplied relative path inside the host's workspace folder and
 * returns its real path. The webview is untrusted: `..`, absolute paths and
 * symlinks/junctions that lead outside the workspace are rejected.
 */
function resolveInsideWorkspace(workspacePath, relativePath) {
    if (!workspacePath)
        throw new Error("[HarnessVscode] No workspace folder is open.");
    const root = fs.realpathSync(path.resolve(workspacePath));
    const target = path.resolve(root, relativePath);
    // Resolve links on the deepest part of the path that exists. lstat does not follow
    // links, so a dangling link is realpath'd too (and fails) instead of being skipped.
    let existing = target;
    const tail = [];
    for (;;) {
        try {
            fs.lstatSync(existing);
            break;
        }
        catch { /* not created yet */ }
        const parent = path.dirname(existing);
        if (parent === existing)
            break;
        tail.unshift(path.basename(existing));
        existing = parent;
    }
    const real = path.join(fs.realpathSync(existing), ...tail);
    const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
    const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (norm(real) !== norm(root) && !norm(real).startsWith(norm(rootPrefix))) {
        throw new Error(`[HarnessVscode] Path is outside the workspace: ${relativePath}`);
    }
    return real;
}
async function readWorkspaceFile(workspacePath, relativePath) {
    const abs = vscode.Uri.file(resolveInsideWorkspace(workspacePath, relativePath));
    const bytes = await vscode.workspace.fs.readFile(abs);
    return Buffer.from(bytes).toString("utf-8");
}
async function listWorkspaceFiles(workspacePath) {
    const root = vscode.Uri.file(workspacePath);
    const entries = [];
    async function walk(dir, prefix) {
        try {
            const items = await vscode.workspace.fs.readDirectory(dir);
            for (const [name, type] of items) {
                if (name.startsWith(".") || name === "node_modules" || name === "target")
                    continue;
                const relPath = prefix ? `${prefix}/${name}` : name;
                const isDir = type === vscode.FileType.Directory;
                entries.push({ path: relPath, name, isDirectory: isDir });
                if (isDir && entries.length < 500) {
                    await walk(vscode.Uri.joinPath(dir, name), relPath);
                }
            }
        }
        catch { /* skip unreadable directories */ }
    }
    await walk(root, "");
    return entries;
}
// ── Handler registry ─────────────────────────────────────────────────────────
async function handleInvoke(command, args, credentials, workspacePath) {
    switch (command) {
        case "call_ollama_api": {
            const ollamaKey = await credentials.getApiKey("ollama");
            return (0, providerBridge_1.callOllamaApi)({
                model: String(args.model ?? "qwen2.5-coder:7b"),
                system: String(args.system ?? ""),
                userMessage: String(args.userMessage ?? ""),
                baseUrl: String(args.baseUrl ?? "http://localhost:11434"),
                apiKey: ollamaKey ?? String(args.apiKey ?? ""),
                maxTokens: Number(args.maxTokens ?? 2048),
            });
        }
        case "call_openai_api": {
            const baseUrl = args.baseUrl != null ? String(args.baseUrl) : null;
            // The stored OpenAI key only ever goes to OpenAI itself. A custom baseUrl (chosen
            // by the webview) gets just the key the request carried, which may be empty.
            const openaiKey = (0, providerBridge_1.isOfficialOpenAIEndpoint)(baseUrl)
                ? await credentials.getApiKey("openai")
                : undefined;
            return (0, providerBridge_1.callOpenAIApi)({
                model: String(args.model ?? "gpt-4o-mini"),
                system: String(args.system ?? ""),
                userMessage: String(args.userMessage ?? ""),
                apiKey: openaiKey ?? String(args.apiKey ?? ""),
                maxTokens: Number(args.maxTokens ?? 2048),
                baseUrl,
                reasoningEffort: args.reasoningEffort != null ? String(args.reasoningEffort) : null,
            });
        }
        case "call_claude_api": {
            const anthropicKey = await credentials.getApiKey("anthropic");
            return (0, providerBridge_1.callClaudeApi)({
                model: String(args.model ?? "claude-haiku-4.5"),
                system: String(args.system ?? ""),
                userMessage: String(args.userMessage ?? ""),
                apiKey: anthropicKey ?? String(args.apiKey ?? ""),
                maxTokens: Number(args.maxTokens ?? 2048),
            });
        }
        case "get_provider_defaults": {
            const ollamaBaseUrl = vscode.workspace.getConfiguration("harness").get("ollamaBaseUrl", "http://localhost:11434");
            const ollamaModel = vscode.workspace.getConfiguration("harness").get("ollamaModel", "qwen2.5-coder:7b");
            return credentials.getProviderDefaults(ollamaBaseUrl, ollamaModel);
        }
        case "check_provider_health": {
            const provider = String(args.provider ?? "ollama");
            if (provider === "ollama" || provider === "ollama-cloud") {
                const ollamaKey = await credentials.getApiKey("ollama");
                return (0, providerBridge_1.checkOllamaHealth)(String(args.baseUrl ?? "http://localhost:11434"), String(args.model ?? "qwen2.5-coder:7b"), ollamaKey ?? "");
            }
            // For other providers, return a simple health stub
            return { ok: false, message: `${provider} health check not implemented in VS Code extension`, model_available: false, pull_command: null };
        }
        // File commands always use the host's workspace folder; a webview-supplied
        // args.workspacePath is ignored.
        case "read_workspace_file": {
            const rel = String(args.relativePath ?? "");
            return readWorkspaceFile(workspacePath, rel);
        }
        case "list_workspace_files":
            return listWorkspaceFiles(resolveInsideWorkspace(workspacePath, ""));
        case "get_workspace_path":
            return workspacePath;
        case "load_workflow_file": {
            const rel = String(args.relativePath ?? "");
            return readWorkspaceFile(workspacePath, rel);
        }
        case "save_workflow_file": {
            const rel = String(args.relativePath ?? "");
            const content = String(args.content ?? "");
            const abs = vscode.Uri.file(resolveInsideWorkspace(workspacePath, rel));
            await vscode.workspace.fs.writeFile(abs, Buffer.from(content, "utf-8"));
            return null;
        }
        default:
            throw new Error(`[HarnessVscode] Unhandled command: "${command}". This command requires the Tauri runtime.`);
    }
}
