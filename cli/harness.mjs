#!/usr/bin/env node
/**
 * harness-cli v0 — read-only CLI for Harness Studio
 *
 * Usage:
 *   node cli/harness.mjs project status                   [--workspace <path>]
 *   node cli/harness.mjs workflow validate <path>
 *   node cli/harness.mjs provider list                    [--json]
 *
 * No Tauri runtime required. No API calls made.
 * Schemas are duplicated from src/schemas/ — see comments marked [KEEP-IN-SYNC].
 *
 * Safe to run: read-only, no network, no secret output.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const args    = process.argv.slice(2);
const jsonOut = args.includes("--json");

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
  const wIdx = args.indexOf("--workspace");
  if (wIdx !== -1 && args[wIdx + 1]) return resolve(args[wIdx + 1]);
  const env = process.env.HARNESS_WORKSPACE;
  if (env) return resolve(env);
  return process.cwd();
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
          const stat = statSync(full);
          if (stat.isDirectory() && !entry.includes("node_modules") && !entry.includes("target")) {
            walk(full);
          } else if (entry.endsWith(".harness.yaml") || entry.endsWith(".harness.yml")) {
            result.push(full);
          }
        } catch { /* skip permission errors */ }
      }
    };
    walk(dir);
  } catch { /* empty */ }
  return result;
}

function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
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
  const exampleFiles = findHarnessFiles(join(workspace, "examples"));
  const harnessDir = join(workspace, ".harness");
  const auditLog   = join(harnessDir, "audit.log.jsonl");
  const snapIndex  = join(harnessDir, "snapshots", "index.json");
  const packageJson = readJsonFile(join(workspace, "package.json"), {});
  const keyDocs = KEY_DOCS.map((docPath) => ({
    path: docPath,
    exists: existsSync(join(workspace, docPath)),
  }));

  // Count audit entries
  let auditCount = 0;
  if (existsSync(auditLog)) {
    try {
      const lines = readFileSync(auditLog, "utf-8").split("\n").filter(Boolean);
      auditCount = lines.length;
    } catch { /* ignore */ }
  }

  // Count snapshots
  let snapCount = 0;
  if (existsSync(snapIndex)) {
    try {
      const idx = JSON.parse(readFileSync(snapIndex, "utf-8"));
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

  if (result.success) {
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
    const issues = result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const [cmd, sub, arg] = args.filter((a) => !a.startsWith("--"));

if (cmd === "project" && sub === "status") {
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

Options:
  --workspace <path>   Override workspace (default: cwd or HARNESS_WORKSPACE env)
  --json               Emit JSON output (machine-readable)

Examples:
  node cli/harness.mjs project status
  node cli/harness.mjs workflow validate examples/purchasing-decision.harness.yaml
  node cli/harness.mjs provider list --json
`);
  process.exit(1);
}
