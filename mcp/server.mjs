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
 *
 * Usage (stdio):
 *   node mcp/server.mjs
 *   npx @modelcontextprotocol/inspector node mcp/server.mjs
 *
 * No MCP SDK dependency — implements the JSON-RPC 2.0 / MCP wire format directly.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
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

function validateTestFilter(filter) {
  if (!filter) return null;
  if (typeof filter !== "string" || filter.length > 180) {
    return "Filter must be a short string.";
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
  if (process.platform !== "win32") {
    return spawnSync(command, args, options);
  }
  return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command, ...args], options);
}

function parseTestOutput(stdout, stderr) {
  const combined = stdout + stderr;
  // Vitest output
  const vitestMatch = combined.match(/Tests\s+(\d+) passed.*?(?:\((\d+)\))?/);
  const failMatch   = combined.match(/(\d+) failed/);
  const fileMatch   = combined.match(/Test Files\s+(\d+) passed.*?(?:\((\d+)\))?/);

  if (vitestMatch) {
    return {
      passed: parseInt(vitestMatch[1]),
      failed: parseInt(failMatch?.[1] ?? "0"),
      files:  parseInt(fileMatch?.[1] ?? "0"),
      runner: "vitest",
    };
  }
  // Cargo test output
  const cargoMatch = combined.match(/test result: (\w+)\. (\d+) passed; (\d+) failed/);
  if (cargoMatch) {
    return {
      passed: parseInt(cargoMatch[2]),
      failed: parseInt(cargoMatch[3]),
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
      const args = ["vitest", "run", ...(filter ? [filter] : [])];
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
      const tscResult = spawnPortable("npx", ["tsc", "--noEmit"], {
        cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 60_000,
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      const tscStdout = String(tscResult.stdout ?? "");
      const tscStderr = String(tscResult.stderr ?? "");
      const tscErrors = (tscStdout + tscStderr).slice(0, 2000);
      // Only report as failed if tsc actually produced type errors (output contains "error TS")
      const typeCheckPassed = tscResult.status === 0 || !tscErrors.includes("error TS");

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
};

// ── MCP wire protocol ─────────────────────────────────────────────────────────

const SERVER_INFO = {
  name: "harness-studio",
  version: "1.0.0",
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
  const { id, method, params } = request;

  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: CAPABILITIES,
      serverInfo: SERVER_INFO,
    });
    return;
  }

  if (method === "initialized") {
    // Notification — no response needed
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
    const tool = TOOLS[name];
    if (!tool) {
      respondError(id, -32601, `Unknown tool: ${name}`);
      return;
    }
    try {
      const result = await tool.run(args);
      respond(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      respondError(id, -32603, `Tool error: ${e.message}`);
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

process.stdin.setEncoding("utf-8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      await dispatch(msg);
    } catch (e) {
      process.stderr.write(`[mcp] parse error: ${e.message}\n`);
    }
  }
});

process.stdin.on("end", () => process.exit(0));
process.stderr.write(`[harness-studio MCP] ready — tools: ${Object.keys(TOOLS).join(", ")}\n`);
