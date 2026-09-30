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
 *   edit_file               — replace an exact snippet (comes with fs.write)
 *   None of them writes a protected path (a ".git" folder or file at any depth,
 *   ".harness/hooks", ".harness/runs", the audit log); reads are not restricted.
 *
 * Execute tool (requires "bash" in node's allowedTools):
 *   bash / run_command — run a shell command line in the workspace. It runs only
 *   through a workflow node, after the user approves that exact command
 *   (services/execution/commandTool.ts); executeTool itself never runs it, and
 *   sub-agents never get it.
 */

import type { InvokeFn } from "@/services/model-providers/providerAdapter";
import type { FileTreeEntry } from "@/types/filesystem";
import { applyEdit } from "@/services/execution/editFile";

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
  edit_file: {
    name: "edit_file",
    description:
      "Replace an exact piece of text in an existing workspace file. old_string must match the file exactly " +
      "(whitespace and indentation included) and occur once, unless replace_all is true. " +
      "Use it to change existing files; use fs.write to create a file.",
    args: {
      path: "Relative path from workspace root",
      old_string: "The exact text to replace",
      new_string: "The replacement text",
      replace_all: "(optional) true to replace every occurrence",
    },
  },
  bash: {
    name: "bash",
    description:
      "Run one command line in the workspace folder (cmd.exe on Windows, sh elsewhere) and get its exit code " +
      "and output, e.g. to run the tests. The user must approve each command before it runs; a denied " +
      "command is not run. It gets no input and stops at your time limit. On Windows a bare name such as " +
      "build.bat is not looked up in the workspace folder: run it as .\\build.bat.",
    args: { command: "The command line, e.g. npm test" },
  },
};

// Run by the agent loop (services/execution/subAgents.ts), not by executeTool.
const AGENT_TOOL_DEFS: Record<string, ToolDef> = {
  subagent_dispatch: {
    name: "subagent_dispatch",
    description:
      "Start a helper agent with a fresh context to do one self-contained task and get its final report back. " +
      "Put everything it needs in the task: the goal, relevant facts or file paths, constraints, and what to report. " +
      "Several calls in one reply run in parallel.",
    args: {
      task: "The complete brief for the helper",
      name: "(optional) Short label for the helper, e.g. spec-reader",
      tools: "(optional) Which of your tools the helper may use, e.g. [\"read_file\"]; default: all of yours",
    },
  },
};

// ── Native tool definitions ───────────────────────────────────────────────────

/** A tool definition in JSON-schema form, for providers with native tool calling. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const REQUIRED_ARGS: Record<string, string[]> = {
  read_file: ["path"],
  "fs.read": ["path"],
  list_files: [],
  grep: ["path", "pattern"],
  "fs.write": ["path", "content"],
  "fs.append": ["path", "content"],
  edit_file: ["path", "old_string", "new_string"],
  bash: ["command"],
  subagent_dispatch: ["task"],
};

// Arguments that are not plain strings.
const ARG_SCHEMAS: Record<string, Record<string, Record<string, unknown>>> = {
  edit_file: { replace_all: { type: "boolean" } },
  subagent_dispatch: { tools: { type: "array", items: { type: "string" } } },
};

function toolDef(tool: string): ToolDef | undefined {
  return SAFE_TOOL_DEFS[tool] ?? WRITE_EXEC_TOOL_DEFS[tool] ?? AGENT_TOOL_DEFS[tool];
}

/** The node's tools that actually run; the others (web_search, …) never execute.
 *  Editing is part of writing: a node with fs.write also gets edit_file. */
export function runnableTools(allowedTools: string[]): string[] {
  const tools = allowedTools.filter((t) => toolDef(t) !== undefined);
  if (tools.includes("fs.write") && !tools.includes("edit_file")) tools.push("edit_file");
  return tools;
}

/** Provider tool names may only use [a-zA-Z0-9_-]: "fs.read" is offered as "fs_read". */
export function nativeToolName(tool: string): string {
  return tool.replace(/\./g, "_");
}

/** The node's tool a call refers to (native name, tool name or alias), or null
 *  when the agent was not offered it. */
export function toolForNativeName(name: string, allowedTools: string[]): string | null {
  const canonical = TOOL_ALIASES[name] ?? name;
  return runnableTools(allowedTools).find((t) => t === canonical || nativeToolName(t) === name) ?? null;
}

export function toolDefinitions(allowedTools: string[]): ToolSpec[] {
  return runnableTools(allowedTools).map((tool) => {
    const def = toolDef(tool) as ToolDef;
    const properties = Object.fromEntries(
      Object.entries(def.args).map(([arg, text]) => [
        arg,
        { ...(ARG_SCHEMAS[tool]?.[arg] ?? { type: "string" }), description: text.replace(/^\(optional\)\s*/, "") },
      ]),
    );
    return {
      name: nativeToolName(tool),
      description: def.description,
      parameters: { type: "object", properties, required: REQUIRED_ARGS[tool] ?? [] },
    };
  });
}

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
  const agentNames = allowedTools.filter((t) => t in AGENT_TOOL_DEFS);

  if (safeNames.length === 0 && writeExecNames.length === 0 && agentNames.length === 0) return "";

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

  if (agentNames.length > 0) {
    sections.push(agentNames.map((n) => formatDef(AGENT_TOOL_DEFS[n])).join("\n\n"));
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
  args: Record<string, unknown>;
}

/** Native tool calls may send numbers or objects where the tool expects text. */
function argText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}

/** What a reply holds for the text protocol.
 *  none: no <tool_call> block, or one whose body does not start with "{" (the
 *        tag mentioned in prose).
 *  malformed: a block that looks like a call ("{…") but is not a valid one, or
 *        that is cut off before its closing tag (a reply that hit Max tokens). */
export type ToolCallReading =
  | { kind: "none" }
  | { kind: "call"; call: ToolCall }
  | { kind: "malformed"; reason: string };

/** Models often wrap the JSON inside the tags in a ``` fence, tagged json, jsonc, json5,
 *  javascript, js, typescript or ts, or not. (No regex that scans for the closing fence: on
 *  a long run of spaces it backtracks for seconds.) */
function unfence(body: string): string {
  let text = body.trim();
  if (text.startsWith("```")) text = text.replace(/^```(?:json[c5]?|javascript|js|typescript|ts)?/i, "");
  if (text.endsWith("```")) text = text.slice(0, -3);
  return text.trim();
}

/** Where a call was cut off before its closing tag, or -1: the last "<tool_call>", when
 *  no "</tool_call>" follows it and its body starts with "{". A reply that stops in the
 *  middle of a call ends like this. The tag mentioned in prose (a body that does not
 *  start with "{") is not one. */
function cutOffCallAt(text: string): number {
  const at = text.lastIndexOf("<tool_call>");
  if (at < 0) return -1;
  const body = text.slice(at + "<tool_call>".length);
  return !body.includes("</tool_call>") && unfence(body).startsWith("{") ? at : -1;
}

export function readToolCall(text: string): ToolCallReading {
  const match = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  const body = match ? unfence(match[1]) : "";
  if (!body.startsWith("{")) {
    // No closed call. A reply cut off in the middle of one is no answer either.
    return cutOffCallAt(text) < 0
      ? { kind: "none" }
      : { kind: "malformed", reason: "the call was cut off before </tool_call>" };
  }
  let parsed: { name?: unknown; args?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return { kind: "malformed", reason: e instanceof Error ? e.message : String(e) };
  }
  if (typeof parsed.name !== "string") return { kind: "malformed", reason: 'it has no "name" string' };
  const { args } = parsed;
  if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
    return { kind: "malformed", reason: '"args" must be a JSON object' };
  }
  return { kind: "call", call: { name: parsed.name, args: (args ?? {}) as Record<string, unknown> } };
}

/** Strip the tool_call tag from text, returning just the surrounding content. A call
 *  cut off before its closing tag goes too (readToolCall counts it as a broken call). */
export function stripToolCall(text: string): string {
  const closed = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "");
  const cutOff = cutOffCallAt(closed);
  return (cutOff < 0 ? closed : closed.slice(0, cutOff)).trim();
}

// ── Permission helpers ────────────────────────────────────────────────────────

function resolveCanonical(toolName: string): string {
  return TOOL_ALIASES[toolName] ?? toolName;
}

/** The node permission a tool needs; edit_file comes with fs.write. */
function permissionFor(toolName: string): string {
  const canonical = resolveCanonical(toolName);
  return canonical === "edit_file" ? "fs.write" : canonical;
}

function isToolAllowed(toolName: string, allowedTools: string[]): boolean {
  return allowedTools.includes(toolName) || allowedTools.includes(permissionFor(toolName));
}

const WRITE_EXEC_TOOLS = new Set([
  "fs.write", "write_file",
  "fs.append", "append_file",
  "edit_file",
  "bash", "run_command",
]);

/** A Rust io error for a missing file or folder: "(os error 2)" / "(os error 3)"
 *  end the message whatever the OS language. */
export function isNotFound(error: unknown): boolean {
  return /\(os error [23]\)/.test(String(error));
}

// ── Protected paths ───────────────────────────────────────────────────────────

/**
 * Paths an agent may read but never write: a ".git" folder or file at any depth
 * (a changed hook or config runs code the next time git runs), ".harness/hooks"
 * and everything under it, ".harness/runs" and everything under it (a resumed run
 * trusts its saved record, the hook-script hashes included), and
 * ".harness/audit.log.jsonl". Judged on the path's text, not on the disk: "\"
 * counts as "/", "." and ".." segments are resolved, case is ignored, and a
 * symlink is not followed.
 */
function isProtectedPath(path: string): boolean {
  const text = path.trim().replace(/\\/g, "/");
  // An absolute path, or one that climbs above the workspace root, cannot be placed
  // under the root by its text, yet the backend accepts it while it lands inside the
  // workspace. Then ".harness" is matched at any depth instead of at the root only.
  let atRoot = !/^\/|^[a-z]:/i.test(text);
  const parts: string[] = [];
  for (const part of text.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part.toLowerCase());
    else if (parts.length > 0) parts.pop();
    else atRoot = false;
  }
  return parts.some((part, i) =>
    part === ".git" ||
    (part === ".harness" && (i === 0 || !atRoot) &&
      // runs: a resumed run trusts its saved record (hook script hashes included).
      (parts[i + 1] === "hooks" || parts[i + 1] === "runs" ||
        (parts[i + 1] === "audit.log.jsonl" && i + 2 === parts.length))));
}

function protectedPathError(tool: string, path: string): string {
  return `[error] ${tool} refused: ${path.trim()} is a protected path ` +
    "(git internals, .harness/hooks, .harness/runs and the audit log); nothing was written.";
}

// ── Tool executor ─────────────────────────────────────────────────────────────

/** Told about every file an agent changes: its content before (null if new) and after. */
export type FileChangeListener = (path: string, before: string | null, after: string) => void;

/** The file's content, null if it does not exist yet. Any other failure is thrown:
 *  a file that cannot be read must not pass for a new one. */
async function readBefore(invokeFn: InvokeFn, workspacePath: string, path: string): Promise<string | null> {
  try {
    return await invokeFn<string>("read_workspace_file", { workspacePath, relativePath: path });
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

export async function executeTool(
  call: ToolCall,
  workspacePath: string | null,
  invokeFn: InvokeFn,
  allowedTools: string[] = [],
  onChange?: FileChangeListener,
): Promise<string> {
  if (!workspacePath) {
    return "[error] No workspace open — open a workspace folder first.";
  }

  const { name, args } = call;

  // Guard: write/exec tools require explicit allowedTools permission
  if (WRITE_EXEC_TOOLS.has(name) && !isToolAllowed(name, allowedTools)) {
    return `[error] Tool "${name}" is not enabled for this agent. Enable "${permissionFor(name)}" in the Permission Matrix.`;
  }

  try {
    // ── Read tools ───────────────────────────────────────────────────────────

    if (name === "read_file" || name === "fs.read") {
      const path = argText(args.path ?? args.file);
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
      // The backend returns a nested tree (with "\" separators on Windows): flatten
      // it and use "/" so sub-directory prefixes and patterns match nested files.
      const flat: FileTreeEntry[] = [];
      const walk = (items: FileTreeEntry[]) => {
        for (const e of items) {
          flat.push({ ...e, path: e.path.replace(/\\/g, "/") });
          if (e.children) walk(e.children);
        }
      };
      walk(entries);
      const prefix = argText(args.path).trim().replace(/\\/g, "/").replace(/^\/|\/$/g, "");
      const pattern = argText(args.pattern).trim();
      const filtered = flat
        .filter((e) => {
          if (prefix && e.path !== prefix && !e.path.startsWith(`${prefix}/`)) return false;
          if (pattern && !e.path.endsWith(pattern)) return false;
          return true;
        })
        .map((e) => `${e.isDirectory ? "📁" : "📄"} ${e.path}`)
        .slice(0, 100);
      return `Files${prefix ? ` under ${prefix}` : ""}:\n${filtered.join("\n") || "(none)"}`;
    }

    if (name === "grep") {
      const path = argText(args.path);
      const pattern = argText(args.pattern);
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
      const path = argText(args.path);
      if (!path) return "[error] fs.write requires a 'path' argument.";
      if (isProtectedPath(path)) return protectedPathError("fs.write", path);
      // Left out is not empty: only an explicit "" writes an empty file.
      if (args.content === undefined || args.content === null) return "[error] fs.write requires 'content'";
      const content = argText(args.content);
      // The old content is only read when someone records changes. Only a missing file
      // is new: a file that exists but cannot be read (say, not UTF-8) must not be
      // replaced, or the change log would never know.
      let before: string | null | undefined;
      if (onChange) {
        try {
          before = await readBefore(invokeFn, workspacePath, path.trim());
        } catch (e) {
          return `[error] fs.write could not read ${path}; nothing was written: ${String(e)}`;
        }
      }
      await invokeFn<void>("write_workspace_file", {
        workspacePath,
        relativePath: path.trim(),
        content,
      });
      if (before !== undefined) onChange?.(path.trim(), before, content);
      return `Written: ${path} (${content.length} chars)`;
    }

    if (name === "fs.append" || name === "append_file") {
      const path = argText(args.path);
      if (!path) return "[error] fs.append requires a 'path' argument.";
      if (isProtectedPath(path)) return protectedPathError("fs.append", path);
      if (args.content === undefined || args.content === null) return "[error] fs.append requires 'content'";
      const toAppend = argText(args.content);
      // Only a missing file counts as empty. Any other read failure (e.g. a
      // non-UTF-8 file) must not turn the append into an overwrite. Rust io
      // errors end in "(os error 2)" (not found) / "(os error 3)" (no such
      // directory) regardless of the OS language.
      let existing: string | null;
      try {
        existing = await invokeFn<string>("read_workspace_file", {
          workspacePath,
          relativePath: path.trim(),
        });
      } catch (e) {
        if (!isNotFound(e)) {
          return `[error] fs.append could not read ${path}; nothing was written: ${String(e)}`;
        }
        existing = null;
      }
      const after = (existing ?? "") + toAppend;
      await invokeFn<void>("write_workspace_file", {
        workspacePath,
        relativePath: path.trim(),
        content: after,
      });
      onChange?.(path.trim(), existing, after);
      return `Appended to: ${path} (+${toAppend.length} chars)`;
    }

    if (name === "edit_file") {
      const path = argText(args.path).trim();
      if (!path) return "[error] edit_file requires a 'path' argument.";
      if (isProtectedPath(path)) return protectedPathError("edit_file", path);
      if (args.new_string === undefined || args.new_string === null) return "[error] edit_file requires 'new_string'";
      let before: string;
      try {
        before = await invokeFn<string>("read_workspace_file", { workspacePath, relativePath: path });
      } catch (e) {
        if (isNotFound(e)) return `[error] ${path} does not exist. Use fs.write to create it.`;
        throw e;
      }
      const replaceAll = args.replace_all === true || args.replace_all === "true";
      const edit = applyEdit(before, argText(args.old_string), argText(args.new_string), replaceAll);
      if (!edit.ok) return `[error] ${edit.error}`;
      await invokeFn<void>("write_workspace_file", { workspacePath, relativePath: path, content: edit.content });
      onChange?.(path, before, edit.content);
      return `Edited: ${path} (${edit.replacements} replacement${edit.replacements === 1 ? "" : "s"})`;
    }

    // ── Execute tools ────────────────────────────────────────────────────────

    if (name === "bash" || name === "run_command") {
      return `[error] ${name} is not available here: commands run only as a workflow agent's tool, ` +
        "after the user approves each one.";
    }

    return `[error] Tool "${name}" is not available or not safe to execute automatically.`;
  } catch (e) {
    return `[error] ${name} failed: ${String(e)}`;
  }
}
