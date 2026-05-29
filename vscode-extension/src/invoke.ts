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
import * as path from "path";
import { callOllamaApi, callOpenAIApi, callClaudeApi, checkOllamaHealth } from "./providerBridge";
import { CredentialService } from "./credentialService";

// Workspace file helpers
async function readWorkspaceFile(workspacePath: string, relativePath: string): Promise<string> {
  const abs = vscode.Uri.file(path.join(workspacePath, relativePath));
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
      const openaiKey = await credentials.getApiKey("openai");
      return callOpenAIApi({
        model:           String(args.model           ?? "gpt-4o-mini"),
        system:          String(args.system          ?? ""),
        userMessage:     String(args.userMessage     ?? ""),
        apiKey:          openaiKey ?? String(args.apiKey ?? ""),
        maxTokens:       Number(args.maxTokens       ?? 2048),
        baseUrl:         args.baseUrl != null ? String(args.baseUrl) : null,
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

    case "read_workspace_file": {
      const ws = String(args.workspacePath ?? workspacePath);
      const rel = String(args.relativePath ?? "");
      return readWorkspaceFile(ws, rel);
    }

    case "list_workspace_files": {
      const ws = String(args.workspacePath ?? workspacePath);
      return listWorkspaceFiles(ws);
    }

    case "get_workspace_path":
      return workspacePath;

    case "load_workflow_file": {
      const ws = String(args.workspacePath ?? workspacePath);
      const rel = String(args.relativePath ?? "");
      return readWorkspaceFile(ws, rel);
    }

    case "save_workflow_file": {
      const ws = String(args.workspacePath ?? workspacePath);
      const rel = String(args.relativePath ?? "");
      const content = String(args.content ?? "");
      const abs = vscode.Uri.file(path.join(ws, rel));
      await vscode.workspace.fs.writeFile(abs, Buffer.from(content, "utf-8"));
      return null;
    }

    default:
      throw new Error(`[HarnessVscode] Unhandled command: "${command}". This command requires the Tauri runtime.`);
  }
}
