/**
 * runWorkflow — the multi-agent workflow run engine.
 *
 * 1. AGENT CHAINING   — upstream agent outputs are passed as context to downstream agents
 * 2. MEMORY           — memoryRead/memoryWrite keys persist values across agents per run
 * 3. TOOL EXECUTION   — the node's tools run through agentLoop.ts (native tool calls, <tool_call>
 *                       fallback); subagent_dispatch starts helper agents (subAgents.ts)
 * 4. GATEWAY ROUTING  — gateway JSON output determines which downstream branch to follow
 * 5. MEMORY NODES     — aggregate upstream outputs into memory keys (no LLM call needed)
 * 6. PARALLEL EXEC    — independent branches run concurrently up to executionSettings.maxParallel
 *
 * Plain TypeScript with no React, UI stores or Tauri, so it can run outside the
 * app. The host runs the Rust commands, gets the run as events, approves shell
 * commands and says when the run is stopped. The app's host is in
 * hooks/useWorkflowExecution.ts.
 */

import { AgentRole, type AgentNodeData, type HookConfig } from "@/types/agent";
import type { AuditEntry } from "@/types/audit";
import type { AgentRun, SubAgentRecord, WorkflowRun } from "@/types/execution";
import type { HookResult } from "@/types/hookResult";
import type { WorkflowRunConfig } from "@/types/workflowRunConfig";
import type { CommandApproval, CommandRequest } from "@/store/commandConsentStore";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import {
  definitionHash, RUN_RECORD_VERSION, reusableNodes, savedHookScripts, savedNodeId, UNVERIFIABLE_HOOK, type RunRecord,
} from "@/engine/runRecord";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  isBillingRelatedError,
  isOllamaCloudUrl,
  isRemoteOllamaUrl,
  selectProviderForModel,
  shouldFallbackToOllama,
  type LlmProvider,
  type RuntimeProvider,
} from "@/utils/providerConfig";
import {
  callChatTurn,
  callProvider,
  buildSystemMessage,
  estimateTokens,
  resolveModel,
  REASONING_EFFORT,
  isReasoningModel,
  type ChatMessage,
  type InvokeFn,
} from "@/services/model-providers/providerAdapter";
import { MemoryService } from "@/services/execution/memoryService";
import {
  executeTool,
  runnableTools,
  type ToolCall,
  type ToolSpec,
} from "@/services/execution/toolExecutor";
import { beforeDeadline, runAgentLoop } from "@/services/execution/agentLoop";
import { runCommandTool } from "@/services/execution/commandTool";
import { findChange, recordChange } from "@/services/execution/changeLog";
import { SUMMARY_INSTRUCTIONS } from "@/services/execution/compaction";
import { loadProjectInstructions, usesWorkspace } from "@/services/execution/projectInstructions";
import {
  createSubAgentRunner,
  MAX_CONCURRENT_SUBAGENTS,
  SUBAGENT_TOOL,
} from "@/services/execution/subAgents";
import { prunedNodes, runParallel } from "@/services/execution/parallelScheduler";
import {
  firedFeedbackEdges,
  MAX_REVISION_ROUNDS,
  parseGatewayRoute,
  revisionPath,
} from "@/services/execution/routing";
import { resolvePromptContent } from "@/services/execution/promptSource";
import { entryAgentIds } from "@/services/execution/entryNodes";

// ── Run input and host ────────────────────────────────────────────────────────

/** Provider settings for a run: the fields of the app's executionStore. */
export interface ProviderSettings {
  llmProvider: LlmProvider;
  /** Anthropic key. */
  apiKey: string;
  openaiApiKey: string;
  ollamaApiKey: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  customApiUrl: string;
  customApiKey: string;
  /** The model every agent uses on the Custom endpoint; empty: each agent's own model. */
  customApiModel: string;
  /** Ollama's context window in tokens, sent as num_ctx on every Ollama call of the run (0: none is
   *  sent, the server's default stands). One value for the whole run: Ollama reloads the model
   *  whenever it changes. */
  ollamaNumCtx: number;
  /** Seconds one model call may take in total. */
  requestTimeoutSecs: number;
}

export interface RunInput {
  graph: WorkflowGraph;
  config: WorkflowRunConfig;
  provider: ProviderSettings;
  /** Agents' file tools, commands and hooks work only inside it. */
  workspacePath: string | null;
  continueOnError: boolean;
  /** The workflow file the graph came from, for the run record (harness run: its path and SHA-256). */
  workflowFile?: { path: string | null; hash: string | null };
  /** A saved run to resume (harness run --resume): same run id; unchanged finished nodes are reused. */
  resume?: RunRecord;
}

/** A node that finished, for the app's context snapshots. */
export interface NodeSnapshot {
  runId: string;
  nodeId: string;
  status: "completed" | "failed";
  output: string;
  error?: string;
}

export interface RunEvents {
  onRunStarted: (runId: string, workflowName: string) => void;
  onAgentUpdate: (nodeId: string, partial: Partial<AgentRun>) => void;
  /** The canvas node's status, with its token count when it finishes. */
  onNodeStatus: (nodeId: string, status: AgentNodeData["status"], tokens?: { used: number; budget: number }) => void;
  onAudit: (entry: AuditEntry) => void;
  /** An agent changed a workspace file (fs.write, fs.append, edit_file). */
  onFileChange: (path: string, before: string | null, after: string, agent: string) => void;
  /** The run is over. The host must deny commands still waiting for approval. */
  onRunFinished: (status: "done" | "error" | "cancelled") => void;
}

export interface RunHost {
  /** Runs a Rust command by name, with the app's IPC arguments. */
  invoke: InvokeFn;
  events: RunEvents;
  /** Approves an agent's shell command, or not (in the app: the user). */
  askCommand: (request: Omit<CommandRequest, "id">) => Promise<CommandApproval>;
  /** True once the run is stopped. Asked only after onRunStarted. */
  isCancelled: () => boolean;
  snapshot?: (snapshot: NodeSnapshot) => void;
  /** Who approves commands when it is not the user (harness run: "--allow-command"). */
  commandPolicy?: string;
  /** false: no progressive reveal of each final answer (the app shows one; harness run does not). */
  revealOutput?: boolean;
  /** Saves the run record (.harness/runs/<id>/run.json) after the start, after each node and at the end.
   *  A failure is reported once; the run goes on. */
  saveRun?: (record: RunRecord) => Promise<void>;
}

/** A run that never started (the provider preflight failed), or the finished run.
 *  `error` on a finished run: it failed as a whole ("Run failed: …", a cycle or
 *  blocked dependencies). A node's own failure is on the node, not here. */
export type RunOutcome =
  | { started: false; error: string }
  | { started: true; run: WorkflowRun; error?: string };

// ── Edge helpers ──────────────────────────────────────────────────────────────

type EdgeData = { label?: string; edgeKind?: string };

export function isFeedbackEdge(edge: { type?: string; data?: unknown }): boolean {
  return (edge.data as EdgeData | undefined)?.edgeKind === "feedback" || edge.type === "feedback";
}

function edgeLabel(edge: { label?: unknown; data?: unknown }): string | undefined {
  const dataLabel = (edge.data as EdgeData | undefined)?.label;
  if (typeof dataLabel === "string") return dataLabel;
  return typeof edge.label === "string" ? edge.label : undefined;
}

// ── Provider types ────────────────────────────────────────────────────────────

interface ProviderHealth {
  ok: boolean; provider: string; latency_ms: number;
  message: string; model_available: boolean; pull_command: string | null;
}

interface ProviderDefaults {
  llm_provider: LlmProvider; ollama_base_url: string; ollama_model: string;
  openai_api_key_configured: boolean; anthropic_api_key_configured: boolean;
  ollama_api_key_configured: boolean; suggested_ollama_models: string[];
}

const FALLBACK_DEFAULTS: ProviderDefaults = {
  llm_provider: "auto", ollama_base_url: DEFAULT_OLLAMA_BASE_URL,
  ollama_model: DEFAULT_OLLAMA_MODEL, openai_api_key_configured: false,
  anthropic_api_key_configured: false, ollama_api_key_configured: false,
  suggested_ollama_models: [],
};

function isExecutable(role: AgentRole): boolean {
  return role !== AgentRole.Memory && role !== AgentRole.Hook;
}

// ── Health checks ─────────────────────────────────────────────────────────────

async function runHealthChecks(
  invoke: InvokeFn,
  openaiKey: string, anthropicKey: string,
  ollamaUrl: string, ollamaModel: string, ollamaKey: string,
  ollamaProvider: Extract<RuntimeProvider, "ollama" | "ollama-cloud">,
  customUrl: string, customKey: string, customModel: string,
  /** The providers local Ollama is probed for as the billing fallback only (not used by the run). */
  ollamaFallbackFor: string[],
  addEntry: (entry: AuditEntry) => void,
): Promise<ProviderHealth[]> {
  const checks: Promise<ProviderHealth>[] = [];
  if (openaiKey) {
    checks.push(invoke<ProviderHealth>("check_provider_health", {
      provider: "openai", apiKey: openaiKey, baseUrl: "", model: "",
    }).catch((e): ProviderHealth => ({ ok: false, provider: "openai", latency_ms: 0, message: String(e), model_available: false, pull_command: null })));
  }
  if (anthropicKey) {
    checks.push(invoke<ProviderHealth>("check_provider_health", {
      provider: "anthropic", apiKey: anthropicKey, baseUrl: "", model: "",
    }).catch((e): ProviderHealth => ({ ok: false, provider: "anthropic", latency_ms: 0, message: String(e), model_available: false, pull_command: null })));
  }
  if (ollamaUrl) {
    checks.push(invoke<ProviderHealth>("check_provider_health", {
      provider: ollamaProvider, apiKey: ollamaKey, baseUrl: ollamaUrl, model: ollamaModel,
    }).catch((e): ProviderHealth => ({
      ok: false,
      provider: ollamaProvider,
      latency_ms: 0,
      message: String(e),
      model_available: false,
      pull_command: ollamaProvider === "ollama" ? `ollama pull ${ollamaModel}` : null,
    })));
  }
  if (customUrl) {
    checks.push(invoke<ProviderHealth>("check_provider_health", {
      provider: "openai-compatible", apiKey: customKey, baseUrl: customUrl, model: customModel,
    }).catch((e): ProviderHealth => ({ ok: false, provider: "openai-compatible", latency_ms: 0, message: String(e), model_available: false, pull_command: null })));
  }
  const results = await Promise.all(checks);
  for (const h of results) {
    // A fallback that is down is a warning: the run does not need it.
    const fallbackDown = !h.ok && h.provider === ollamaProvider && ollamaFallbackFor.length > 0;
    // A server that answers but lacks the model says "… not found" and how to pull it.
    const why = h.pull_command && h.message.includes("not found")
      ? `model ${ollamaModel} is not pulled at ${ollamaUrl} (run: ${h.pull_command})`
      : `not available at ${ollamaUrl}`;
    addEntry({
      id: `health-${h.provider}-${Date.now()}`, timestamp: new Date().toISOString(),
      action: "provider_check", agentId: "system",
      details: fallbackDown
        ? `⚠ ${h.provider} — ${why}, so a billing error from ` +
          `${ollamaFallbackFor.join(" or ")} cannot fall back to local Ollama`
        : `${h.ok ? "✓" : "⚠"} ${h.provider} — ${h.message}`,
      success: h.ok || fallbackDown, warning: fallbackDown,
    });
  }
  return results;
}

// ── Engine ────────────────────────────────────────────────────────────────────

export async function runWorkflow(input: RunInput, host: RunHost): Promise<RunOutcome> {
  const { nodes, edges, meta, executionSettings } = input.graph;
  const { config, workspacePath, continueOnError } = input;
  const {
    apiKey, openaiApiKey, ollamaApiKey, customApiUrl, customApiKey, customApiModel,
    llmProvider, ollamaBaseUrl, ollamaModel, ollamaNumCtx, requestTimeoutSecs,
  } = input.provider;
  const invoke = <T>(cmd: string, args?: Record<string, unknown>) => host.invoke<T>(cmd, args);
  // Every audit entry of the run, for its record; a resumed run continues the saved list.
  const auditLog: AuditEntry[] = [...(input.resume?.audit ?? [])];
  const addEntry = (entry: AuditEntry) => {
    auditLog.push(entry);
    host.events.onAudit(entry);
  };
  // Async like the IPC wrappers they stand in for: a synchronous throw still rejects.
  const readWorkspaceFile = async (ws: string, relativePath: string) =>
    invoke<string>("read_workspace_file", { workspacePath: ws, relativePath });
  const writeAuditEntry = async (ws: string, entry: AuditEntry) =>
    invoke<void>("write_audit_entry", { workspacePath: ws, entry });

  // ── Resolve provider settings ────────────────────────────────────────────
  const providerDefaults = await invoke<ProviderDefaults>("get_provider_defaults")
    .catch(() => FALLBACK_DEFAULTS);
  const activeProvider   = config.providerOverride ?? llmProvider;
  const effectiveProvider =
    activeProvider === "auto" && providerDefaults.llm_provider !== "auto"
      ? providerDefaults.llm_provider : activeProvider;
  const effectiveOllamaUrl   = ollamaBaseUrl || providerDefaults.ollama_base_url || DEFAULT_OLLAMA_BASE_URL;
  const effectiveOllamaModel = resolveModel(
    ollamaModel || providerDefaults.ollama_model || DEFAULT_OLLAMA_MODEL
  );
  const ollamaProviderType: Extract<RuntimeProvider, "ollama" | "ollama-cloud"> =
    effectiveProvider === "ollama-cloud" || isRemoteOllamaUrl(effectiveOllamaUrl)
      ? "ollama-cloud" : "ollama";

  const hasOpenAIKey    = Boolean(openaiApiKey || providerDefaults.openai_api_key_configured);
  const hasAnthropicKey = Boolean(apiKey       || providerDefaults.anthropic_api_key_configured);
  const hasOllamaKey    = Boolean(ollamaApiKey || providerDefaults.ollama_api_key_configured);

  // Guard: missing key for explicitly chosen hosted provider
  const missingKey =
    (effectiveProvider === "openai"       && !hasOpenAIKey)    ||
    (effectiveProvider === "anthropic"    && !hasAnthropicKey)  ||
    (effectiveProvider === "ollama-cloud" && !hasOllamaKey && isOllamaCloudUrl(effectiveOllamaUrl));
  if (missingKey) {
    return { started: false, error: "No API key for the selected provider. Add one in Settings or switch to Ollama." };
  }

  // Guard: custom endpoint mode selected but no URL configured
  if (effectiveProvider === "openai-compatible" && !customApiUrl.trim()) {
    return { started: false, error: "Custom endpoint URL is not configured. Add it in Settings → Custom Endpoint." };
  }

  // A Hook node's script path, or undefined for any other node (or with no workspace open).
  const hookScriptPath = (n: (typeof nodes)[number]): string | undefined =>
    workspacePath && n.data.role === AgentRole.Hook ? n.data.preHook?.path || undefined : undefined;

  const requiredProviders = new Set<RuntimeProvider>();
  for (const node of nodes) {
    if (!isExecutable(node.data.role)) continue;
    const sel = selectProviderForModel({
      mode: effectiveProvider, model: node.data.model || "qwen2.5-coder:7b",
      hasOpenAIKey, hasAnthropicKey, ollamaModel: effectiveOllamaModel,
    });
    requiredProviders.add(sel.provider === "ollama" ? ollamaProviderType : sel.provider);
  }

  // The model an agent sends to the Custom endpoint: the Custom model setting when there is one (the
  // app's field, harness run's --model), else the agent's own. The preflight probes the first agent's,
  // so it asks the server for a model the run really uses, and never one of ours.
  const customModelFor = (data: AgentNodeData) => customApiModel || data.model || "";
  const firstAgent = nodes.find((n) => isExecutable(n.data.role));
  const customProbeModel = firstAgent ? customModelFor(firstAgent.data) : customApiModel;

  // Health checks — never contact a hosted provider this run will not use. Local
  // Ollama is probed when the run uses it, or as the billing fallback of OpenAI and
  // Anthropic (a Custom endpoint never falls back).
  const usesOllama = requiredProviders.has(ollamaProviderType);
  const fallbackFor = (["openai", "anthropic"] as const)
    .filter((p) => requiredProviders.has(p))
    .map((p) => (p === "openai" ? "OpenAI" : "Anthropic"));
  const probeOllama = usesOllama || (fallbackFor.length > 0 && !isRemoteOllamaUrl(effectiveOllamaUrl));
  const healthResults = await runHealthChecks(
    invoke,
    requiredProviders.has("openai") ? openaiApiKey : "",
    requiredProviders.has("anthropic") ? apiKey : "",
    probeOllama ? effectiveOllamaUrl : "", effectiveOllamaModel,
    ollamaApiKey, ollamaProviderType,
    requiredProviders.has("openai-compatible") ? customApiUrl : "",
    customApiKey, customProbeModel, usesOllama ? [] : fallbackFor, addEntry,
  );
  const healthMap   = new Map(healthResults.map((h) => [h.provider, h]));
  const ollamaHealth = healthMap.get(ollamaProviderType);
  const ollamaReady  = Boolean(ollamaHealth?.ok && ollamaHealth.model_available);

  for (const prov of requiredProviders) {
    if (prov === "ollama" || prov === "ollama-cloud") {
      if (!ollamaReady) {
        const pull = ollamaHealth?.pull_command ? `\nRun: ${ollamaHealth.pull_command}` : "";
        return { started: false, error: `${ollamaHealth?.message ?? "Ollama not reachable."}${pull}` };
      }
      continue;
    }
    const h = healthMap.get(prov);
    if (h && !h.ok) {
      if (isBillingRelatedError(h.message) && ollamaReady) continue;
      return { started: false, error: h.message };
    }
  }

  // ── Pre-read context files ────────────────────────────────────────────────
  let contextFileContent = "";
  if (config.contextFilePaths.length > 0 && workspacePath) {
    const parts = await Promise.all(
      config.contextFilePaths.map((p) =>
        readWorkspaceFile(workspacePath, p)
          .then((t) => `--- ${p} ---\n${t}`)
          .catch(() => `--- ${p} --- (not found)`),
      ),
    );
    contextFileContent = parts.join("\n\n");
  }

  // ── Project instructions (AGENTS.md at the workspace root) ─────────────────
  const projectInstructions = workspacePath
    ? await loadProjectInstructions((path) => readWorkspaceFile(workspacePath, path))
    : "";
  if (projectInstructions) {
    addEntry({ id: `agents-md-${Date.now()}`, timestamp: new Date().toISOString(), action: "file_read",
      path: "AGENTS.md", success: true,
      details: `Project instructions: AGENTS.md (${projectInstructions.length.toLocaleString()} chars)` });
  }

  // What shapes each node's work, for the record and for resume.
  const hashes = new Map<string, string>();
  for (const n of nodes) {
    const prompt = await resolvePromptContent(n.data.promptSource, workspacePath, readWorkspaceFile)
      .catch((e) => `unreadable: ${String(e)}`);
    hashes.set(n.id, definitionHash(n.data, prompt));
  }

  // ── Per-run runtime state ─────────────────────────────────────────────────
  const memory        = new MemoryService();
  const agentOutputs  = new Map<string, string>(); // nodeId → output text
  const gatewayRoutes = new Map<string, string>(); // gatewayId → chosen route
  const noNativeTools = new Set<string>();         // "provider:model" that refused native tools
  const noStreaming   = new Set<string>();         // "provider:model" that could not stream
  const contextWarned = new Set<string>();         // node ids already told their prompt may not fit Ollama's context window
  // Feedback-edge target → the review it is being re-run for.
  const revisionRequests = new Map<string, { from: string; text: string; reviewed: string; round: number }>();

  const entryIds = entryAgentIds(nodes, edges);
  const isEntryNode = (id: string) => entryIds.has(id);

  // "[From: name → label]\noutput" for each forward input of nodeId that has output.
  const inputsOf = (nodeId: string, skip: ReadonlySet<string> = new Set()) => {
    const parts: string[] = [];
    for (const e of edges) {
      if (e.target !== nodeId || isFeedbackEdge(e) || skip.has(e.source)) continue;
      const out = agentOutputs.get(e.source);
      if (!out) continue;
      const srcName = nodes.find((n) => n.id === e.source)?.data.name ?? e.source;
      const labelText = edgeLabel(e);
      parts.push(`[From: ${srcName}${labelText ? ` → ${labelText}` : ""}]\n${out}`);
    }
    return parts;
  };

  const runId = input.resume?.runId ?? `run-${Date.now()}`;
  const attempts = (input.resume?.attempts ?? 0) + 1;
  const run: WorkflowRun = { id: runId, workflowName: meta.name, startedAt: Date.now(), status: "running", agents: {} };
  host.events.onRunStarted(runId, meta.name);
  const isRunCancelled = () => host.isCancelled();
  // The engine's record of the run; the host gets every change as an event.
  const updateAgent = (nodeId: string, partial: Partial<AgentRun>) => {
    run.agents[nodeId] = { ...(run.agents[nodeId] ?? { agentId: nodeId, agentName: nodeId, status: "idle" }), ...partial };
    host.events.onAgentUpdate(nodeId, partial);
  };
  const updateNodeData = (nodeId: string, data: { status: AgentNodeData["status"]; tokens?: { used: number; budget: number } }) =>
    host.events.onNodeStatus(nodeId, data.status, data.tokens);
  for (const n of nodes) updateNodeData(n.id, { status: "idle" });

  // Resume: nodes saved as done, unchanged and fed only by reused nodes keep their
  // saved results; the change log and the audit continue.
  const reused = input.resume ? reusableNodes(input.graph, input.resume, hashes) : new Set<string>();
  if (input.resume) {
    const saved = input.resume;
    run.changes = saved.changes;
    nodes.forEach((n, i) => {
      if (!reused.has(n.id)) return;
      agentOutputs.set(n.id, saved.outputs[savedNodeId(i)] ?? saved.nodes[savedNodeId(i)]?.output ?? "");
      for (const key of n.data.memoryWrite) {
        if (key in saved.memory) memory.write(key, saved.memory[key], n.id);
      }
      const route = saved.gatewayRoutes[savedNodeId(i)];
      if (route) gatewayRoutes.set(n.id, route);
    });
  }
  // A reused node shows its saved result, as if it had just run.
  const showReused = (nodeId: string) => {
    const i = nodes.findIndex((n) => n.id === nodeId);
    const saved = input.resume?.nodes[savedNodeId(i)];
    if (!saved) return;
    addEntry({ id: `${nodeId}-reused-${Date.now()}`, timestamp: new Date().toISOString(), action: "agent_reused",
      agentId: nodeId, success: true, details: `↩ ${nodes[i].data.name}: reused from the saved run (unchanged)` });
    updateAgent(nodeId, {
      agentId: nodeId, agentName: nodes[i].data.name, status: "done", output: saved.output,
      startedAt: saved.startedAt, finishedAt: saved.finishedAt, modelUsed: saved.modelUsed,
      providerUsed: saved.providerUsed, tokenEstimate: saved.tokenEstimate, revision: saved.revision,
      subAgents: saved.subAgents,
    });
    updateNodeData(nodeId, { status: "done" });
  };

  // ── Hooks, as the run first started ───────────────────────────────────────
  // A Hook node without requireConsent runs its script unasked, so it must run the script
  // that was set up, with the env that was set up (the backend applies preHook.env as it is:
  // a BASH_ENV or PATH in it changes what the script runs, and an agent can edit the workflow
  // file). An agent's file tools leave a change log, but a shell command it ran (bash), a link
  // or another spelling of the path change the file without one. So every hook node's script
  // and env are fingerprinted when the run first starts, and an unasked hook's again just
  // before it runs: any difference refuses it. The fingerprint is harness-core's
  // (hook_fingerprint: a SHA-256 of the script's bytes and of the env, so a script that is not
  // UTF-8 counts too; the text is not kept), and execute_hook is given the one that was checked
  // and verifies it again itself right before it starts the script.
  // The record's hookScripts keeps the fingerprints and a resume carries them on as they
  // are, so a change made during an earlier attempt never becomes a later attempt's
  // baseline. Consent-required hooks have one too: editing the workflow file to drop the
  // requirement (an agent can write that file) does not start a new baseline. Only an attempt
  // with none to start from (a new run, or a record from before hookScripts) takes baselines;
  // a resume adds none. So an unasked hook with no baseline (a node added to the workflow
  // since) is refused, as is one whose script or env is not the one that was fingerprinted;
  // the way on is the Hooks tab or a new run. The record itself is trusted: the agents' file
  // tools cannot write it (isProtectedPath), but a shell command can.
  // A baseline is a fingerprint; null (there was no such script); or UNVERIFIABLE_HOOK, when
  // harness-core could not say (the script cannot be read, or it is older than the app and does
  // not have hook_fingerprint), which nothing matches. A failed fingerprint never fails the run.
  // The record keeps only that marker. The text of the error behind it is kept in this attempt
  // alone (whyUnverifiable), for the refusal: a resume that carries the marker on has none.
  /** The text of harness-core's error when it could not fingerprint a hook, by node key: the last
   *  call's, so a call that then answers clears it. */
  const whyUnverifiable = new Map<string, string>();
  /** What harness-core says the fingerprint of a hook's script and env is: a string; null when
   *  there is no such script; UNVERIFIABLE_HOOK when it cannot say (it failed, or did not answer
   *  with a fingerprint or null). */
  const fingerprintHook = async (key: string, ws: string, path: string, env: HookConfig["env"]): Promise<string | null> => {
    whyUnverifiable.delete(key);
    try {
      const fingerprint = await invoke<unknown>("hook_fingerprint", { workspacePath: ws, hookPath: path, env });
      return fingerprint === null || (typeof fingerprint === "string" && fingerprint !== "") ? fingerprint : UNVERIFIABLE_HOOK;
    } catch (e) {
      whyUnverifiable.set(key, String(e));
      return UNVERIFIABLE_HOOK;
    }
  };
  // By node key.
  const savedScripts = savedHookScripts(input.resume);
  const hookScripts: Record<string, string | null> = { ...savedScripts };
  if (savedScripts === undefined && workspacePath) {
    await Promise.all(nodes.map(async (n, i) => {
      const path = hookScriptPath(n);
      const key = savedNodeId(i);
      if (path) hookScripts[key] = await fingerprintHook(key, workspacePath, path, n.data.preHook?.env);
    }));
  }
  /** What a hook that runs without asking may do now: it is refused, with the reason (the node
   *  fails with it), or it runs, and execute_hook is given this fingerprint to verify. */
  type HookCheck = { refusal: string } | { fingerprint: string };
  const checkUnattendedHook = async (nodeId: string, ws: string, hook: HookConfig): Promise<HookCheck> => {
    const key = savedNodeId(nodes.findIndex((n) => n.id === nodeId));
    if (!Object.prototype.hasOwnProperty.call(hookScripts, key)) {
      return { refusal: `Hook script ${hook.path} has no baseline from this run's first attempt, so it is not run unasked; ` +
        "run it from the Hooks tab or start a new run." };
    }
    // Says why in harness-core's own words when it gave any (a path outside the workspace, a folder,
    // a permission error); a baseline saved by an earlier attempt has none.
    const unverifiable = () => ({ refusal: `Hook script ${hook.path} could not be checked (` +
      (whyUnverifiable.get(key) || "the script could not be read, or harness-core is older than the app") +
      "), so it is not run unasked; run it from the Hooks tab or start a new run." });
    const baseline = hookScripts[key];
    if (baseline === UNVERIFIABLE_HOOK) return unverifiable();
    const now = await fingerprintHook(key, ws, hook.path, hook.env);
    if (now === UNVERIFIABLE_HOOK) return unverifiable();
    if (baseline === null && now === null) {
      // Not there as the run started, and still not: there is nothing to run, so nothing is started.
      return { refusal: `Hook script ${hook.path} was not found in the workspace, so it was not run.` };
    }
    // A script that appeared (baseline null) or went (now null) counts as changed, and so does its env.
    if (baseline === null || now !== baseline) {
      return { refusal: `Hook script ${hook.path} or its environment was changed during this run; ` +
        "review it, then run it from the Hooks tab or start a new run." };
    }
    return { fingerprint: baseline };
  };

  const buildRecord = (): RunRecord => ({
    version: RUN_RECORD_VERSION,
    runId,
    workflow: { name: meta.name, path: input.workflowFile?.path ?? null, hash: input.workflowFile?.hash ?? null },
    task: config.userInput,
    provider: { llmProvider, ollamaBaseUrl, ollamaModel, customApiUrl, customApiModel, ollamaNumCtx },
    status: run.status,
    startedAt: input.resume?.startedAt ?? run.startedAt,
    finishedAt: run.finishedAt,
    attempts,
    nodes: Object.fromEntries(nodes.map((n, i) => {
      const agent = run.agents[n.id];
      return [savedNodeId(i), {
        agent: n.data.name, status: agent?.status ?? "idle", output: agent?.output, error: agent?.error,
        startedAt: agent?.startedAt, finishedAt: agent?.finishedAt, modelUsed: agent?.modelUsed,
        providerUsed: agent?.providerUsed, tokenEstimate: agent?.tokenEstimate, revision: agent?.revision,
        subAgents: agent?.subAgents, definitionHash: hashes.get(n.id) ?? "",
      }];
    })),
    outputs: Object.fromEntries(nodes.flatMap((n, i) => {
      const output = agentOutputs.get(n.id);
      return output === undefined ? [] : [[savedNodeId(i), output]];
    })),
    memory: memory.dump(),
    gatewayRoutes: Object.fromEntries(nodes.flatMap((n, i) => {
      const route = gatewayRoutes.get(n.id);
      return route === undefined ? [] : [[savedNodeId(i), route]];
    })),
    changes: run.changes ?? [],
    audit: [...auditLog],
    hookScripts: { ...hookScripts },
  });
  // Saves go out one at a time, in order. A failure is reported once; the run goes on.
  let saving = Promise.resolve();
  let saveFailed = false;
  const save = (): Promise<void> => {
    const saveRun = host.saveRun;
    if (!saveRun) return saving;
    const record = buildRecord();
    saving = saving.then(() => saveRun(record)).catch((e) => {
      if (saveFailed) return;
      saveFailed = true;
      addEntry({ id: `run-record-${Date.now()}`, timestamp: new Date().toISOString(), action: "run_record",
        agentId: "system", success: false, details: `Could not save the run record: ${String(e)}` });
    });
    return saving;
  };
  await save();

  // ── Per-node async processor (called by parallel scheduler) ──────────────
  async function processNode(nodeId: string): Promise<void> {
    if (isRunCancelled()) return;

    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const data = node.data;

    // ── MEMORY NODE — aggregate upstream → memoryWrite keys ──────────────
    if (data.role === AgentRole.Memory) {
      const upstreamText = edges
        .filter((e) => e.target === nodeId && !isFeedbackEdge(e))
        .map((e) => {
          const src = nodes.find((n) => n.id === e.source);
          const out = agentOutputs.get(e.source) ?? "";
          if (!out) return null;
          return `[${src?.data.name ?? e.source}]\n${out}`;
        })
        .filter(Boolean)
        .join("\n\n---\n\n");

      const stored = upstreamText || "(no upstream output)";
      memory.writeAll(data.memoryWrite, stored, nodeId);
      agentOutputs.set(nodeId, stored);

      updateAgent(nodeId, {
        agentId: nodeId, agentName: data.name, status: "done",
        output: `Stored ${data.memoryWrite.length} key(s): ${data.memoryWrite.join(", ")}`,
        finishedAt: Date.now(),
      });
      updateNodeData(nodeId, { status: "done" });
      addEntry({ id: `${nodeId}-mem-${Date.now()}`, timestamp: new Date().toISOString(),
        action: "memory_write", agentId: nodeId,
        details: `Memory wrote: ${data.memoryWrite.join(", ")}`, success: true });
      return;
    }

    // ── HOOK NODE — execute pre-hook script ──────────────────────────────
    if (data.role === AgentRole.Hook) {
      updateAgent(nodeId, { agentId: nodeId, agentName: data.name, status: "running" });
      updateNodeData(nodeId, { status: "running" });
      let hookFailed = false;
      const failHook = (message: string) => {
        hookFailed = true;
        updateAgent(nodeId, { status: "error", error: message, finishedAt: Date.now() });
        const entry = { id: `${nodeId}-hook-blocked-${Date.now()}`, timestamp: new Date().toISOString(),
          action: "hook_executed" as const, agentId: nodeId, details: message, success: false };
        addEntry(entry);
        // A refusal is part of the workspace's audit log, as a hook that ran is.
        if (workspacePath) writeAuditEntry(workspacePath, entry).catch(console.error);
      };
      if (data.preHook?.path) {
        // Why this hook is not run, or the fingerprint it may run under: nothing runs without one.
        let check: HookCheck;
        if (!workspacePath) {
          // Hooks run only inside the open workspace: a loaded or pasted workflow
          // must not choose the folder code executes in (meta.projectRoot).
          check = { refusal: "Open a workspace to run hooks." };
        } else if (data.preHook.requireConsent) {
          check = { refusal: "Hook requires explicit manual consent. Open the Hooks tab and run it there." };
        } else if (findChange(run.changes ?? [], data.preHook.path, workspacePath)) {
          // Without consent a hook runs as the script that was set up. One an agent wrote
          // earlier in this run (the change log, matched by path; a resumed run's log
          // includes its earlier attempts) is not that script.
          check = {
            refusal: `Hook script ${data.preHook.path} was changed by an agent during this run; ` +
              "review it, then run it from the Hooks tab or start a new run.",
          };
        } else {
          // What the change log cannot see: another spelling of the path, a link, a shell command.
          check = await checkUnattendedHook(nodeId, workspacePath, data.preHook);
          if (isRunCancelled()) {
            // Stopped while the script was being checked: the hook has not started, whatever the script says.
            updateAgent(nodeId, { status: "stopped", finishedAt: Date.now() });
            updateNodeData(nodeId, { status: "stopped" });
            return;
          }
        }
        if ("refusal" in check) {
          failHook(check.refusal);
        } else if (workspacePath) { // always so here: with none open, the check refuses above
          try {
            // Rust enforces the hook's timeout; this race only stops waiting on Stop.
            const hookTimeout = Math.min(data.timeoutSeconds || 30, 3600);
            const result = await beforeDeadline(
              invoke<HookResult>("execute_hook", {
                workspacePath, hookPath: data.preHook.path, agentId: nodeId,
                env: data.preHook.env ?? {}, consentGranted: true,
                timeoutSecs: data.timeoutSeconds || undefined,
                // harness-core starts the hook only if its script and env still have this fingerprint.
                expectedFingerprint: check.fingerprint,
              }),
              Date.now() + (hookTimeout + 5) * 1000,
              `Hook ${data.preHook.path} did not finish in ${hookTimeout}s`,
              isRunCancelled,
            );
            agentOutputs.set(nodeId, result.stdout);
            const entry = {
              id: `${nodeId}-hook-${Date.now()}`, timestamp: new Date().toISOString(),
              action: "hook_executed" as const, agentId: nodeId,
              details: `${data.preHook.path} exited ${result.exitCode}`, success: result.exitCode === 0,
            };
            addEntry(entry);
            writeAuditEntry(workspacePath, entry).catch(console.error);
            if (result.exitCode === 0) {
              updateAgent(nodeId, { status: "done", output: result.stdout, finishedAt: Date.now() });
            } else {
              hookFailed = true;
              updateAgent(nodeId, {
                status: "error",
                error: `Hook exited ${result.exitCode}: ${result.stderr || result.stdout || "no output"}`,
                output: result.stdout, finishedAt: Date.now(),
              });
            }
          } catch (e) {
            if (isRunCancelled()) {
              // Stopped while the hook ran; the process ends at its own timeout.
              updateAgent(nodeId, { status: "stopped", finishedAt: Date.now() });
              updateNodeData(nodeId, { status: "stopped" });
              return;
            }
            // A hook that did not start (harness-core refused it: the script changed after the check)
            // or did not finish: audited like a refusal here, and the node fails with what it said.
            failHook(String(e));
          }
        }
      } else {
        updateAgent(nodeId, { status: "done", output: "(no hook script)", finishedAt: Date.now() });
      }
      updateNodeData(nodeId, { status: hookFailed ? "error" : "done" });
      // A hook is a gate: its failure stops the run even with continueOnError,
      // so dependents never run behind a failed or unconsented gate.
      if (hookFailed) throw new Error("Hook failed — stopping run");
      return;
    }

    // ── AGENT / GATEWAY / WORKER / CRITIC / AGGREGATOR NODE ─────────────
    const rawModel = data.model || (effectiveProvider === "openai-compatible" ? customApiModel : effectiveOllamaModel);
    const selProv  = selectProviderForModel({
      mode: effectiveProvider, model: rawModel,
      hasOpenAIKey, hasAnthropicKey, ollamaModel: effectiveOllamaModel,
    });
    const runtimeProvider = selProv.provider === "ollama" ? ollamaProviderType : selProv.provider;
    const model =
      selProv.provider === "openai"           ? resolveModel(selProv.model) :
      runtimeProvider === "openai-compatible" ? customModelFor(data) :
      selProv.model;
    const apiKeyForProvider =
      selProv.provider === "openai"           ? openaiApiKey :
      selProv.provider === "anthropic"        ? apiKey       :
      runtimeProvider === "openai-compatible" ? customApiKey : "";
    // A key set only in the environment is resolved by the Rust command itself.
    const envKeyConfigured =
      (selProv.provider === "openai" && providerDefaults.openai_api_key_configured) ||
      (selProv.provider === "anthropic" && providerDefaults.anthropic_api_key_configured);

    updateAgent(nodeId, {
      agentId: nodeId, agentName: data.name, status: "running", startedAt: Date.now(),
      modelUsed: model, providerUsed: runtimeProvider,
    });
    updateNodeData(nodeId, { status: "running" });
    addEntry({
      id: `${nodeId}-start-${Date.now()}`, timestamp: new Date().toISOString(),
      action: "agent_started", agentId: nodeId,
      details: `▶ ${data.name} — ${model} via ${runtimeProvider}`, success: true,
    });

    // Streamed text reaches the node through a throttled flush. It ends with the node's
    // model calls, whether they finish, fail or are stopped: a call that Stop or a timeout
    // gave up on may keep streaming, and must not touch the node afterwards.
    let liveTimer: ReturnType<typeof setTimeout> | undefined;
    let liveEnded = false;
    const endLiveText = () => {
      liveEnded = true;
      clearTimeout(liveTimer);
      liveTimer = undefined;
    };

    try {
      const promptContent = await resolvePromptContent(data.promptSource, workspacePath, readWorkspaceFile);

      const memoryContext    = memory.buildContext(data.memoryRead);

      const upstreamContext = inputsOf(nodeId).join("\n\n─────────────────\n\n");

      // Only tools that actually run are named; the loop adds how to call them.
      const systemMsg = buildSystemMessage({
        agentName: data.name, role: data.role, workflowName: meta.name,
        description: data.description, tools: runnableTools(data.tools as string[]),
        memoryRead: data.memoryRead, memoryWrite: data.memoryWrite, promptContent,
        projectInstructions: usesWorkspace(data.tools as string[]) ? projectInstructions : undefined,
      });

      const userMsgParts: string[] = [];
      if (isEntryNode(nodeId)) {
        if (contextFileContent) userMsgParts.push(`CONTEXT FILES:\n${contextFileContent}`);
        if (config.userInput)   userMsgParts.push(`USER TASK:\n${config.userInput}`);
      }
      if (memoryContext)   userMsgParts.push(`MEMORY:\n${memoryContext}`);
      if (upstreamContext) userMsgParts.push(`UPSTREAM OUTPUTS:\n${upstreamContext}`);
      // Re-run for a revision: the review, and what this agent produced last time.
      const revision = revisionRequests.get(nodeId);
      if (revision) {
        userMsgParts.push(`REVISION REQUEST (round ${revision.round}) from ${revision.from}:\n${revision.text}`);
        if (revision.reviewed) userMsgParts.push(`WHAT ${revision.from} REVIEWED:\n${revision.reviewed}`);
        const previous = agentOutputs.get(nodeId);
        if (previous) userMsgParts.push(`YOUR PREVIOUS OUTPUT:\n${previous}`);
      }
      if (userMsgParts.length === 0)
        userMsgParts.push(`Execute your role as ${data.name} in the ${meta.name} workflow.`);

      const baseUserMsg = userMsgParts.join("\n\n");
      const maxTok = data.maxTokens || 2048;

      // Ollama cuts a prompt that does not fit its context window (num_ctx) without a word, so say it,
      // once per node for the run. Only when num_ctx is really sent: not for 0, and not for ollama.com.
      // The estimate is the first prompt's (the system and user messages, chars / 4); the tool
      // definitions and the steps after it add to it, so it is a minimum. The reply counts as at most
      // half the window: Max tokens is a ceiling, not a size, and a generous one (the shipped examples
      // give some agents 16384, the whole default window) should not warn on its own.
      if ((runtimeProvider === "ollama" || runtimeProvider === "ollama-cloud") && ollamaNumCtx > 0 &&
          !isOllamaCloudUrl(effectiveOllamaUrl) && !contextWarned.has(nodeId)) {
        const promptTokens = estimateTokens(systemMsg, baseUserMsg, "");
        if (promptTokens + Math.min(maxTok, Math.floor(ollamaNumCtx / 2)) > ollamaNumCtx) {
          contextWarned.add(nodeId);
          addEntry({ id: `${nodeId}-ctx-${Date.now()}`, timestamp: new Date().toISOString(),
            action: "context_window", agentId: nodeId, warning: true, success: true,
            details: `⚠ ${data.name}: its prompt is about ${promptTokens.toLocaleString()} tokens and it may reply ` +
              `with up to ${maxTok.toLocaleString()} tokens, but Ollama's context window is ` +
              `${ollamaNumCtx.toLocaleString()} tokens, so Ollama may cut off the start of the prompt. ` +
              "Raise the context window (Settings → Ollama context window; harness run: --num-ctx)." });
        }
      }
      const effectiveThinkDepth =
        config.thinkDepthOverride !== null ? config.thinkDepthOverride : (data.thinkDepth ?? null);
      const reasoningEffort: string | null =
        selProv.provider !== "openai" || !isReasoningModel(selProv.model) ? null :
        effectiveThinkDepth && effectiveThinkDepth !== "none" ? effectiveThinkDepth :
        (REASONING_EFFORT[rawModel] ?? null);

      const timeoutSeconds = data.timeoutSeconds || 300;
      const providerParams = {
        provider: runtimeProvider, model, rawModel, maxTokens: maxTok,
        apiKey: apiKeyForProvider, requiresKey: selProv.requiresKey && !envKeyConfigured,
        ollamaBaseUrl: effectiveOllamaUrl, ollamaModel: effectiveOllamaModel,
        ollamaApiKey: ollamaApiKey || undefined,
        customBaseUrl: runtimeProvider === "openai-compatible" ? customApiUrl : undefined,
        reasoningEffort,
        ollamaNumCtx, requestTimeoutSecs,
      };
      const nativeKey = `${runtimeProvider}:${model}`;
      let toolCallCount = 0;
      let eventCount = 0;
      const helpers: SubAgentRecord[] = [];

      // Moves later by the time spent waiting for the user to approve a command.
      let deadline = Date.now() + timeoutSeconds * 1000;
      // Shared by the node and the helpers it dispatches.
      const shared = {
        maxSteps: data.maxSteps || 5,
        deadline: () => deadline,
        isCancelled: isRunCancelled,
        preferText: noNativeTools.has(nativeKey),
        // A billing error on a hosted provider retries via the text path, whose
        // provider call falls back to local Ollama (never to a remote one). A
        // backend without chat_turn (the VS Code extension) uses the text path too.
        fallbackOnError: (e: unknown) =>
          /Unhandled command: "chat_turn"/.test(String(e)) ||
          ((runtimeProvider === "openai" || runtimeProvider === "anthropic") &&
            shouldFallbackToOllama(String(e)) && !isRemoteOllamaUrl(effectiveOllamaUrl)),
        callTurn: (system: string, messages: ChatMessage[], tools: ToolSpec[]) =>
          callChatTurn({ ...providerParams, systemMsg: system, messages, tools }, invoke),
        callText: async (system: string, userMsg: string) => {
          const callResult = await callProvider({ ...providerParams, systemMsg: system, userMsg }, invoke);
          if (callResult.usedOllamaFallback) {
            addEntry({ id: `${nodeId}-fb-${Date.now()}`, timestamp: new Date().toISOString(),
              action: "provider_fallback", agentId: nodeId, warning: true,
              details: `Billing error — fell back to Ollama (${effectiveOllamaModel})`, success: true });
          }
          return callResult.text;
        },
      };
      const logToolCall = (who: string) => (call: ToolCall) => {
        toolCallCount++;
        addEntry({ id: `${nodeId}-tool-${toolCallCount}-${Date.now()}`, timestamp: new Date().toISOString(),
          action: "tool_call", agentId: nodeId,
          details: `${who}Tool: ${call.name}(${JSON.stringify(call.args)})`, success: true });
      };

      // The node's own native turns stream into its output (throttled); helpers don't.
      let liveText = "";
      let streamed = false;
      const showLiveText = (piece: string) => {
        if (liveEnded) return;
        liveText += piece;
        streamed = true;
        if (!liveTimer) {
          liveTimer = setTimeout(() => {
            liveTimer = undefined;
            if (!liveEnded) updateAgent(nodeId, { output: liveText });
          }, 50);
        }
      };
      const streamingCallTurn = async (system: string, messages: ChatMessage[], tools: ToolSpec[]) => {
        liveText = "";
        const params = { ...providerParams, systemMsg: system, messages, tools };
        if (noStreaming.has(nativeKey)) return callChatTurn(params, invoke);
        let received = false;
        try {
          return await callChatTurn(params, invoke, (piece) => { received = true; showLiveText(piece); });
        } catch (e) {
          // A server that cannot stream: ask again without streaming, and stop streaming to it this run.
          if (received || !/stream/i.test(String(e))) throw e;
          noStreaming.add(nativeKey);
          return callChatTurn(params, invoke);
        }
      };

      // Every file an agent writes goes into the run's change log (Changes dialog, revert).
      const recordChangeBy = (agent: string) => (path: string, before: string | null, after: string) => {
        run.changes = recordChange(run.changes ?? [], path, before, after, agent);
        host.events.onFileChange(path, before, after, agent);
      };

      // bash: the host approves each command (the app asks the user: CommandConsentDialog).
      const runCommand = (args: Record<string, unknown>) => runCommandTool(args, {
        runId, agentName: data.name, workspacePath, invoke, policy: host.commandPolicy,
        askUser: (command) => host.askCommand({
          runId, agentName: data.name, command, workspacePath: workspacePath ?? "",
        }),
        deadline: () => deadline,
        extendDeadline: (ms) => { deadline += ms; },
        isCancelled: isRunCancelled,
        onAudit: (details, success) => {
          const entry = { id: `${nodeId}-cmd-${Date.now()}`, timestamp: new Date().toISOString(),
            action: "command_executed" as const, agentId: nodeId, details, success };
          addEntry(entry);
          if (workspacePath) writeAuditEntry(workspacePath, entry).catch(console.error);
        },
      });

      const subAgents = createSubAgentRunner({
        parentName: data.name,
        workflowName: meta.name,
        parentTools: data.tools as string[],
        isCancelled: isRunCancelled,
        projectInstructions,
        runLoop: (child) => runAgentLoop({
          ...shared,
          system: child.system,
          userMessage: child.userMessage,
          tools: child.tools,
          timeoutMessage: `Sub-agent "${child.name}" ran past ${data.name}'s ${timeoutSeconds}s limit`,
          runTool: (call) => executeTool(call, workspacePath, invoke, child.tools, recordChangeBy(child.name)),
          onToolCall: logToolCall(`↳ ${child.name} — `),
        }),
        onEvent: (details, success) => {
          eventCount++;
          addEntry({ id: `${nodeId}-sub-${eventCount}-${Date.now()}`, timestamp: new Date().toISOString(),
            action: "subagent", agentId: nodeId, details, success });
        },
        // The activity panel shows the helpers from the node's run record.
        onUpdate: (record) => {
          const i = helpers.findIndex((h) => h.id === record.id);
          if (i >= 0) helpers[i] = record;
          else helpers.push(record);
          updateAgent(nodeId, { subAgents: [...helpers] });
        },
      });

      const loop = await runAgentLoop({
        ...shared,
        system: systemMsg,
        userMessage: baseUserMsg,
        tools: data.tools as string[],
        timeoutMessage: `${data.name} timed out after ${timeoutSeconds}s`,
        callTurn: streamingCallTurn,
        runTool: (call) => call.name === SUBAGENT_TOOL ? subAgents.dispatch(call.args)
          : call.name === "bash" ? runCommand(call.args)
          : executeTool(call, workspacePath, invoke, data.tools as string[], recordChangeBy(data.name)),
        onToolCall: logToolCall(""),
        concurrentTools: [SUBAGENT_TOOL],
        maxConcurrent: MAX_CONCURRENT_SUBAGENTS,
        // Past 75% of the node's Token budget, older steps become a progress note.
        compaction: (data.tokens?.budget ?? 0) > 0 ? {
          budget: data.tokens.budget,
          summarize: (text) => shared.callText(SUMMARY_INSTRUCTIONS, text),
          onCompacted: (steps, before, after) => addEntry({
            id: `${nodeId}-compact-${Date.now()}`, timestamp: new Date().toISOString(),
            action: "compaction", agentId: nodeId, success: true,
            details: `↻ ${data.name}: compacted ${steps} earlier step${steps === 1 ? "" : "s"} ` +
              `(~${before.toLocaleString()} → ~${after.toLocaleString()} tokens)`,
          }),
          onFailed: (e) => addEntry({
            id: `${nodeId}-compact-fail-${Date.now()}`, timestamp: new Date().toISOString(),
            action: "compaction", agentId: nodeId, success: true, warning: true,
            details: `↻ ${data.name}: could not compact the conversation: ${String(e)}`,
          }),
        } : undefined,
      });
      endLiveText();
      if (loop.nativeRefused) {
        noNativeTools.add(nativeKey);
        addEntry({ id: `${nodeId}-textmode-${Date.now()}`, timestamp: new Date().toISOString(),
          action: "provider_fallback", agentId: nodeId, warning: true,
          details: `${model} via ${runtimeProvider} refused native tool calls — using the text tool protocol`,
          success: true });
      }
      const finalText = loop.text;

      // Store output + memory
      agentOutputs.set(nodeId, finalText);
      memory.writeAll(data.memoryWrite, finalText, nodeId);

      // Gateway routing
      if (data.role === AgentRole.Gateway) {
        const route = parseGatewayRoute(finalText);
        if (route) {
          gatewayRoutes.set(nodeId, route);
          addEntry({ id: `${nodeId}-route-${Date.now()}`, timestamp: new Date().toISOString(),
            action: "gateway_route", agentId: nodeId,
            details: `Gateway routed → "${route}"`, success: true });
        } else {
          // No route now: every branch is followed, as after a first run that names none. A route
          // from an earlier run of this gateway (a revision re-runs it) is not kept.
          gatewayRoutes.delete(nodeId);
        }
      }

      // Simulated streaming display, unless the text already streamed in live or the host shows none
      if (host.revealOutput !== false && !(streamed && loop.mode === "native")) {
        const chunkSize = finalText.length > 2000 ? 120 : 60;
        let accumulated = "";
        for (let i = 0; i < finalText.length; i += chunkSize) {
          if (isRunCancelled()) break;
          await new Promise<void>((r) => setTimeout(r, finalText.length > 2000 ? 15 : 25));
          accumulated += finalText.slice(i, i + chunkSize);
          updateAgent(nodeId, { output: accumulated });
        }
      }

      const tokenEstimate = loop.tokenEstimate + subAgents.tokenEstimate();
      updateAgent(nodeId, {
        status: "done", output: finalText, finishedAt: Date.now(),
        tokenEstimate, providerUsed: runtimeProvider, modelUsed: model,
      });
      updateNodeData(nodeId, { status: "done", tokens: { used: tokenEstimate, budget: data.tokens.budget } });
      addEntry({
        id: `${nodeId}-done-${Date.now()}`, timestamp: new Date().toISOString(),
        action: "agent_finished", agentId: nodeId,
        details: `✓ ${data.name} — ${tokenEstimate} est. tokens${toolCallCount > 0 ? ` (${toolCallCount} tool calls)` : ""}`,
        success: true,
      });

      host.snapshot?.({ runId, nodeId, status: "completed", output: finalText });

    } catch (e) {
      endLiveText();
      if (isRunCancelled()) {
        // Stopped while this node was working: not a failure of the node.
        updateAgent(nodeId, { status: "stopped", finishedAt: Date.now() });
        updateNodeData(nodeId, { status: "stopped" });
        return;
      }
      updateAgent(nodeId, { status: "error", error: String(e), finishedAt: Date.now() });
      updateNodeData(nodeId, { status: "error" });
      addEntry({ id: `${nodeId}-err-${Date.now()}`, timestamp: new Date().toISOString(),
        action: "agent_failed", agentId: nodeId, details: String(e), success: false });

      host.snapshot?.({ runId, nodeId, status: "failed", output: "", error: String(e) });

      if (!continueOnError) throw e; // propagate to scheduler → stops remaining nodes
    }
  }

  // ── Nodes a gateway's routes prune ────────────────────────────────────────
  // The scheduler skips the branch a gateway does not take. A revision can re-run a
  // gateway, and it may route differently, so which nodes are pruned is asked again
  // from the routes as they are now (prunedNodes). A pruned node that has already run
  // is taken back: marked skipped, as the scheduler marks one that never ran, and what
  // it produced is removed from everything a later node or the record reads. One that
  // has not run yet is not run: the scheduler never hears of a route that changed.
  /** A node the routing leaves out: skipped, and idle on the canvas. */
  const skipNode = (nodeId: string) => {
    const n = nodes.find((x) => x.id === nodeId);
    updateAgent(nodeId, { agentId: nodeId, agentName: n?.data.name ?? nodeId, status: "skipped" as const });
    updateNodeData(nodeId, { status: "idle" });
    addEntry({ id: `${nodeId}-skip-${Date.now()}`, timestamp: new Date().toISOString(),
      action: "agent_skipped", agentId: nodeId, details: "skipped by gateway routing", success: true });
  };
  const dropNode = (nodeId: string) => {
    const n = nodes.find((x) => x.id === nodeId);
    const name = n?.data.name ?? nodeId;
    agentOutputs.delete(nodeId);   // what later nodes are given, and the record's outputs
    gatewayRoutes.delete(nodeId);  // a gateway that is dropped takes its decision with it
    memory.forget(nodeId);         // what it wrote to memory, for the nodes that read it
    // The record and the UI show a node that did not run: no output, error, timing or helpers.
    updateAgent(nodeId, {
      agentId: nodeId, agentName: name, status: "skipped", output: undefined, error: undefined,
      startedAt: undefined, finishedAt: undefined, tokenEstimate: undefined, modelUsed: undefined,
      providerUsed: undefined, revision: undefined, subAgents: undefined,
    });
    updateNodeData(nodeId, { status: "idle", tokens: { used: 0, budget: n?.data.tokens.budget ?? 0 } });
    addEntry({ id: `${nodeId}-dropped-${Date.now()}`, timestamp: new Date().toISOString(),
      action: "revision", agentId: nodeId, success: true,
      details: `↺ ${name} skipped: a gateway now routes around it, so its earlier result is dropped` });
  };
  /** The nodes the current routes prune; those of them that already ran are dropped. A node still
   *  working when its gateway routes elsewhere is not interrupted. One that failed is dropped only
   *  when the run goes on past failures, and a Hook is never: a failed Hook stops the run whatever
   *  continueOnError says, and the error of the node the run is ending because of must stay where
   *  it can be read. */
  const dropPruned = (): Set<string> => {
    const pruned = prunedNodes(nodes, edges, gatewayRoutes);
    for (const id of pruned) {
      const status = run.agents[id]?.status;
      const keepsError = !continueOnError || nodes.find((n) => n.id === id)?.data.role === AgentRole.Hook;
      if (status === "done" || (status === "error" && !keepsError)) dropNode(id);
    }
    return pruned;
  };

  // ── Revision loops ─────────────────────────────────────────────────────────
  // A node whose verdict fires its feedback edges re-runs the path from each
  // target back to itself, then reviews again (at most MAX_REVISION_ROUNDS times).
  // The scheduler awaits this, so downstream nodes see the final result.
  // Only that path re-runs, not the whole graph: a node that a gateway's new route
  // makes live again runs only if it lies on the path. One off it (its branch does
  // not lead back to the reviewer) stays unrun. That is the design, not an oversight.
  async function runWithRevisions(nodeId: string): Promise<void> {
    await processNode(nodeId);
    const name = nodes.find((n) => n.id === nodeId)?.data.name ?? nodeId;
    for (let round = 1; ; round++) {
      if (isRunCancelled()) return;
      // A branch a gateway pruned never ran, or has just been dropped, and cannot be sent back.
      const pruned = dropPruned();
      const review = agentOutputs.get(nodeId) ?? "";
      const targets = [...new Set(firedFeedbackEdges(nodeId, review, edges).map((e) => e.target))]
        .filter((t) => !pruned.has(t));
      if (targets.length === 0) return;
      if (round > MAX_REVISION_ROUNDS) {
        addEntry({ id: `${nodeId}-revision-limit-${Date.now()}`, timestamp: new Date().toISOString(),
          action: "revision", agentId: nodeId, success: true, warning: true,
          details: `↺ ${name}: revision limit (${MAX_REVISION_ROUNDS}) reached — continuing with the latest version` });
        return;
      }
      const targetNames = targets.map((t) => nodes.find((n) => n.id === t)?.data.name ?? t).join(", ");
      addEntry({ id: `${nodeId}-revision-${round}-${Date.now()}`, timestamp: new Date().toISOString(),
        action: "revision", agentId: nodeId, success: true,
        details: `↺ ${name} asked for revision ${round}/${MAX_REVISION_ROUNDS}: re-running ${targetNames}` });
      for (const target of targets) {
        // Plus what the reviewer read that the target doesn't see itself, e.g. the
        // critique behind a gateway's bare {"route":"revise"}.
        const seen = new Set([target, ...edges.filter((e) => e.target === target && !isFeedbackEdge(e)).map((e) => e.source)]);
        revisionRequests.set(target, { from: name, text: review, reviewed: inputsOf(nodeId, seen).join("\n\n"), round });
      }
      const path = revisionPath(targets, nodeId, edges);
      // Asks again which nodes are pruned. A gateway that re-ran may now route to nodes that were
      // pruned before: those on the path run in this round; for the others it says so, since they will not.
      let before = pruned;
      const look = (): Set<string> => {
        const now = dropPruned();
        for (const id of before) {
          if (now.has(id) || path.includes(id) || run.agents[id]?.status !== "skipped") continue;
          addEntry({ id: `${id}-offpath-${Date.now()}`, timestamp: new Date().toISOString(),
            action: "revision", agentId: id, success: true, warning: true,
            details: `↺ ${nodes.find((n) => n.id === id)?.data.name ?? id}: a gateway now routes to it, ` +
              "but it is not on the revision path, so it did not run" });
        }
        before = now;
        return now;
      };
      for (const id of path) {
        if (isRunCancelled()) return;
        // A gateway earlier on the path may just have routed differently.
        if (look().has(id)) continue;
        updateAgent(id, { revision: round });
        await processNode(id);
      }
      for (const target of targets) revisionRequests.delete(target);
      if (isRunCancelled()) return;
      if (look().has(nodeId)) return; // the new route took this reviewer's own branch away
      updateAgent(nodeId, { revision: round });
      await processNode(nodeId);
    }
  }

  async function runNode(nodeId: string): Promise<void> {
    try {
      // A reused node neither runs nor reviews again; a revision round that
      // targets it still runs it (revisionPath calls processNode).
      if (reused.has(nodeId)) showReused(nodeId);
      // The scheduler queued this node before a revision changed a gateway's route, and does not
      // know: a node the routes prune now is skipped, whatever it would do (a shell command too).
      else if (prunedNodes(nodes, edges, gatewayRoutes).has(nodeId)) skipNode(nodeId);
      else await runWithRevisions(nodeId);
    } finally {
      await save(); // after every node settles, a failed one too
    }
  }

  // ── Parallel execution (replaces sequential for-loop) ────────────────────
  const maxParallel = executionSettings.maxParallel || 4;
  // What failed nodes threw: each is already on its node and in the audit log. What
  // else stops the run (a cycle, blocked dependencies) has no other message.
  const nodeFailures = new Set<unknown>();
  const runTracked = (nodeId: string) => runNode(nodeId).catch((e: unknown) => {
    nodeFailures.add(e);
    throw e;
  });
  let failed = false;
  let runError: string | undefined;
  try {
    await runParallel(
      nodes,
      edges,
      runTracked,
      {
        maxParallel,
        isCancelled: isRunCancelled,
        onSkipped: skipNode,
        gatewayRoutes,
      },
    );
  } catch (e) {
    failed = true;
    if (!nodeFailures.has(e)) {
      runError = `Run failed: ${e instanceof Error ? e.message : String(e)}`;
      const entry = { id: `run-error-${Date.now()}`, timestamp: new Date().toISOString(),
        action: "run_failed" as const, agentId: "system", details: runError, success: false };
      addEntry(entry);
      if (workspacePath) writeAuditEntry(workspacePath, entry).catch(console.error);
    }
  }

  // With continueOnError the scheduler completes despite failed agents; the run
  // must still be reported as failed rather than "done".
  const anyFailed = Object.values(run.agents).some((a) => a.status === "error");
  const status = failed ? "error" : isRunCancelled() ? "cancelled" : anyFailed ? "error" : "done";
  run.status = status;
  run.finishedAt = Date.now();
  await save();
  host.events.onRunFinished(status);
  return runError === undefined ? { started: true, run } : { started: true, run, error: runError };
}
