/**
 * The task-set file of `harness eval` (<name>.tasks.yaml): tasks, each with a fixture to copy and
 * the scorers that grade a trial. The schema is strict: an unknown key is an error (workflow
 * files are different: there unknown keys are dropped). Every path is checked when the file is
 * loaded, before any trial. Pure of the run: nothing here starts a process.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep as pathSep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import { TASK_ID, type EvalSplit } from "@/cli/evalArgs";

// ── The types the eval works with ─────────────────────────────────────────────

export interface CommandScorer {
  kind: "command";
  name: string;
  weight: number;
  /** One line of plain text. It runs only when it was passed exactly with --allow-scorer. */
  command: string;
  /** Paths in the trial's folder that are put back from the task's workspace before the command runs. */
  restore: string[];
  /** Grader files copied in before the command runs: `from` is an absolute path in the task set's
   *  folder, `to` is a path in the trial's folder. */
  inject: Array<{ from: string; to: string }>;
  timeoutSecs: number;
}

export interface OutputScorer {
  kind: "output";
  name: string;
  weight: number;
  contains: string[];
  notContains: string[];
  /** Regular expressions, as source text. */
  matches: string[];
  /** The one node whose output is checked (by name); else the run's final output. */
  node?: string;
}

export interface FileScorer {
  kind: "file";
  name: string;
  weight: number;
  /** A path in the trial's folder. */
  path: string;
  contains: string[];
  matches: string[];
}

export type Scorer = CommandScorer | OutputScorer | FileScorer;

export interface TaskDef {
  id: string;
  split: "evolve" | "heldout";
  smoke: boolean;
  weight: number;
  /** The task text the workflow is given. */
  task: string;
  /** The fixture folder copied fresh for each trial (absolute); none: the trial's folder starts empty. */
  workspace?: string;
  scorers: Scorer[];
}

export interface TaskSet {
  name: string;
  /** The task-set file, absolute. */
  path: string;
  /** SHA-256 of the file's text. */
  hash: string;
  /** The file's folder: every path in it is relative to this. */
  dir: string;
  /** The workflow named in the file, absolute; --workflow overrides it. */
  workflow?: string;
  trials?: number;
  tasks: TaskDef[];
}

// ── The files, as the schema reads them ───────────────────────────────────────

const lines = z.array(z.string().min(1));

const scorerSchema = z.strictObject({
  name: z.string().min(1).max(64),
  weight: z.number().positive().optional(),
  command: z.string().optional(),
  restore: z.array(z.string()).optional(),
  inject: z.array(z.strictObject({ from: z.string(), to: z.string() })).optional(),
  timeoutSecs: z.number().int().min(1).max(3600).optional(),
  output: z.strictObject({
    contains: lines.optional(), notContains: lines.optional(), matches: lines.optional(), node: z.string().min(1).optional(),
  }).optional(),
  file: z.strictObject({ path: z.string().min(1), contains: lines.optional(), matches: lines.optional() }).optional(),
}).superRefine((scorer, ctx) => {
  if ((["command", "output", "file"] as const).filter((kind) => scorer[kind] !== undefined).length !== 1) {
    ctx.addIssue({ code: "custom", message: "give exactly one of command, output and file" });
  }
  if (scorer.command === undefined) {
    for (const key of ["restore", "inject", "timeoutSecs"] as const) {
      if (scorer[key] !== undefined) ctx.addIssue({ code: "custom", path: [key], message: `${key} is for a command scorer` });
    }
  }
  const output = scorer.output;
  if (output && !output.contains && !output.notContains && !output.matches) {
    ctx.addIssue({ code: "custom", path: ["output"], message: "give at least one of contains, notContains and matches" });
  }
});

const taskSchema = z.strictObject({
  id: z.string().regex(TASK_ID, "a task id has letters, digits, - and _ only"),
  split: z.enum(["evolve", "heldout"]).optional(),
  smoke: z.boolean().optional(),
  weight: z.number().positive().optional(),
  task: z.string().optional(),
  taskFile: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  scorers: z.array(scorerSchema).min(1),
}).superRefine((task, ctx) => {
  if ((task.task === undefined) === (task.taskFile === undefined)) {
    ctx.addIssue({ code: "custom", message: "give the task with exactly one of task and taskFile" });
  }
});

const taskSetSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1).max(128),
  workflow: z.string().min(1).optional(),
  trials: z.number().int().min(1).optional(),
  tasks: z.array(taskSchema).min(1),
});

// ── Paths ─────────────────────────────────────────────────────────────────────

// [KEEP-IN-SYNC] with isInsideDir in cli/harness.mjs, mcp/server.mjs and scripts/offline-bundle-lib.mjs.
/** True when `absPath` is `rootPath` itself or inside it. */
export function isInsideDir(rootPath: string, absPath: string): boolean {
  const rel = relative(rootPath, absPath);
  // Only ".." itself, or ".." and a separator first, leads out: a folder named "..data" is inside.
  // An absolute rel is another drive on Windows.
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + pathSep) && !isAbsolute(rel));
}

/** What is wrong with `path` as a relative path that must stay inside `folder` (named as the message
 *  should say it: "the trial's folder"); undefined when nothing is. The folder itself is not a place
 *  inside it. Only the text is looked at. */
export function relativePathProblem(path: string, folder = "its folder"): string | undefined {
  if (path.trim() === "") return "is empty";
  // A drive letter or a UNC path is absolute on Windows, whatever platform reads the file.
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith("\\\\")) return "is not relative";
  const base = resolve("trial-folder");
  const target = resolve(base, path);
  if (!isInsideDir(base, target)) return `leaves ${folder}`;
  if (target === base) return `is ${folder} itself`;
  return undefined;
}

type Kind = "file" | "folder" | "link" | "other" | "missing";

/** What `path` is, without following a link. */
export function kindOf(path: string): Kind {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "folder" : stat.isFile() ? "file" : "other";
  } catch (e) {
    const code = (e as { code?: string }).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "other";
  }
}

const IS_A_LINK = "is a link (a task set may not contain links)";
const shown = (base: string, path: string) => relative(base, path).split(pathSep).join("/") || ".";

/** Why the tree at `path` is not plain fixture or grader material: a link, or anything that is not a
 *  regular file or folder (a pipe would block a copy). undefined when every entry is plain. */
function treeProblem(path: string, base: string): string | undefined {
  const kind = kindOf(path);
  if (kind === "link") return `${shown(base, path)} ${IS_A_LINK}`;
  if (kind !== "file" && kind !== "folder") return `${shown(base, path)} is not a regular file or folder`;
  if (kind === "folder") {
    for (const name of readdirSync(path)) {
      const problem = treeProblem(join(path, name), base);
      if (problem) return problem;
    }
  }
  return undefined;
}

/** What is wrong with the file or folder at `abs`, inside `base`: missing, the wrong kind, or a link on the
 *  way to it or inside it. undefined when it is plain. Nothing is followed: a task set may not lead out
 *  of its folder, and a copy of a link would point at the original. */
function plainProblem(base: string, abs: string, want: "file" | "folder" | "either"): string | undefined {
  let current = base;
  for (const part of relative(base, abs).split(pathSep).filter(Boolean)) {
    current = join(current, part);
    if (kindOf(current) === "link") return `${shown(base, current)} ${IS_A_LINK}`;
  }
  const kind = kindOf(abs);
  if (kind === "missing") return `${shown(base, abs)} does not exist`;
  if (want !== "either" && kind !== want) return `${shown(base, abs)} is not a ${want}`;
  return treeProblem(abs, base);
}

// ── Loading ───────────────────────────────────────────────────────────────────

/** zod's path as text: tasks[0].scorers[1].name */
function pathText(path: ReadonlyArray<PropertyKey>): string {
  const text = path.map((part, i) => (typeof part === "number" ? `[${part}]` : `${i === 0 ? "" : "."}${String(part)}`)).join("");
  return text || "(the file)";
}

// As in commandTool.ts: the user must see exactly what runs, so a command is one line of plain
// text (no control or invisible format characters, which could make the shown text differ) of
// reasonable length.
const MAX_COMMAND_CHARS = 2000;

/** The task set in `file`, every path in it checked; or everything that is wrong with it. */
export function loadTaskSet(file: string): { taskSet: TaskSet } | { errors: string[] } {
  const path = resolve(file);
  let text: string;
  let raw: unknown;
  try {
    text = readFileSync(path, "utf8");
    raw = parseYaml(text);
  } catch (e) {
    return { errors: [`cannot read ${path}: ${String(e)}`] };
  }
  const checked = taskSetSchema.safeParse(raw);
  if (!checked.success) return { errors: checked.error.issues.map((i) => `${pathText(i.path)}: ${i.message}`) };

  const dir = dirname(path);
  const problems: string[] = [];
  const seenIds = new Set<string>();

  /** A path of the task set that must stay in its folder, with no link in it; its absolute path. */
  const inFolder = (id: string, what: string, p: string, want: "file" | "folder" | "either"): string | undefined => {
    const lexical = relativePathProblem(p, "the task set's folder");
    if (lexical) { problems.push(`task ${id}: ${what} ${p} ${lexical}`); return undefined; }
    const abs = resolve(dir, p);
    const bad = plainProblem(dir, abs, want);
    if (bad) { problems.push(`task ${id}: ${what}: ${bad}`); return undefined; }
    return abs;
  };
  /** A path in the trial's folder. */
  const inTrial = (id: string, what: string, p: string) => {
    const lexical = relativePathProblem(p, "the trial's folder");
    if (lexical) problems.push(`task ${id}: ${what} ${p} ${lexical}`);
  };

  const tasks = checked.data.tasks.map((t): TaskDef => {
    if (seenIds.has(t.id)) problems.push(`task id ${t.id} is used twice`);
    seenIds.add(t.id);

    let task = t.task ?? "";
    let unreadable = false;
    if (t.taskFile !== undefined) {
      const abs = inFolder(t.id, "taskFile", t.taskFile, "file");
      unreadable = abs === undefined;
      if (abs) {
        try {
          task = readFileSync(abs, "utf8");
        } catch (e) {
          unreadable = true;
          problems.push(`task ${t.id}: cannot read taskFile ${t.taskFile}: ${String(e)}`);
        }
      }
    }
    if (!unreadable && !task.trim()) problems.push(`task ${t.id}: the task text is empty`);

    const workspace = t.workspace === undefined ? undefined : inFolder(t.id, "workspace", t.workspace, "folder");

    const names = new Set<string>();
    const scorers = t.scorers.map((s): Scorer => {
      const where = `task ${t.id}, scorer ${s.name}`;
      if (names.has(s.name)) problems.push(`task ${t.id}: scorer name ${s.name} is used twice`);
      names.add(s.name);
      const weight = s.weight ?? 1;
      const regexes = (list: string[] | undefined) => {
        for (const source of list ?? []) {
          try { new RegExp(source); } catch (e) { problems.push(`${where}: matches /${source}/ is not a regular expression: ${String(e)}`); }
        }
      };
      if (s.command !== undefined) {
        const command = s.command.trim();
        if (!command) problems.push(`${where}: the command is empty`);
        else if (/[\p{Cc}\p{Cf}]/u.test(command)) {
          problems.push(`${where}: the command must be one line of plain text: no line breaks, control or invisible characters`);
        } else if (command.length > MAX_COMMAND_CHARS) {
          problems.push(`${where}: the command is too long to review (over ${MAX_COMMAND_CHARS} characters)`);
        }
        for (const p of s.restore ?? []) inTrial(t.id, `scorer ${s.name}: restore`, p);
        const inject = (s.inject ?? []).map((i) => {
          inTrial(t.id, `scorer ${s.name}: inject.to`, i.to);
          const from = inFolder(t.id, `scorer ${s.name}: inject.from`, i.from, "either");
          // The agents see their workspace: a grader file in it is no secret.
          if (from && workspace && isInsideDir(workspace, from)) {
            problems.push(`${where}: inject.from ${i.from} is inside the task's workspace, so the agents would see it`);
          }
          return { from: from ?? resolve(dir, i.from), to: i.to };
        });
        return {
          kind: "command", name: s.name, weight, command, restore: s.restore ?? [], inject, timeoutSecs: s.timeoutSecs ?? 300,
        };
      }
      if (s.output !== undefined) {
        regexes(s.output.matches);
        return {
          kind: "output", name: s.name, weight, contains: s.output.contains ?? [], notContains: s.output.notContains ?? [],
          matches: s.output.matches ?? [], node: s.output.node,
        };
      }
      // Exactly one of the three is set (the schema checked it): this is the file scorer.
      const file = s.file;
      if (!file) throw new Error(`scorer ${s.name} has none of command, output and file, and passed the schema`);
      inTrial(t.id, `scorer ${s.name}: file.path`, file.path);
      regexes(file.matches);
      return { kind: "file", name: s.name, weight, path: file.path, contains: file.contains ?? [], matches: file.matches ?? [] };
    });

    return { id: t.id, split: t.split ?? "evolve", smoke: t.smoke ?? false, weight: t.weight ?? 1, task, workspace, scorers };
  });

  if (problems.length > 0) return { errors: problems };
  return {
    taskSet: {
      name: checked.data.name, path, hash: createHash("sha256").update(text).digest("hex"), dir,
      workflow: checked.data.workflow === undefined ? undefined : resolve(dir, checked.data.workflow),
      trials: checked.data.trials, tasks,
    },
  };
}

// ── Checks that need the options or the workflow ──────────────────────────────

/** The tasks to run: those in the split (smoke: the ones marked `smoke`, whichever split they are in;
 *  all: every task), and with `only`, only those named. Task-set order. Or why there is nothing to run. */
export function selectTasks(tasks: TaskDef[], split: EvalSplit, only: string[]): { tasks: TaskDef[] } | { error: string } {
  const inSplit = (t: TaskDef) => split === "all" || (split === "smoke" ? t.smoke : t.split === split);
  const known = tasks.map((t) => t.id);
  for (const id of only) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return { error: `--only ${id}: the task set has no such task (its tasks: ${known.join(", ")})` };
    if (!inSplit(task)) {
      return { error: `--only ${id}: that task is not in the split ${split}; use --split ${task.split} (or --split all)` };
    }
  }
  const selected = tasks.filter((t) => inSplit(t) && (only.length === 0 || only.includes(t.id)));
  if (selected.length === 0) return { error: `no task is in the split ${split}` };
  return { tasks: selected };
}

/** The `node:` of an output scorer must name exactly one node of the workflow under test: what is
 *  wrong, scorer by scorer. */
export function nodeProblems(tasks: TaskDef[], graph: WorkflowGraph): string[] {
  const problems: string[] = [];
  for (const task of tasks) {
    for (const scorer of task.scorers) {
      if (scorer.kind !== "output" || scorer.node === undefined) continue;
      const named = graph.nodes.filter((n) => n.data.name === scorer.node).length;
      if (named === 1) continue;
      problems.push(`task ${task.id}, scorer ${scorer.name}: node "${scorer.node}" ${named === 0
        ? "is not an agent of the workflow" : `names ${named} agents of the workflow; it must name one`}`);
    }
  }
  return problems;
}

/** The scorer commands of `tasks` that were not approved: each is listed once, with the scorers that
 *  use it. A scorer command runs only when it was passed exactly with --allow-scorer. */
export function unapprovedScorerCommands(
  tasks: TaskDef[], allowed: ReadonlySet<string>,
): Array<{ command: string; scorers: string[] }> {
  const unapproved = new Map<string, string[]>();
  for (const task of tasks) {
    for (const scorer of task.scorers) {
      if (scorer.kind !== "command" || allowed.has(scorer.command)) continue;
      unapproved.set(scorer.command, [...(unapproved.get(scorer.command) ?? []), `${task.id}/${scorer.name}`]);
    }
  }
  return [...unapproved].map(([command, scorers]) => ({ command, scorers }));
}
