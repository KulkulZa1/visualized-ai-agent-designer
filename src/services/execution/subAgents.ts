/**
 * subAgents — `subagent_dispatch`: an agent starts helper agents while it runs.
 *
 * A helper gets a fresh context (its brief is the whole conversation), a subset
 * of its parent's tools (never bash), and its parent's provider, model, deadline
 * and Stop.
 * Helpers cannot start helpers (one level deep), one node run starts at most
 * MAX_SUBAGENTS_PER_NODE of them, and the parent gets each helper's final report
 * as the tool result.
 */

import { buildSystemMessage } from "@/services/model-providers/providerAdapter";
import { runnableTools, toolForNativeName } from "@/services/execution/toolExecutor";
import { usesWorkspace } from "@/services/execution/projectInstructions";
import type { AgentLoopResult } from "@/services/execution/agentLoop";
import type { SubAgentRecord } from "@/types/execution";

export const SUBAGENT_TOOL = "subagent_dispatch";
export const MAX_SUBAGENTS_PER_NODE = 5;
export const MAX_CONCURRENT_SUBAGENTS = 3;

export interface SubAgentRun {
  name: string;
  system: string;
  userMessage: string;
  tools: string[];
}

export interface SubAgentRunnerOptions {
  parentName: string;
  workflowName: string;
  parentTools: string[];
  /** Runs the helper's loop with the parent's provider, deadline and Stop. */
  runLoop: (child: SubAgentRun) => Promise<AgentLoopResult>;
  onEvent?: (message: string, success: boolean) => void;
  /** Each helper's state when it starts and when it finishes (activity panel). */
  onUpdate?: (record: SubAgentRecord) => void;
  /** True once the run is stopped: a helper ending then is "stopped", not failed. */
  isCancelled?: () => boolean;
  /** The workspace's AGENTS.md, for helpers that work in the workspace. */
  projectInstructions?: string;
}

const HELPER_INSTRUCTIONS =
  "Do the task in the user message and reply with a concise final report of what you found or did. " +
  "No one can answer questions, so make reasonable assumptions and state them in the report.";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function createSubAgentRunner(opts: SubAgentRunnerOptions) {
  let started = 0;
  let tokens = 0;
  // Never subagent_dispatch (helpers stay one level deep) or bash (only the
  // workflow's own agents ask the user to approve commands).
  const allowed = runnableTools(opts.parentTools).filter((t) => t !== SUBAGENT_TOOL && t !== "bash");

  async function dispatch(args: Record<string, unknown>): Promise<string> {
    const task = text(args.task);
    if (!task) return `[error] ${SUBAGENT_TOOL} requires a 'task': the complete brief for the helper.`;
    if (started >= MAX_SUBAGENTS_PER_NODE) {
      return `[error] Sub-agent limit reached (${MAX_SUBAGENTS_PER_NODE} per node run). ` +
        "Finish the task with the reports you have.";
    }
    started++;
    const name = text(args.name) || `${opts.parentName} helper ${started}`;
    // A helper gets the tools it asks for (by tool or native name), but only ones its parent has.
    const requested = Array.isArray(args.tools)
      ? args.tools.map((t) => toolForNativeName(String(t), opts.parentTools) ?? String(t))
      : allowed;
    const tools = allowed.filter((t) => requested.includes(t));
    const system = buildSystemMessage({
      agentName: name, role: "worker", workflowName: opts.workflowName,
      description: `Helper started by ${opts.parentName}.`,
      tools, memoryRead: [], memoryWrite: [], promptContent: HELPER_INSTRUCTIONS,
      projectInstructions: usesWorkspace(tools) ? opts.projectInstructions : undefined,
    });

    const record: SubAgentRecord = {
      id: `sub-${started}`, name, task, tools, status: "running", startedAt: Date.now(),
    };
    opts.onUpdate?.(record);
    opts.onEvent?.(`↳ Sub-agent "${name}" started by ${opts.parentName}: ${task.slice(0, 120)}`, true);
    try {
      const result = await opts.runLoop({ name, system, userMessage: task, tools });
      tokens += result.tokenEstimate;
      opts.onUpdate?.({
        ...record, status: "done", output: result.text, toolCalls: result.toolCalls, finishedAt: Date.now(),
      });
      opts.onEvent?.(`✓ Sub-agent "${name}" reported (${result.text.length} chars)`, true);
      return `Report from ${name}:\n${result.text}`;
    } catch (e) {
      if (opts.isCancelled?.()) {
        opts.onUpdate?.({ ...record, status: "stopped", finishedAt: Date.now() });
        opts.onEvent?.(`■ Sub-agent "${name}" stopped`, true);
        return `[error] Sub-agent ${name} was stopped.`;
      }
      opts.onUpdate?.({ ...record, status: "error", error: String(e), finishedAt: Date.now() });
      opts.onEvent?.(`✗ Sub-agent "${name}" failed: ${String(e)}`, false);
      return `[error] Sub-agent ${name} failed: ${String(e)}`;
    }
  }

  return { dispatch, tokenEstimate: () => tokens };
}
