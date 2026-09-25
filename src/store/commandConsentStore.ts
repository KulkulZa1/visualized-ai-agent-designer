import { create } from "zustand";

/**
 * commandConsentStore — shell commands an agent wants to run, waiting for the
 * user's answer (CommandConsentDialog). Every command needs its own approval,
 * unless the user allowed that exact command for the rest of the run.
 */

/** The user's answer in the dialog. */
export type CommandDecision = "allow" | "allow-run" | "deny";
/** What a request resolves with: the answer, or "granted" when the exact command
 *  was allowed for this run earlier (no prompt). */
export type CommandApproval = CommandDecision | "granted";

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
  /** Commands allowed for the rest of a run, by run id. */
  grants: Record<string, string[]>;
  /** Ask the user; resolves with their answer ("deny" if the run ends first). */
  request: (details: Omit<CommandRequest, "id">) => Promise<CommandApproval>;
  answer: (id: number, decision: CommandDecision) => void;
  /** The run was stopped or has ended: deny its pending requests, drop its grants. */
  denyRun: (runId: string) => void;
}

const resolvers = new Map<number, (approval: CommandApproval) => void>();
let nextId = 1;

export const useCommandConsentStore = create<CommandConsentState>()((set, get) => ({
  queue: [],
  grants: {},

  request: (details) => {
    if (get().grants[details.runId]?.includes(details.command)) return Promise.resolve("granted");
    return new Promise<CommandApproval>((resolve) => {
      const id = nextId++;
      resolvers.set(id, resolve);
      set((state) => ({ queue: [...state.queue, { ...details, id }] }));
    });
  },

  answer: (id, decision) => {
    const request = get().queue.find((r) => r.id === id);
    if (!request) return;
    // Allowed for this run: the same command waiting from another agent runs too.
    const settled = decision === "allow-run"
      ? get().queue.filter((r) => r.runId === request.runId && r.command === request.command)
      : [request];
    set((state) => ({
      queue: state.queue.filter((r) => !settled.includes(r)),
      grants: decision === "allow-run"
        ? { ...state.grants, [request.runId]: [...(state.grants[request.runId] ?? []), request.command] }
        : state.grants,
    }));
    for (const r of settled) {
      resolvers.get(r.id)?.(r === request ? decision : "granted");
      resolvers.delete(r.id);
    }
  },

  denyRun: (runId) => {
    for (const r of get().queue) if (r.runId === runId) get().answer(r.id, "deny");
    set((state) => ({
      grants: Object.fromEntries(Object.entries(state.grants).filter(([id]) => id !== runId)),
    }));
  },
}));
