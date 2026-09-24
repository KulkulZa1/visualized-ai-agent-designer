import { create } from "zustand";

/**
 * commandConsentStore — shell commands an agent wants to run, waiting for the
 * user's answer (CommandConsentDialog). Every command needs its own approval.
 */

export type CommandDecision = "allow" | "deny";

export interface CommandRequest {
  id: number;
  runId: string;
  agentName: string;
  command: string;
  workspacePath: string;
}

interface CommandConsentState {
  /** Oldest first; the dialog shows the first one. */
  queue: CommandRequest[];
  /** Ask the user; resolves with their answer ("deny" if the run ends first). */
  request: (details: Omit<CommandRequest, "id">) => Promise<CommandDecision>;
  answer: (id: number, decision: CommandDecision) => void;
  /** Deny a run's pending requests: it was stopped or has ended. */
  denyRun: (runId: string) => void;
}

const resolvers = new Map<number, (decision: CommandDecision) => void>();
let nextId = 1;

export const useCommandConsentStore = create<CommandConsentState>()((set, get) => ({
  queue: [],

  request: (details) =>
    new Promise<CommandDecision>((resolve) => {
      const id = nextId++;
      resolvers.set(id, resolve);
      set((state) => ({ queue: [...state.queue, { ...details, id }] }));
    }),

  answer: (id, decision) => {
    const resolve = resolvers.get(id);
    resolvers.delete(id);
    set((state) => ({ queue: state.queue.filter((r) => r.id !== id) }));
    resolve?.(decision);
  },

  denyRun: (runId) => {
    for (const r of get().queue) if (r.runId === runId) get().answer(r.id, "deny");
  },
}));
