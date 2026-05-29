/**
 * memoryService — per-run key-value memory store.
 *
 * Created fresh for every workflow run. Memory nodes write outputs here;
 * agent nodes read from it before building their context. Never persisted
 * across runs in this slice (future: .harness/memory.jsonl).
 */

export class MemoryService {
  private store = new Map<string, string>();

  /** Write a value under a key (overwrites previous). */
  write(key: string, value: string): void {
    this.store.set(key, value.trim());
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
  writeAll(keys: string[], value: string): void {
    for (const key of keys) {
      this.write(key, value);
    }
  }

  /** Full dump for debugging. */
  dump(): Record<string, string> {
    return Object.fromEntries(this.store.entries());
  }
}
