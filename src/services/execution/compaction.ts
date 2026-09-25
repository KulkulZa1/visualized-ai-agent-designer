/**
 * compaction — keeps a long agent conversation within the node's Token budget.
 * Once it passes 75% of the budget, the older steps are replaced by a progress
 * note the model writes. The newest tool exchange stays verbatim, so every tool
 * call still has its results: a history every provider accepts.
 */
import type { ChatMessage } from "@/services/model-providers/providerAdapter";

const COMPACT_AT = 0.75;
const NOTE_MARKER = "\n\nPROGRESS SO FAR (summary of earlier steps):\n";
const RESULT_CHARS_FOR_SUMMARY = 4000;

export const SUMMARY_INSTRUCTIONS =
  "Summarize the work so far for the agent that will continue it: the task, what was found, " +
  "files read or changed, commands run and their results, and what remains. Be specific " +
  "(paths, names, errors, numbers). Reply with the summary only.";

/** Estimated tokens: characters ÷ 4, like estimateTokens. */
export function textTokens(...parts: string[]): number {
  return Math.ceil(parts.reduce((n, p) => n + p.length, 0) / 4);
}

export function historyTokens(system: string, messages: ChatMessage[]): number {
  return textTokens(system, JSON.stringify(messages));
}

export function needsCompaction(tokens: number, budget: number): boolean {
  return budget > 0 && tokens > budget * COMPACT_AT;
}

/** Keep the start and the end of a long text, at most `max` characters. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - 60);
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}\n[… ${text.length - keep} characters cut …]\n${text.slice(text.length - (keep - head))}`;
}

/** The summarizer sees at most about the budget's worth of text. */
function summaryInput(text: string, budget: number): string {
  return truncateMiddle(text, Math.max(8000, budget * 4));
}

function render(messages: ChatMessage[]): string {
  return messages.map((m) => {
    if (m.role === "user") return `USER:\n${m.text}`;
    if (m.role === "assistant") {
      const calls = m.toolCalls.map((c) => `CALLED ${c.name}(${JSON.stringify(c.args)})`);
      return [`ASSISTANT:${m.text ? `\n${m.text}` : ""}`, ...calls].join("\n");
    }
    return m.toolResults
      .map((r) => `RESULT of ${r.name}${r.isError ? " (error)" : ""}:\n${truncateMiddle(r.content, RESULT_CHARS_FOR_SUMMARY)}`)
      .join("\n");
  }).join("\n\n");
}

/** Cut the kept tool results in the middle when they alone are too big. */
function fit(kept: ChatMessage[], budget: number): ChatMessage[] {
  const chars = Math.floor(budget * 4 * COMPACT_AT / 2); // room for the task, the note and the reply
  return kept.map((m) => m.role !== "tool" ? m : {
    ...m,
    toolResults: m.toolResults.map((r) => ({
      ...r, content: truncateMiddle(r.content, Math.floor(chars / m.toolResults.length)),
    })),
  });
}

/**
 * Replace the older steps of a native conversation with a progress note: the
 * first user message (task + note), then the newest assistant turn and its tool
 * results. Returns the steps folded into the note (0: nothing to compact).
 */
export async function compactNative(
  messages: ChatMessage[], budget: number, summarize: (text: string) => Promise<string>,
): Promise<{ messages: ChatMessage[]; steps: number }> {
  const first = messages[0];
  const older = messages.slice(1, -2);
  if (first?.role !== "user" || older.length === 0) return { messages, steps: 0 };
  const task = first.text.split(NOTE_MARKER)[0];
  const note = await summarize(summaryInput(`TASK:\n${first.text}\n\nSTEPS SO FAR:\n${render(older)}`, budget));
  return {
    messages: [{ role: "user", text: `${task}${NOTE_MARKER}${note.trim()}` }, ...fit(messages.slice(-2), budget)],
    steps: older.filter((m) => m.role === "assistant").length,
  };
}

/** The text-protocol conversation after compaction: the task, a new note, the newest step. */
export async function compactText(
  task: string, conversation: string, lastStep: string, summarize: (text: string) => Promise<string>,
  budget = 0,
): Promise<string> {
  const note = await summarize(summaryInput(`TASK AND STEPS SO FAR:\n${conversation}`, budget));
  return `${task}${NOTE_MARKER}${note.trim()}\n\n${lastStep}`;
}
