# Headless + CI, Part 3: `harness run` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `node cli/harness.mjs run <workflow> --task "…"`. It runs a workflow with the shared engine and `harness-core`, without the app, and reports readable lines or JSON events with CI exit codes.

**Architecture:**
- `src/cli/` holds the headless runner, bundled by Vite in SSR mode into `cli/dist/harness-run.mjs`.
  - The bundle includes its dependencies.
  - `@tauri-apps/api/core` is aliased to a Node shim.
- `cli/harness.mjs run …` loads the bundle.
- The runner does the following:
  - parses flags;
  - loads and validates the workflow with the app's own schema and `validateWorkflow`;
  - starts `harness-core` (`coreClient.ts`);
  - builds a `RunHost` whose `askCommand` is the `--allow-command` allowlist;
  - prints events through a reporter.
- The engine gains three small host options, all additive with the app's defaults unchanged:
  - `commandPolicy` names the approver in the audit;
  - `revealOutput: false` skips the progressive reveal;
  - the node's model and provider are announced at start.

**Tech Stack:** TypeScript, Vite 7 SSR build, Node child processes, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-25-headless-ci-design.md` §3, including the Part 1 review notes. `--resume` and saved runs are Part 4.

---

## Design decisions (read before starting)

1. **Keys.** harness-core already reads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_API_KEY` and `OLLAMA_REMOTE_API_KEY` when the passed key is empty (Rust `resolve_api_key`, `resolve_ollama_api_key_for_endpoint`). The CLI therefore passes empty keys, and key values never enter the JavaScript side.
   - The one exception is an OpenAI-compatible endpoint, which gets no env fallback in Rust (so an OpenAI key is never sent to a custom server). The CLI reads `HARNESS_CUSTOM_API_KEY` for it.
2. **Where `--base-url` and `--model` go.** They set the Ollama endpoint and model for `auto`, `ollama` and `ollama-cloud`, and the custom endpoint for `openai-compatible`.
   - With `openai` or `anthropic` they are a usage error, because hosted providers keep each agent's model.
   - `openai-compatible` requires `--base-url`.
3. **`--continue-on-error` defaults to off.** The workflow file has no such setting; the app's own default lives in its store. CI stops at the first failed agent unless asked.
4. **Command policy.** `askCommand` resolves `"granted"` for an exact (trimmed) `--allow-command` match and `"deny"` otherwise. `commandPolicy: "--allow-command"` makes the audit and the tool result say "allowed by --allow-command" and "denied (not in --allow-command)". Without the option, the app's wording is unchanged.
5. **Reporting reuses the engine's events.**
   - `node_started`/`node_finished` come from `onAgentUpdate` status changes. The model and provider are now in the running update.
   - `command` is an audit entry with action `command_executed`. `revision` and `compaction` are audit entries starting with `↺` and `↻`. Everything else is `audit`.
   - Human mode prints the starts, ends, commands, revisions and compactions, then a summary. The summary covers:
     - the status and time;
     - each agent;
     - the changed files with line counts;
     - the final output of the agents that nothing runs after (feedback edges ignored).
6. **Exit codes:**
   - `0` done; `1` failed; `130` cancelled.
   - `2` usage, a missing file or an invalid workflow (checked before harness-core starts).
   - `3` in three cases:
     - harness-core is missing or doesn't answer the startup `get_provider_defaults`;
     - the provider preflight failed;
     - harness-core stopped during the run.
7. **Ctrl+C:** the first one sets `isCancelled()`, and the engine's Stop path denies, cancels and kills. A second one exits 130 at once.
8. **A JavaScript `--core` runs with `node`.** This is how the tests use the fake core, `tests/fixtures/fake-core.mjs`.
9. **Node typings.** The project has no `@types/node`; `tests/node-shims.d.ts` is included for all of `src` and `tests`. The CLI's few Node APIs are added there.
10. **The end-to-end test builds the bundle itself** in `beforeAll` (`vite build --config vite.cli.config.ts`), so `npx vitest run` covers the bundle loading in Node.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/services/execution/commandTool.ts` | modify | `policy` option: audit and tool-result wording |
| `src/engine/runWorkflow.ts` | modify | `commandPolicy`, `revealOutput` host options; model/provider in the running update; export `isFeedbackEdge` |
| `src/cli/runArgs.ts` | create | `parseRunArgs`, `providerSettings`, `RUN_USAGE` |
| `src/cli/coreClient.ts` | create | `startCore`: harness-core over pipes |
| `src/cli/report.ts` | create | `createReporter`: human lines or JSON events, summary |
| `src/cli/runCli.ts` | create | `runHarness(argv)`, `exitCode`, `createInterrupt`, `corePath` |
| `src/cli/tauriShim.ts` | create | Node stand-in for `@tauri-apps/api/core` |
| `vite.cli.config.ts` | create | SSR bundle → `cli/dist/harness-run.mjs` |
| `cli/harness.mjs` | modify | `run` subcommand, header and usage |
| `package.json` | modify | `build:cli` |
| `tests/node-shims.d.ts` | modify | `spawn`, `fileURLToPath`, `process` I/O and signals |
| `tests/fixtures/fake-core.mjs` | create | fake harness-core for the tests |
| `tests/unit/cli/{runArgs,coreClient,report,runCli,harnessRun}.test.ts` | create | unit and end-to-end tests |
| `AGENT.md` | modify | rules 4 and 6 and the CLI row now cover `harness run` |

---

### Task 1: Engine options for headless hosts

**Files:** `src/services/execution/commandTool.ts`, `src/engine/runWorkflow.ts`; tests in `tests/unit/services/execution/commandTool.test.ts`, `tests/unit/engine/runWorkflow.test.ts`

- [ ] **Step 1: Failing tests**

Append to the `describe("runCommandTool")` block in `commandTool.test.ts`:

```ts
  it("names the run's command policy, not the user, when commands are allowed up front (harness run)", async () => {
    const denied = options({ askUser: vi.fn(async () => "deny" as const), policy: "--allow-command" });
    const text = await runCommandTool({ command: "rm -rf build" }, denied.opts);
    expect(text).toMatch(/^\[error\] This run does not allow this command \(--allow-command\)/);
    expect(denied.audit).toEqual([
      { details: "Tester: command denied (not in --allow-command): rm -rf build", success: false },
    ]);

    const allowed = options({ askUser: vi.fn(async () => "granted" as const), policy: "--allow-command" });
    await runCommandTool({ command: "npm test" }, allowed.opts);
    expect(allowed.audit).toEqual([
      { details: "Tester ran: npm test (allowed by --allow-command; exit 0, 1200 ms)", success: true },
    ]);
  });
```

Append to the `describe("runWorkflow")` block in `runWorkflow.test.ts`, after `commandRun` and its tests:

```ts
  it("tells the host each node's model and provider when it starts", async () => {
    const { host, log } = fakeHost();

    await runWorkflow(runInput([makeNode("A")]), host);

    expect(log.agents.find(([id, p]) => id === "A" && p.status === "running")?.[1])
      .toMatchObject({ modelUsed: "qwen2.5-coder:7b", providerUsed: "ollama" });
  });

  it("skips the progressive reveal of answers when the host asks (harness run)", async () => {
    const answer = "x".repeat(300);
    const revealSteps = (agents: Array<[string, Partial<AgentRun>]>) =>
      agents.filter(([, p]) => p.output !== undefined && p.status === undefined).length;

    const shown = fakeHost({ call_ollama_api: () => answer });
    await runWorkflow(runInput([makeNode("A")]), shown.host);
    const plain = fakeHost({ call_ollama_api: () => answer }, { revealOutput: false });
    await runWorkflow(runInput([makeNode("A")]), plain.host);

    expect(revealSteps(shown.log.agents)).toBeGreaterThan(1);
    expect(revealSteps(plain.log.agents)).toBe(0);
  });

  it("names the host's command policy in the audit", async () => {
    const { nodes, handlers } = commandRun();
    const { host, log } = fakeHost(handlers, { askCommand: async () => "deny", commandPolicy: "--allow-command" });

    await runWorkflow(runInput(nodes), host);

    expect(log.audit.map((e) => e.details)).toContain("A: command denied (not in --allow-command): npm test");
  });
```

Run: `npx vitest run tests/unit/services/execution/commandTool.test.ts tests/unit/engine/runWorkflow.test.ts`
Expected: the 4 new tests FAIL; the others pass.

- [ ] **Step 2: `commandTool.ts`**

Add to `CommandToolOptions`, after `onAudit`:

```ts
  /** Who approves commands when it is not the user, e.g. "--allow-command"
   *  (harness run); named in the audit and in what the agent is told. */
  policy?: string;
```

Replace the deny branch:

```ts
  if (approval === "deny") {
    if (opts.policy) {
      opts.onAudit(`${opts.agentName}: command denied (not in ${opts.policy}): ${command}`, false);
      return `[error] This run does not allow this command (${opts.policy}), so it was not run: ${command}. ` +
        "Do not ask for it again; continue without it or explain what you needed it for.";
    }
    opts.onAudit(`${opts.agentName}: command denied by the user: ${command}`, false);
    return `[error] The user denied this command, so it was not run: ${command}. ` +
      "Do not ask for it again; continue without it or explain what you needed it for.";
  }
```

and the success audit:

```ts
    const approved = opts.policy ? `allowed by ${opts.policy}` : APPROVED[approval];
    opts.onAudit(
      `${opts.agentName} ran: ${command} (${approved}; exit ${result.exitCode}, ${result.durationMs} ms)`,
      result.exitCode === 0);
```

- [ ] **Step 3: `runWorkflow.ts`**

1. Add to `RunHost`, after `snapshot?`:

```ts
  /** Who approves commands when it is not the user (harness run: "--allow-command"). */
  commandPolicy?: string;
  /** false: no progressive reveal of each final answer (the app shows one; harness run does not). */
  revealOutput?: boolean;
```

2. Export the edge helper, because the CLI's summary needs it: `function isFeedbackEdge(` becomes `export function isFeedbackEdge(`.

3. In `processNode`, move the running update below the provider resolution and add the model:

```ts
// old (first lines of the AGENT / GATEWAY / … section)
    updateAgent(nodeId, { agentId: nodeId, agentName: data.name, status: "running", startedAt: Date.now() });
    updateNodeData(nodeId, { status: "running" });

    const rawModel =
// new
    const rawModel =
```
```ts
// old
      (selProv.provider === "anthropic" && providerDefaults.anthropic_api_key_configured);

    addEntry({
// new
      (selProv.provider === "anthropic" && providerDefaults.anthropic_api_key_configured);

    updateAgent(nodeId, {
      agentId: nodeId, agentName: data.name, status: "running", startedAt: Date.now(),
      modelUsed: model, providerUsed: runtimeProvider,
    });
    updateNodeData(nodeId, { status: "running" });
    addEntry({
```

4. Pass the policy: in `runCommand`, `runId, agentName: data.name, workspacePath, invoke,` becomes `runId, agentName: data.name, workspacePath, invoke, policy: host.commandPolicy,`.

5. Honor `revealOutput`:

```ts
// old
      // Simulated streaming display, unless the text already streamed in live
      if (!(streamed && loop.mode === "native")) {
// new
      // Simulated streaming display, unless the text already streamed in live or the host shows none
      if (host.revealOutput !== false && !(streamed && loop.mode === "native")) {
```

- [ ] **Step 4: Tests pass, the app unchanged**

Run: `npx vitest run tests/unit/services/execution/commandTool.test.ts tests/unit/engine tests/unit/hooks/useWorkflowExecution.test.ts && npx tsc --noEmit`
Expected: all pass (the 40 hook tests unchanged), with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/execution/commandTool.ts src/engine/runWorkflow.ts tests/unit/services/execution/commandTool.test.ts tests/unit/engine/runWorkflow.test.ts
git commit -m "Engine options for headless hosts: command policy wording, no reveal, model at node start"
```

---

### Task 2: `runArgs.ts`

**Files:** create `src/cli/runArgs.ts`, `tests/unit/cli/runArgs.test.ts`

- [ ] **Step 1: Failing test** — `tests/unit/cli/runArgs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseRunArgs, providerSettings, type RunArgs } from "@/cli/runArgs";

function ok(argv: string[]): RunArgs {
  const parsed = parseRunArgs(argv);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.args;
}
function error(argv: string[]): string | undefined {
  const parsed = parseRunArgs(argv);
  return "error" in parsed ? parsed.error : undefined;
}

describe("parseRunArgs", () => {
  it("reads the workflow, the task and every option", () => {
    expect(ok([
      "wf.harness.yaml", "--task", "Fix it", "--workspace", "repo", "--provider", "ollama",
      "--base-url", "http://gpu:11434", "--model", "qwen3:8b", "--max-parallel", "2", "--continue-on-error",
      "--allow-command", " npm test ", "--allow-command", "cargo test", "--json", "--core", "bin/harness-core",
    ])).toEqual({
      workflow: "wf.harness.yaml", task: "Fix it", workspace: "repo", provider: "ollama",
      baseUrl: "http://gpu:11434", model: "qwen3:8b", maxParallel: 2, continueOnError: true,
      allowCommands: ["npm test", "cargo test"], json: true, core: "bin/harness-core",
    });
  });

  it("defaults to the auto provider, stopping at the first failure, with no commands allowed", () => {
    expect(ok(["wf.yaml", "--task-file", "task.md"])).toEqual({
      workflow: "wf.yaml", taskFile: "task.md", provider: "auto", continueOnError: false, json: false,
      allowCommands: [],
    });
  });

  it.each([
    [["--task", "t"], /one workflow file/],
    [["a.yaml", "b.yaml", "--task", "t"], /one workflow file/],
    [["wf.yaml"], /--task or --task-file/],
    [["wf.yaml", "--task", "t", "--task-file", "f"], /--task or --task-file/],
    [["wf.yaml", "--task", "  "], /task is empty/],
    [["wf.yaml", "--task"], /--task needs a value/],
    [["wf.yaml", "--task", "t", "--verbose"], /Unknown option: --verbose/],
    [["wf.yaml", "--task", "t", "--provider", "gemini"], /--provider must be one of/],
    [["wf.yaml", "--task", "t", "--max-parallel", "0"], /--max-parallel/],
    [["wf.yaml", "--task", "t", "--allow-command", " "], /--allow-command needs a command/],
    [["wf.yaml", "--task", "t", "--provider", "openai", "--model", "gpt-5"], /each agent's model/],
    [["wf.yaml", "--task", "t", "--provider", "openai-compatible"], /needs --base-url/],
  ])("rejects %j", (argv, message) => {
    expect(error(argv)).toMatch(message);
  });
});

describe("providerSettings", () => {
  const env = {
    OPENAI_API_KEY: "sk-openai", ANTHROPIC_API_KEY: "sk-ant", OLLAMA_API_KEY: "ol",
    HARNESS_CUSTOM_API_KEY: "custom-key",
  };

  it("leaves the hosted and Ollama keys in the environment, where harness-core reads them", () => {
    const args = ok(["wf.yaml", "--task", "t", "--provider", "ollama", "--base-url", "http://gpu:11434", "--model", "qwen3:8b"]);
    expect(providerSettings(args, env)).toEqual({
      llmProvider: "ollama", apiKey: "", openaiApiKey: "", ollamaApiKey: "",
      ollamaBaseUrl: "http://gpu:11434", ollamaModel: "qwen3:8b",
      customApiUrl: "", customApiKey: "", customApiModel: "",
    });
  });

  it("gives HARNESS_CUSTOM_API_KEY only to an OpenAI-compatible endpoint", () => {
    const args = ok(["wf.yaml", "--task", "t", "--provider", "openai-compatible",
      "--base-url", "https://llm.example/v1", "--model", "m"]);
    expect(providerSettings(args, env)).toEqual({
      llmProvider: "openai-compatible", apiKey: "", openaiApiKey: "", ollamaApiKey: "",
      ollamaBaseUrl: "", ollamaModel: "",
      customApiUrl: "https://llm.example/v1", customApiKey: "custom-key", customApiModel: "m",
    });
  });
});
```

Run: `npx vitest run tests/unit/cli/runArgs.test.ts` → FAIL (module not found).

- [ ] **Step 2: `src/cli/runArgs.ts`**

```ts
/**
 * `harness run`'s command line: the workflow, the task and the options
 * (docs/HEADLESS.md). Pure, so the parsing is tested without a process.
 */
import type { ProviderSettings } from "@/engine/runWorkflow";
import type { LlmProvider } from "@/utils/providerConfig";

export interface RunArgs {
  workflow: string;
  task?: string;
  taskFile?: string;
  workspace?: string;
  provider: LlmProvider;
  baseUrl?: string;
  model?: string;
  maxParallel?: number;
  continueOnError: boolean;
  json: boolean;
  core?: string;
  /** Exact command lines agents may run; every other command is denied. */
  allowCommands: string[];
}

export const RUN_USAGE = `Usage: harness run <workflow.harness.yaml> --task "…" [options]

  --task "<text>"            What the run should do (or --task-file <path>)
  --workspace <dir>          The folder the agents work in (default: the current folder)
  --provider <name>          auto, openai, anthropic, ollama, ollama-cloud or openai-compatible (default: auto)
  --base-url <url>           The Ollama or OpenAI-compatible endpoint
  --model <name>             The Ollama or OpenAI-compatible model (hosted providers use each agent's model)
  --max-parallel <n>         Agents running at once (default: the workflow's setting)
  --continue-on-error        Keep running the other agents after one fails
  --allow-command "<cmd>"    Let agents run this exact command (repeatable); every other command is denied
  --json                     One JSON event per line on stdout
  --core <path>              The harness-core binary (default: HARNESS_CORE, then src-tauri/target/release)

Keys come from the environment only: OPENAI_API_KEY, ANTHROPIC_API_KEY, OLLAMA_API_KEY,
OLLAMA_REMOTE_API_KEY, and HARNESS_CUSTOM_API_KEY for an OpenAI-compatible endpoint.
Exit codes: 0 done, 1 an agent failed, 2 bad usage or workflow, 3 could not start, 130 interrupted.`;

const PROVIDERS: readonly LlmProvider[] = ["auto", "openai", "anthropic", "ollama", "ollama-cloud", "openai-compatible"];
const TAKES_VALUE = new Set([
  "--task", "--task-file", "--workspace", "--provider", "--base-url", "--model", "--max-parallel", "--core",
  "--allow-command",
]);

export function parseRunArgs(argv: string[]): { args: RunArgs } | { error: string } {
  const args: RunArgs = { workflow: "", provider: "auto", continueOnError: false, json: false, allowCommands: [] };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") { args.json = true; continue; }
    if (flag === "--continue-on-error") { args.continueOnError = true; continue; }
    if (!flag.startsWith("--")) { positionals.push(flag); continue; }
    if (!TAKES_VALUE.has(flag)) return { error: `Unknown option: ${flag}` };
    const value = argv[++i];
    if (value === undefined) return { error: `${flag} needs a value` };
    switch (flag) {
      case "--task": args.task = value; break;
      case "--task-file": args.taskFile = value; break;
      case "--workspace": args.workspace = value; break;
      case "--base-url": args.baseUrl = value; break;
      case "--model": args.model = value; break;
      case "--core": args.core = value; break;
      case "--provider":
        if (!PROVIDERS.includes(value as LlmProvider)) {
          return { error: `--provider must be one of: ${PROVIDERS.join(", ")}` };
        }
        args.provider = value as LlmProvider;
        break;
      case "--max-parallel": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) return { error: "--max-parallel must be a whole number of at least 1" };
        args.maxParallel = n;
        break;
      }
      case "--allow-command":
        if (!value.trim()) return { error: "--allow-command needs a command" };
        args.allowCommands.push(value.trim());
        break;
    }
  }
  if (positionals.length !== 1) return { error: "Give exactly one workflow file." };
  args.workflow = positionals[0];
  if ((args.task === undefined) === (args.taskFile === undefined)) {
    return { error: "Give the task with --task or --task-file (one of them)." };
  }
  if (args.task !== undefined && !args.task.trim()) return { error: "The task is empty." };
  if ((args.provider === "openai" || args.provider === "anthropic") && (args.baseUrl || args.model)) {
    return { error: `--base-url and --model are for Ollama and OpenAI-compatible endpoints; ${args.provider} uses each agent's model.` };
  }
  if (args.provider === "openai-compatible" && !args.baseUrl) {
    return { error: "--provider openai-compatible needs --base-url" };
  }
  return { args };
}

/** The run's provider settings. harness-core reads OPENAI_API_KEY, ANTHROPIC_API_KEY,
 *  OLLAMA_API_KEY and OLLAMA_REMOTE_API_KEY itself when the key it gets is empty;
 *  Rust has no fallback for a custom endpoint, so its key (HARNESS_CUSTOM_API_KEY) is passed. */
export function providerSettings(args: RunArgs, env: Record<string, string | undefined>): ProviderSettings {
  const custom = args.provider === "openai-compatible";
  return {
    llmProvider: args.provider,
    apiKey: "",
    openaiApiKey: "",
    ollamaApiKey: "",
    ollamaBaseUrl: custom ? "" : args.baseUrl ?? "",
    ollamaModel: custom ? "" : args.model ?? "",
    customApiUrl: custom ? args.baseUrl ?? "" : "",
    customApiKey: custom ? env.HARNESS_CUSTOM_API_KEY ?? "" : "",
    customApiModel: custom ? args.model ?? "" : "",
  };
}
```

- [ ] **Step 3:** Run: `npx vitest run tests/unit/cli/runArgs.test.ts && npx tsc --noEmit` → PASS (16 tests).

- [ ] **Step 4: Commit:** `git add src/cli/runArgs.ts tests/unit/cli/runArgs.test.ts && git commit -m "Add harness run's argument parsing and provider settings"`

---

### Task 3: `coreClient.ts` and the fake core

**Files:**
- Create: `src/cli/coreClient.ts`, `tests/fixtures/fake-core.mjs`, `tests/unit/cli/coreClient.test.ts`
- Modify: `tests/node-shims.d.ts`

- [ ] **Step 1: The fake core** — `tests/fixtures/fake-core.mjs`:

```js
/**
 * A stand-in for harness-core in the CLI tests: the same JSON-lines protocol
 * (src-tauri/src/commands/core_server.rs) with canned model replies.
 *
 * FAKE_CORE_SCENARIO: a JSON file { replies: { <agent>: string[] }, healthFails?: true }.
 *   An agent's replies are used in order, and the last one repeats. A reply that
 *   starts with "ERROR:" is returned as that call's error.
 * FAKE_CORE_LOG: a file each request is appended to as a JSON line.
 * Test-only commands: "echo" (replies with its args), "fail", "slow", "die".
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const scenario = process.env.FAKE_CORE_SCENARIO
  ? JSON.parse(readFileSync(process.env.FAKE_CORE_SCENARIO, "utf8"))
  : { replies: {} };
const calls = {};

function modelReply(system) {
  const agent = /^You are (.+?),/.exec(system ?? "")?.[1] ?? "?";
  const replies = scenario.replies?.[agent] ?? ["ok"];
  calls[agent] = (calls[agent] ?? 0) + 1;
  const reply = replies[Math.min(calls[agent], replies.length) - 1];
  if (reply.startsWith("ERROR:")) throw reply.slice("ERROR:".length).trim();
  return reply;
}

const file = (a) => join(a.workspacePath, a.relativePath);

const commands = {
  get_provider_defaults: () => ({
    llm_provider: "auto", ollama_base_url: "http://localhost:11434", ollama_model: "qwen2.5-coder:7b",
    openai_api_key_configured: false, anthropic_api_key_configured: false,
    ollama_api_key_configured: false, suggested_ollama_models: [],
  }),
  check_provider_health: (a) => (scenario.healthFails
    ? { ok: false, provider: a.provider, latency_ms: 0, message: "Ollama is not running", model_available: false, pull_command: null }
    : { ok: true, provider: a.provider, latency_ms: 1, message: "ok", model_available: true, pull_command: null }),
  call_ollama_api: (a) => modelReply(a.system),
  // Every agent uses the text tool protocol.
  chat_turn: () => ({ text: "", toolCalls: [], finishReason: "tools_unsupported", nativeToolsSupported: false }),
  read_workspace_file: (a) => {
    try { return readFileSync(file(a), "utf8"); } catch { throw "IO error: not found (os error 2)"; }
  },
  write_workspace_file: (a) => {
    mkdirSync(dirname(file(a)), { recursive: true });
    writeFileSync(file(a), a.content);
    return null;
  },
  delete_workspace_file: (a) => { rmSync(file(a)); return null; },
  list_workspace_files: () => [],
  write_audit_entry: () => null,
  execute_hook: () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
  execute_command: () => ({ exitCode: 0, stdout: scenario.commandOutput ?? "5 passed", stderr: "", durationMs: 5 }),
  cancel_command: () => true,
  echo: (a) => a,
  fail: () => { throw "boom"; },
  slow: () => new Promise((resolve) => setTimeout(() => resolve("slow"), 200)),
  die: () => process.exit(1),
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const { id, cmd, args } = JSON.parse(line);
  if (process.env.FAKE_CORE_LOG) appendFileSync(process.env.FAKE_CORE_LOG, `${JSON.stringify({ cmd, args })}\n`);
  let reply;
  try {
    if (!commands[cmd]) throw `Unknown command: ${cmd}`;
    reply = { id, ok: await commands[cmd](args ?? {}) };
  } catch (e) {
    reply = { id, err: String(e) };
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`);
});
```

- [ ] **Step 2: Failing test** — `tests/unit/cli/coreClient.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CORE_STOPPED, startCore } from "@/cli/coreClient";

const fakeCore = resolve(__dirname, "../../fixtures/fake-core.mjs");
const core = () => startCore(process.execPath, [fakeCore]);

describe("startCore", () => {
  it("answers each call with its own reply, in whatever order they finish", async () => {
    const c = core();
    const [slow, echo] = await Promise.all([c.invoke("slow"), c.invoke("echo", { x: 1 })]);
    expect([slow, echo]).toEqual(["slow", { x: 1 }]);
    await c.close();
    expect(c.stopped()).toBe(true);
  });

  it("rejects with the command's error message, as Tauri's invoke does", async () => {
    const c = core();
    await expect(c.invoke("fail")).rejects.toBe("boom");
    await c.close();
  });

  it("rejects pending and later calls once harness-core stops", async () => {
    const c = core();
    const pending = c.invoke("slow");
    void c.invoke("die").catch(() => {});
    await expect(pending).rejects.toBe(CORE_STOPPED);
    expect(c.stopped()).toBe(true);
    await expect(c.invoke("echo")).rejects.toBe(CORE_STOPPED);
  });

  it("reports a core that cannot start as stopped", async () => {
    const c = startCore(join(tmpdir(), "no-such-harness-core"));
    await expect(c.invoke("echo")).rejects.toBe(CORE_STOPPED);
    expect(c.stopped()).toBe(true);
  });
});
```

Run: `npx vitest run tests/unit/cli/coreClient.test.ts` → FAIL (module not found).

- [ ] **Step 3: Node typings** — in `tests/node-shims.d.ts`:

At the top of the file:

```ts
// Minimal Node typings: this project has no @types/node. Used by the Node-side
// tests and by src/cli (harness run).
```

In `declare module "node:child_process"`:

```ts
  export interface ChildProcess {
    stdin: {
      write(data: string): boolean;
      end(): void;
      on(event: "error", listener: (error: unknown) => void): void;
    };
    stdout: {
      setEncoding(encoding: string): void;
      on(event: "data", listener: (chunk: string) => void): void;
    };
    on(event: "error" | "close", listener: () => void): void;
    kill(): boolean;
  }

  export function spawn(
    command: string,
    args?: string[],
    options?: { stdio?: Array<"pipe" | "inherit" | "ignore"> },
  ): ChildProcess;
```

A new module:

```ts
declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
```

and `process` gains I/O and signals:

```ts
declare const process: {
  execPath: string;
  env: Record<string, string | undefined>;
  platform: string;
  stdout: { write(text: string): boolean };
  stderr: { write(text: string): boolean };
  on(event: "SIGINT", listener: () => void): void;
  off(event: "SIGINT", listener: () => void): void;
  exit(code?: number): never;
};
```

- [ ] **Step 4: `src/cli/coreClient.ts`**

```ts
/**
 * harness-core as a child process. `invoke` sends one request line and resolves
 * with the matching reply (protocol: src-tauri/src/commands/core_server.rs). A
 * command's error rejects with its message, as Tauri's invoke does.
 */
import { spawn } from "node:child_process";
import type { InvokeFn } from "@/services/model-providers/providerAdapter";

export const CORE_STOPPED = "harness-core stopped";

export interface CoreClient {
  invoke: InvokeFn;
  /** True once harness-core has exited, or could not start. */
  stopped: () => boolean;
  /** Ends its input, so it answers what is still running and exits; kills it
   *  if it still runs after `graceMs`. */
  close: (graceMs?: number) => Promise<void>;
}

type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void };

export function startCore(command: string, args: string[] = []): CoreClient {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let stopped = false;
  let markExited = () => {};
  const exited = new Promise<void>((resolve) => { markExited = resolve; });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const call of pending.values()) call.reject(CORE_STOPPED);
    pending.clear();
    markExited();
  };
  child.on("error", stop); // it could not start
  child.on("close", stop); // it exited, and its output has been read
  child.stdin.on("error", () => {}); // it exited; stop() rejects what was pending

  const settle = (line: string) => {
    let reply: { id?: unknown; ok?: unknown; err?: unknown };
    try {
      reply = JSON.parse(line);
    } catch {
      return; // not a reply
    }
    const call = typeof reply.id === "number" ? pending.get(reply.id) : undefined;
    if (!call) return;
    pending.delete(reply.id as number);
    if (reply.err !== undefined) call.reject(String(reply.err));
    else call.resolve(reply.ok);
  };
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      settle(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
    }
  });

  const invoke = <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (stopped) return Promise.reject(CORE_STOPPED);
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
    });
  };

  return {
    invoke,
    stopped: () => stopped,
    close: async (graceMs = 5000) => {
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), graceMs); });
      if (await Promise.race([exited.then(() => false), late])) child.kill();
      clearTimeout(timer);
    },
  };
}
```

- [ ] **Step 5:** Run: `npx vitest run tests/unit/cli/coreClient.test.ts && npx tsc --noEmit` → PASS (4 tests).

- [ ] **Step 6: Commit:** `git add src/cli/coreClient.ts tests/fixtures/fake-core.mjs tests/unit/cli/coreClient.test.ts tests/node-shims.d.ts && git commit -m "Add the harness-core client for harness run, with a fake core for tests"`

---

### Task 4: `report.ts`

**Files:** create `src/cli/report.ts`, `tests/unit/cli/report.test.ts`

- [ ] **Step 1: Failing test** — `tests/unit/cli/report.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createReporter } from "@/cli/report";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import { AgentRole } from "@/types/agent";
import type { AuditEntry } from "@/types/audit";
import type { WorkflowRun } from "@/types/execution";
import type { AgentNode } from "@/types/workflow";

function node(id: string): AgentNode {
  return {
    id, type: "agent", position: { x: 0, y: 0 },
    data: {
      name: id, role: AgentRole.Worker, model: "m", temperature: 0.7, maxTokens: 1024, maxSteps: 3,
      timeoutSeconds: 300, promptSource: { type: "inline", content: "" }, tools: [], memoryRead: [],
      memoryWrite: [], tokens: { used: 0, budget: 0 }, status: "idle",
    },
  };
}

/** Coder → Reviewer, with a feedback edge back: only Reviewer's output is the result. */
const graph: WorkflowGraph = {
  nodes: [node("Coder"), node("Reviewer")],
  edges: [
    { id: "c-r", source: "Coder", target: "Reviewer" },
    { id: "r-c", source: "Reviewer", target: "Coder", data: { edgeKind: "feedback", label: "revise" } },
  ],
  meta: { name: "W", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
  executionSettings: { maxParallel: 2, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
};

const audit = (agentId: string, action: AuditEntry["action"], details: string, success = true): AuditEntry =>
  ({ id: details, timestamp: "", action, agentId, details, success });

const run: WorkflowRun = {
  id: "run-1", workflowName: "W", startedAt: 0, status: "done",
  agents: {
    Coder: { agentId: "Coder", agentName: "Coder", status: "done", output: "patched" },
    Reviewer: { agentId: "Reviewer", agentName: "Reviewer", status: "done", output: "Looks good.\nShip it." },
  },
  changes: [{ path: "src/a.ts", before: "a\n", after: "a\nb\n", agents: ["Coder"], edits: 1 }],
};

function capture(json: boolean) {
  const out: string[] = [];
  const err: string[] = [];
  return { reporter: createReporter(graph, json, (l) => out.push(l), (l) => err.push(l)), out, err };
}

describe("createReporter", () => {
  it("prints each agent's start and end, and its commands, compactions and revisions", () => {
    const { reporter: { events }, out } = capture(false);

    events.onRunStarted("run-1", "W");
    events.onAgentUpdate("Coder", { agentId: "Coder", agentName: "Coder", status: "running", startedAt: 1000,
      modelUsed: "qwen3:8b", providerUsed: "ollama" });
    events.onAudit(audit("Coder", "file_read", "Tool: read_file({})"));
    events.onAudit(audit("Coder", "command_executed", "Coder ran: npm test (allowed by --allow-command; exit 0, 900 ms)"));
    events.onAudit(audit("Coder", "workflow_loaded", "↻ Coder: compacted 2 earlier steps (~4,000 → ~900 tokens)"));
    events.onAgentUpdate("Coder", { status: "done", output: "patched", finishedAt: 13_300 });
    events.onAudit(audit("Reviewer", "workflow_loaded", "↺ Reviewer asked for revision 1/2: re-running Coder"));
    events.onAgentUpdate("Reviewer", { agentId: "Reviewer", agentName: "Reviewer", status: "error",
      error: "model crashed", finishedAt: 14_000 });

    expect(out).toEqual([
      "Run run-1: W (2 agents)",
      "▶ Coder started (qwen3:8b via ollama)",
      "$ Coder ran: npm test (allowed by --allow-command; exit 0, 900 ms)",
      "↻ Coder: compacted 2 earlier steps (~4,000 → ~900 tokens)",
      "✓ Coder done (12.3 s)",
      "↺ Reviewer asked for revision 1/2: re-running Coder",
      "✗ Reviewer failed: model crashed",
    ]);
  });

  it("sums up the run: status, each agent, changed files and the final output", () => {
    const { reporter, out } = capture(false);

    reporter.summary({ started: true, run }, 45_210);

    expect(out).toEqual([
      "",
      "Done in 45.2 s · run run-1",
      "  ✓ Coder: done",
      "  ✓ Reviewer: done",
      "Changed files:",
      "  src/a.ts  +1 −0",
      "",
      "Final output — Reviewer:",
      "  Looks good.",
      "  Ship it.",
    ]);
  });

  it("emits one JSON event per line with --json, ending with the summary", () => {
    const { reporter, out } = capture(true);

    reporter.events.onRunStarted("run-1", "W");
    reporter.events.onAgentUpdate("Coder", { agentId: "Coder", agentName: "Coder", status: "running",
      startedAt: 1000, modelUsed: "m", providerUsed: "ollama" });
    reporter.events.onAudit(audit("Coder", "command_executed", "Coder: command denied (not in --allow-command): rm -rf /", false));
    reporter.events.onAudit(audit("Coder", "file_read", "Tool: read_file({})"));
    reporter.events.onAgentUpdate("Coder", { status: "done", output: "patched", finishedAt: 2000 });
    reporter.summary({ started: true, run }, 5000);

    expect(out.map((line) => JSON.parse(line))).toEqual([
      { type: "run_started", runId: "run-1", workflow: "W" },
      { type: "node_started", nodeId: "Coder", agent: "Coder", model: "m", provider: "ollama" },
      { type: "command", nodeId: "Coder", details: "Coder: command denied (not in --allow-command): rm -rf /", success: false },
      { type: "audit", nodeId: "Coder", details: "Tool: read_file({})", success: true },
      { type: "node_finished", nodeId: "Coder", agent: "Coder", status: "done", output: "patched", durationMs: 1000 },
      {
        type: "run_finished", runId: "run-1", status: "done", durationMs: 5000,
        agents: { Coder: { agent: "Coder", status: "done" }, Reviewer: { agent: "Reviewer", status: "done" } },
        changes: [{ path: "src/a.ts", created: false, added: 1, removed: 0 }],
        outputs: { Reviewer: "Looks good.\nShip it." },
      },
    ]);
  });

  it("reports a run that did not start on stderr, or as run_finished with --json", () => {
    const human = capture(false);
    human.reporter.summary({ started: false, error: "Ollama is not running" }, 10);
    expect(human.out).toEqual([]);
    expect(human.err).toEqual(["harness run: the run did not start: Ollama is not running"]);

    const json = capture(true);
    json.reporter.summary({ started: false, error: "Ollama is not running" }, 10);
    expect(json.out.map((line) => JSON.parse(line))).toEqual([
      { type: "run_finished", status: "not_started", error: "Ollama is not running" },
    ]);
  });
});
```

Run: `npx vitest run tests/unit/cli/report.test.ts` → FAIL (module not found).

- [ ] **Step 2: `src/cli/report.ts`**

```ts
/**
 * How `harness run` reports a run on stdout: a line per event and a summary,
 * or with --json one JSON object per line (docs/HEADLESS.md).
 */
import { isFeedbackEdge, type RunEvents, type RunOutcome } from "@/engine/runWorkflow";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import { lineCounts } from "@/services/execution/changeLog";
import type { AgentRun, AgentStatus, WorkflowRun } from "@/types/execution";

export type Write = (line: string) => void;

export interface Reporter {
  events: RunEvents;
  summary: (outcome: RunOutcome, elapsedMs: number) => void;
}

const ENDED: ReadonlySet<AgentStatus> = new Set(["done", "error", "stopped", "skipped"]);
const ICON: Record<AgentStatus, string> = {
  idle: "·", waiting: "·", running: "·", done: "✓", error: "✗", stopped: "■", skipped: "–",
};
const RESULT: Record<WorkflowRun["status"], string> = {
  running: "Running", done: "Done", error: "Failed", cancelled: "Stopped",
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function endLine(agent: AgentRun, durationMs: number | undefined): string {
  switch (agent.status) {
    case "done": return `✓ ${agent.agentName} done${durationMs === undefined ? "" : ` (${seconds(durationMs)})`}`;
    case "error": return `✗ ${agent.agentName} failed: ${agent.error ?? "unknown error"}`;
    case "stopped": return `■ ${agent.agentName} stopped`;
    default: return `– ${agent.agentName} skipped`;
  }
}

export function createReporter(graph: WorkflowGraph, json: boolean, out: Write, err: Write): Reporter {
  const emit = (event: Record<string, unknown>) => out(JSON.stringify(event));
  const name = (nodeId: string) => graph.nodes.find((n) => n.id === nodeId)?.data.name ?? nodeId;
  // The run's result is the output of the agents nothing runs after.
  const hasNext = new Set(graph.edges.filter((e) => !isFeedbackEdge(e)).map((e) => e.source));
  const finalNodes = graph.nodes.filter((n) => !hasNext.has(n.id));
  const agents: Record<string, AgentRun> = {};

  const events: RunEvents = {
    onRunStarted: (runId, workflowName) => {
      if (json) emit({ type: "run_started", runId, workflow: workflowName });
      else out(`Run ${runId}: ${workflowName} (${graph.nodes.length} agents)`);
    },
    onAgentUpdate: (nodeId, partial) => {
      const agent = agents[nodeId] = {
        ...(agents[nodeId] ?? { agentId: nodeId, agentName: name(nodeId), status: "idle" }), ...partial,
      };
      if (partial.status === "running") {
        if (json) {
          emit({ type: "node_started", nodeId, agent: agent.agentName, model: agent.modelUsed,
            provider: agent.providerUsed, revision: agent.revision });
        } else {
          out(`▶ ${agent.agentName} started${agent.modelUsed ? ` (${agent.modelUsed} via ${agent.providerUsed})` : ""}`);
        }
      } else if (partial.status && ENDED.has(partial.status)) {
        const durationMs = agent.startedAt && agent.finishedAt ? agent.finishedAt - agent.startedAt : undefined;
        if (json) {
          emit({ type: "node_finished", nodeId, agent: agent.agentName, status: agent.status, output: agent.output,
            error: agent.error, durationMs, revision: agent.revision });
        } else {
          out(endLine(agent, durationMs));
        }
      }
    },
    onNodeStatus: () => {},
    onAudit: (entry) => {
      const details = entry.details ?? "";
      const type = entry.action === "command_executed" ? "command"
        : details.startsWith("↺") ? "revision"
        : details.startsWith("↻") ? "compaction"
        : "audit";
      if (json) emit({ type, nodeId: entry.agentId, details, success: entry.success });
      else if (type === "command") out(`$ ${details}`);
      else if (type !== "audit") out(details);
    },
    onFileChange: () => {},
    onRunFinished: () => {},
  };

  const summary = (outcome: RunOutcome, elapsedMs: number) => {
    if (!outcome.started) {
      if (json) emit({ type: "run_finished", status: "not_started", error: outcome.error });
      else err(`harness run: the run did not start: ${outcome.error}`);
      return;
    }
    const { run } = outcome;
    const changes = (run.changes ?? []).map((c) => ({
      path: c.path, created: c.before === null, ...lineCounts(c.before, c.after),
    }));
    const outputs = finalNodes
      .filter((n) => run.agents[n.id]?.output)
      .map((n) => ({ id: n.id, name: n.data.name, output: run.agents[n.id].output ?? "" }));
    if (json) {
      emit({
        type: "run_finished", runId: run.id, status: run.status, durationMs: elapsedMs,
        agents: Object.fromEntries(graph.nodes.map((n) => [n.id, { agent: n.data.name, status: run.agents[n.id]?.status ?? "idle" }])),
        changes,
        outputs: Object.fromEntries(outputs.map((o) => [o.id, o.output])),
      });
      return;
    }
    out("");
    out(`${RESULT[run.status]} in ${seconds(elapsedMs)} · run ${run.id}`);
    for (const n of graph.nodes) {
      const status = run.agents[n.id]?.status ?? "idle";
      out(`  ${ICON[status]} ${n.data.name}: ${status === "idle" ? "not run" : status}`);
    }
    if (changes.length > 0) {
      out("Changed files:");
      for (const c of changes) out(`  ${c.path}${c.created ? " (new)" : ""}  +${c.added} −${c.removed}`);
    }
    for (const o of outputs) {
      out("");
      out(`Final output — ${o.name}:`);
      for (const line of o.output.split("\n")) out(`  ${line}`);
    }
  };

  return { events, summary };
}
```

- [ ] **Step 3:** Run: `npx vitest run tests/unit/cli/report.test.ts && npx tsc --noEmit` → PASS (4 tests).

- [ ] **Step 4: Commit:** `git add src/cli/report.ts tests/unit/cli/report.test.ts && git commit -m "Add harness run's reporter: event lines or JSON events, and the summary"`

---

### Task 5: `runCli.ts`, the bundle and `cli/harness.mjs run`

**Files:**
- Create: `src/cli/runCli.ts`, `src/cli/tauriShim.ts`, `vite.cli.config.ts`, `tests/unit/cli/runCli.test.ts`, `tests/unit/cli/harnessRun.test.ts`
- Modify: `cli/harness.mjs`, `package.json`

- [ ] **Step 1: Failing unit tests** — `tests/unit/cli/runCli.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { corePath, createInterrupt, exitCode, EXIT } from "@/cli/runCli";
import type { WorkflowRun } from "@/types/execution";

const finished = (status: WorkflowRun["status"]) =>
  ({ started: true as const, run: { id: "r", workflowName: "W", startedAt: 0, status, agents: {} } });

describe("exitCode", () => {
  it("is 0 when done, 1 when an agent failed, 130 when stopped and 3 when the run could not start", () => {
    expect(exitCode(finished("done"), false)).toBe(0);
    expect(exitCode(finished("error"), false)).toBe(1);
    expect(exitCode(finished("cancelled"), false)).toBe(130);
    expect(exitCode({ started: false, error: "Ollama is not running" }, false)).toBe(3);
    expect(exitCode(finished("error"), true)).toBe(3); // harness-core stopped during the run
  });
});

describe("createInterrupt", () => {
  it("stops the run on the first Ctrl+C and exits on the second", () => {
    const messages: string[] = [];
    const exit = vi.fn();
    const stop = createInterrupt((line) => messages.push(line), exit);

    stop.onInterrupt();
    expect(stop.interrupted()).toBe(true);
    expect(messages).toEqual(["Stopping the run… (press Ctrl+C again to exit now)"]);
    expect(exit).not.toHaveBeenCalled();

    stop.onInterrupt();
    expect(exit).toHaveBeenCalledWith(EXIT.interrupted);
  });
});

describe("corePath", () => {
  it("takes --core, then HARNESS_CORE, then this repo's release build", () => {
    expect(corePath("bin/core", { HARNESS_CORE: "/opt/core" }, "linux")).toMatch(/bin[\\/]core$/);
    expect(corePath(undefined, { HARNESS_CORE: "/opt/core" }, "linux")).toMatch(/opt[\\/]core$/);
    expect(corePath(undefined, {}, "win32")).toMatch(/src-tauri[\\/]target[\\/]release[\\/]harness-core\.exe$/);
    expect(corePath(undefined, {}, "linux")).toMatch(/src-tauri[\\/]target[\\/]release[\\/]harness-core$/);
  });
});
```

and the end-to-end test — `tests/unit/cli/harnessRun.test.ts`:

```ts
// @vitest-environment node
/**
 * harness run end to end: the built bundle (npm run build:cli) through
 * cli/harness.mjs, against the fake harness-core with canned model replies.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";

const root = resolve(__dirname, "../../..");
const fakeCore = join(root, "tests", "fixtures", "fake-core.mjs");

beforeAll(() => {
  const vite = join(root, "node_modules", "vite", "bin", "vite.js");
  const build = spawnSync(process.execPath, [vite, "build", "--config", "vite.cli.config.ts", "--logLevel", "error"],
    { cwd: root, encoding: "utf8" });
  expect(build.status, build.stderr).toBe(0);
}, 120_000);

function agent(name: string, role: string, tools: string[] = []) {
  return {
    name, role, model: "qwen2.5-coder:7b", temperature: 0.7, maxTokens: 1024, maxSteps: 3, timeoutSeconds: 60,
    promptSource: { type: "inline", content: `You review and fix code as the ${name}.` }, tools,
    memoryRead: [], memoryWrite: [], tokens: { used: 0, budget: 0 }, status: "idle",
  };
}

/** A workspace with a Coder → Reviewer workflow, and the fake core's scenario. */
function workspace(replies: Record<string, string[]>, extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-run-"));
  writeFileSync(join(dir, "review.harness.yaml"), stringify({
    meta: { name: "Code Review", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
    agents: [agent("Coder", "worker", ["bash"]), agent("Reviewer", "critic")],
    connections: [{ id: "c1", sourceAgentId: "agent-0", targetAgentId: "agent-1" }],
    executionSettings: { maxParallel: 2, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
    nodePositions: {},
  }));
  writeFileSync(join(dir, "scenario.json"), JSON.stringify({ replies, ...extra }));
  return dir;
}

function harnessRun(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [
    join(root, "cli", "harness.mjs"), "run", join(dir, "review.harness.yaml"),
    "--workspace", dir, "--core", fakeCore, ...args,
  ], {
    cwd: dir, encoding: "utf8",
    env: {
      ...process.env, FAKE_CORE_SCENARIO: join(dir, "scenario.json"), FAKE_CORE_LOG: join(dir, "core.log"),
      OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", LLM_PROVIDER: "",
    },
  });
  const log = join(dir, "core.log");
  const requests = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { cmd: string; args: Record<string, unknown> })
    : [];
  return { ...result, requests };
}

const bashCall = '<tool_call>{"name":"bash","args":{"command":"npm test"}}</tool_call>';

describe("harness run", () => {
  it("runs a workflow, printing each agent and a summary, and exits 0", () => {
    const run = harnessRun(workspace({ Coder: ["wrote the fix"], Reviewer: ["Looks good."] }), ["--task", "Fix the bug"]);

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("▶ Coder started (qwen2.5-coder:7b via ollama)");
    expect(run.stdout).toMatch(/✓ Coder done \(\d+\.\d s\)/);
    expect(run.stdout).toContain("Final output — Reviewer:\n  Looks good.");
    const coder = run.requests.find((r) => r.cmd === "call_ollama_api" && String(r.args.system).startsWith("You are Coder"));
    expect(coder?.args.userMessage).toContain("USER TASK:\nFix the bug");
  });

  it("prints only JSON events with --json", () => {
    const run = harnessRun(workspace({ Coder: ["done"], Reviewer: ["fine"] }), ["--task", "t", "--json"]);

    expect(run.status, run.stderr).toBe(0);
    const events = run.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events[0].type).toBe("run_started");
    expect(events.filter((e) => e.type === "node_finished").map((e) => [e.agent, e.status]))
      .toEqual([["Coder", "done"], ["Reviewer", "done"]]);
    expect(events.at(-1)).toMatchObject({ type: "run_finished", status: "done", outputs: { "agent-1": "fine" } });
  });

  it("denies an agent's command unless it was allowed exactly with --allow-command", () => {
    const replies = { Coder: [bashCall, "tested"], Reviewer: ["ok"] };

    const denied = harnessRun(workspace(replies), ["--task", "t"]);
    expect(denied.status, denied.stderr).toBe(0);
    expect(denied.stdout).toContain("$ Coder: command denied (not in --allow-command): npm test");
    expect(denied.requests.some((r) => r.cmd === "execute_command")).toBe(false);

    const allowed = harnessRun(workspace(replies), ["--task", "t", "--allow-command", "npm test"]);
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(allowed.stdout).toMatch(/\$ Coder ran: npm test \(allowed by --allow-command; exit 0/);
    expect(allowed.requests.find((r) => r.cmd === "execute_command")?.args)
      .toMatchObject({ command: "npm test", consentGranted: true });
  });

  it("exits 1 when an agent fails", () => {
    const run = harnessRun(workspace({ Coder: ["done"], Reviewer: ["ERROR: model crashed"] }), ["--task", "t"]);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("✗ Reviewer failed: model crashed");
  });

  it("exits 2 for bad usage or an invalid workflow, without starting harness-core", () => {
    const dir = workspace({});
    expect(harnessRun(dir, []).status).toBe(2); // no task

    writeFileSync(join(dir, "review.harness.yaml"), "meta:\n  name: broken\n");
    const invalid = harnessRun(dir, ["--task", "t"]);
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("is not a valid workflow");
    expect(invalid.requests).toEqual([]);
  });

  it("exits 3 when harness-core is missing or the provider preflight fails", () => {
    const dir = workspace({}, { healthFails: true });

    const missing = harnessRun(dir, ["--task", "t", "--core", join(dir, "no-such-core")]);
    expect(missing.status).toBe(3);
    expect(missing.stderr).toContain("harness-core not found");

    const preflight = harnessRun(dir, ["--task", "t"]);
    expect(preflight.status).toBe(3);
    expect(preflight.stderr).toContain("Ollama is not running");
  });
});
```

Run: `npx vitest run tests/unit/cli/runCli.test.ts tests/unit/cli/harnessRun.test.ts`
Expected: FAIL. `@/cli/runCli` is missing, and the build fails because `vite.cli.config.ts` is missing.

- [ ] **Step 2: `src/cli/tauriShim.ts`**

```ts
/**
 * @tauri-apps/api/core in the harness run bundle (vite.cli.config.ts). Node has
 * no Tauri IPC: the engine's commands go to harness-core, and providerAdapter
 * cannot create a stream channel, so replies do not stream.
 */
export class Channel {
  constructor() {
    throw new Error("harness run has no Tauri IPC: replies do not stream");
  }
}
```

- [ ] **Step 3: `vite.cli.config.ts`**

```ts
import { defineConfig } from "vite";
import path from "path";

// harness run: the shared engine bundled for Node (npm run build:cli → cli/dist/harness-run.mjs).
export default defineConfig({
  publicDir: false,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The engine reaches Tauri only through providerAdapter's Channel.
      "@tauri-apps/api/core": path.resolve(__dirname, "./src/cli/tauriShim.ts"),
    },
  },
  // Everything in one file, so the bundle runs without resolving app packages.
  ssr: { noExternal: true },
  build: {
    ssr: "src/cli/runCli.ts",
    outDir: "cli/dist",
    emptyOutDir: true,
    target: "node18",
    minify: false,
    rollupOptions: { output: { entryFileNames: "harness-run.mjs", format: "es" } },
  },
});
```

`package.json` scripts, after `build:core`:

```json
    "build:cli": "vite build --config vite.cli.config.ts",
```

- [ ] **Step 4: `src/cli/runCli.ts`**

```ts
/**
 * harness run: runs a workflow without the app, for CI (docs/HEADLESS.md). The
 * engine is the app's (src/engine/runWorkflow.ts); the Rust commands come from
 * harness-core over its pipes. Bundled by `npm run build:cli` into
 * cli/dist/harness-run.mjs, which `node cli/harness.mjs run` loads.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { runWorkflow, type RunHost, type RunOutcome } from "@/engine/runWorkflow";
import { defToGraph } from "@/engine/workflowGraph";
import { workflowDefSchema } from "@/schemas/workflowSchema";
import type { WorkflowDef } from "@/types/workflow";
import { validateWorkflow } from "@/utils/validateWorkflow";
import { startCore } from "@/cli/coreClient";
import { createReporter, type Write } from "@/cli/report";
import { parseRunArgs, providerSettings, RUN_USAGE } from "@/cli/runArgs";

export const EXIT = { done: 0, failed: 1, usage: 2, notStarted: 3, interrupted: 130 } as const;

/** The exit code for a run's outcome. harness-core stopping during the run counts as not starting. */
export function exitCode(outcome: RunOutcome, coreStopped: boolean): number {
  if (!outcome.started || coreStopped) return EXIT.notStarted;
  if (outcome.run.status === "done") return EXIT.done;
  return outcome.run.status === "cancelled" ? EXIT.interrupted : EXIT.failed;
}

/** Ctrl+C once stops the run, like the app's Stop; twice exits at once. */
export function createInterrupt(err: Write, exit: (code: number) => void) {
  let interrupted = false;
  return {
    interrupted: () => interrupted,
    onInterrupt: () => {
      if (interrupted) exit(EXIT.interrupted);
      interrupted = true;
      err("Stopping the run… (press Ctrl+C again to exit now)");
    },
  };
}

/** harness-core: --core, then HARNESS_CORE, then this repo's release build. */
export function corePath(flag: string | undefined, env: Record<string, string | undefined>, platform: string): string {
  if (flag) return resolve(flag);
  if (env.HARNESS_CORE) return resolve(env.HARNESS_CORE);
  const exe = platform === "win32" ? "harness-core.exe" : "harness-core";
  return fileURLToPath(new URL(`../../src-tauri/target/release/${exe}`, import.meta.url).href);
}

/** The workflow file, checked with the app's schema; or what is wrong with it. */
function loadWorkflow(file: string): { def: WorkflowDef } | { error: string } {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, "utf8"));
  } catch (e) {
    return { error: `cannot read ${file}: ${String(e)}` };
  }
  const checked = workflowDefSchema.safeParse(raw);
  if (!checked.success) {
    const issues = checked.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    return { error: `${file} is not a valid workflow:\n${issues}` };
  }
  return { def: checked.data as WorkflowDef };
}

/** `harness run <workflow> …`; returns the exit code. */
export async function runHarness(argv: string[]): Promise<number> {
  const out: Write = (line) => { process.stdout.write(`${line}\n`); };
  const err: Write = (line) => { process.stderr.write(`${line}\n`); };
  if (argv.includes("--help") || argv.includes("-h")) {
    out(RUN_USAGE);
    return EXIT.done;
  }
  const parsed = parseRunArgs(argv);
  if ("error" in parsed) {
    err(`harness run: ${parsed.error}\n\n${RUN_USAGE}`);
    return EXIT.usage;
  }
  const args = parsed.args;
  const loaded = loadWorkflow(args.workflow);
  if ("error" in loaded) {
    err(`harness run: ${loaded.error}`);
    return EXIT.usage;
  }
  let task: string;
  try {
    task = args.task ?? readFileSync(args.taskFile ?? "", "utf8");
  } catch (e) {
    err(`harness run: cannot read the task file: ${String(e)}`);
    return EXIT.usage;
  }
  const workspacePath = resolve(args.workspace ?? ".");
  if (!existsSync(workspacePath)) {
    err(`harness run: the workspace ${workspacePath} does not exist`);
    return EXIT.usage;
  }
  const graph = defToGraph(loaded.def);
  if (args.maxParallel) graph.executionSettings = { ...graph.executionSettings, maxParallel: args.maxParallel };
  const validation = validateWorkflow(graph.nodes, graph.edges);
  for (const warning of validation.warnings) err(`warning: ${warning.message}`);
  if (!validation.valid) {
    for (const problem of validation.errors) err(`harness run: ${problem.message}`);
    return EXIT.usage;
  }

  const coreFile = corePath(args.core, process.env, process.platform);
  if (!existsSync(coreFile)) {
    err(`harness run: harness-core not found at ${coreFile}. Build it with npm run build:core, or pass --core <path>.`);
    return EXIT.notStarted;
  }
  // A JavaScript core (the tests' fake) runs with node.
  const core = /\.[cm]?js$/.test(coreFile) ? startCore(process.execPath, [coreFile]) : startCore(coreFile);
  try {
    await core.invoke("get_provider_defaults");
  } catch (e) {
    err(`harness run: harness-core did not answer: ${String(e)}`);
    await core.close(1000);
    return EXIT.notStarted;
  }

  const stop = createInterrupt(err, (code) => process.exit(code));
  process.on("SIGINT", stop.onInterrupt);
  const reporter = createReporter(graph, args.json, out, err);
  const allowed = new Set(args.allowCommands);
  const host: RunHost = {
    invoke: core.invoke,
    events: reporter.events,
    // The user allowed these exact commands up front; every other command is denied.
    askCommand: async ({ command }) => (allowed.has(command.trim()) ? "granted" : "deny"),
    commandPolicy: "--allow-command",
    isCancelled: stop.interrupted,
    revealOutput: false,
  };
  const started = Date.now();
  try {
    const outcome = await runWorkflow({
      graph,
      config: { userInput: task, contextFilePaths: [], thinkDepthOverride: null, providerOverride: null },
      provider: providerSettings(args, process.env),
      workspacePath,
      continueOnError: args.continueOnError,
    }, host);
    reporter.summary(outcome, Date.now() - started);
    if (core.stopped()) err("harness run: harness-core stopped during the run.");
    return exitCode(outcome, core.stopped());
  } finally {
    process.off("SIGINT", stop.onInterrupt);
    await core.close();
  }
}
```

- [ ] **Step 5: `cli/harness.mjs`**

Change the header comment:

```js
/**
 * harness-cli — command line for Harness Studio
 *
 * Usage:
 *   node cli/harness.mjs project status                   [--workspace <path>]
 *   node cli/harness.mjs workflow validate <path>
 *   node cli/harness.mjs provider list                    [--json]
 *   node cli/harness.mjs run <workflow> --task "…"        (see run --help)
 *
 * project, workflow and provider are read-only: no Tauri runtime, no API calls.
 * Their schemas are duplicated from src/schemas/ — see comments marked [KEEP-IN-SYNC].
 *
 * run executes a workflow headless (docs/HEADLESS.md): model calls, workspace
 * files, and only the agent commands passed with --allow-command. It loads
 * cli/dist/harness-run.mjs (npm run build:cli) and needs harness-core (npm run build:core).
 */
```

Add before the Router section:

```js
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
```

In the router, before `if (cmd === "project" && sub === "status") {`:

```js
if (args[0] === "run") {
  process.exitCode = await cmdRun(args.slice(1));
} else if (cmd === "project" && sub === "status") {
```

(The existing `if (cmd === "project" …` line becomes the `else if`.) In the usage text, add under Commands:

```
  run <workflow> --task "…"           Run a workflow headless (run --help for options)
```

- [ ] **Step 6: Tests pass**

Run: `npx vitest run tests/unit/cli && npx tsc --noEmit`
Expected: every CLI test passes: the existing `harnessCli` and `cliValidate`, plus `runArgs`, `coreClient`, `report`, `runCli` and `harnessRun`.

If `harnessRun` fails while loading the bundle, run `node cli/harness.mjs run --help` to see the Node error. A module that touches `window`, `document` or `localStorage` at import is the likely cause.

- [ ] **Step 7: Commit**

```bash
git add src/cli/runCli.ts src/cli/tauriShim.ts vite.cli.config.ts package.json cli/harness.mjs tests/unit/cli/runCli.test.ts tests/unit/cli/harnessRun.test.ts
git commit -m "Add harness run: headless workflow runs through harness-core, bundled for Node"
```

---

### Task 6: Rules, the real core, full verification

**Files:** `AGENT.md`

- [ ] **Step 1: AGENT.md**

Rule 4 becomes:

```md
4. The CLI's `project`, `workflow` and `provider` commands stay read-only, and MCP stays limited to read/test tools. `harness run` executes workflows: agent commands run only if the user passed that exact command with `--allow-command`, and every command is audited.
```

Rule 6 becomes:

```md
6. Do not add command execution without the user's approval of that exact command: once, as a run grant the user chose (agent `bash` goes through `commandConsentStore`), or up front with `harness run --allow-command`. Never auto-approve anything else.
```

The Key Files row `| cli/harness.mjs | Read-only CLI |` becomes:

```md
| `cli/harness.mjs` | CLI: read-only commands, and `run` (headless runs: `src/cli/`, needs `npm run build:cli` and `npm run build:core`) |
```

- [ ] **Step 2: The real harness-core, through the real CLI**

Run with no OpenAI key, so the preflight stops before any network call:

```bash
npm run build:cli && OPENAI_API_KEY= node cli/harness.mjs run examples/purchasing-decision.harness.yaml --task "Pick a laptop" --provider openai; echo "exit $?"
```

Expected:
- The default core, `src-tauri/target/release/harness-core.exe` from Part 2, answers the handshake.
- The engine's preflight reports `the run did not start: No API key for the selected provider…`.
- `exit 3`.

- [ ] **Step 3: Full verification**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | tail -4 && npm run build 2>&1 | tail -2`
Expected:
- No type errors.
- All tests pass: 611 plus Part 3's (4 engine and command tool, 16 `runArgs`, 4 `coreClient`, 4 `report`, 3 `runCli`, 6 `harnessRun`).
- The app build passes.

- [ ] **Step 4: Commit:** `git add AGENT.md && git commit -m "AGENT.md: harness run's command policy in the rules"`

---

## Spec coverage (Part 3)

| Spec §3 requirement | Where |
|---|---|
| `node cli/harness.mjs run <workflow>` / `npm run harness -- run` | Task 5, Step 5 |
| `--task`/`--task-file`, `--workspace`, `--provider`, `--base-url`, `--model`, `--max-parallel`, `--continue-on-error`, `--json`, `--core`/`HARNESS_CORE` | Task 2; `corePath` in Task 5 |
| keys from the environment only (no key flag) | Task 2 `providerSettings`, design note 1 |
| exact-match `--allow-command` → `granted`, else `deny`, with the audit wording | Task 1 (policy), Task 5 (host) |
| the engine's command checks still apply | unchanged `runCommandTool` checks |
| human lines + summary; `--json` events, nothing else on stdout | Task 4; the end-to-end `--json` test |
| exit codes 0/1/2/3/130 | `exitCode` (Task 5) and the end-to-end tests |
| Ctrl+C: Stop, then exit | `createInterrupt` (Task 5) |
| Vite SSR bundle, no new dependency, loaded by `cli/harness.mjs` | Task 5, Steps 3 and 5 |
| core client; "harness-core stopped" on death | Task 3 |
| review notes: Tauri shim, run the built bundle in Node, skip the reveal | Tasks 1 and 5 |
| `--resume` | Part 4 |
