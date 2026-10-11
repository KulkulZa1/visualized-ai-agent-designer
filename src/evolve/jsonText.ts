/**
 * The JSON objects in a model's output: the proposer's proposal and the critic's verdict are both read with it. A model writes its
 * JSON in a fenced block or bare among prose, and may write several (a draft, then the answer), so every object is returned, in the
 * order of the text, and the caller picks the one it wants (the last with the field it needs). Pure of the run.
 */

/** A fenced block: an opening line (three or more backticks and an optional language), the body, and a closing line of backticks.
 *  Lines start with optional indentation; a fence in the middle of a line (``` inside a JSON string) is not one. */
const FENCE = /^[ \t]*(`{3,})[^\n`]*\n([\s\S]*?)^[ \t]*\1`*[ \t]*$/gm;

/** Where the `{…}` that starts at `start` ends (the index of its `}`), reading strings as JSON does: a brace or an escaped quote
 *  inside a string does not count. -1 when it never closes. */
function spanEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++; // a backslash: the next character is escaped
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x7b) {
      depth++;
    } else if (c === 0x7d && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** Adds to `found` each top-level `{…}` of `text` that is JSON. A span that does not parse is skipped whole, and so is a `{` that
 *  never closes (the scan goes on after it, so a stray brace in prose does not hide the object that follows). */
function collect(text: string, found: unknown[]): void {
  let start = text.indexOf("{");
  while (start !== -1) {
    const end = spanEnd(text, start);
    if (end === -1) {
      start = text.indexOf("{", start + 1);
      continue;
    }
    try {
      found.push(JSON.parse(text.slice(start, end + 1)));
    } catch {
      // not JSON: skipped
    }
    start = text.indexOf("{", end + 1);
  }
}

/**
 * Every JSON object in `text`, in order of appearance: the bodies of fenced blocks (```json or plain ```) and the top-level `{…}`
 * spans of the text outside them. A fenced block is read on its own, so a stray brace in the prose around it cannot swallow it.
 * Objects nested in another are not returned separately.
 */
export function jsonObjectsIn(text: string): unknown[] {
  const found: unknown[] = [];
  let from = 0;
  for (const block of text.matchAll(FENCE)) {
    collect(text.slice(from, block.index), found);
    collect(block[2], found);
    from = block.index + block[0].length;
  }
  collect(text.slice(from), found);
  return found;
}
