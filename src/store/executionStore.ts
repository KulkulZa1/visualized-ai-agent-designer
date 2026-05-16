import { create } from "zustand";
import type { WorkflowRun, AgentRun } from "@/types/execution";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  type LlmProvider,
} from "@/utils/providerConfig";

interface ExecutionState {
  currentRun: WorkflowRun | null;
  apiKey: string;          // Anthropic  sk-ant-...
  openaiApiKey: string;    // OpenAI     sk-...
  isRunning: boolean;
  llmProvider: LlmProvider;
  ollamaBaseUrl: string;
  ollamaModel: string;
  continueOnError: boolean;
}

interface ExecutionActions {
  startRun: (workflowName: string) => string;
  updateAgent: (agentId: string, partial: Partial<AgentRun>) => void;
  finishRun: (status: "done" | "error" | "cancelled") => void;
  setApiKey: (key: string) => void;
  setOpenaiApiKey: (key: string) => void;
  cancelRun: () => void;
  setLlmProvider: (p: LlmProvider) => void;
  setOllamaBaseUrl: (url: string) => void;
  setOllamaModel: (model: string) => void;
  setContinueOnError: (v: boolean) => void;
}

function loadKey(name: string): string {
  try { return localStorage.getItem(name) ?? ""; } catch { return ""; }
}

export const useExecutionStore = create<ExecutionState & ExecutionActions>()((set, get) => ({
  currentRun: null,
  apiKey: loadKey("harness_api_key"),
  openaiApiKey: loadKey("harness_openai_key"),
  isRunning: false,
  llmProvider: (loadKey("harness_llm_provider") || "auto") as LlmProvider,
  ollamaBaseUrl: loadKey("harness_ollama_url") || DEFAULT_OLLAMA_BASE_URL,
  ollamaModel: loadKey("harness_ollama_model") || DEFAULT_OLLAMA_MODEL,
  continueOnError: true,

  startRun: (workflowName) => {
    const id = `run-${Date.now()}`;
    const run: WorkflowRun = {
      id,
      workflowName,
      startedAt: Date.now(),
      status: "running",
      agents: {},
    };
    set({ currentRun: run, isRunning: true });
    return id;
  },

  updateAgent: (agentId, partial) =>
    set((state) => {
      if (!state.currentRun) return {};
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

  setApiKey: (key) => {
    try { localStorage.setItem("harness_api_key", key); } catch {}
    set({ apiKey: key });
  },

  setOpenaiApiKey: (key) => {
    try { localStorage.setItem("harness_openai_key", key); } catch {}
    set({ openaiApiKey: key });
  },

  cancelRun: () => {
    const { currentRun } = get();
    if (!currentRun) return;
    set({
      currentRun: { ...currentRun, status: "cancelled", finishedAt: Date.now() },
      isRunning: false,
    });
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

  setContinueOnError: (v) => set({ continueOnError: v }),
}));
