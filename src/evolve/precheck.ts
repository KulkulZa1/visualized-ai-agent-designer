// Ported from RRSI (Apache License 2.0) and changed: see src/evolve/NOTICE.md.
/**
 * The deterministic layer of the critic (spec §4.1), run before the critic model. It looks only at the text a proposal adds, and
 * flags a pattern only when the pattern is not in the incumbent's file already. RRSI's "domain patterns" are written by hand; here
 * they come from the task set: its task ids, the literals its scorers look for, and the names of its grader files. Scorer names,
 * scorer commands and `matches` patterns are left out on purpose: they are often common words, generic commands or broad patterns.
 */
import type { TaskSet } from "@/cli/taskSet";
import type { Proposal } from "@/evolve/edits";

export interface LeakagePattern {
  kind: "task id" | "scorer text" | "grader file";
  text: string;
  /** Where the pattern comes from, for the reason: `task laptop`, `task laptop, scorer names-it`. */
  source: string;
}

/** A pattern shorter than this would flag ordinary words. */
const MIN_LENGTH = 4;

/** RRSI's generic credential pattern: a Google API key, an `sk-` key, or `api_key = "…"`. */
const CREDENTIAL = /AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{20,}|api_key\s*=\s*["'][^"']{8,}/g;

/** The last name of a path, written with / or \. */
const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? "";

/**
 * What a proposal must not teach the workflow, from every task of every split. A task id is matched as a whole word, ignoring case;
 * the literals of `output` scorers (`contains`, `notContains`) and of `file` scorers (`contains`, and the `path`) and the base names of
 * the `inject` sources and targets of command scorers are matched as case-sensitive substrings. Each is 4 characters or longer, and
 * each kind and text is listed once, with the first place it comes from.
 */
export function leakagePatterns(taskSet: TaskSet): LeakagePattern[] {
  const found = new Map<string, LeakagePattern>();
  const add = (kind: LeakagePattern["kind"], text: string, source: string): void => {
    const key = `${kind}\n${text}`;
    if (text.length >= MIN_LENGTH && !found.has(key)) found.set(key, { kind, text, source });
  };
  for (const task of taskSet.tasks) {
    add("task id", task.id, `task ${task.id}`);
    for (const scorer of task.scorers) {
      const source = `task ${task.id}, scorer ${scorer.name}`;
      if (scorer.kind === "output") {
        for (const text of [...scorer.contains, ...scorer.notContains]) add("scorer text", text, source);
      } else if (scorer.kind === "file") {
        for (const text of [...scorer.contains, scorer.path]) add("scorer text", text, source);
      } else {
        for (const { from, to } of scorer.inject) {
          add("grader file", baseName(from), source);
          add("grader file", baseName(to), source);
        }
      }
    }
  }
  return [...found.values()];
}

/** Every string a proposal adds to the workflow, one per line: new text, a new agent's name, prompt, description and memory keys,
 *  memory keys added, and edge labels. */
export function addedText(proposal: Pick<Proposal, "edits">): string {
  const added: string[] = [];
  for (const edit of proposal.edits) {
    for (const op of edit.ops) {
      switch (op.op) {
        case "replace_text":
          added.push(op.new);
          break;
        case "set_text":
          added.push(op.value);
          break;
        case "add_agent":
          added.push(op.name, op.prompt, ...(op.description === undefined ? [] : [op.description]), ...(op.memoryRead ?? []), ...(op.memoryWrite ?? []));
          break;
        case "add_memory_read":
        case "add_memory_write":
          added.push(op.key);
          break;
        case "connect":
          if (op.label !== undefined) added.push(op.label);
          break;
        default:
          break;
      }
    }
  }
  return added.join("\n");
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `pattern` is in `text`: a task id as a whole word, ignoring case; anything else as a case-sensitive substring. */
function appearsIn(pattern: LeakagePattern, text: string): boolean {
  if (pattern.kind !== "task id") return text.includes(pattern.text);
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(pattern.text)}(?![A-Za-z0-9_])`, "i").test(text);
}

/**
 * Why the proposal is rejected before the critic reads it, one reason per hit; none when it is clean. A credential hits when what the
 * proposal adds has one that the incumbent's file does not have; any other pattern, when the added text has it and the incumbent's
 * file has it nowhere.
 */
export function precheck(proposal: Pick<Proposal, "edits">, incumbentText: string, patterns: readonly LeakagePattern[]): string[] {
  const added = addedText(proposal);
  const reasons: string[] = [];
  if ((added.match(CREDENTIAL) ?? []).some((credential) => !incumbentText.includes(credential))) {
    reasons.push("precheck: a credential in the change");
  }
  for (const pattern of patterns) {
    if (appearsIn(pattern, added) && !appearsIn(pattern, incumbentText)) {
      reasons.push(`precheck: ${pattern.kind} "${pattern.text}" (${pattern.source})`);
    }
  }
  return reasons;
}
