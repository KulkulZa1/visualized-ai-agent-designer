import { invoke } from "@tauri-apps/api/core";
import { useWorkflowStore } from "@/store/workflowStore";
import { useExecutionStore } from "@/store/executionStore";
import { useAuditStore } from "@/store/auditStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { AgentRole } from "@/types/agent";
import type { AgentNode } from "@/types/workflow";
import type { Edge } from "@xyflow/react";
import type { HookResult } from "@/types/hookResult";
import { buildContextSnapshot } from "@/services/context-builder/contextSnapshot";
import { createSnapshot } from "@/services/context-builder/snapshotService";
import { MOCK_ARTIFACTS } from "@/services/artifact-manager/mockArtifacts";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  isBillingRelatedError,
  selectProviderForModel,
  shouldFallbackToOllama,
  type LlmProvider,
  type RuntimeProvider,
} from "@/utils/providerConfig";

// ── Model alias resolution ────────────────────────────────────────────────────

const MODEL_ALIASES: Record<string, string> = {
  "gpt-5.5-xhigh": "gpt-5.5",
  "gpt-5.5-high":  "gpt-5.5",
  "gpt-5.5-mid":   "gpt-5.4-mini",
  "gpt-4o-high":   "gpt-4o",
  "gpt-4o-mini":   "gpt-4o-mini",
};

const REASONING_EFFORT: Record<string, string> = {
  "gpt-5.5-xhigh": "high",
  "gpt-5.5-high":  "medium",
  "gpt-5.5-mid":   "medium",
};

function resolveModel(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

// ── Topological sort (Kahn's algorithm) ───────────────────────────────────────

function topoSort(nodes: AgentNode[], edges: Edge[]): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
  }

  for (const e of edges) {
    if (!adj.has(e.source)) continue;
    adj.get(e.source)!.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);
    for (const neighbor of adj.get(current) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  const sorted = new Set(result);
  for (const n of nodes) {
    if (!sorted.has(n.id)) result.push(n.id);
  }

  return result;
}

// ── Provider health check ─────────────────────────────────────────────────────

interface ProviderHealth {
  ok: boolean;
  provider: string;
  latency_ms: number;
  message: string;
  model_available: boolean;
  pull_command: string | null;
}

interface ProviderDefaults {
  llm_provider: LlmProvider;
  ollama_base_url: string;
  ollama_model: string;
  openai_api_key_configured: boolean;
  anthropic_api_key_configured: boolean;
  suggested_ollama_models: string[];
}

const FALLBACK_PROVIDER_DEFAULTS: ProviderDefaults = {
  llm_provider: "auto",
  ollama_base_url: DEFAULT_OLLAMA_BASE_URL,
  ollama_model: DEFAULT_OLLAMA_MODEL,
  openai_api_key_configured: false,
  anthropic_api_key_configured: false,
  suggested_ollama_models: [],
};

function isExecutableAgent(role: AgentRole): boolean {
  return role !== AgentRole.Memory && role !== AgentRole.Hook;
}

async function runHealthChecks(
  openaiApiKey: string,
  apiKey: string,
  ollamaBaseUrl: string,
  ollamaModel: string,
  addEntry: ReturnType<typeof useAuditStore.getState>["addEntry"],
  hasOpenAIKey = Boolean(openaiApiKey),
  hasAnthropicKey = Boolean(apiKey),
): Promise<ProviderHealth[]> {
  const checks: Promise<ProviderHealth | null>[] = [];

  if (hasOpenAIKey) {
    checks.push(
      invoke<ProviderHealth>("check_provider_health", {
        provider: "openai", apiKey: openaiApiKey, baseUrl: "", model: "",
      }).catch((e): ProviderHealth => ({
        ok: false, provider: "openai", latency_ms: 0,
        message: String(e), model_available: false, pull_command: null,
      }))
    );
  }

  if (hasAnthropicKey) {
    checks.push(
      invoke<ProviderHealth>("check_provider_health", {
        provider: "anthropic", apiKey, baseUrl: "", model: "",
      }).catch((e): ProviderHealth => ({
        ok: false, provider: "anthropic", latency_ms: 0,
        message: String(e), model_available: false, pull_command: null,
      }))
    );
  }

  if (ollamaBaseUrl) {
    checks.push(
      invoke<ProviderHealth>("check_provider_health", {
        provider: "ollama", apiKey: "", baseUrl: ollamaBaseUrl, model: ollamaModel,
      }).catch((e): ProviderHealth => ({
        ok: false, provider: "ollama", latency_ms: 0,
        message: String(e), model_available: false, pull_command: `ollama pull ${ollamaModel}`,
      }))
    );
  }

  const results = (await Promise.all(checks)).filter(Boolean) as ProviderHealth[];

  for (const h of results) {
    const icon = h.ok ? "✓" : "⚠";
    addEntry({
      id: `health-${h.provider}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      action: "workflow_loaded",
      agentId: "system",
      details: `Provider health: ${icon} ${h.provider.charAt(0).toUpperCase() + h.provider.slice(1)} — ${h.message}`,
      success: h.ok,
    });
  }

  return results;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useWorkflowExecution() {
  const nodes          = useWorkflowStore((s) => s.nodes);
  const edges          = useWorkflowStore((s) => s.edges);
  const meta           = useWorkflowStore((s) => s.meta);
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const workspacePath  = useWorkspaceStore((s) => s.workspacePath);

  const {
    currentRun, apiKey, openaiApiKey,
    llmProvider, ollamaBaseUrl, ollamaModel,
    startRun, updateAgent, finishRun, cancelRun, isRunning,
  } = useExecutionStore();

  const addEntry = useAuditStore((s) => s.addEntry);

  async function executeWorkflow() {
    const providerDefaults = await invoke<ProviderDefaults>("get_provider_defaults")
      .catch(() => FALLBACK_PROVIDER_DEFAULTS);
    const effectiveProvider =
      llmProvider === "auto" && providerDefaults.llm_provider !== "auto"
        ? providerDefaults.llm_provider
        : llmProvider;
    const effectiveOllamaBaseUrl = ollamaBaseUrl || providerDefaults.ollama_base_url || DEFAULT_OLLAMA_BASE_URL;
    const effectiveOllamaModel = ollamaModel || providerDefaults.ollama_model || DEFAULT_OLLAMA_MODEL;
    const hasOpenAIKey = Boolean(openaiApiKey || providerDefaults.openai_api_key_configured);
    const hasAnthropicKey = Boolean(apiKey || providerDefaults.anthropic_api_key_configured);

    const selectedHostedProviderMissingKey =
      (effectiveProvider === "openai" && !hasOpenAIKey) ||
      (effectiveProvider === "anthropic" && !hasAnthropicKey);
    if (selectedHostedProviderMissingKey) {
      alert("The selected hosted provider has no API key. Save a key in Settings or switch LLM_PROVIDER=ollama.");
      return;
    }

    const requiredProviders = new Set<RuntimeProvider>();
    for (const node of nodes) {
      if (!isExecutableAgent(node.data.role)) continue;
      const selected = selectProviderForModel({
        mode: effectiveProvider,
        model: node.data.model || "gpt-4o-mini",
        hasOpenAIKey,
        hasAnthropicKey,
        ollamaModel: effectiveOllamaModel,
      });
      requiredProviders.add(selected.provider);
    }

    const healthResults = await runHealthChecks(
      openaiApiKey,
      apiKey,
      effectiveOllamaBaseUrl,
      effectiveOllamaModel,
      addEntry,
      hasOpenAIKey,
      hasAnthropicKey,
    );
    const healthByProvider = new Map(healthResults.map((health) => [health.provider, health]));
    const ollamaHealth = healthByProvider.get("ollama");
    const ollamaReady = Boolean(ollamaHealth?.ok && ollamaHealth.model_available);

    for (const provider of requiredProviders) {
      const health = healthByProvider.get(provider);
      if (provider === "ollama") {
        if (!ollamaReady) {
          const pull = ollamaHealth?.pull_command ? `\n${ollamaHealth.pull_command}` : "";
          alert(`${ollamaHealth?.message ?? "Ollama is not available."}${pull}`);
          return;
        }
        continue;
      }

      if (health && !health.ok) {
        if (isBillingRelatedError(health.message) && ollamaReady) {
          continue;
        }
        alert(health.message);
        return;
      }
    }

    const order = topoSort(nodes, edges);
    startRun(meta.name);

    // Reset all nodes to idle
    for (const nodeId of order) {
      updateNodeData(nodeId, { status: "idle" });
    }

    for (const nodeId of order) {
      if (useExecutionStore.getState().currentRun?.status === "cancelled") break;

      const node = nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      const data = node.data;

      // ── Memory nodes — passthrough ──────────────────────────────────────────
      if (data.role === AgentRole.Memory) {
        updateAgent(nodeId, { agentId: nodeId, agentName: data.name, status: "done", output: "(memory node — passthrough)" });
        updateNodeData(nodeId, { status: "done" });
        addEntry({ id: `${nodeId}-${Date.now()}`, timestamp: new Date().toISOString(), action: "workflow_loaded", agentId: nodeId, details: "memory passthrough", success: true });
        continue;
      }

      // ── Hook nodes ─────────────────────────────────────────────────────────
      if (data.role === AgentRole.Hook) {
        updateAgent(nodeId, { agentId: nodeId, agentName: data.name, status: "running" });
        updateNodeData(nodeId, { status: "running" });
        const workspace = useWorkflowStore.getState().meta.projectRoot || ".";

        if (data.preHook?.path) {
          try {
            const result = await invoke<HookResult>("execute_hook", {
              workspacePath: workspace,
              hookPath: data.preHook.path,
              agentId: nodeId,
              env: {},
            });
            updateAgent(nodeId, { status: "done", output: result.stdout, finishedAt: Date.now() });
          } catch (e) {
            updateAgent(nodeId, { status: "error", error: String(e), finishedAt: Date.now() });
          }
        } else {
          updateAgent(nodeId, { status: "done", output: "(no hook script)", finishedAt: Date.now() });
        }
        updateNodeData(nodeId, { status: "done" });
        continue;
      }

      // ── Agent nodes ────────────────────────────────────────────────────────
      updateAgent(nodeId, { agentId: nodeId, agentName: data.name, status: "running", startedAt: Date.now() });
      updateNodeData(nodeId, { status: "running" });

      const rawModel = data.model || "gpt-4o-mini";
      const selectedProvider = selectProviderForModel({
        mode: effectiveProvider,
        model: rawModel,
        hasOpenAIKey,
        hasAnthropicKey,
        ollamaModel: effectiveOllamaModel,
      });
      const model = selectedProvider.provider === "openai"
        ? resolveModel(selectedProvider.model)
        : selectedProvider.model;
      const key = selectedProvider.provider === "openai"
        ? openaiApiKey
        : selectedProvider.provider === "anthropic"
          ? apiKey
          : "";

      addEntry({
        id: `${nodeId}-start-${Date.now()}`,
        timestamp: new Date().toISOString(),
        action: "hook_executed",
        agentId: nodeId,
        details: selectedProvider.provider === "ollama"
          ? `Running ${effectiveOllamaModel} via Ollama fallback/local provider`
          : `Running ${model} via ${selectedProvider.provider}${rawModel !== model ? ` (alias: ${rawModel})` : ""}`,
        success: true,
      });

      try {
        const promptContent = data.promptSource.type === "inline"
          ? data.promptSource.content
          : `[System prompt from file: ${data.promptSource.path ?? ""}]`;

        const systemMsg = [
          `You are ${data.name}, a ${data.role} agent in the ${meta.name} workflow.`,
          data.description ? `\nYour role: ${data.description}` : "",
          `\nAllowed tools: ${data.tools.join(", ") || "none"}`,
          `\nMemory keys to read: ${data.memoryRead.join(", ") || "none"}`,
          `\nMemory keys to write: ${data.memoryWrite.join(", ") || "none"}`,
          promptContent ? `\n\n${promptContent}` : "",
        ].join("");

        const userMsg = `[Workflow execution] Please describe what you would do as ${data.name} for the current task in the ${meta.name} workflow. This is a demonstration run.`;

        const maxTok = Math.min(data.maxTokens || 1024, 2048);

        // Helper: call via Ollama fallback
        const callOllama = () =>
          invoke<string>("call_ollama_api", {
            model: effectiveOllamaModel,
            system: systemMsg,
            userMessage: userMsg,
            baseUrl: effectiveOllamaBaseUrl,
            maxTokens: maxTok,
          });

        let result: string;

        if (selectedProvider.provider === "ollama") {
          result = await callOllama();
        } else {
          if (!key && selectedProvider.requiresKey) {
            throw new Error(`No ${selectedProvider.provider} API key. Add it in Settings or set the provider key in the environment.`);
          }

          const reasoningEffort: string | null = (() => {
            if (selectedProvider.provider !== "openai") return null;
            if (data.thinkDepth && data.thinkDepth !== "none") return data.thinkDepth;
            return REASONING_EFFORT[rawModel] ?? null;
          })();

          try {
            result = await invoke<string>(
              selectedProvider.provider === "openai" ? "call_openai_api" : "call_claude_api",
              {
                model,
                system: systemMsg,
                userMessage: userMsg,
                apiKey: key,
                maxTokens: maxTok,
                ...(selectedProvider.provider === "openai" ? { reasoningEffort } : {}),
              }
            );
          } catch (primaryErr) {
            const errStr = String(primaryErr);
            if (shouldFallbackToOllama(errStr) && effectiveOllamaBaseUrl) {
              addEntry({
                id: `${nodeId}-fallback-${Date.now()}`,
                timestamp: new Date().toISOString(),
                action: "hook_executed",
                agentId: nodeId,
                details: `Billing/quota error - retrying with Ollama fallback (${effectiveOllamaModel})`,
                success: false,
              });
              result = (await callOllama()) + "\n[ran on Ollama fallback]";
            } else {
              throw primaryErr;
            }
          }
        }

        const tokenEstimate = Math.ceil((systemMsg.length + userMsg.length + result.length) / 4);
        updateAgent(nodeId, {
          status: "done",
          output: result,
          finishedAt: Date.now(),
          tokenEstimate,
          providerUsed: selectedProvider.provider,
          modelUsed: model,
        });
        updateNodeData(nodeId, {
          status: "done",
          tokens: { used: tokenEstimate, budget: data.tokens.budget },
        });
        addEntry({
          id: `${nodeId}-done-${Date.now()}`,
          timestamp: new Date().toISOString(),
          action: "hook_executed",
          agentId: nodeId,
          details: result.slice(0, 200),
          success: true,
        });

        // Non-blocking snapshot save
        const ctxDone = buildContextSnapshot({
          node,
          nodes,
          edges,
          agentRun: { agentId: nodeId, agentName: data.name, status: "done", output: result },
          artifacts: MOCK_ARTIFACTS,
        });
        createSnapshot(ctxDone, {
          workspacePath,
          workflowId: meta.name,
          runId: currentRun?.id,
          snapshotStatus: "completed",
        }).catch(console.error);
      } catch (e) {
        updateAgent(nodeId, { status: "error", error: String(e), finishedAt: Date.now() });
        updateNodeData(nodeId, { status: "error" });
        addEntry({
          id: `${nodeId}-err-${Date.now()}`,
          timestamp: new Date().toISOString(),
          action: "hook_executed",
          agentId: nodeId,
          details: String(e),
          success: false,
        });

        // Non-blocking snapshot save for failed run
        const ctxErr = buildContextSnapshot({
          node,
          nodes,
          edges,
          agentRun: { agentId: nodeId, agentName: data.name, status: "error", output: "" },
          artifacts: MOCK_ARTIFACTS,
        });
        createSnapshot(ctxErr, {
          workspacePath,
          workflowId: meta.name,
          runId: currentRun?.id,
          snapshotStatus: "failed",
          metadata: { error: String(e) },
        }).catch(console.error);
      }
    }

    const finalStatus = useExecutionStore.getState().currentRun?.status;
    if (finalStatus !== "cancelled") {
      finishRun("done");
    }
  }

  return { executeWorkflow, currentRun, isRunning, cancelRun };
}
