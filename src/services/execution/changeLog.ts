/**
 * changeLog — the files a run's agents changed, for the Changes dialog and
 * revert: one entry per file with its content before the run first changed it,
 * the latest content, and the agents that changed it.
 */
import type { FileChange } from "@/types/execution";

export function normalizeChangePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

export function recordChange(
  changes: FileChange[], path: string, before: string | null, after: string, agent: string,
): FileChange[] {
  const key = normalizeChangePath(path);
  const prev = changes.find((c) => c.path === key);
  if (!prev) return [...changes, { path: key, before, after, agents: [agent], edits: 1 }];
  // Changed back to what it was before the run: nothing left to show or revert.
  if (prev.before === after) return changes.filter((c) => c !== prev);
  const next: FileChange = {
    ...prev,
    after,
    agents: prev.agents.includes(agent) ? prev.agents : [...prev.agents, agent],
    edits: prev.edits + 1,
  };
  return changes.map((c) => (c === prev ? next : c));
}

/** Added and removed lines, counted as multisets: an approximation of a diff. */
export function lineCounts(before: string | null, after: string): { added: number; removed: number } {
  const lines = (text: string | null) => (text ? text.replace(/\n$/, "").split("\n") : []);
  const remaining = new Map<string, number>();
  for (const line of lines(before)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of lines(after)) {
    const n = remaining.get(line) ?? 0;
    if (n > 0) remaining.set(line, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of remaining.values()) removed += n;
  return { added, removed };
}
