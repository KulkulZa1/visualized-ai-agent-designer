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

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { callOllamaApi, callOpenAIApi, callClaudeApi, checkOllamaHealth, isOfficialOpenAIEndpoint } from "./providerBridge";
import { CredentialService } from "./credentialService";

// Workspace file helpers

/**
 * Resolves a webview-supplied relative path inside the host's workspace folder and
 * returns its real path. The webview is untrusted: `..`, absolute paths and
 * symlinks/junctions that lead outside the workspace are rejected.
 */
function resolveInsideWorkspace(workspacePath: string, relativePath: string): string {
  if (!workspacePath) throw new Error("[HarnessVscode] No workspace folder is open.");
  const root = fs.realpathSync(path.resolve(workspacePath));
  const target = path.resolve(root, relativePath);

  // Resolve links on the deepest part of the path that exists. lstat does not follow
  // links, so a dangling link is realpath'd too (and fails) instead of being skipped.
  let existing = target;
  const tail: string[] = [];
  for (;;) {
    try { fs.lstatSync(existing); break; } catch { /* not created yet */ }
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  const real = path.join(fs.realpathSync(existing), ...tail);

  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (norm(real) !== norm(root) && !norm(real).startsWith(norm(rootPrefix))) {
    throw new Error(`[HarnessVscode] Path is outside the workspace: ${relativePath}`);
  }
  return real;
}

async function readWorkspaceFile(workspacePath: string, relativePath: string): Promise<string> {
  const abs = vscode.Uri.file(resolveInsideWorkspace(workspacePath, relativePath));
  const bytes = await vscode.workspace.fs.readFile(abs);
  return Buffer.from(bytes).toString("utf-8");
}

interface FileEntry {
  path: string;
  name: string;
  isDirectory: boolean;
}

async function listWorkspaceFiles(workspacePath: string): Promise<FileEntry[]> {
  const root = vscode.Uri.file(workspacePath);
  const entries: FileEntry[] = [];

  async function walk(dir: vscode.Uri, prefix: string) {
    try {
      const items = await vscode.workspace.fs.readDirectory(dir);
      for (const [name, type] of items) {
        if (name.startsWith(".") || name === "node_modules" || name === "target") continue;
        const relPath = prefix ? `${prefix}/${name}` : name;
        const isDir = type === vscode.FileType.Directory;
        entries.push({ path: relPath, name, isDirectory: isDir });
        if (isDir && entries.length < 500) {
          await walk(vscode.Uri.joinPath(dir, name), relPath);
        }
      }
    } catch { /* skip unreadable directories */ }
  }

  await walk(root, "");
  return entries;
}

// ── Handler registry ─────────────────────────────────────────────────────────

export async function handleInvoke(
  command: string,
  args: Record<string, unknown>,
  credentials: CredentialService,
  workspacePath: string,
): Promise<unknown> {
  switch (command) {
    case "call_ollama_api": {
      const ollamaKey = await credentials.getApiKey("ollama");
      return callOllamaApi({
        model:       String(args.model       ?? "qwen2.5-coder:7b"),
        system:      String(args.system      ?? ""),
        userMessage: String(args.userMessage ?? ""),
        baseUrl:     String(args.baseUrl     ?? "http://localhost:11434"),
        apiKey:      ollamaKey ?? String(args.apiKey ?? ""),
        maxTokens:   Number(args.maxTokens   ?? 2048),
      });
    }

    case "call_openai_api": {
      const baseUrl = args.baseUrl != null ? String(args.baseUrl) : null;
      // The stored OpenAI key only ever goes to OpenAI itself. A custom baseUrl (chosen
      // by the webview) gets just the key the request carried, which may be empty.
      const openaiKey = isOfficialOpenAIEndpoint(baseUrl)
        ? await credentials.getApiKey("openai")
        : undefined;
      return callOpenAIApi({
        model:           String(args.model           ?? "gpt-4o-mini"),
        system:          String(args.system          ?? ""),
        userMessage:     String(args.userMessage     ?? ""),
        apiKey:          openaiKey ?? String(args.apiKey ?? ""),
        maxTokens:       Number(args.maxTokens       ?? 2048),
        baseUrl,
        reasoningEffort: args.reasoningEffort != null ? String(args.reasoningEffort) : null,
      });
    }

    case "call_claude_api": {
      const anthropicKey = await credentials.getApiKey("anthropic");
      return callClaudeApi({
        model:       String(args.model       ?? "claude-haiku-4.5"),
        system:      String(args.system      ?? ""),
        userMessage: String(args.userMessage ?? ""),
        apiKey:      anthropicKey ?? String(args.apiKey ?? ""),
        maxTokens:   Number(args.maxTokens   ?? 2048),
      });
    }

    case "get_provider_defaults": {
      const ollamaBaseUrl = vscode.workspace.getConfiguration("harness").get<string>("ollamaBaseUrl", "http://localhost:11434");
      const ollamaModel   = vscode.workspace.getConfiguration("harness").get<string>("ollamaModel", "qwen2.5-coder:7b");
      return credentials.getProviderDefaults(ollamaBaseUrl, ollamaModel);
    }

    case "check_provider_health": {
      const provider = String(args.provider ?? "ollama");
      if (provider === "ollama" || provider === "ollama-cloud") {
        const ollamaKey = await credentials.getApiKey("ollama");
        return checkOllamaHealth(
          String(args.baseUrl  ?? "http://localhost:11434"),
          String(args.model    ?? "qwen2.5-coder:7b"),
          ollamaKey ?? "",
        );
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
