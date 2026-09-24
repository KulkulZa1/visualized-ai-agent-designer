#!/usr/bin/env node
/**
 * Harness Studio MCP Server — stdio transport.
 * Implements the Model Context Protocol so Claude Code, Cursor, and other
 * MCP-aware agents can interact with this project without opening the UI.
 *
 * Tools (v0 — read + test):
 *   run_tests            Run `npx vitest run` and return pass/fail counts
 *   run_cargo_tests      Run `cargo test` and return Rust test results
 *   validate_workflow    Zod-validate a .harness.yaml file
 *   project_status       Summary of workspace files, test counts, and docs
 *   list_workflows       List all .harness.yaml files under a directory
 *   list_providers       Provider metadata and capability flags (no credential values)
 *   list_artifacts       Artifact file metadata under .harness/artifacts (no content)
 *   get_recent_logs      Recent .harness/audit.log.jsonl entries, secrets redacted
 *
 * Usage (stdio):
 *   node mcp/server.mjs
 *   npx @modelcontextprotocol/inspector node mcp/server.mjs
 *
 * No MCP SDK dependency — implements the JSON-RPC 2.0 / MCP wire format directly.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync, lstatSync, openSync, readSync, closeSync } from "node:fs";
import { resolve, join, basename, dirname, relative, isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ── Working directory = project root ─────────────────────────────────────────
// Use fileURLToPath to handle Windows drive-letter paths correctly.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Inline schema (must stay in sync with src/schemas/) ───────────────────────
const agentSchema = z.object({
  name:           z.string().min(1).max(64),
  role:           z.enum(["orchestrator","gateway","worker","critic","memory","hook","aggregator","tool_caller"]),
  model:          z.string(),
  temperature:    z.number().min(0).max(2),
  maxTokens:      z.number().int().min(0).max(200000),
  maxSteps:       z.number().int().min(1).max(1000),
  timeoutSeconds: z.number().int().min(1).max(86400),
  promptSource:   z.discriminatedUnion("type", [
    z.object({ type: z.literal("inline"), content: z.string() }),
    z.object({ type: z.literal("file"),   path: z.string().min(1) }),
  ]),
  tools:          z.array(z.string()),
  memoryRead:     z.array(z.string()),
  memoryWrite:    z.array(z.string()),
  tokens:         z.object({ used: z.number().int().min(0), budget: z.number().int().min(0) }),
  status:         z.enum(["idle","running","waiting","done","error"]),
}).passthrough();

const workflowSchema = z.object({
  meta: z.object({
    name:        z.string().min(1).max(128),
    version:     z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().max(512),
    projectRoot: z.string(),
    createdAt:   z.string(),
    updatedAt:   z.string(),
  }),
  agents:            z.array(agentSchema),
  connections:       z.array(z.object({
    id:            z.string().min(1),
    sourceAgentId: z.string().min(1),
    targetAgentId: z.string().min(1),
    label:         z.string().optional(),
    edgeKind:      z.enum(["dataflow","memory","feedback","control"]).optional(),
  })),
  executionSettings: z.object({
    maxParallel:    z.number().int().min(1).max(32),
    timeoutSeconds: z.number().int().min(1).max(3600),
    retryOnFailure: z.boolean(),
    maxRetries:     z.number().int().min(0).max(10),
  }),
  nodePositions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
});

const PROVIDER_CATALOG = [
  {
    id: "openai",
    name: "OpenAI",
    type: "openai",
    classification: "cloud",
    credentialRef: "env:OPENAI_API_KEY",
    isLocal: false,
    enabled: true,
    status: "unknown",
    capabilities: { streaming: true, toolCalling: true, modelListing: true, tokenCostEstimate: true },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    type: "anthropic",
    classification: "cloud",
    credentialRef: "env:ANTHROPIC_API_KEY",
    isLocal: false,
    enabled: true,
    status: "unknown",
    capabilities: { streaming: true, toolCalling: true, modelListing: false, tokenCostEstimate: true },
  },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible endpoint",
    type: "openai-compatible",
    classification: "gateway",
    credentialRef: "env:OPENAI_COMPATIBLE_API_KEY",
    isLocal: false,
    enabled: false,
    status: "not_configured",
    capabilities: { streaming: false, toolCalling: false, modelListing: false, tokenCostEstimate: false },
  },
  {
    id: "ollama",
    name: "Ollama local",
    type: "ollama",
    classification: "local",
    credentialRef: null,
    isLocal: true,
    enabled: true,
    status: "unknown",
    capabilities: { streaming: true, toolCalling: false, modelListing: true, tokenCostEstimate: false },
  },
  {
    id: "cloud-placeholder",
    name: "Cloud provider placeholder",
    type: "cloud",
    classification: "cloud",
    credentialRef: null,
    isLocal: false,
    enabled: false,
    status: "not_configured",
    capabilities: { streaming: false, toolCalling: false, modelListing: false, tokenCostEstimate: false },
  },
  {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    type: "ollama-remote",
    classification: "cloud",
    credentialRef: "env:OLLAMA_API_KEY",
    isLocal: false,
    enabled: true,
    status: "unknown",
    capabilities: { streaming: true, toolCalling: false, modelListing: true, tokenCostEstimate: false },
  },
  {
    id: "gemini",
    name: "Google Gemini",
    type: "gemini",
    classification: "cloud",
    credentialRef: "env:GEMINI_API_KEY",
    isLocal: false,
    enabled: false,
    status: "not_configured",
    capabilities: { streaming: true, toolCalling: true, modelListing: true, tokenCostEstimate: false },
  },
  {
    id: "kilo",
    name: "Kilo / Kilo Gateway",
    type: "kilo",
    classification: "gateway",
    credentialRef: "env:KILO_API_KEY",
    isLocal: false,
    enabled: false,
    status: "not_configured",
    capabilities: { streaming: true, toolCalling: true, modelListing: true, tokenCostEstimate: true },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function findFiles(dir, ext, max = 50) {
  const result = [];
  const walk = (d) => {
    if (result.length >= max) return;
    try {
      for (const entry of readdirSync(d)) {
        if (entry.startsWith(".") || entry === "node_modules" || entry === "target") continue;
        const full = join(d, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) walk(full);
          else if (entry.endsWith(ext)) result.push(full);
        } catch {}
      }
    } catch {}
  };
  walk(dir);
  return result;
}

function isInsideProject(absPath) {
  const rel = relative(PROJECT_ROOT, absPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveSafePath(inputPath) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new Error("Path is required.");
  }
  const normalized = normalize(inputPath);
  if (normalized.split(/[\\/]+/).includes("..")) {
    throw new Error("Path traversal is not allowed.");
  }
  const abs = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(PROJECT_ROOT, inputPath);
  if (!isInsideProject(abs)) {
    throw new Error("Path must stay inside the Harness Studio project.");
  }
  return abs;
}

function resolveWorkspacePath(inputPath) {
  if (inputPath == null || inputPath === "") return PROJECT_ROOT;
  return resolveSafePath(inputPath);
}

function clampLimit(value, fallback, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(num)));
}

function toProjectRelativePath(absPath, workspace) {
  return relative(workspace, absPath).split(/[\\/]+/).join("/");
}

// A key or assignment name is secret when it ENDS with one of these (case-insensitive), e.g.
// OPENAI_API_KEY, accessToken, client_secret — while "tokens"/"maxTokens" counters do not match.
const SECRET_NAME = String.raw`(?:api[_-]?key|token|secret|password|passwd|authorization|auth|credentials?|private[_-]?key|access[_-]?key)`;
const SECRET_KEY_RE = new RegExp(`${SECRET_NAME}$`, "i");
// name[:=]value — the name may be quoted (JSON), the value quoted or led by an auth scheme.
const SECRET_ASSIGNMENT_RE = new RegExp(
  String.raw`\b([\w-]{0,64}?${SECRET_NAME}["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|(?:(?:Bearer|Basic|Token)\s+)?[^\s"',;&]+)`,
  "gi"
);

function redactSecretLikeText(value) {
  return value
    .replace(SECRET_ASSIGNMENT_RE, (_match, prefix, secret) => {
      const quote = secret[0] === '"' || secret[0] === "'" ? secret[0] : "";
      return `${prefix}${quote}[REDACTED]${quote}`;
    })
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "[REDACTED]")       // OpenAI / Anthropic (sk-ant-...)
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]")        // Google API keys
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]")    // GitHub tokens
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]")  // GitHub fine-grained PATs
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[REDACTED]");    // JWTs
}

function redactSecrets(value) {
  if (typeof value === "string") return redactSecretLikeText(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, SECRET_KEY_RE.test(key) ? "[REDACTED]" : redactSecrets(item)])
    );
  }
  return value;
}

const MAX_LOG_TAIL_BYTES = 5 * 1024 * 1024;

// Reads a log whole, or only its last 5 MiB when larger — dropping the tail's first line,
// which is almost always cut mid-line.
function readLogTail(path) {
  const size = statSync(path).size;
  if (size <= MAX_LOG_TAIL_BYTES) return readFileSync(path, "utf-8");
  const tail = Buffer.alloc(MAX_LOG_TAIL_BYTES);
  const fd = openSync(path, "r");
  let bytesRead;
  try {
    bytesRead = readSync(fd, tail, 0, MAX_LOG_TAIL_BYTES, size - MAX_LOG_TAIL_BYTES);
  } finally {
    closeSync(fd);
  }
  const text = tail.toString("utf-8", 0, bytesRead);
  const firstNewline = text.indexOf("\n");
  return firstNewline === -1 ? "" : text.slice(firstNewline + 1);
}

function collectArtifactFiles(workspace, limit) {
  const root = join(workspace, ".harness", "artifacts");
  const artifacts = [];
  if (!existsSync(root)) return artifacts;

  const walk = (dir) => {
    if (artifacts.length >= limit) return;
    let entries = [];
    try {
      entries = readdirSync(dir).sort((a, b) => a.localeCompare(b));
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      let stat;
      try {
        // lstat: never follow symlinks/junctions (they can escape the project or loop);
        // a link is neither isDirectory() nor isFile() here, so it is skipped.
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        const rel = toProjectRelativePath(full, workspace);
        const parts = rel.split("/");
        artifacts.push({
          path: rel,
          // .harness/artifacts/<nodeId>/<file…>; files directly under artifacts/ have no node.
          nodeId: parts.length >= 4 ? parts[2] : null,
          name: basename(full),
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      }
      if (artifacts.length >= limit) return;
    }
  };

  walk(root);
  return artifacts;
}

function validateTestFilter(filter) {
  if (!filter) return null;
  if (typeof filter !== "string" || filter.length > 180) {
    return "Filter must be a short string.";
  }
  if (filter.startsWith("-")) {
    // e.g. --watch would never exit and would leave a watcher process behind.
    return "Filter must not start with '-' (CLI options are not allowed).";
  }
  if (filter.split(/[\\/]+/).includes("..")) {
    return "Filter must not contain path traversal.";
  }
  if (!/^[A-Za-z0-9_./\\:-]+$/.test(filter)) {
    return "Filter may only contain letters, numbers, dot, slash, backslash, colon, dash, and underscore.";
  }
  return null;
}

function spawnPortable(command, args, options) {
  // spawnSync's default 1 MiB maxBuffer fails large test output with ENOBUFS.
  const opts = { maxBuffer: 16 * 1024 * 1024, ...options };
  if (process.platform !== "win32") {
    return spawnSync(command, args, opts);
  }
  return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command, ...args], opts);
}

function parseTestOutput(stdout, stderr) {
  const combined = stdout + stderr;
  // Vitest output, e.g. "Tests  3 failed | 4 passed (7)" — the "N failed |" part is optional.
  const vitestMatch = combined.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/);
  const fileMatch   = combined.match(/Test Files\s+(?:(\d+) failed \| )?(\d+) passed/);

  if (vitestMatch) {
    return {
      passed: parseInt(vitestMatch[2]),
      failed: parseInt(vitestMatch[1] ?? "0"),
      files:  parseInt(fileMatch?.[2] ?? "0"),
      runner: "vitest",
    };
  }
  // Cargo test output — one "test result:" line per test binary, so sum them all.
  const cargoMatches = [...combined.matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed/g)];
  if (cargoMatches.length > 0) {
    return {
      passed: cargoMatches.reduce((sum, m) => sum + parseInt(m[2]), 0),
      failed: cargoMatches.reduce((sum, m) => sum + parseInt(m[3]), 0),
      files:  null,
      runner: "cargo",
    };
  }
  return null;
}

// ── Tool implementations ──────────────────────────────────────────────────────

const TOOLS = {

  run_tests: {
    description: "Run the full Vitest test suite and return pass/fail counts with output.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional safe file/name filter pattern" },
      },
    },
    async run({ filter = "" }) {
      // filter is treated as a bounded file/name pattern (e.g. "goalTemplates", "providerAdapter").
      // Shell metacharacters and path traversal are rejected before spawning a subprocess.
      const filterError = validateTestFilter(filter);
      if (filterError) {
        return {
          success: false,
          exitCode: -1,
          spawnError: null,
          summary: `Invalid test filter: ${filterError}`,
          counts: null,
          output: "",
        };
      }
      // --no-install: never let npx silently download a package when the local binary is missing.
      const args = ["--no-install", "vitest", "run", ...(filter ? [filter] : [])];
      const result = spawnPortable("npx", args, {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 150_000,
        env: { ...process.env, FORCE_COLOR: "0", CI: "true" },
      });
      const stdout = String(result.stdout ?? "");
      const stderr = String(result.stderr ?? "");
      const spawnErr = result.error ? `spawn error: ${result.error.message}` : null;
      const counts = parseTestOutput(stdout, stderr);
      const passed = result.status === 0;

      return {
        success: passed,
        exitCode: result.status ?? -1,
        spawnError: spawnErr,
        summary: spawnErr
          ? `Could not start vitest: ${spawnErr}`
          : counts
          ? `${counts.runner}: ${counts.passed} passed, ${counts.failed} failed` +
            (counts.files != null ? ` (${counts.files} files)` : "")
          : passed ? "Tests passed" : "Tests failed",
        counts,
        output: (stdout + stderr).slice(-4000), // last 4 KB
      };
    },
  },

  run_cargo_tests: {
    description: "Run Rust `cargo test` in src-tauri/ and return results.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const result = spawnPortable("cargo", ["test"], {
        cwd: join(PROJECT_ROOT, "src-tauri"),
        encoding: "utf-8",
        timeout: 180_000,
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      const counts = parseTestOutput(stdout, stderr);
      const passed = result.status === 0;

      return {
        success: passed,
        exitCode: result.status ?? -1,
        summary: counts
          ? `cargo: ${counts.passed} passed, ${counts.failed} failed`
          : passed ? "Cargo tests passed" : "Cargo tests failed",
        counts,
        output: (stdout + stderr).slice(-4000),
      };
    },
  },

  validate_workflow: {
    description: "Validate a .harness.yaml file against the workflow schema.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Path to the .harness.yaml file" },
      },
    },
    async run({ path: filePath }) {
      let abs;
      try {
        abs = resolveSafePath(filePath);
      } catch (e) {
        return { valid: false, error: `Path rejected: ${e.message}` };
      }
      if (!existsSync(abs)) {
        return { valid: false, error: `File not found: ${abs}` };
      }
      let raw;
      try {
        raw = parseYaml(readFileSync(abs, "utf-8"));
      } catch (e) {
        return { valid: false, error: `YAML parse error: ${e.message}` };
      }
      const result = workflowSchema.safeParse(raw);
      if (result.success) {
        return {
          valid: true,
          name: result.data.meta.name,
          version: result.data.meta.version,
          agents: result.data.agents.length,
          connections: result.data.connections.length,
        };
      }
      const issues = result.error.issues.map((i) => ({
        path: i.path.join(".") || "(root)",
        message: i.message,
      }));
      return { valid: false, issues };
    },
  },

  project_status: {
    description: "Return a summary of project health: workflows, test state, docs.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const workflows = findFiles(PROJECT_ROOT, ".harness.yaml");
      const testFiles = findFiles(join(PROJECT_ROOT, "tests"), ".test.ts");
      const hasAgent  = existsSync(join(PROJECT_ROOT, "AGENT.md"));
      const hasTodo   = existsSync(join(PROJECT_ROOT, "docs", "TODO.md"));

      // Quick tsc check — shell:true required on Windows; result may be unreliable in
      // subprocess contexts where tsconfig.json or node_modules are not on PATH.
      const tscResult = spawnPortable("npx", ["--no-install", "tsc", "--noEmit"], {
        cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 60_000,
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      const tscStdout = String(tscResult.stdout ?? "");
      const tscStderr = String(tscResult.stderr ?? "");
      const tscErrors = (tscStdout + tscStderr).slice(0, 2000);
      // Only a zero exit is a pass — a non-zero exit without "error TS" means tsc never ran.
      const typeCheckPassed = tscResult.status === 0;

      return {
        projectRoot:      PROJECT_ROOT,
        workflowCount:    workflows.length,
        workflows:        workflows.map((f) => basename(f)),
        testFileCount:    testFiles.length,
        typeCheckPassed,
        typeCheckErrors:  !typeCheckPassed ? tscErrors : null,
        tscExitCode:      tscResult.status,
        hasAgentMd:       hasAgent,
        hasTodoMd:        hasTodo,
      };
    },
  },

  list_workflows: {
    description: "List all .harness.yaml files found under the project.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const files = findFiles(PROJECT_ROOT, ".harness.yaml");
      const sep = process.platform === "win32" ? "\\" : "/";
      return {
        count: files.length,
        workflows: files.map((f) => ({
          path: f.replace(PROJECT_ROOT + sep, "").replace(PROJECT_ROOT + "/", ""),
          name: basename(f),
        })),
      };
    },
  },

  list_providers: {
    description: "List provider metadata and capability flags without reading or printing credential values.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      return {
        count: PROVIDER_CATALOG.length,
        providers: PROVIDER_CATALOG,
        note: "Credential refs are metadata only. No environment values or stored secrets are read.",
      };
    },
  },

  list_artifacts: {
    description: "List persisted artifact file metadata from .harness/artifacts without reading artifact content.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Optional workspace path inside the project root" },
        limit: { type: "number", description: "Maximum artifacts to return, capped at 500" },
      },
    },
    async run({ workspace = "", limit = 100 }) {
      let workspacePath;
      try {
        workspacePath = resolveWorkspacePath(workspace);
      } catch (e) {
        return { count: 0, artifacts: [], error: `Path rejected: ${e.message}` };
      }
      if (!existsSync(workspacePath)) {
        return { count: 0, artifacts: [], error: `Workspace not found: ${workspacePath}` };
      }

      const cappedLimit = clampLimit(limit, 100, 500);
      // Collect one extra so "truncated" is true only when more artifacts exist than returned.
      const found = collectArtifactFiles(workspacePath, cappedLimit + 1);
      const artifacts = found.slice(0, cappedLimit);
      return {
        workspace: workspacePath,
        count: artifacts.length,
        truncated: found.length > cappedLimit,
        artifacts,
        note: "Artifact content is not read or returned.",
      };
    },
  },

  get_recent_logs: {
    description: "Return recent .harness/audit.log.jsonl entries with secret-like strings redacted.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Optional workspace path inside the project root" },
        limit: { type: "number", description: "Maximum log entries to return, capped at 100" },
      },
    },
    async run({ workspace = "", limit = 20 }) {
      let workspacePath;
      try {
        workspacePath = resolveWorkspacePath(workspace);
      } catch (e) {
        return { count: 0, entries: [], error: `Path rejected: ${e.message}` };
      }
      if (!existsSync(workspacePath)) {
        return { count: 0, entries: [], error: `Workspace not found: ${workspacePath}` };
      }

      const logPath = join(workspacePath, ".harness", "audit.log.jsonl");
      if (!existsSync(logPath)) {
        return {
          workspace: workspacePath,
          count: 0,
          entries: [],
          invalidLines: 0,
          note: "No audit log exists for this workspace.",
        };
      }

      const cappedLimit = clampLimit(limit, 20, 100);
      const entries = [];
      let invalidLines = 0;
      const lines = readLogTail(logPath).split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {}
        // Not JSON, or valid JSON that is not an entry object (null, 42, [], "text").
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          invalidLines += 1;
          continue;
        }
        const time = Date.parse(String(parsed.timestamp ?? ""));
        entries.push({ time: Number.isNaN(time) ? -Infinity : time, entry: redactSecrets(parsed) });
      }
      // Newest first; a missing/invalid timestamp sorts as oldest. `|| 0` covers -Infinity - -Infinity.
      entries.sort((a, b) => b.time - a.time || 0);
      const limited = entries.slice(0, cappedLimit).map(({ entry }) => entry);
      return {
        workspace: workspacePath,
        count: limited.length,
        totalEntries: entries.length,
        invalidLines,
        truncated: entries.length > limited.length,
        entries: limited,
      };
    },
  },
};

// ── MCP wire protocol ─────────────────────────────────────────────────────────

const SERVER_INFO = {
  name: "harness-studio",
  version: "0.1.0",
};

const CAPABILITIES = {
  tools: {},
};

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}

async function dispatch(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.method !== "string") {
    respondError(request?.id ?? null, -32600, "Invalid Request");
    return;
  }
  const { id, method, params } = request;

  // A message without an id is a notification and never gets a response — including
  // "notifications/initialized" (legacy: "initialized"), sent by clients after initialize.
  if (id === undefined) return;

  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: CAPABILITIES,
      serverInfo: SERVER_INFO,
    });
    return;
  }

  if (method === "tools/list") {
    respond(id, {
      tools: Object.entries(TOOLS).map(([name, def]) => ({
        name,
        description: def.description,
        inputSchema: def.inputSchema,
      })),
    });
    return;
  }

  if (method === "tools/call") {
    const { name, arguments: args = {} } = params ?? {};
    // Own properties only — "toString" etc. must not resolve to Object.prototype members.
    const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
    if (!tool) {
      respondError(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    try {
      const result = await tool.run(args);
      respond(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      // MCP reports tool execution failures as a result with isError, not a protocol error.
      respond(id, {
        content: [{ type: "text", text: `Tool error: ${e.message}` }],
        isError: true,
      });
    }
    return;
  }

  if (method === "ping") {
    respond(id, {});
    return;
  }

  respondError(id, -32601, `Method not found: ${method}`);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

let buffer = "";

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (e) {
    process.stderr.write(`[mcp] parse error: ${e.message}\n`);
    respondError(null, -32700, "Parse error");
    return;
  }
  try {
    await dispatch(msg);
  } catch (e) {
    process.stderr.write(`[mcp] dispatch error: ${e.message}\n`);
  }
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    await handleLine(line);
  }
});

process.stdin.on("end", async () => {
  // The last message may arrive without a trailing newline.
  await handleLine(buffer);
  process.exit(0);
});
process.stderr.write(`[harness-studio MCP] ready — tools: ${Object.keys(TOOLS).join(", ")}\n`);
