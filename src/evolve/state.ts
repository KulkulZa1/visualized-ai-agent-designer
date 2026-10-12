/**
 * The saved state of a `harness evolve` run (spec §6.2): `frontier.json`, the pins that make the rounds of a run comparable, and the
 * lock that keeps two runs out of one folder. The frontier is the commit point of a round: the loop writes it last, atomically, so a
 * crash leaves either the old frontier or the new one, never half of one. All of it lives in the run's folder.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { configDiff, configFromJson, type EvolveConfig } from "@/evolve/config";

export const FRONTIER_FILE = "frontier.json";
export const LOCK_FILE = "evolve.lock";

/** What makes the rounds of a run comparable. A resume with any of it different stops (exit 2). No keys. */
export interface Pins {
  taskSet: { path: string; hash: string };
  /** The starting workflow, as the user's file. */
  workflow: { path: string; hash: string };
  provider: { llmProvider: string; baseUrl: string; model: string; numCtx: number };
  /** Trials per task in each evaluation. */
  k: number;
  /** The method's parameters, T included. */
  config: EvolveConfig;
}

/** An evaluation's pooled score and cost. */
export interface Score {
  S: number;
  C: number | null;
}

export interface Frontier {
  version: 1;
  pins: Pins;
  /** The starting workflow as `base.harness.yaml` holds it (the hash is of that file), and its score. */
  base: Score & { hash: string };
  /** The workflow the next round starts from. `file` and `eval_dir` are relative to the run's folder, written with "/". */
  incumbent: Score & { t: number; file: string; hash: string; eval_dir: string; variant?: string };
  /** The best S so far: the floor of the admissibility rule is S* − delta. */
  S_star: number;
  /** Entry t is the incumbent after t rounds; a round is settled once the entry t+1 exists. */
  trajectory: Array<Score & { t: number; hash: string; eval_dir: string }>;
  /** Rounds in a row that ended with every candidate's evaluation invalid. */
  infra_streak: number;
  /** The held-out check, once it has run. It never enters selection. */
  heldout?: { base: Score; final: Score & { hash: string } };
}

// ── Reading and writing ───────────────────────────────────────────────────────

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errorCode = (e: unknown): string | undefined => (typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined);

/** The SHA-256 of a text, as hex. */
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Writes a file atomically: a temporary file next to it, then a rename, so a reader (or a crash) never sees half of it. Makes the
 *  file's folder if it is missing. */
export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  try {
    writeFileSync(temp, text);
    renameSync(temp, file);
  } catch (e) {
    try {
      rmSync(temp, { force: true }); // no half of a file is left behind
    } catch {
      // the first error is the one to report
    }
    throw e;
  }
}

// The config is checked as a `--config` file is (unknown keys are errors); the keys it lacks take their defaults.
const configField = z.unknown().transform((raw, ctx): EvolveConfig => {
  const checked = configFromJson(raw, {});
  if ("error" in checked) {
    ctx.addIssue({ code: "custom", message: checked.error });
    return z.NEVER;
  }
  return checked.config;
});

const score = { S: z.number(), C: z.number().nullable() };
const where = { path: z.string(), hash: z.string() };

const frontierSchema: z.ZodType<Frontier> = z.strictObject({
  version: z.literal(1),
  pins: z.strictObject({
    taskSet: z.strictObject(where),
    workflow: z.strictObject(where),
    provider: z.strictObject({ llmProvider: z.string(), baseUrl: z.string(), model: z.string(), numCtx: z.number() }),
    k: z.number().int().min(1),
    config: configField,
  }),
  base: z.strictObject({ ...score, hash: z.string() }),
  incumbent: z.strictObject({
    ...score, t: z.number().int().min(0), file: z.string(), hash: z.string(), eval_dir: z.string(), variant: z.string().optional(),
  }),
  S_star: z.number(),
  trajectory: z.array(z.strictObject({ ...score, t: z.number().int().min(0), hash: z.string(), eval_dir: z.string() })).min(1),
  infra_streak: z.number().int().min(0),
  heldout: z.strictObject({
    base: z.strictObject(score),
    final: z.strictObject({ ...score, hash: z.string() }),
  }).optional(),
});

/** The frontier of the run in `outDir`; undefined when there is none. A file that cannot be read, is not JSON or is not a frontier
 *  throws, naming the file and what is wrong. */
export function readFrontier(outDir: string): Frontier | undefined {
  const file = join(outDir, FRONTIER_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return undefined;
    throw new Error(`${file} cannot be read: ${messageOf(e)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not JSON: ${messageOf(e)}`);
  }
  const checked = frontierSchema.safeParse(raw);
  if (!checked.success) {
    const problems = checked.error.issues.slice(0, 5).map((issue) => `${issue.path.map(String).join(".") || "(the file)"}: ${issue.message}`);
    throw new Error(`${file} is not a frontier file: ${problems.join("; ")}`);
  }
  return checked.data;
}

/** Writes the frontier atomically. */
export function writeFrontier(outDir: string, frontier: Frontier): void {
  writeFileAtomic(join(outDir, FRONTIER_FILE), `${JSON.stringify(frontier, null, 2)}\n`);
}

// ── The pins ──────────────────────────────────────────────────────────────────

/** What differs between two sets of pins, one readable item each: `task set (hash)`, `model (a → b)`, `config: beta1 (40 → 12.5)`.
 *  Nothing when they are the same. Hashes and the base URL are named, not shown. */
export function pinDiff(a: Pins, b: Pins): string[] {
  const out: string[] = [];
  const change = (x: unknown, y: unknown): string => `${String(x)} → ${String(y)}`;
  if (a.taskSet.hash !== b.taskSet.hash) out.push("task set (hash)");
  if (a.taskSet.path !== b.taskSet.path) out.push(`task set (path ${change(a.taskSet.path, b.taskSet.path)})`);
  if (a.workflow.hash !== b.workflow.hash) out.push("workflow (hash)");
  if (a.workflow.path !== b.workflow.path) out.push(`workflow (path ${change(a.workflow.path, b.workflow.path)})`);
  if (a.provider.llmProvider !== b.provider.llmProvider) out.push(`provider (${change(a.provider.llmProvider, b.provider.llmProvider)})`);
  if (a.provider.baseUrl !== b.provider.baseUrl) out.push("base URL");
  if (a.provider.model !== b.provider.model) out.push(`model (${change(a.provider.model, b.provider.model)})`);
  if (a.provider.numCtx !== b.provider.numCtx) out.push(`context window (${change(a.provider.numCtx, b.provider.numCtx)})`);
  if (a.k !== b.k) out.push(`k (${change(a.k, b.k)})`);
  const shown = (value: unknown): string => (value === null ? "measured" : String(value));
  const keys = configDiff(a.config, b.config);
  if (keys.length > 0) out.push(`config: ${keys.map((key) => `${key} (${change(shown(a.config[key]), shown(b.config[key]))})`).join(", ")}`);
  return out;
}

// ── The lock ──────────────────────────────────────────────────────────────────

/** The process id a lock file holds; undefined for a file that holds none (empty, or not a number), which no process owns. */
function lockHolder(file: string): number | undefined {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a process with this id exists. A process we may not signal (EPERM) exists. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errorCode(e) === "EPERM";
  }
}

/**
 * Takes the lock of the run in `outDir`: `evolve.lock`, created exclusively (the `wx` flag) and holding this process's id. A lock
 * whose process is alive is not ours: the result is an error saying so. A lock whose process is gone (or that holds no process id)
 * is taken over.
 */
export function acquireLock(outDir: string): { ok: true } | { error: string } {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: "wx" });
      return { ok: true };
    } catch (e) {
      if (errorCode(e) !== "EEXIST") throw e;
    }
    const holder = lockHolder(file);
    if (holder !== undefined && isAlive(holder)) {
      return { error: `${file} is in use by process ${holder}; wait for it to finish, use a new --out, or delete the file if that process is not a harness evolve run` };
    }
    rmSync(file, { force: true }); // its process is gone: taken over, by one more try
  }
  return { error: `${file} could not be taken over: another process took it first; delete it if no harness evolve is running in this folder` };
}

/** Gives up the lock, if this process holds it: a lock another process took over is left alone. */
export function releaseLock(outDir: string): void {
  const file = join(outDir, LOCK_FILE);
  if (lockHolder(file) === process.pid) rmSync(file, { force: true });
}
