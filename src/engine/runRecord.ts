/**
 * A run's saved record: .harness/runs/<runId>/run.json in the workspace, written
 * as the run goes (docs/HEADLESS.md). `harness run --resume` reuses the nodes it
 * saved as done when nothing that shapes their work has changed.
 */
import type { AgentNodeData } from "@/types/agent";
import type { AuditEntry } from "@/types/audit";
import type { AgentStatus, FileChange, NodeUsage, SubAgentRecord, WorkflowRun } from "@/types/execution";
import type { InvokeFn } from "@/services/model-providers/providerAdapter";
import { isForwardEdge } from "@/services/execution/parallelScheduler";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import type { ProviderSettings } from "@/engine/runWorkflow";

export const RUN_RECORD_VERSION = 1;

/** Where a run's record is, relative to the workspace. */
export const runRecordPath = (runId: string) => `.harness/runs/${runId}/run.json`;

/** A node's key in the record: its place in the workflow file ("agent-<i>"), so
 *  a run in the app and a run of the saved file name the same node alike. */
export const savedNodeId = (index: number) => `agent-${index}`;

export interface NodeRecord {
  agent: string;
  status: AgentStatus;
  output?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  modelUsed?: string;
  providerUsed?: string;
  tokenEstimate?: number;
  /** The tokens the node's model calls used, as the providers reported them (see NodeUsage). Set on an agent
   *  node that ran; absent in a record from before it existed (it is additive: the record's version stays 1),
   *  and on a node that made no model call. A resume carries a reused node's on. */
  usage?: NodeUsage;
  revision?: number;
  subAgents?: SubAgentRecord[];
  /** What shapes the node's work; resume re-runs the node when it changes. */
  definitionHash: string;
}

export interface RunRecord {
  version: typeof RUN_RECORD_VERSION;
  runId: string;
  /** The workflow file, relative to the workspace, and the SHA-256 of its text (harness run). */
  workflow: { name: string; path: string | null; hash: string | null };
  task: string;
  /** The run's provider settings, without keys and without the model call timeout. `ollamaNumCtx` is
   *  Ollama's context window for the run (0: none was sent); absent in a record from before it existed.
   *  Recorded, never compared: a resume reuses finished agents whatever the window was. */
  provider: Omit<
    ProviderSettings,
    "apiKey" | "openaiApiKey" | "ollamaApiKey" | "customApiKey" | "ollamaNumCtx" | "requestTimeoutSecs"
  > & { ollamaNumCtx?: number };
  status: WorkflowRun["status"];
  startedAt: number;
  finishedAt?: number;
  /** 1 for the first run; each resume adds 1. */
  attempts: number;
  nodes: Record<string, NodeRecord>;
  /** The text each node passes downstream (a memory node's differs from its shown output). */
  outputs: Record<string, string>;
  memory: Record<string, string>;
  gatewayRoutes: Record<string, string>;
  changes: FileChange[];
  audit: AuditEntry[];
  /** For each Hook node with a script, whether or not it runs without asking: the fingerprint
   *  harness-core's hook_fingerprint gave (SHA-256, hex) of the script's bytes, as the run first found
   *  them, and of the node's env; null if there was no such script; UNVERIFIABLE_HOOK if harness-core
   *  could not give one. A resume carries these on and compares an unasked hook's with them, not with
   *  what it finds when it starts. Always written ({} when there is none); absent in a record from
   *  before it existed. */
  hookScripts?: Record<string, string | null>;
}

/** A hookScripts entry for a hook whose fingerprint could not be taken when the run started:
 *  harness-core could not read the script, or is older than the app and has no hook_fingerprint.
 *  A fingerprint is 64 hex digits, so nothing ever equals this: the hook is not run unasked, in
 *  that run or in any resume of it. */
export const UNVERIFIABLE_HOOK = "unverifiable";

/** The baselines a resume starts from: the record's hookScripts, kept to entries of the right shape;
 *  undefined for a record from before the field (that attempt takes the baselines itself). A field
 *  that is there but malformed counts as empty, so that no hook that runs without asking is
 *  trusted on the strength of it. */
export function savedHookScripts(record: RunRecord | undefined): Record<string, string | null> | undefined {
  const saved: unknown = record?.hookScripts;
  if (saved === undefined) return undefined;
  const kept: Record<string, string | null> = {};
  if (saved !== null && typeof saved === "object" && !Array.isArray(saved)) {
    for (const [key, value] of Object.entries(saved)) {
      if (typeof value === "string" || value === null) kept[key] = value;
    }
  }
  return kept;
}

/** A short fingerprint of a text, to notice a change (cyrb53 by bryc, public
 *  domain). Not for security. */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** What shapes a node's work, as a fingerprint. `prompt` is the prompt's text:
 *  a file prompt's content, so an edited file counts as a change. */
export function definitionHash(data: AgentNodeData, prompt: string): string {
  return fingerprint(JSON.stringify([
    data.role, data.model, data.tools, data.maxSteps, data.timeoutSeconds, data.maxTokens, data.thinkDepth ?? null,
    data.promptSource, prompt, data.memoryRead, data.memoryWrite, data.preHook ?? null,
  ]));
}

/** The nodes a resume reuses: saved as done, unchanged since (same definition
 *  hash), and fed only by nodes that are reused too. `hashes` are today's, by node id. */
export function reusableNodes(graph: WorkflowGraph, record: RunRecord, hashes: ReadonlyMap<string, string>): Set<string> {
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const decided = new Map<string, boolean>();
  const reusable = (id: string): boolean => {
    const known = decided.get(id);
    if (known !== undefined) return known;
    decided.set(id, false); // nothing on a cycle is reused
    const saved = record.nodes[savedNodeId(index.get(id) ?? -1)];
    const ok = saved?.status === "done"
      && saved.definitionHash === hashes.get(id)
      && graph.edges
        .filter((e) => e.target === id && isForwardEdge(e) && index.has(e.source))
        .every((e) => reusable(e.source));
    decided.set(id, ok);
    return ok;
  };
  return new Set(graph.nodes.map((n) => n.id).filter(reusable));
}

/** Writes the record with the Rust command, which replaces the file atomically. */
export function writeRunRecord(invoke: InvokeFn, workspacePath: string, record: RunRecord): Promise<void> {
  return invoke<void>("write_workspace_file", {
    workspacePath, relativePath: runRecordPath(record.runId), content: `${JSON.stringify(record, null, 2)}\n`,
  });
}
