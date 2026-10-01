#!/usr/bin/env node
/**
 * harness-cli — command line for Harness Studio
 *
 * Usage:
 *   node cli/harness.mjs project status                   [--workspace <path> | --workspace=<path>]
 *   node cli/harness.mjs workflow validate <path>
 *   node cli/harness.mjs provider list                    [--json]
 *   node cli/harness.mjs run <workflow> --task "…"        (see run --help)
 *   node cli/harness.mjs eval <tasks.yaml>                (see eval --help)
 *
 * project, workflow and provider are read-only: no Tauri runtime, no API calls.
 * Their schemas are duplicated from src/schemas/ — see comments marked [KEEP-IN-SYNC].
 *
 * run executes a workflow headless (docs/HEADLESS.md): model calls, workspace
 * files, and only the agent commands passed with --allow-command. It loads
 * cli/dist/harness-run.mjs (npm run build:cli) and needs harness-core (npm run build:core).
 *
 * eval runs a workflow on each task of a task set, k times each in a fresh copy of the task's
 * workspace, and scores every trial: the agents' commands as for run (--allow-command), and the
 * scorers' commands only when passed exactly with --allow-scorer. It uses the same bundle and
 * harness-core as run.
 */

import { readFileSync, readdirSync, lstatSync, realpathSync, existsSync } from "node:fs";
import { join, resolve, basename, relative, isAbsolute, sep as pathSep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// [KEEP-IN-SYNC] with src/schemas/agentSchema.ts + src/types/agent.ts
// These must be updated whenever the Zod schema in src/ changes.
// ---------------------------------------------------------------------------
const AGENT_ROLES = ["orchestrator","gateway","worker","critic","memory","hook","aggregator","tool_caller"];
const TOOL_PERMISSIONS = [
  "read_file","fs.write","fs.append","fs.read","list_files","bash",
  "web_search","web_fetch","grep","classify","vector_search","cite",
  "git","todo_write","subagent_dispatch","test","puppeteer",
];

const promptSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inline"), content: z.string() }),
  z.object({ type: z.literal("file"),   path: z.string().min(1) }),
]);
const hookConfigSchema = z.object({
  path: z.string().min(1),
  requireConsent: z.boolean(),
  env: z.record(z.string(), z.string()).optional(),
});
const agentNodeDataSchema = z.object({
  name:           z.string().min(1).max(64),
  role:           z.enum(AGENT_ROLES),
  model:          z.string(),
  temperature:    z.number().min(0).max(2),
  maxTokens:      z.number().int().min(0).max(200000),
  maxSteps:       z.number().int().min(1).max(1000),
  timeoutSeconds: z.number().int().min(1).max(86400),
  promptSource:   promptSourceSchema,
  tools:          z.array(z.enum(TOOL_PERMISSIONS)),
  preHook:        hookConfigSchema.optional(),
  postHook:       hookConfigSchema.optional(),
  memoryRead:     z.array(z.string()),
  memoryWrite:    z.array(z.string()),
  tokens:         z.object({ used: z.number().int().min(0), budget: z.number().int().min(0) }),
  status:         z.enum(["idle","running","waiting","done","error"]),
  condition:      z.string().optional(),
  description:    z.string().optional(),
  thinkDepth:     z.enum(["none","low","medium","high"]).optional(),
  comment:        z.string().optional(),
  fallback:       z.object({
    model: z.string().min(1),
    trigger: z.enum(["rate_limit","error","timeout","any"]),
    maxAttempts: z.number().int().min(1).max(10).optional(),
  }).optional(),
});
const connectionSchema = z.object({
  id:            z.string().min(1),
  sourceAgentId: z.string().min(1),
  targetAgentId: z.string().min(1),
  label:         z.string().optional(),
  edgeKind:      z.enum(["dataflow","memory","feedback","control"]).optional(),
});
const workflowDefSchema = z.object({
  meta: z.object({
    name:        z.string().min(1).max(128),
    version:     z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().max(512),
    projectRoot: z.string(),
    createdAt:   z.string(),
    updatedAt:   z.string(),
  }),
  agents:            z.array(agentNodeDataSchema),
  connections:       z.array(connectionSchema),
  executionSettings: z.object({
    maxParallel:    z.number().int().min(1).max(32),
    timeoutSeconds: z.number().int().min(1).max(3600),
    retryOnFailure: z.boolean(),
    maxRetries:     z.number().int().min(0).max(10),
  }),
  nodePositions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
});
// [END KEEP-IN-SYNC] -----------------------------------------------------------

// ---------------------------------------------------------------------------
// Provider catalog — read-only, mirrors src/services/model-providers/providerCatalog.ts
// ---------------------------------------------------------------------------
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
    capabilities: { streaming: true, toolCalling: true, modelListing: false, tokenCostEstimate: false },
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
    capabilities: { streaming: true, toolCalling: true, modelListing: true, tokenCostEstimate: false },
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
    capabilities: { streaming: true, toolCalling: true, modelListing: true, tokenCostEstimate: false },
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const args    = process.argv.slice(2);
const jsonOut = args.includes("--json");
const WORKSPACE_FLAG_EQ = "--workspace=";

function fail(msg, hint = "") {
  const out = { error: { code: "CLI_ERROR", message: msg, hint } };
  process.stderr.write(JSON.stringify(out) + "\n");
  process.exit(1);
}

function out(data) {
  if (jsonOut) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    return data; // caller handles formatting
  }
}

function table(rows, cols) {
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))
  );
  const sep = widths.map((w) => "─".repeat(w)).join("─┬─");
  const header = cols.map((c, i) => c.padEnd(widths[i])).join(" │ ");
  const divider = widths.map((w) => "─".repeat(w)).join("─┼─");
  const lines = rows.map((r) =>
    cols.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join(" │ ")
  );
  console.log("─" + sep + "─");
  console.log(" " + header + " ");
  console.log("─" + divider + "─");
  for (const l of lines) console.log(" " + l + " ");
  console.log("─" + widths.map((w) => "─".repeat(w)).join("─┴─") + "─");
}

function findWorkspace() {
  // Both "--workspace <path>" and "--workspace=<path>"; the first one given wins.
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace" && args[i + 1]) return resolve(args[i + 1]);
    if (args[i].startsWith(WORKSPACE_FLAG_EQ) && args[i].length > WORKSPACE_FLAG_EQ.length) {
      return resolve(args[i].slice(WORKSPACE_FLAG_EQ.length));
    }
  }
  const env = process.env.HARNESS_WORKSPACE;
  if (env) return resolve(env);
  return process.cwd();
}

// [KEEP-IN-SYNC] with isRealDirectory in mcp/server.mjs.
// True for a real folder, false for a symlink or junction (even one that leads to a folder) and
// for anything that does not exist.
function isRealDirectory(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

// [KEEP-IN-SYNC] with isInsideDir in mcp/server.mjs and in src/cli/taskSet.ts (harness eval's copy).
function isInsideDir(rootPath, absPath) {
  const rel = relative(rootPath, absPath);
  // Only ".." itself, or ".." and a separator first, leads out: a folder named "..data" (a Kubernetes
  // ConfigMap mount has one) is inside. An absolute rel is another drive on Windows.
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + pathSep) && !isAbsolute(rel));
}

// [KEEP-IN-SYNC] with resolveInsideWorkspace in mcp/server.mjs: the same rule, that the REAL path
// must be inside the real workspace. There is no project root to check here, and only a regular
// file qualifies.
// Returns the text of `target`, a file under `workspace` (package.json, the audit log, the snapshot
// index), or null when there is nothing safe to read: it is missing or unreadable, it resolves
// outside the workspace through a symlink or junction (on it or on any folder above it), or it is
// not a regular file. A cloned repository can ship such links, and `-> /dev/zero` has no end. The
// caller treats null as a missing file. The workspace itself is the user's choice, so it may be
// reached through a link: only where the file resolves matters.
function readFileInsideWorkspace(workspace, target) {
  try {
    const real = realpathSync(target);
    if (!isInsideDir(realpathSync(workspace), real)) return null;
    // The type of what the path resolves to: a link to a regular file inside the workspace still
    // qualifies, and a FIFO or a device does not, whatever it is called or linked as.
    if (!lstatSync(real).isFile()) return null;
    return readFileSync(real, "utf-8");
  } catch {
    return null;
  }
}

function findHarnessFiles(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  try {
    const walk = (d) => {
      for (const entry of readdirSync(d)) {
        if (entry.startsWith(".")) continue;
        const full = join(d, entry);
        try {
          // lstat: a symlink or junction is never followed, since it can lead outside the workspace
          // or back up to a parent folder, and a walk into such a loop never ends. A link is neither
          // isDirectory() nor isFile(), so it is skipped (the same rule as findFiles in mcp/server.mjs).
          const stat = lstatSync(full);
          // Exact directory names: "targets/" or "retargeting/" are ordinary folders.
          if (stat.isDirectory() && entry !== "node_modules" && entry !== "target") {
            walk(full);
          } else if (stat.isFile() && (entry.endsWith(".harness.yaml") || entry.endsWith(".harness.yml"))) {
            result.push(full);
          }
        } catch { /* skip permission errors */ }
      }
    };
    walk(dir);
  } catch { /* empty */ }
  return result;
}

// Returns the parsed JSON object, or `fallback` when the file is missing, unreadable, not JSON,
// or JSON that is not an object (null, an array, a string...) — callers read properties off it.
// The file is read by readFileInsideWorkspace, so a link or a special file counts as missing.
function readJsonFile(workspace, path, fallback) {
  const text = readFileInsideWorkspace(workspace, path);
  if (text === null) return fallback;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

const KEY_DOCS = [
  "docs/PROJECT_STATUS.md",
  "docs/TODO.md",
  "docs/DEVELOPMENT_LOG.md",
  "docs/CLI_MCP_PLAN.md",
  "docs/UX_REVIEW.md",
  "docs/SECURITY.md",
];

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdProjectStatus() {
  const workspace = findWorkspace();
  const files = findHarnessFiles(workspace);
  // examples/ comes from the repository, and a link there could lead anywhere (`examples -> /`
  // would walk the whole disk): it is searched only when it is a real folder. The workspace itself
  // is the user's choice, so it may be reached through a link.
  const examplesDir = join(workspace, "examples");
  const exampleFiles = isRealDirectory(examplesDir) ? findHarnessFiles(examplesDir) : [];
  const harnessDir = join(workspace, ".harness");
  const auditLog   = join(harnessDir, "audit.log.jsonl");
  const snapIndex  = join(harnessDir, "snapshots", "index.json");
  // package.json, the audit log and the snapshot index come from the workspace, which may be a
  // cloned repository: each is read only if it is a regular file that resolves inside the workspace
  // (readFileInsideWorkspace), and counts as missing otherwise.
  const packageJson = readJsonFile(workspace, join(workspace, "package.json"), {});
  const keyDocs = KEY_DOCS.map((docPath) => ({
    path: docPath,
    exists: existsSync(join(workspace, docPath)),
  }));

  // Count audit entries
  let auditCount = 0;
  const auditText = readFileInsideWorkspace(workspace, auditLog);
  if (auditText !== null) auditCount = auditText.split("\n").filter(Boolean).length;

  // Count snapshots
  let snapCount = 0;
  const snapText = readFileInsideWorkspace(workspace, snapIndex);
  if (snapText !== null) {
    try {
      const idx = JSON.parse(snapText);
      snapCount = Object.values(idx).flat().length;
    } catch { /* ignore */ }
  }

  const data = {
    appName: "Harness Studio",
    packageName: packageJson.name ?? "unknown",
    workspace,
    readOnly: true,
    note: "Read-only CLI v0. No files are modified, no providers are called, and no workflows are executed.",
    workflowCount: files.length,
    workflows: files.map((f) => basename(f)),
    exampleWorkflowCount: exampleFiles.length,
    agentFileExists: existsSync(join(workspace, "AGENT.md")),
    keyDocs,
    harnessDirExists: existsSync(harnessDir),
    auditEntries: auditCount,
    snapshots: snapCount,
  };

  if (jsonOut) { out(data); return; }

  console.log("Read-only CLI v0");
  console.log(`App: ${data.appName} (${data.packageName})`);
  console.log(`AGENT.md: ${data.agentFileExists ? "present" : "missing"}`);
  console.log(`Key docs: ${data.keyDocs.filter((doc) => doc.exists).length}/${data.keyDocs.length} present`);
  console.log(`Example workflows: ${data.exampleWorkflowCount}`);

  console.log("\nHarness Studio — Project Status");
  console.log("================================");
  console.log(`  Workspace      : ${workspace}`);
  console.log(`  Workflows      : ${data.workflowCount}`);
  if (data.workflows.length) {
    for (const f of data.workflows) console.log(`                   · ${f}`);
  }
  console.log(`  .harness/ dir  : ${data.harnessDirExists ? "present" : "absent"}`);
  console.log(`  Audit entries  : ${data.auditEntries}`);
  console.log(`  Snapshots      : ${data.snapshots}`);
  console.log();
}

// [KEEP-IN-SYNC] with findDanglingConnections in mcp/server.mjs.
// A saved workflow identifies its agents by list position ("agent-<i>"), the rule the app's
// loadWorkflow and generators use, so every connection endpoint must be one of those ids.
function findDanglingConnections(workflow) {
  const count = workflow.agents.length;
  const known = new Set(workflow.agents.map((_, i) => `agent-${i}`));
  const validIds = count === 0 ? "the workflow has no agents"
    : count === 1 ? "valid id: agent-0"
    : `valid ids: agent-0 to agent-${count - 1}`;
  const quote = (id) => {
    const text = JSON.stringify(id);
    return text.length > 66 ? `${text.slice(0, 65)}…"` : text;
  };
  const issues = [];
  workflow.connections.forEach((connection, index) => {
    for (const key of ["sourceAgentId", "targetAgentId"]) {
      if (!known.has(connection[key])) {
        issues.push({ path: `connections.${index}.${key}`, message: `Unknown agent ${quote(connection[key])} (${validIds})` });
      }
    }
  });
  return issues;
}

function cmdWorkflowValidate(filePath) {
  if (!filePath) fail("Usage: harness workflow validate <path>", "Provide a path to a .harness.yaml file.");
  const abs = resolve(filePath);
  if (!existsSync(abs)) fail(`File not found: ${abs}`);

  let raw;
  try {
    raw = parseYaml(readFileSync(abs, "utf-8"));
  } catch (e) {
    fail(`YAML parse error: ${e.message}`);
  }

  const result = workflowDefSchema.safeParse(raw);

  // The schema only checks shape: a connection to an agent that does not exist still parses.
  const issues = result.success
    ? findDanglingConnections(result.data)
    : result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));

  if (issues.length === 0) {
    const wf = result.data;
    const data = {
      valid: true,
      file: abs,
      name: wf.meta.name,
      version: wf.meta.version,
      agents: wf.agents.length,
      connections: wf.connections.length,
    };
    if (jsonOut) { out(data); return; }
    console.log(`\n✓ VALID  ${basename(abs)}`);
    console.log(`  Name       : ${wf.meta.name} v${wf.meta.version}`);
    console.log(`  Agents     : ${wf.agents.length}`);
    console.log(`  Connections: ${wf.connections.length}\n`);
  } else {
    if (jsonOut) { out({ valid: false, file: abs, issues }); process.exit(1); }
    console.error(`\n✕ INVALID  ${basename(abs)}`);
    for (const i of issues) {
      console.error(`  [${i.path || "(root)"}] ${i.message}`);
    }
    console.error();
    process.exit(1);
  }
}

function cmdProviderList() {
  if (jsonOut) { out(PROVIDER_CATALOG); return; }
  const rows = PROVIDER_CATALOG.map((p) => ({
    id:           p.id,
    name:         p.name,
    type:         p.type,
    class:        p.classification,
    credential:   p.credentialRef ?? "none",
    capabilities: Object.entries(p.capabilities)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(",") || "none",
    enabled:      p.enabled ? "yes" : "no",
    status:       p.status,
  }));
  console.log("\nHarness Studio — Provider Catalog\n");
  console.log("Read-only metadata only. Credential refs are names, not values.");
  table(rows, ["id", "name", "type", "class", "credential", "capabilities", "enabled", "status"]);
  console.log();
}

// harness run: the shared engine, bundled by `npm run build:cli` (src/cli/runCli.ts).
async function cmdRun(runArgs) {
  const bundle = new URL("./dist/harness-run.mjs", import.meta.url);
  if (!existsSync(bundle)) {
    process.stderr.write("harness run: build it first with npm run build:cli\n");
    return 3;
  }
  const { runHarness } = await import(bundle.href);
  return runHarness(runArgs);
}

// harness eval: the same bundle and engine as run (src/cli/evalCli.ts).
async function cmdEval(evalArgs) {
  const bundle = new URL("./dist/harness-run.mjs", import.meta.url);
  if (!existsSync(bundle)) {
    process.stderr.write("harness eval: build it first with npm run build:cli\n");
    return 3;
  }
  try {
    const { runEval } = await import(bundle.href);
    return await runEval(evalArgs);
  } catch (e) {
    // Exit 1 would read as "S is below --min-score": a bundle that cannot be loaded is a 3, the eval could not run.
    process.stderr.write(`harness eval: ${e instanceof Error ? e.message : e}\n`);
    return 3;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
// Flags that take a value: the argument after them is that value, not a positional.
const VALUE_FLAGS = new Set(["--workspace"]);
const positionals = [];
for (let i = 0; i < args.length; i++) {
  if (VALUE_FLAGS.has(args[i])) i++;
  else if (!args[i].startsWith("--")) positionals.push(args[i]);
}
const [cmd, sub, arg] = positionals;

if (args[0] === "run") {
  process.exitCode = await cmdRun(args.slice(1));
} else if (args[0] === "eval") {
  process.exitCode = await cmdEval(args.slice(1));
} else if (cmd === "project" && sub === "status") {
  cmdProjectStatus();
} else if (cmd === "workflow" && sub === "validate") {
  cmdWorkflowValidate(arg);
} else if (cmd === "provider" && sub === "list") {
  cmdProviderList();
} else {
  console.error(`
Harness Studio CLI v0

Commands:
  project status                      Summary of the current workspace
  workflow validate <path>            Validate a .harness.yaml file
  provider list                       Show the provider catalog
  run <workflow> --task "…"           Run a workflow headless (run --help for options)
  eval <tasks.yaml>                   Score a workflow on a task set (eval --help for options)

Options:
  --workspace <path>   Override workspace (default: cwd or HARNESS_WORKSPACE env);
  --workspace=<path>   the same, in one argument
  --json               Emit JSON output (machine-readable)

Examples:
  node cli/harness.mjs project status
  node cli/harness.mjs workflow validate examples/purchasing-decision.harness.yaml
  node cli/harness.mjs provider list --json
`);
  process.exit(1);
}
