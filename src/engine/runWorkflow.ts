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

import { AgentRole, type AgentNodeData } from "@/types/agent";
import type { AuditEntry } from "@/types/audit";
import type { AgentRun, SubAgentRecord, WorkflowRun } from "@/types/execution";
import type { HookResult } from "@/types/hookResult";
import type { WorkflowRunConfig } from "@/types/workflowRunConfig";
import type { CommandApproval, CommandRequest } from "@/store/commandConsentStore";
import type { WorkflowGraph } from "@/engine/workflowGraph";
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
import { recordChange } from "@/services/execution/changeLog";
import { SUMMARY_INSTRUCTIONS } from "@/services/execution/compaction";
import { loadProjectInstructions, usesWorkspace } from "@/services/execution/projectInstructions";
import {
  createSubAgentRunner,
  MAX_CONCURRENT_SUBAGENTS,
  SUBAGENT_TOOL,
} from "@/services/execution/subAgents";
import { runParallel } from "@/services/execution/parallelScheduler";
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
  customApiModel: string;
}

export interface RunInput {
  graph: WorkflowGraph;
  config: WorkflowRunConfig;
  provider: ProviderSettings;
  /** Agents' file tools, commands and hooks work only inside it. */
  workspacePath: string | null;
  continueOnError: boolean;
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
}

/** A run that never started (the provider preflight failed), or the finished run. */
export type RunOutcome =
  | { started: false; error: string }
  | { started: true; run: WorkflowRun };

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
    addEntry({
      id: `health-${h.provider}-${Date.now()}`, timestamp: new Date().toISOString(),
      action: "workflow_loaded", agentId: "system",
      details: `${h.ok ? "✓" : "⚠"} ${h.provider} — ${h.message}`, success: h.ok,
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
    llmProvider, ollamaBaseUrl, ollamaModel,
  } = input.provider;
  const invoke = <T>(cmd: string, args?: Record<string, unknown>) => host.invoke<T>(cmd, args);
  const addEntry = (entry: AuditEntry) => host.events.onAudit(entry);
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

  const requiredProviders = new Set<RuntimeProvider>();
  for (const node of nodes) {
    if (!isExecutable(node.data.role)) continue;
    const sel = selectProviderForModel({
      mode: effectiveProvider, model: node.data.model || "qwen2.5-coder:7b",
      hasOpenAIKey, hasAnthropicKey, ollamaModel: effectiveOllamaModel,
    });
    requiredProviders.add(sel.provider === "ollama" ? ollamaProviderType : sel.provider);
  }

  // Health checks — never contact a hosted provider this run will not use.
  // Local Ollama is always probed because it is the billing fallback.
  const probeOllama = requiredProviders.has(ollamaProviderType) || !isRemoteOllamaUrl(effectiveOllamaUrl);
  const healthResults = await runHealthChecks(
    invoke,
    requiredProviders.has("openai") ? openaiApiKey : "",
    requiredProviders.has("anthropic") ? apiKey : "",
    probeOllama ? effectiveOllamaUrl : "", effectiveOllamaModel,
    ollamaApiKey, ollamaProviderType,
    requiredProviders.has("openai-compatible") ? customApiUrl : "",
    customApiKey, customApiModel, addEntry,
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

  // ── Per-run runtime state ─────────────────────────────────────────────────
  const memory        = new MemoryService();
  const agentOutputs  = new Map<string, string>(); // nodeId → output text
  const gatewayRoutes = new Map<string, string>(); // gatewayId → chosen route
  const noNativeTools = new Set<string>();         // "provider:model" that refused native tools
  const noStreaming   = new Set<string>();         // "provider:model" that could not stream
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

  const runId = `run-${Date.now()}`;
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
      memory.writeAll(data.memoryWrite, stored);
      agentOutputs.set(nodeId, stored);

      updateAgent(nodeId, {
        agentId: nodeId, agentName: data.name, status: "done",
        output: `Stored ${data.memoryWrite.length} key(s): ${data.memoryWrite.join(", ")}`,
        finishedAt: Date.now(),
      });
      updateNodeData(nodeId, { status: "done" });
      addEntry({ id: `${nodeId}-mem-${Date.now()}`, timestamp: new Date().toISOString(),
        action: "workflow_loaded", agentId: nodeId,
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
        addEntry({ id: `${nodeId}-hook-blocked-${Date.now()}`, timestamp: new Date().toISOString(),
          action: "hook_executed", agentId: nodeId, details: message, success: false });
      };
      if (data.preHook?.path) {
        if (!workspacePath) {
          // Hooks run only inside the open workspace: a loaded or pasted workflow
          // must not choose the folder code executes in (meta.projectRoot).
          failHook("Open a workspace to run hooks.");
        } else if (data.preHook.requireConsent) {
          failHook("Hook requires explicit manual consent. Open the Hooks tab and run it there.");
        } else {
          try {
            // Rust enforces the hook's timeout; this race only stops waiting on Stop.
            const hookTimeout = Math.min(data.timeoutSeconds || 30, 3600);
            const result = await beforeDeadline(
              invoke<HookResult>("execute_hook", {
                workspacePath, hookPath: data.preHook.path, agentId: nodeId,
                env: data.preHook.env ?? {}, consentGranted: true,
                timeoutSecs: data.timeoutSeconds || undefined,
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
            hookFailed = true;
            updateAgent(nodeId, { status: "error", error: String(e), finishedAt: Date.now() });
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
      runtimeProvider === "openai-compatible" ? (customApiModel || rawModel) :
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
      action: "hook_executed", agentId: nodeId,
      details: `▶ ${data.name} — ${model} via ${runtimeProvider}`, success: true,
    });

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
              action: "hook_executed", agentId: nodeId,
              details: `Billing error — fell back to Ollama (${effectiveOllamaModel})`, success: false });
          }
          return callResult.text;
        },
      };
      const logToolCall = (who: string) => (call: ToolCall) => {
        toolCallCount++;
        addEntry({ id: `${nodeId}-tool-${toolCallCount}-${Date.now()}`, timestamp: new Date().toISOString(),
          action: "file_read", agentId: nodeId,
          details: `${who}Tool: ${call.name}(${JSON.stringify(call.args)})`, success: true });
      };

      // The node's own native turns stream into its output (throttled); helpers don't.
      let liveText = "";
      let streamed = false;
      let liveTimer: ReturnType<typeof setTimeout> | undefined;
      const showLiveText = (piece: string) => {
        liveText += piece;
        streamed = true;
        if (!liveTimer) {
          liveTimer = setTimeout(() => { liveTimer = undefined; updateAgent(nodeId, { output: liveText }); }, 50);
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
            action: "workflow_loaded", agentId: nodeId, details, success });
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
            action: "workflow_loaded", agentId: nodeId, success: true,
            details: `↻ ${data.name}: compacted ${steps} earlier step${steps === 1 ? "" : "s"} ` +
              `(~${before.toLocaleString()} → ~${after.toLocaleString()} tokens)`,
          }),
          onFailed: (e) => addEntry({
            id: `${nodeId}-compact-fail-${Date.now()}`, timestamp: new Date().toISOString(),
            action: "workflow_loaded", agentId: nodeId, success: false,
            details: `↻ ${data.name}: could not compact the conversation: ${String(e)}`,
          }),
        } : undefined,
      });
      clearTimeout(liveTimer);
      if (loop.nativeRefused) {
        noNativeTools.add(nativeKey);
        addEntry({ id: `${nodeId}-textmode-${Date.now()}`, timestamp: new Date().toISOString(),
          action: "workflow_loaded", agentId: nodeId,
          details: `${model} via ${runtimeProvider} refused native tool calls — using the text tool protocol`,
          success: true });
      }
      const finalText = loop.text;

      // Store output + memory
      agentOutputs.set(nodeId, finalText);
      memory.writeAll(data.memoryWrite, finalText);

      // Gateway routing
      if (data.role === AgentRole.Gateway) {
        const route = parseGatewayRoute(finalText);
        if (route) {
          gatewayRoutes.set(nodeId, route);
          addEntry({ id: `${nodeId}-route-${Date.now()}`, timestamp: new Date().toISOString(),
            action: "workflow_loaded", agentId: nodeId,
            details: `Gateway routed → "${route}"`, success: true });
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
        action: "hook_executed", agentId: nodeId,
        details: `✓ ${data.name} — ${tokenEstimate} est. tokens${toolCallCount > 0 ? ` (${toolCallCount} tool calls)` : ""}`,
        success: true,
      });

      host.snapshot?.({ runId, nodeId, status: "completed", output: finalText });

    } catch (e) {
      if (isRunCancelled()) {
        // Stopped while this node was working: not a failure of the node.
        updateAgent(nodeId, { status: "stopped", finishedAt: Date.now() });
        updateNodeData(nodeId, { status: "stopped" });
        return;
      }
      updateAgent(nodeId, { status: "error", error: String(e), finishedAt: Date.now() });
      updateNodeData(nodeId, { status: "error" });
      addEntry({ id: `${nodeId}-err-${Date.now()}`, timestamp: new Date().toISOString(),
        action: "hook_executed", agentId: nodeId, details: String(e), success: false });

      host.snapshot?.({ runId, nodeId, status: "failed", output: "", error: String(e) });

      if (!continueOnError) throw e; // propagate to scheduler → stops remaining nodes
    }
  }

  // ── Revision loops ─────────────────────────────────────────────────────────
  // A node whose verdict fires its feedback edges re-runs the path from each
  // target back to itself, then reviews again (at most MAX_REVISION_ROUNDS times).
  // The scheduler awaits this, so downstream nodes see the final result.
  async function runNode(nodeId: string): Promise<void> {
    await processNode(nodeId);
    const name = nodes.find((n) => n.id === nodeId)?.data.name ?? nodeId;
    for (let round = 1; ; round++) {
      if (isRunCancelled()) return;
      const review = agentOutputs.get(nodeId) ?? "";
      const targets = [...new Set(firedFeedbackEdges(nodeId, review, edges).map((e) => e.target))];
      if (targets.length === 0) return;
      if (round > MAX_REVISION_ROUNDS) {
        addEntry({ id: `${nodeId}-revision-limit-${Date.now()}`, timestamp: new Date().toISOString(),
          action: "workflow_loaded", agentId: nodeId, success: false,
          details: `↺ ${name}: revision limit (${MAX_REVISION_ROUNDS}) reached — continuing with the latest version` });
        return;
      }
      const targetNames = targets.map((t) => nodes.find((n) => n.id === t)?.data.name ?? t).join(", ");
      addEntry({ id: `${nodeId}-revision-${round}-${Date.now()}`, timestamp: new Date().toISOString(),
        action: "workflow_loaded", agentId: nodeId, success: true,
        details: `↺ ${name} asked for revision ${round}/${MAX_REVISION_ROUNDS}: re-running ${targetNames}` });
      for (const target of targets) {
        // Plus what the reviewer read that the target doesn't see itself, e.g. the
        // critique behind a gateway's bare {"route":"revise"}.
        const seen = new Set([target, ...edges.filter((e) => e.target === target && !isFeedbackEdge(e)).map((e) => e.source)]);
        revisionRequests.set(target, { from: name, text: review, reviewed: inputsOf(nodeId, seen).join("\n\n"), round });
      }
      for (const id of revisionPath(targets, nodeId, edges)) {
        if (isRunCancelled()) return;
        updateAgent(id, { revision: round });
        await processNode(id);
      }
      for (const target of targets) revisionRequests.delete(target);
      if (isRunCancelled()) return;
      updateAgent(nodeId, { revision: round });
      await processNode(nodeId);
    }
  }

  // ── Parallel execution (replaces sequential for-loop) ────────────────────
  const maxParallel = executionSettings.maxParallel || 4;
  let failed = false;
  try {
    await runParallel(
      nodes,
      edges,
      runNode,
      {
        maxParallel,
        isCancelled: isRunCancelled,
        onSkipped: (nodeId) => {
          const n = nodes.find((x) => x.id === nodeId);
          updateAgent(nodeId, { agentId: nodeId, agentName: n?.data.name ?? nodeId, status: "skipped" as const });
          updateNodeData(nodeId, { status: "idle" });
          addEntry({ id: `${nodeId}-skip-${Date.now()}`, timestamp: new Date().toISOString(),
            action: "workflow_loaded", agentId: nodeId, details: "skipped by gateway routing", success: true });
        },
        gatewayRoutes,
      },
    );
  } catch {
    failed = true;
  }

  // With continueOnError the scheduler completes despite failed agents; the run
  // must still be reported as failed rather than "done".
  const anyFailed = Object.values(run.agents).some((a) => a.status === "error");
  const status = failed ? "error" : isRunCancelled() ? "cancelled" : anyFailed ? "error" : "done";
  run.status = status;
  run.finishedAt = Date.now();
  host.events.onRunFinished(status);
  return { started: true, run };
}
