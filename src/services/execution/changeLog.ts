/**
 * changeLog — the files a run's agents changed, for the Changes dialog and
 * revert: one entry per file with its content before the run first changed it,
 * the latest content, and the agents that changed it.
 */
import type { FileChange } from "@/types/execution";

export function normalizeChangePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

/** Resolve "." and ".." segments and repeated separators in a "/"-separated path. */
function resolveSegments(path: string): string {
  const rooted = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    else if (!rooted) parts.push(part); // a relative path keeps the ".." it cannot resolve
  }
  return (rooted ? "/" : "") + parts.join("/");
}

/**
 * Where a path points, so two spellings of it compare equal: resolved against the
 * workspace, then relative to it when inside, with "/" separators, no "." or ".."
 * segments, and lower case. Case is folded because Windows ignores it; on a
 * case-sensitive file system that can match two files, which errs on the safe side.
 */
function changePathKey(path: string, workspacePath?: string | null): string {
  const spelled = normalizeChangePath(path);
  const root = workspacePath ? resolveSegments(normalizeChangePath(workspacePath)).toLowerCase() : "";
  if (!root) return resolveSegments(spelled).toLowerCase();
  const isAbsolute = spelled.startsWith("/") || /^[a-z]:\//i.test(spelled);
  const full = resolveSegments(isAbsolute ? spelled : `${root}/${spelled}`).toLowerCase();
  const inside = root.endsWith("/") ? root : `${root}/`;
  return full.startsWith(inside) ? full.slice(inside.length) : full;
}

/**
 * The run's change to `path`, however the two are spelled: absolute or relative to
 * the workspace, either separator, any case. Lexical: a symlink, junction or 8.3
 * short name that leads to the same file is not followed.
 */
export function findChange(
  changes: FileChange[], path: string, workspacePath?: string | null,
): FileChange | undefined {
  const key = changePathKey(path, workspacePath);
  return changes.find((c) => changePathKey(c.path, workspacePath) === key);
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
