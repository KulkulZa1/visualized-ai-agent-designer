/**
 * The task-set file of `harness eval` (<name>.tasks.yaml): tasks, each with a fixture to copy and
 * the scorers that grade a trial. The schema is strict: an unknown key is an error (workflow
 * files are different: there unknown keys are dropped). Every path is checked when the file is
 * loaded, before any trial. Pure of the run: nothing here starts a process.
 *
 * Links. Where a path leads is decided by the kernel, never by reading the path as text: a `..` after
 * a link goes up from the link's target, not from the link, so a path that looks inside a folder can
 * lead out of it. Every decision below is made on `realpathSync.native`, and the helpers that need
 * one (`physicalPath`, `linkProblem`) are here.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep as pathSep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import { MAX_TRIALS, TASK_ID, type EvalSplit } from "@/cli/evalArgs";

// ── The types the eval works with ─────────────────────────────────────────────

export interface CommandScorer {
  kind: "command";
  name: string;
  weight: number;
  /** One line of plain text. It runs only when it was passed exactly with --allow-scorer. */
  command: string;
  /** Paths in the trial's folder that are put back from the task's workspace before the command runs,
   *  written out: no `.`, no `..`. */
  restore: string[];
  /** Grader files copied in before the command runs: `from` is the real path of a file or folder of the
   *  task set (no link on the way to it or in it), `to` is a path in the trial's folder. */
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
  /** A path in the trial's folder, written out: no `.`, no `..`. */
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
  /** The fixture folder copied fresh for each trial, as its real path: no link on the way to it, and every
   *  link in it is relative and leads to a place in it. None: the trial's folder starts empty. */
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

const lines = z.array(z.string().min(1)).min(1);

// A task's id is a folder of the eval's output and a key of its report: it cannot be the name of an
// object's own property (`__proto__` would vanish from the report while counting in S), or one of the
// names Windows keeps for devices (with or without an extension), which cannot name a folder.
const PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

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
  id: z.string().regex(TASK_ID, "a task id has letters, digits, - and _ only")
    .refine((id) => !PROPERTY_NAMES.has(id), "this cannot be a task id: it is the name of an object's own property")
    .refine((id) => !DEVICE_NAME.test(id), "this cannot be a task id: Windows keeps it for a device, so no folder can have it"),
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
  trials: z.number().int().min(1).max(MAX_TRIALS).optional(),
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

/** A path that passed `relativePathProblem`, written out: "/" between the names, and no "." or ".." in it.
 *  The `..` of a path someone wrote is the writer's own; a `..` met later, after a link, is the kernel's
 *  (it goes up from the link's target), so a stored path has none left to be read two ways. */
export function normalizedRelativePath(path: string): string {
  const base = resolve("trial-folder");
  return relative(base, resolve(base, path)).split(pathSep).join("/");
}

type Kind = "file" | "folder" | "link" | "other" | "unreadable" | "missing";

/** What `path` is, without following a link at its end. `other` is a pipe, a device or a socket; `unreadable`
 *  is a path that cannot be looked at (no permission). */
export function kindOf(path: string): Kind {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "folder" : stat.isFile() ? "file" : "other";
  } catch (e) {
    const code = errorCode(e);
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable";
  }
}

/** An error's code (EACCES, ENOENT), or its text. */
export function errorCode(e: unknown): string {
  return (e as { code?: string })?.code ?? (e instanceof Error ? e.message : String(e));
}

/** `path` and the names below its nearest existing folder or file that do not exist yet (a new output
 *  folder, a folder an agent deleted). */
export function nearestExisting(path: string): { existing: string; rest: string[] } {
  const rest: string[] = [];
  let existing = resolve(path);
  while (kindOf(existing) === "missing") {
    const up = dirname(existing);
    if (up === existing) break;
    rest.unshift(basename(existing));
    existing = up;
  }
  return { existing, rest };
}

/** Where `path` physically is, though it need not exist yet: its nearest existing ancestor resolved by the
 *  kernel (`realpathSync.native`, through every link), and the names that do not exist below it. Throws when
 *  that ancestor cannot be resolved (a link to nothing, or links that loop). */
export function physicalPath(path: string): string {
  const { existing, rest } = nearestExisting(path);
  return join(realpathSync.native(existing), ...rest);
}

const isAbsoluteLinkTarget = (text: string) => isAbsolute(text) || /^[A-Za-z]:/.test(text) || text.startsWith("\\\\");

/** The steps of a path or of a link's target, as the kernel reads them: a backslash separates only where the platform's
 *  own separator is one. */
const stepsOf = (text: string) => text.split(pathSep === "\\" ? /[\\/]+/ : /\/+/);

/** The names of a path written out (no "." and no empty step left), in order; ".." is kept, to be refused by whoever needs
 *  a path with none. */
export const pathParts = (path: string): string[] => stepsOf(path).filter((step) => step !== "" && step !== ".");

/** As many links in a row as the kernel itself follows. */
const MAX_LINK_HOPS = 40;

/** Walks the target `text` of the link at `link` one step at a time, as the kernel does: where the link is, with each link
 *  on the way replaced by its own target, and a `..` going up from the place the walk has reached (not from where the
 *  text says it is: after a link, those are different places). `root` is the fixture's real path and `link` a real path
 *  below it. Returns the place the walk ends at, or what stopped it: it climbed above `root` at some step (even to come
 *  back in later: in a copy of the fixture, above it is not the fixture's own place), it met a link with an absolute
 *  target, or it led to nothing (a name that is not there, a file with something after it, links in a loop). */
function walkLink(link: string, text: string, root: string): { end: string } | { stop: "climbs" | "absolute" | "nothing" } {
  let here = dirname(link);
  let atFile = false;
  let hops = 0;
  const todo = stepsOf(text);
  while (todo.length > 0) {
    const step = todo.shift() as string;
    if (step === "" || step === ".") continue;
    if (atFile) return { stop: "nothing" };
    if (step === "..") {
      const above = dirname(here);
      if (above === here || !isInsideDir(root, above)) return { stop: "climbs" };
      here = above;
      continue;
    }
    const next = join(here, step);
    const kind = kindOf(next);
    if (kind === "link") {
      if (++hops > MAX_LINK_HOPS) return { stop: "nothing" };
      let inner: string;
      try {
        inner = readlinkSync(next);
      } catch {
        return { stop: "nothing" };
      }
      if (isAbsoluteLinkTarget(inner)) return { stop: "absolute" };
      todo.unshift(...stepsOf(inner));
    } else if (kind === "folder") {
      here = next;
    } else if (kind === "file" || kind === "other") {
      here = next;
      atFile = true;
    } else {
      return { stop: "nothing" };
    }
  }
  return { end: here };
}

/** What is wrong with the link at `link` as a link inside a fixture, or undefined when it is fine to have
 *  there and to copy as it is. `root` is the fixture's real path; `link` is a real path below it, with no
 *  link on the way (a walk that never follows a link gives it so). A link in a fixture is allowed when:
 *  - its target is relative: an absolute one leads out of every copy;
 *  - the kernel's walk of it (`walkLink`, links and all, never reading `..` as text) never goes above the fixture, and
 *    ends at a place that exists. The copy is another folder, and above it is not the same place as above the fixture;
 *    so a walk that stays in the fixture is the same walk in the copy, and the copied link points inside the copy. */
export function linkProblem(link: string, root: string): string | undefined {
  let text: string;
  try {
    text = readlinkSync(link);
  } catch (e) {
    return `is a link that cannot be read (${errorCode(e)})`;
  }
  const target = JSON.stringify(text);
  if (isAbsoluteLinkTarget(text)) return `is a link with an absolute target (${target}): a link in a fixture must be relative`;
  const walked = walkLink(link, text, root);
  const nothing = `is a link to nothing (its target ${target} does not exist, or links loop)`;
  if ("stop" in walked) {
    if (walked.stop === "climbs") return `is a link whose target (${target}) climbs out of the fixture: a step of it goes above the fixture's folder`;
    return walked.stop === "absolute" ? `is a link whose target (${target}) goes through a link with an absolute target` : nothing;
  }
  let real: string;
  try {
    real = realpathSync.native(link);
  } catch {
    return nothing;
  }
  // The walk agrees with the kernel, unless the file system is not the plain kind this walk knows: then it is not trusted.
  if (!isInsideDir(root, real)) return `is a link that leads out of the fixture (it ends at ${real})`;
  return undefined;
}

const LINK_ON_THE_WAY = "is a link (a path in a task set may not go through a link)";
const LINK_NOT_ALLOWED = "is a link (grader files and task files may not contain links)";
const shown = (base: string, path: string) => relative(base, path).split(pathSep).join("/") || ".";

/** Why the tree at `path` is not plain material, or undefined when every entry is. Nothing is followed: a link
 *  is looked at where it is and never entered, so `a -> .` cannot loop. A pipe, a device or a socket is never
 *  material (a copy of it would block). A link is refused, unless `root` (the real path of a fixture) is given:
 *  then it is checked with `linkProblem`. `show` writes a path as the message should say it. */
function treeProblem(path: string, show: (path: string) => string, root?: string): string | undefined {
  const kind = kindOf(path);
  if (kind === "link") {
    if (root === undefined) return `${show(path)} ${LINK_NOT_ALLOWED}`;
    const problem = linkProblem(path, root);
    return problem === undefined ? undefined : `${show(path)} ${problem}`;
  }
  if (kind === "unreadable") return `${show(path)} cannot be looked at (no permission?)`;
  if (kind !== "file" && kind !== "folder") return `${show(path)} is not a regular file or folder`;
  if (kind === "folder") {
    let names: string[];
    try {
      names = readdirSync(path);
    } catch (e) {
      return `${show(path)} cannot be read (${errorCode(e)})`;
    }
    for (const name of names) {
      const problem = treeProblem(join(path, name), show, root);
      if (problem) return problem;
    }
  }
  return undefined;
}

/** What is wrong with the path `abs`, inside `base`: a link on the way to it, or it is one; or it is
 *  missing or of the wrong kind. undefined when it is as wanted. */
function pathProblem(base: string, abs: string, want: "file" | "folder" | "either"): string | undefined {
  let current = base;
  for (const part of relative(base, abs).split(pathSep).filter(Boolean)) {
    current = join(current, part);
    if (kindOf(current) === "link") return `${shown(base, current)} ${LINK_ON_THE_WAY}`;
  }
  const kind = kindOf(abs);
  if (kind === "missing") return `${shown(base, abs)} does not exist`;
  if (kind === "unreadable") return `${shown(base, abs)} cannot be looked at (no permission?)`;
  if (want !== "either" && kind !== want) return `${shown(base, abs)} is not a ${want}`;
  return undefined;
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

/** The task set in `file`, every path in it checked; or everything that is wrong with it. A file that
 *  cannot be read is something that is wrong with the task set, never an exception. */
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

  /** A path of the task set that must stay in its folder, with no link on the way to it (and, `strict`, none
   *  in it); its absolute path. */
  const inFolder = (id: string, what: string, p: string, want: "file" | "folder" | "either", strict = false): string | undefined => {
    const lexical = relativePathProblem(p, "the task set's folder");
    if (lexical) { problems.push(`task ${id}: ${what} ${p} ${lexical}`); return undefined; }
    const abs = resolve(dir, p);
    const bad = pathProblem(dir, abs, want) ?? (strict ? treeProblem(abs, (x) => shown(dir, x)) : undefined);
    if (bad) { problems.push(`task ${id}: ${what}: ${bad}`); return undefined; }
    return abs;
  };
  /** Where the kernel says `abs` is. */
  const realOf = (id: string, what: string, abs: string): string | undefined => {
    try {
      return realpathSync.native(abs);
    } catch (e) {
      problems.push(`task ${id}: ${what}: cannot be resolved (${errorCode(e)})`);
      return undefined;
    }
  };
  /** A path in the trial's folder; it is stored written out. */
  const inTrial = (id: string, what: string, p: string): string => {
    const lexical = relativePathProblem(p, "the trial's folder");
    if (lexical) problems.push(`task ${id}: ${what} ${p} ${lexical}`);
    return lexical ? p : normalizedRelativePath(p);
  };

  try {
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

      // The fixture: a plain folder with no link on the way to it. Inside it a link is allowed when it is relative
      // and leads to a place in the fixture (an npm install's node_modules/.bin has such links): it is copied as
      // it is, and still points inside the copy.
      let workspace: string | undefined;
      if (t.workspace !== undefined) {
        const abs = inFolder(t.id, "workspace", t.workspace, "folder");
        const real = abs === undefined ? undefined : realOf(t.id, "workspace", abs);
        if (real !== undefined) {
          const label = normalizedRelativePath(t.workspace);
          const bad = treeProblem(real, (x) => {
            const below = relative(real, x).split(pathSep).filter(Boolean).join("/");
            return below ? `${label}/${below}` : label;
          }, real);
          if (bad) problems.push(`task ${t.id}: workspace: ${bad}`);
          else workspace = real;
        }
      }

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
          const restore = (s.restore ?? []).map((p) => inTrial(t.id, `scorer ${s.name}: restore`, p));
          const inject = (s.inject ?? []).map((i) => {
            const to = inTrial(t.id, `scorer ${s.name}: inject.to`, i.to);
            const abs = inFolder(t.id, `scorer ${s.name}: inject.from`, i.from, "either", true);
            const from = abs === undefined ? undefined : realOf(t.id, `scorer ${s.name}: inject.from`, abs);
            // The agents see their workspace: a grader file in it is no secret.
            if (from && workspace && isInsideDir(workspace, from)) {
              problems.push(`${where}: inject.from ${i.from} is inside the task's workspace, so the agents would see it`);
            }
            return { from: from ?? resolve(dir, i.from), to };
          });
          return { kind: "command", name: s.name, weight, command, restore, inject, timeoutSecs: s.timeoutSecs ?? 300 };
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
        const filePath = inTrial(t.id, `scorer ${s.name}: file.path`, file.path);
        regexes(file.matches);
        return { kind: "file", name: s.name, weight, path: filePath, contains: file.contains ?? [], matches: file.matches ?? [] };
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
  } catch (e) {
    // Whatever else the files do (a folder that goes away while it is read): a problem of the task set, not a crash.
    return { errors: [...problems, `cannot read the files of the task set: ${errorCode(e)}`] };
  }
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
