/**
 * agentLoop — one agent's model ⇄ tool loop, shared by workflow nodes and sub-agents.
 *
 * Native mode: the model gets JSON-schema tool definitions and a real message
 * history, and every tool call of a turn is answered in one tool message.
 * Text mode: the `<tool_call>` text protocol, one tool per step. It is used when
 * the agent has no runnable tools, when the provider or model refuses native
 * tools, or after a first-call error the caller accepts (billing → Ollama).
 *
 * Either way only the tools offered to the agent run.
 */

import {
  buildToolInstructions,
  parseToolCall,
  runnableTools,
  stripToolCall,
  toolDefinitions,
  toolForNativeName,
  type ToolCall,
  type ToolSpec,
} from "@/services/execution/toolExecutor";
import {
  estimateTokens,
  type ChatMessage,
  type ChatReply,
  type NativeToolCall,
  type NativeToolResult,
} from "@/services/model-providers/providerAdapter";

export interface AgentLoopOptions {
  system: string;
  userMessage: string;
  /** The agent's tools; only the runnable ones are offered. */
  tools: string[];
  /** Model calls allowed. */
  maxSteps: number;
  /** Epoch ms after which no new model call starts. */
  deadline: number;
  timeoutMessage: string;
  isCancelled: () => boolean;
  callTurn: (system: string, messages: ChatMessage[], tools: ToolSpec[]) => Promise<ChatReply>;
  callText: (system: string, userMessage: string) => Promise<string>;
  /** Runs one offered tool (by its tool name) and returns the result text. */
  runTool: (call: ToolCall) => Promise<string>;
  onToolCall?: (call: ToolCall) => void;
  /** Skip native tools: this provider/model refused them earlier in the run. */
  preferText?: boolean;
  /** First-call errors that should be retried with the text protocol. */
  fallbackOnError?: (error: unknown) => boolean;
  /** Tools whose calls in one turn may run at the same time (sub-agents). */
  concurrentTools?: string[];
  maxConcurrent?: number;
}

export interface AgentLoopResult {
  text: string;
  toolCalls: number;
  mode: "native" | "text";
  /** The provider or model refused native tools. */
  nativeRefused: boolean;
  tokenEstimate: number;
}

/** Reject once `deadline` (epoch ms) passes or the run is stopped. The provider
 *  call itself cannot be aborted; its late result is discarded. Giving up on Stop
 *  lets the run settle (and a new run start) without waiting for the call. */
export function beforeDeadline<T>(
  work: Promise<T>, deadline: number, message: string, isCancelled: () => boolean,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(0, deadline - Date.now()));
    poll = setInterval(() => { if (isCancelled()) reject(new Error("Run stopped")); }, 200);
  });
  return Promise.race([work, expired]).finally(() => {
    clearTimeout(timer);
    clearInterval(poll);
  });
}

// A reply cut off here may carry truncated tool input: never run it.
const TRUNCATED = new Set(["max_tokens", "length"]);

function checkpoint(opts: AgentLoopOptions): void {
  if (opts.isCancelled()) throw new Error("Run stopped");
  // A tool step may have used up the budget: don't start another paid call.
  if (Date.now() >= opts.deadline) throw new Error(opts.timeoutMessage);
}

function guarded<T>(opts: AgentLoopOptions, work: Promise<T>): Promise<T> {
  return beforeDeadline(work, opts.deadline, opts.timeoutMessage, opts.isCancelled);
}

/** Resolve a call to an offered tool and run it; refuse anything else. */
async function runOffered(opts: AgentLoopOptions, call: ToolCall): Promise<string> {
  const tool = toolForNativeName(call.name, opts.tools);
  if (!tool) return `[error] Tool "${call.name}" is not available to this agent.`;
  const resolved = { name: tool, args: call.args };
  opts.onToolCall?.(resolved);
  return opts.runTool(resolved);
}

async function answer(opts: AgentLoopOptions, call: NativeToolCall): Promise<NativeToolResult> {
  // Stop may have been pressed while the model was answering or a tool ran.
  if (opts.isCancelled()) throw new Error("Run stopped");
  const content = await runOffered(opts, call);
  return { id: call.id, name: call.name, content, isError: content.startsWith("[error]") };
}

/** Answer every call of a turn, in call order. Calls to concurrent tools run in
 *  parallel (up to maxConcurrent); all other tools run one at a time. */
async function answerAll(opts: AgentLoopOptions, calls: NativeToolCall[]): Promise<NativeToolResult[]> {
  const results: NativeToolResult[] = new Array(calls.length);
  const concurrent = new Set(opts.concurrentTools ?? []);
  const indexes = calls.map((_, i) => i);
  const isConcurrent = (i: number) => concurrent.has(toolForNativeName(calls[i].name, opts.tools) ?? "");
  const run = async (i: number) => { results[i] = await answer(opts, calls[i]); };

  const parallel = indexes.filter(isConcurrent);
  let next = 0;
  const worker = async () => { while (next < parallel.length) await run(parallel[next++]); };
  await Promise.all([
    (async () => { for (const i of indexes.filter((i) => !isConcurrent(i))) await run(i); })(),
    ...Array.from({ length: Math.min(opts.maxConcurrent ?? 1, parallel.length) }, worker),
  ]);
  return results;
}

async function runNative(
  opts: AgentLoopOptions, defs: ToolSpec[],
): Promise<AgentLoopResult | "refused" | "fallback"> {
  const messages: ChatMessage[] = [{ role: "user", text: opts.userMessage }];
  let toolCalls = 0;
  let last = "";
  const done = (text: string): AgentLoopResult => ({
    text, toolCalls, mode: "native", nativeRefused: false,
    tokenEstimate: estimateTokens(opts.system, JSON.stringify(messages), text),
  });

  for (let step = 0; step < opts.maxSteps; step++) {
    checkpoint(opts);
    let reply: ChatReply;
    try {
      reply = await guarded(opts, opts.callTurn(opts.system, messages, defs));
    } catch (e) {
      if (step === 0 && !opts.isCancelled() && opts.fallbackOnError?.(e)) return "fallback";
      throw e;
    }
    if (!reply.nativeToolsSupported) {
      if (step === 0) return "refused";
      throw new Error("The provider stopped accepting tool definitions during the run.");
    }
    if (reply.toolCalls.length === 0) return done(reply.text);
    if (reply.finishReason === "refusal") return done(reply.text || "[The model declined the request.]");
    if (TRUNCATED.has(reply.finishReason)) {
      throw new Error("The model's reply was cut off at Max tokens in the middle of a tool call. Raise Max tokens.");
    }

    messages.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls });
    messages.push({ role: "tool", toolResults: await answerAll(opts, reply.toolCalls) });
    toolCalls += reply.toolCalls.length;
    last = reply.text;
  }
  return done(`[Reached max steps (${opts.maxSteps}).${last ? ` Last reply:\n${last.slice(-500)}` : ""}]`);
}

async function runText(opts: AgentLoopOptions, nativeRefused: boolean): Promise<AgentLoopResult> {
  const system = [opts.system, buildToolInstructions(runnableTools(opts.tools))].filter(Boolean).join("\n\n");
  let message = opts.userMessage;
  let toolCalls = 0;
  let final: string | null = null;

  for (let step = 0; step < opts.maxSteps; step++) {
    checkpoint(opts);
    const reply = await guarded(opts, opts.callText(system, message));
    const call = parseToolCall(reply);
    if (!call) {
      final = reply;
      break;
    }
    if (opts.isCancelled()) throw new Error("Run stopped");
    toolCalls++;
    const result = await runOffered(opts, call);
    const before = stripToolCall(reply);
    message =
      `${message}\n\n` +
      `[Step ${toolCalls}: called ${call.name}]\n` +
      (before ? `${before}\n` : "") +
      `<tool_result>${result}</tool_result>\n\n` +
      `Now continue your task based on the tool result above.`;
  }

  const text = final ?? `[Reached max steps (${opts.maxSteps}). Last context:\n${message.slice(-500)}]`;
  return { text, toolCalls, mode: "text", nativeRefused, tokenEstimate: estimateTokens(system, message, text) };
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const defs = opts.preferText ? [] : toolDefinitions(opts.tools);
  if (defs.length === 0) return runText(opts, false);
  const outcome = await runNative(opts, defs);
  if (outcome === "refused") return runText(opts, true);
  if (outcome === "fallback") return runText(opts, false);
  return outcome;
}
