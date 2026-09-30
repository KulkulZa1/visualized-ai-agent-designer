/**
 * routing — where a node's output sends the run next.
 *
 * Gateways: `parseGatewayRoute` picks the route the scheduler follows.
 * Feedback edges: a node's verdict fires the feedback edges it names; the run
 * loop then re-runs the path from each fired edge's target back to that node,
 * at most MAX_REVISION_ROUNDS times per node per run.
 */

import type { Edge } from "@xyflow/react";

export const MAX_REVISION_ROUNDS = 2;

type EdgeData = { label?: string; edgeKind?: string };

function isFeedbackEdge(edge: Edge): boolean {
  return (edge.data as EdgeData | undefined)?.edgeKind === "feedback" || edge.type === "feedback";
}

function edgeLabel(edge: Edge): string {
  const dataLabel = (edge.data as EdgeData | undefined)?.label;
  const label = typeof dataLabel === "string" ? dataLabel : typeof edge.label === "string" ? edge.label : "";
  return label.trim().toLowerCase();
}

/** Index of the `}` that closes the `{` at `start`, skipping braces inside JSON strings
 *  (and the quotes they escape); -1 when it never closes. */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++; // the next character is escaped
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** The JSON objects in `text`, in order. Braces in prose or code around them are skipped. */
function jsonObjects(text: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const starts = /\{(?=\s*["}])/g; // a JSON object opens with `{` and then a key or `}`
  // Characters we may scan in all. Ordinary replies use a fraction of it; a runaway one
  // (thousands of `{"` that never close) would otherwise take quadratic time.
  let budget = 32 * text.length;
  for (let m = starts.exec(text); m && budget > 0; m = starts.exec(text)) {
    const end = closingBrace(text, m.index);
    budget -= (end < 0 ? text.length : end + 1) - m.index;
    if (end < 0) continue;
    try {
      found.push(JSON.parse(text.slice(m.index, end + 1)));
      starts.lastIndex = end + 1; // whatever is nested in this object is part of it
    } catch { /* not JSON: an object may still sit inside these braces */ }
  }
  return found;
}

const ROUTE_KEYS = ["route", "target", "domain", "verdict", "action"];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Try to extract a routing key from a gateway's (or reviewer's) text output.
 * Looks for JSON `{"route":"X"}`, `{"target":"X"}`, `{"domain":"X"}`, `{"verdict":"X"}` or
 * `{"action":"X"}` anywhere in the text and uses the last object that carries one, then for
 * a `route: X` / `verdict: X` keyword (markdown around it is fine: `**Verdict:** **X**`).
 * `keys` narrows both to those names. A call that passes `keys` reads a stated verdict, not a
 * gateway's route, and reads two things more: a parenthesized note or options list before the
 * colon (`Verdict (PASS/REVISE): X`), and a quoted `"verdict": "X"` pair in JSON that did not
 * parse (cut off, a trailing comma). The default parse does neither: a gateway whose reply names
 * no route follows every branch, and a template it echoes (`{"route": "a" | "b"}`), a list of
 * routes or a quoted phrase in prose must not pick one.
 */
export function parseGatewayRoute(text: string, keys?: readonly string[]): string | null {
  const wanted = keys ?? ROUTE_KEYS;
  const objects = jsonObjects(text);
  for (let i = objects.length - 1; i >= 0; i--) {
    const val = wanted.map((key) => objects[i][key]).find((v) => v !== undefined && v !== null);
    if (typeof val === "string" && val.trim()) return val.trim().toLowerCase();
  }
  const names = wanted.map(escapeRegExp).join("|");
  const note = keys ? "(?:\\([^()\\n]*\\)[*_`]*\\s*)?" : "";
  const kvMatch = text.match(new RegExp(`(?:${names})[*_\`]*\\s*${note}[":][\\s*_\`"']*([a-zA-Z0-9_-]+)`, "i"));
  if (kvMatch) return kvMatch[1].toLowerCase();
  if (!keys) return null;
  const quoted = text.match(new RegExp(`"(?:${names})"\\s*:\\s*"([^"\\n]+)"`, "i"));
  if (quoted && quoted[1].trim()) return quoted[1].trim().toLowerCase();
  return null;
}

/** Verdicts that close a review without asking for changes: what the example reviewers
 *  answer with besides REVISE. */
const CLOSING_VERDICTS = new Set(["approved", "pass", "escalate"]);

/** Whether the word that ends at `end` stands alone: the text or the line ends there, or a
 *  separator follows ("APPROVED.", "**PASS** — …"), not another word ("Pass 1 of the review",
 *  "Approved changes so far"), a question ("Escalate? …") or an alternative ("PASS/REVISE: …"). */
function standsAlone(text: string, end: number): boolean {
  // A letter, a digit, "?" or "/" after any closing marks and blanks on the same line.
  const notAlone = /[*_`"')]*[^\S\r\n]*[\p{L}\p{N}?/]/uy;
  notAlone.lastIndex = end;
  return !notAlone.test(text);
}

/** Two or more alternatives, as an echo of the options lists them: "PASS/REVISE", or with blanks
 *  around each slash, as the example prompts write them, "APPROVED / REVISE / ESCALATE". */
const OPTIONS = String.raw`[A-Za-z][\w-]*(?:[^\S\r\n]*\/[^\S\r\n]*[A-Za-z][\w-]*)+`;

/** An echo of the options that opens the reply ("PASS/REVISE:", "**Pass/Fail:**"). */
const LEADING_OPTIONS = new RegExp(`^[\\s*_#>\`"'(-]*${OPTIONS}[*_\`"')]*[^\\S\\r\\n]*:`);

/** An echo of the options that opens a line: "PASS/REVISE: X", "**Pass/Fail:** X" or a lone
 *  "PASS/REVISE". Group 1 is the options, group 2 the colon (empty for a lone echo). */
const OPTIONS_LABEL = new RegExp(`^[ \\t*_#>\`"'(-]*(${OPTIONS})[*_\`"')]*[^\\S\\r\\n]*(:|$)`, "gm");

/** The word at `from` (after blanks, line breaks and markup), lower-cased, and whether it stands alone. */
function wordAt(text: string, from: number): { word: string; alone: boolean } | null {
  const lead = /[\s*_#>`"'(-]*([A-Za-z][\w-]*)/y;
  lead.lastIndex = from;
  const found = lead.exec(text);
  return found && { word: found[1].toLowerCase(), alone: standsAlone(text, from + found[0].length) };
}

/** The reply's first word, lower-cased, and whether it stands alone. An echo of the options
 *  ("PASS/REVISE:") is not a verdict: the choice after it is the first word. */
function leadingWord(text: string): { word: string; alone: boolean } | null {
  const options = LEADING_OPTIONS.exec(text);
  return wordAt(text, options ? options[0].length : 0);
}

/** The echoes of the options that open a line, read as `leadingWord` reads one that opens the reply.
 *  Each states its choice, the word after the colon ("PASS/REVISE: REVISE"), and is `open` when it
 *  leaves REVISE undecided: REVISE is among its options, and no choice that stands alone names an
 *  option or a closing verdict (none, or "PASS/REVISE: fix the intro."). */
function optionsLabels(text: string): { choice?: string; open: boolean }[] {
  return [...text.matchAll(OPTIONS_LABEL)].map((m) => {
    const options = m[1].toLowerCase().split("/").map((option) => option.trim());
    const choice = m[2] ? wordAt(text, m.index + m[0].length) : null;
    const settled = choice?.alone && (options.includes(choice.word) || CLOSING_VERDICTS.has(choice.word));
    return { choice: choice?.word, open: options.includes("revise") && !settled };
  });
}

/** Whether a "revise" that stands alone opens a sentence or a line: the verdict can follow a
 *  question ("Escalate? Not needed. REVISE: fix the intro."). One after a "/" does not: it is a path
 *  or code ("lib/revise.js", "`/revise`"), or an option, which `optionsLabels` reads. */
function opensWithRevise(text: string): boolean {
  for (const m of text.matchAll(/(?:^|[.!?\n])[ \t*_#>`"'(-]*revise(?![\w-])/gim)) {
    if (standsAlone(text, m.index + m[0].length)) return true;
  }
  return false;
}

/** Verdicts a node's output states: its explicit verdict, the parsed route, its leading word
 *  ("REVISE — …"), the choice after an echo of the options that opens a line ("PASS/REVISE: REVISE")
 *  and a REVISE that opens a later sentence or line.
 *  A reply that opens with a closing verdict that stands alone has stated it, so a keyword later
 *  on ("APPROVED. Optional follow-up action: revise the headline") does not add a revision; only
 *  an explicit verdict does: a JSON `verdict` or a "Verdict:" keyword, which may name its options
 *  first ("Verdict (PASS/REVISE): REVISE"). Any other reply states that verdict too, so a key or
 *  keyword that comes first does not hide it (`{"verdict":"REVISE","target":"x"}`,
 *  "Action: rewrite the intro.\nVerdict: REVISE"). It also decides over a REVISE that merely opens a
 *  sentence ("- Revise: none\n- Verdict: PASS") and over an echo of the options that makes no choice.
 *  A first word that does not stand alone ("Pass 1 of the review is done. Verdict: REVISE") states
 *  nothing. Any other leading word stays open to a later keyword: "REVISE — target: rust-fix" says
 *  which of several feedback edges to fire. */
function statedVerdicts(text: string): string[] {
  const leading = leadingWord(text);
  const explicit = parseGatewayRoute(text, ["verdict"]);
  const labels = optionsLabels(text);
  const said: (string | null | undefined)[] = leading?.alone && CLOSING_VERDICTS.has(leading.word)
    ? [leading.word, explicit]
    : [
        explicit,
        parseGatewayRoute(text),
        leading?.word,
        ...labels.map((label) => label.choice),
        !explicit && (opensWithRevise(text) || labels.some((label) => label.open)) ? "revise" : null,
      ];
  return said.filter((v): v is string => Boolean(v));
}

/** The feedback edges out of `sourceId` that its output fires: those whose label the
 *  verdict names exactly, or all of them on a plain "revise". */
export function firedFeedbackEdges(sourceId: string, output: string, edges: Edge[]): Edge[] {
  const feedback = edges.filter((e) => e.source === sourceId && isFeedbackEdge(e));
  if (feedback.length === 0) return [];
  const said = statedVerdicts(output);
  const named = feedback.filter((e) => edgeLabel(e) !== "" && said.includes(edgeLabel(e)));
  if (named.length > 0) return named;
  return said.includes("revise") ? feedback : [];
}

/** Nodes to re-run for a revision: each target plus every node on a forward path from
 *  a target back to `sourceId`, in dependency order, without the source itself. */
export function revisionPath(targets: string[], sourceId: string, edges: Edge[]): string[] {
  const forward = edges.filter((e) => !isFeedbackEdge(e));
  const reach = (starts: string[], next: (id: string) => string[]) => {
    const seen = new Set(starts);
    const queue = [...starts];
    while (queue.length > 0) {
      for (const n of next(queue.shift()!)) {
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
    return seen;
  };
  const downstream = reach(targets, (id) => forward.filter((e) => e.source === id).map((e) => e.target));
  const upstream = reach([sourceId], (id) => forward.filter((e) => e.target === id).map((e) => e.source));
  const members = new Set([...targets, ...[...downstream].filter((id) => upstream.has(id))]);
  members.delete(sourceId);

  // Dependency order among the members (Kahn).
  const inDegree = new Map([...members].map((id) => [id, 0]));
  for (const e of forward) {
    if (members.has(e.source) && members.has(e.target)) inDegree.set(e.target, inDegree.get(e.target)! + 1);
  }
  const ready = [...members].filter((id) => inDegree.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const e of forward) {
      if (e.source !== id || !members.has(e.target)) continue;
      const left = inDegree.get(e.target)! - 1;
      inDegree.set(e.target, left);
      if (left === 0) ready.push(e.target);
    }
  }
  return order;
}
