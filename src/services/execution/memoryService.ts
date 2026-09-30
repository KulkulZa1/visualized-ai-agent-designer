/**
 * memoryService — per-run key-value memory store.
 *
 * Created fresh for every workflow run. Memory nodes write outputs here;
 * agent nodes read from it before building their context. Never persisted
 * across runs in this slice (future: .harness/memory.jsonl).
 */

export class MemoryService {
  private store = new Map<string, string>();
  /** The writes that stand, oldest first, with who made each: forget() takes one writer's back. */
  private writes: Array<{ key: string; value: string; writer: string }> = [];

  /** Write a value under a key (overwrites previous). `writer` names who wrote it, for forget(). */
  write(key: string, value: string, writer = ""): void {
    const stored = value.trim();
    this.writes = this.writes.filter((w) => w.key !== key || w.writer !== writer);
    this.writes.push({ key, value: stored, writer });
    this.store.set(key, stored);
  }

  /** Read a key, returns null if not set. */
  read(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  /**
   * Build a context block from a list of keys.
   * Returns "" if none of the keys are set.
   */
  buildContext(keys: string[]): string {
    const parts: string[] = [];
    for (const key of keys) {
      const val = this.store.get(key);
      if (val) parts.push(`[memory:${key}]\n${val}`);
    }
    return parts.join("\n\n");
  }

  /** Store all memoryWrite keys with the agent's output. */
  writeAll(keys: string[], value: string, writer = ""): void {
    for (const key of keys) {
      this.write(key, value, writer);
    }
  }

  /** Take back everything `writer` wrote, as if it never had: a key it overwrote goes back to
   *  what the writer before it left, or is gone if there was none. */
  forget(writer: string): void {
    if (!this.writes.some((w) => w.writer === writer)) return;
    this.writes = this.writes.filter((w) => w.writer !== writer);
    this.store = new Map(this.writes.map((w): [string, string] => [w.key, w.value]));
  }

  /** Full dump for debugging. */
  dump(): Record<string, string> {
    return Object.fromEntries(this.store.entries());
  }
}
