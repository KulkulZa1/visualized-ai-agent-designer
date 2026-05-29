/**
 * toolExecutor — safe tool execution for agent workflows.
 *
 * Read tools (always available when listed in allowedTools):
 *   read_file / fs.read  — read a workspace file
 *   list_files           — list files under a path
 *   grep                 — search text in a file
 *
 * Write tools (require "fs.write" or "fs.append" in node's allowedTools):
 *   fs.write / write_file   — overwrite a file
 *   fs.append / append_file — append to a file
 *
 * Execute tools (require "bash" in node's allowedTools):
 *   bash / run_command — run a shell command in the workspace directory
 */

import type { InvokeFn } from "@/services/model-providers/providerAdapter";
import type { FileTreeEntry, HookResult } from "@/types/filesystem";

// ── Tool definitions ──────────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  args: Record<string, string>;
}

const SAFE_TOOL_DEFS: Record<string, ToolDef> = {
  read_file: {
    name: "read_file",
    description: "Read the full content of a workspace file.",
    args: { path: "Relative path from workspace root, e.g. src/main.ts" },
  },
  "fs.read": {
    name: "fs.read",
    description: "Read the full content of a workspace file (alias for read_file).",
    args: { path: "Relative path from workspace root" },
  },
  list_files: {
    name: "list_files",
    description: "List files and directories under a path (non-recursive by default).",
    args: {
      path: "Relative directory path, e.g. src/components",
      pattern: "(optional) Extension filter, e.g. .ts",
    },
  },
  grep: {
    name: "grep",
    description: "Search for a text pattern in a workspace file.",
    args: {
      path: "Relative file path to search",
      pattern: "Text or regex pattern to search for",
    },
  },
};

const WRITE_EXEC_TOOL_DEFS: Record<string, ToolDef> = {
  "fs.write": {
    name: "fs.write",
    description: "Overwrite a workspace file with new content. Creates the file if it does not exist.",
    args: {
      path: "Relative path from workspace root, e.g. src/output.ts",
      content: "Full file content to write",
    },
  },
  "fs.append": {
    name: "fs.append",
    description: "Append text to the end of a workspace file. Creates the file if it does not exist.",
    args: {
      path: "Relative path from workspace root",
      content: "Text to append",
    },
  },
  bash: {
    name: "bash",
    description: "Run a shell command in the workspace directory. Returns stdout, stderr, and exit code.",
    args: {
      command: "Shell command to run, e.g. npx tsc --noEmit or npm test",
    },
  },
};

// Canonical name for each tool alias (LLM may use either form)
const TOOL_ALIASES: Record<string, string> = {
  write_file: "fs.write",
  append_file: "fs.append",
  run_command: "bash",
};

// ── System message injection ──────────────────────────────────────────────────

/**
 * Build the tool instructions to inject into the system message.
 * Only includes tools the agent actually has permission to use.
 */
export function buildToolInstructions(allowedTools: string[]): string {
  const safeNames = allowedTools.filter((t) => t in SAFE_TOOL_DEFS);
  const writeExecNames = allowedTools.filter((t) => t in WRITE_EXEC_TOOL_DEFS);

  if (safeNames.length === 0 && writeExecNames.length === 0) return "";

  function formatDef(def: ToolDef): string {
    const argList = Object.entries(def.args)
      .map(([k, v]) => `  "${k}": "${v}"`)
      .join(",\n");
    return `• ${def.name}: ${def.description}\n  Args: {${argList}\n  }`;
  }

  const sections: string[] = [];

  if (safeNames.length > 0) {
    sections.push(safeNames.map((n) => formatDef(SAFE_TOOL_DEFS[n])).join("\n\n"));
  }

  if (writeExecNames.length > 0) {
    const writeExecBlock = writeExecNames.map((n) => formatDef(WRITE_EXEC_TOOL_DEFS[n])).join("\n\n");
    sections.push(
      `WRITE / EXECUTE TOOLS — use only when your task specifically requires creating,\n` +
      `modifying files, or running commands. Do not use these unless necessary.\n\n` +
      writeExecBlock
    );
  }

  return `
## Tool Usage
You have access to these tools:

${sections.join("\n\n")}

To call a tool, respond with EXACTLY this (nothing else on that line):
<tool_call>{"name":"<tool_name>","args":{<args_json>}}</tool_call>

After seeing the <tool_result>, continue your original task.
Only call one tool per response. Do not call tools you don't need.
If you don't need a tool right now, respond normally without any tool_call tags.
`.trim();
}

// ── Tool call parser ──────────────────────────────────────────────────────────

export interface ToolCall {
  name: string;
  args: Record<string, string>;
}

export function parseToolCall(text: string): ToolCall | null {
  const match = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (typeof parsed.name !== "string") return null;
    return { name: parsed.name, args: parsed.args ?? {} };
  } catch {
    return null;
  }
}

/** Strip the tool_call tag from text, returning just the surrounding content. */
export function stripToolCall(text: string): string {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
}

// ── Permission helpers ────────────────────────────────────────────────────────

function resolveCanonical(toolName: string): string {
  return TOOL_ALIASES[toolName] ?? toolName;
}

function isToolAllowed(toolName: string, allowedTools: string[]): boolean {
  const canonical = resolveCanonical(toolName);
  return allowedTools.includes(toolName) || allowedTools.includes(canonical);
}

const WRITE_EXEC_TOOLS = new Set([
  "fs.write", "write_file",
  "fs.append", "append_file",
  "bash", "run_command",
]);

// ── Tool executor ─────────────────────────────────────────────────────────────

export async function executeTool(
  call: ToolCall,
  workspacePath: string | null,
  invokeFn: InvokeFn,
  allowedTools: string[] = [],
): Promise<string> {
  if (!workspacePath) {
    return "[error] No workspace open — open a workspace folder first.";
  }

  const { name, args } = call;

  // Guard: write/exec tools require explicit allowedTools permission
  if (WRITE_EXEC_TOOLS.has(name) && !isToolAllowed(name, allowedTools)) {
    const canonical = resolveCanonical(name);
    return `[error] Tool "${name}" is not enabled for this agent. Enable "${canonical}" in the Permission Matrix.`;
  }

  try {
    // ── Read tools ───────────────────────────────────────────────────────────

    if (name === "read_file" || name === "fs.read") {
      const path = args.path ?? args.file ?? "";
      if (!path) return "[error] read_file requires a 'path' argument.";
      const content = await invokeFn<string>("read_workspace_file", {
        workspacePath,
        relativePath: path.trim(),
      });
      return `File: ${path}\n${"─".repeat(40)}\n${content}`;
    }

    if (name === "list_files") {
      const entries = await invokeFn<FileTreeEntry[]>("list_workspace_files", {
        workspacePath,
      });
      const prefix = (args.path ?? "").trim().replace(/^\/|\/$/g, "");
      const pattern = (args.pattern ?? "").trim();
      const filtered = entries
        .filter((e) => {
          if (prefix && !e.path.startsWith(prefix)) return false;
          if (pattern && !e.path.endsWith(pattern)) return false;
          return true;
        })
        .map((e) => `${e.isDirectory ? "📁" : "📄"} ${e.path}`)
        .slice(0, 100);
      return `Files${prefix ? ` under ${prefix}` : ""}:\n${filtered.join("\n") || "(none)"}`;
    }

    if (name === "grep") {
      const path = args.path ?? "";
      const pattern = args.pattern ?? "";
      if (!path || !pattern) return "[error] grep requires 'path' and 'pattern' arguments.";
      const content = await invokeFn<string>("read_workspace_file", {
        workspacePath,
        relativePath: path.trim(),
      });
      const lines = content.split("\n");
      let re: RegExp;
      try { re = new RegExp(pattern, "i"); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
      const matches = lines
        .map((line, i) => ({ line, num: i + 1 }))
        .filter(({ line }) => re.test(line))
        .map(({ line, num }) => `${String(num).padStart(4)}: ${line}`)
        .slice(0, 50);
      return matches.length > 0
        ? `grep "${pattern}" in ${path}:\n${matches.join("\n")}`
        : `grep "${pattern}" in ${path}: no matches found.`;
    }

    // ── Write tools ──────────────────────────────────────────────────────────

    if (name === "fs.write" || name === "write_file") {
      const path = args.path ?? "";
      if (!path) return "[error] fs.write requires a 'path' argument.";
      const content = args.content ?? "";
      await invokeFn<void>("write_workspace_file", {
        workspacePath,
        relativePath: path.trim(),
        content,
      });
      return `Written: ${path} (${content.length} chars)`;
    }

    if (name === "fs.append" || name === "append_file") {
      const path = args.path ?? "";
      if (!path) return "[error] fs.append requires a 'path' argument.";
      const toAppend = args.content ?? "";
      const existing = await invokeFn<string>("read_workspace_file", {
        workspacePath,
        relativePath: path.trim(),
      }).catch(() => "");
      await invokeFn<void>("write_workspace_file", {
        workspacePath,
        relativePath: path.trim(),
        content: existing + toAppend,
      });
      return `Appended to: ${path} (+${toAppend.length} chars)`;
    }

    // ── Execute tools ────────────────────────────────────────────────────────

    if (name === "bash" || name === "run_command") {
      const command = args.command ?? "";
      if (!command) return "[error] bash requires a 'command' argument.";
      const result = await invokeFn<HookResult>("execute_inline_command", {
        workspacePath,
        command,
        consentGranted: true,
      });
      const out = [
        result.stdout.trim(),
        result.stderr.trim() ? `[stderr] ${result.stderr.trim()}` : "",
      ].filter(Boolean).join("\n");
      return `exit ${result.exitCode}\n${out || "(no output)"}`;
    }

    return `[error] Tool "${name}" is not available or not safe to execute automatically.`;
  } catch (e) {
    return `[error] ${name} failed: ${String(e)}`;
  }
}
