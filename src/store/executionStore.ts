import { create } from "zustand";
import type { WorkflowRun, AgentRun } from "@/types/execution";
import { useCommandConsentStore } from "@/store/commandConsentStore";
import { recordChange } from "@/services/execution/changeLog";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_NUM_CTX,
  DEFAULT_REQUEST_TIMEOUT_SECS,
  parseNumCtx,
  parseRequestTimeoutSecs,
  type LlmProvider,
} from "@/utils/providerConfig";

interface ExecutionState {
  currentRun: WorkflowRun | null;
  apiKey: string;           // Anthropic  sk-ant-...
  openaiApiKey: string;     // OpenAI     sk-...
  ollamaApiKey: string;     // Ollama Cloud / authenticated remote (empty = no auth)
  customApiUrl: string;     // Custom OpenAI-compatible endpoint base URL
  customApiKey: string;     // Custom endpoint API key (optional)
  customApiModel: string;   // Model name to use with the custom endpoint; empty: each node's own model
  isRunning: boolean;
  llmProvider: LlmProvider;
  ollamaBaseUrl: string;
  ollamaModel: string;
  /** Ollama's context window in tokens, sent as num_ctx; 0: the server's own default. */
  ollamaNumCtx: number;
  /** Seconds one model call may take in total (30 to 86400). */
  requestTimeoutSecs: number;
  continueOnError: boolean;
}

interface ExecutionActions {
  /** Starts a run; the engine passes its run id. `workspacePath` is the folder the run works in
   *  (the one the engine was given): the run's changes are relative to it, and Revert checks it. */
  startRun: (workflowName: string, id?: string, workspacePath?: string) => string;
  updateAgent: (agentId: string, partial: Partial<AgentRun>) => void;
  finishRun: (status: "done" | "error" | "cancelled") => void;
  /** Clears a finished run's per-agent results and keeps the run: its workflow name, status,
   *  timing, workspace folder and changed files (Changes, Revert). Another workflow's nodes
   *  reuse the ids (agent-0, ...), so the results would show on them; the files the agents
   *  wrote stay on disk, so their change log stays too. Late agent updates of a cleared run
   *  are dropped. A run that is still going is kept as it is. */
  clearRun: () => void;
  recordFileChange: (path: string, before: string | null, after: string, agent: string) => void;
  forgetFileChange: (path: string) => void;
  setApiKey: (key: string) => void;
  setOpenaiApiKey: (key: string) => void;
  setOllamaApiKey: (key: string) => void;
  setCustomApiUrl: (url: string) => void;
  setCustomApiKey: (key: string) => void;
  setCustomApiModel: (model: string) => void;
  cancelRun: () => void;
  setLlmProvider: (p: LlmProvider) => void;
  setOllamaBaseUrl: (url: string) => void;
  setOllamaModel: (model: string) => void;
  /** Ignores a value that is not a whole number of 0 or more. */
  setOllamaNumCtx: (tokens: number) => void;
  /** Ignores a value that is not whole seconds from 30 to 86400. */
  setRequestTimeoutSecs: (secs: number) => void;
  setContinueOnError: (v: boolean) => void;
}

function loadKey(name: string): string {
  try { return localStorage.getItem(name) ?? ""; } catch { return ""; }
}

/** A saved number; the default when none is saved or the saved text is not a valid value. */
function loadNumber(name: string, parse: (text: string) => number | null, fallback: number): number {
  return parse(loadKey(name)) ?? fallback;
}

export const useExecutionStore = create<ExecutionState & ExecutionActions>()((set, get) => ({
  currentRun: null,
  apiKey: loadKey("harness_api_key"),
  openaiApiKey: loadKey("harness_openai_key"),
  ollamaApiKey: loadKey("harness_ollama_key"),
  customApiUrl: loadKey("harness_custom_url"),
  customApiKey: loadKey("harness_custom_key"),
  customApiModel: loadKey("harness_custom_model"),
  isRunning: false,
  llmProvider: (loadKey("harness_llm_provider") || "auto") as LlmProvider,
  ollamaBaseUrl: loadKey("harness_ollama_url") || DEFAULT_OLLAMA_BASE_URL,
  ollamaModel: loadKey("harness_ollama_model") || DEFAULT_OLLAMA_MODEL,
  ollamaNumCtx: loadNumber("harness_ollama_num_ctx", parseNumCtx, DEFAULT_OLLAMA_NUM_CTX),
  requestTimeoutSecs: loadNumber("harness_request_timeout_secs", parseRequestTimeoutSecs, DEFAULT_REQUEST_TIMEOUT_SECS),
  continueOnError: true,

  startRun: (workflowName, id = `run-${Date.now()}`, workspacePath) => {
    const run: WorkflowRun = {
      id,
      workflowName,
      startedAt: Date.now(),
      status: "running",
      agents: {},
      ...(workspacePath === undefined ? {} : { workspacePath }),
    };
    set({ currentRun: run, isRunning: true });
    return id;
  },

  updateAgent: (agentId, partial) =>
    set((state) => {
      // A cleared run stays cleared: an agent that was stopped and finishes late must not
      // bring its result back onto another workflow's nodes.
      if (!state.currentRun || state.currentRun.agentsCleared) return {};
      const prev = state.currentRun.agents[agentId] ?? {
        agentId,
        agentName: agentId,
        status: "idle" as const,
      };
      return {
        currentRun: {
          ...state.currentRun,
          agents: {
            ...state.currentRun.agents,
            [agentId]: { ...prev, ...partial },
          },
        },
      };
    }),

  finishRun: (status) =>
    set((state) => ({
      currentRun: state.currentRun
        ? { ...state.currentRun, status, finishedAt: Date.now() }
        : null,
      isRunning: false,
    })),

  clearRun: () => set((state) => {
    const run = state.currentRun;
    if (state.isRunning || !run || run.agentsCleared) return {};
    return { currentRun: { ...run, agents: {}, agentsCleared: true } };
  }),

  recordFileChange: (path, before, after, agent) =>
    set((state) => state.currentRun
      ? { currentRun: { ...state.currentRun,
          changes: recordChange(state.currentRun.changes ?? [], path, before, after, agent) } }
      : {}),

  forgetFileChange: (path) =>
    set((state) => state.currentRun
      ? { currentRun: { ...state.currentRun,
          changes: (state.currentRun.changes ?? []).filter((c) => c.path !== path) } }
      : {}),

  setApiKey: (key) => {
    try { localStorage.setItem("harness_api_key", key); } catch {}
    set({ apiKey: key });
  },

  setOpenaiApiKey: (key) => {
    try { localStorage.setItem("harness_openai_key", key); } catch {}
    set({ openaiApiKey: key });
  },

  setOllamaApiKey: (key) => {
    try { localStorage.setItem("harness_ollama_key", key); } catch {}
    set({ ollamaApiKey: key });
  },

  setCustomApiUrl: (url) => {
    try { localStorage.setItem("harness_custom_url", url); } catch {}
    set({ customApiUrl: url });
  },

  setCustomApiKey: (key) => {
    try { localStorage.setItem("harness_custom_key", key); } catch {}
    set({ customApiKey: key });
  },

  setCustomApiModel: (model) => {
    try { localStorage.setItem("harness_custom_model", model); } catch {}
    set({ customApiModel: model });
  },

  cancelRun: () => {
    const { currentRun } = get();
    if (!currentRun) return;
    set({
      currentRun: { ...currentRun, status: "cancelled", finishedAt: Date.now() },
      isRunning: false,
    });
    // A command still waiting for approval must not run after Stop.
    useCommandConsentStore.getState().denyRun(currentRun.id);
  },

  setLlmProvider: (p) => {
    try { localStorage.setItem("harness_llm_provider", p); } catch {}
    set({ llmProvider: p });
  },

  setOllamaBaseUrl: (url) => {
    try { localStorage.setItem("harness_ollama_url", url); } catch {}
    set({ ollamaBaseUrl: url });
  },

  setOllamaModel: (model) => {
    try { localStorage.setItem("harness_ollama_model", model); } catch {}
    set({ ollamaModel: model });
  },

  setOllamaNumCtx: (tokens) => {
    if (parseNumCtx(String(tokens)) === null) return;
    try { localStorage.setItem("harness_ollama_num_ctx", String(tokens)); } catch {}
    set({ ollamaNumCtx: tokens });
  },

  setRequestTimeoutSecs: (secs) => {
    if (parseRequestTimeoutSecs(String(secs)) === null) return;
    try { localStorage.setItem("harness_request_timeout_secs", String(secs)); } catch {}
    set({ requestTimeoutSecs: secs });
  },

  setContinueOnError: (v) => set({ continueOnError: v }),
}));
