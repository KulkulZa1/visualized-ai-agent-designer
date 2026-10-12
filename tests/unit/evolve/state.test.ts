// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type EvolveConfig } from "@/evolve/config";
import {
  acquireLock, pinDiff, readFrontier, releaseLock, sha256, writeFileAtomic, writeFrontier, type Frontier, type Pins,
} from "@/evolve/state";

const scratch: string[] = [];
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "evolve-state-"));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The project's minimal Node typings do not declare these parts of `process`.
const proc = process as unknown as { pid: number; kill(pid: number, signal?: number): boolean };

const pins = (over: Partial<Pins> = {}): Pins => ({
  taskSet: { path: "/ts/set.tasks.yaml", hash: "ts-hash" }, workflow: { path: "/w/flow.harness.yaml", hash: "w-hash" },
  provider: { llmProvider: "ollama", baseUrl: "http://localhost:11434", model: "qwen3:8b", numCtx: 16384 }, k: 2, config: { ...DEFAULT_CONFIG }, ...over,
});

const frontier = (over: Partial<Frontier> = {}): Frontier => ({
  version: 1, pins: pins(), base: { hash: "base-hash", S: 0.5, C: 4200 },
  incumbent: { t: 1, file: "r0/A/candidate.harness.yaml", hash: "cand-hash", eval_dir: "r0/A/eval", S: 0.667, C: 4400, variant: "A" },
  S_star: 0.667,
  trajectory: [
    { t: 0, S: 0.5, C: 4200, hash: "base-hash", eval_dir: "base" },
    { t: 1, S: 0.667, C: 4400, hash: "cand-hash", eval_dir: "r0/A/eval" },
  ],
  infra_streak: 0, ...over,
});

describe("sha256", () => {
  it("is the hex digest", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("writeFileAtomic", () => {
  it("makes the folder, writes the text, and leaves no temporary file", () => {
    const dir = folder();

    writeFileAtomic(join(dir, "a", "b", "file.txt"), "text");

    expect(readFileSync(join(dir, "a", "b", "file.txt"), "utf8")).toBe("text");
    expect(readdirSync(join(dir, "a", "b"))).toEqual(["file.txt"]);
  });

  it("replaces a file that is there", () => {
    const dir = folder();
    writeFileAtomic(join(dir, "file.txt"), "one");

    writeFileAtomic(join(dir, "file.txt"), "two");

    expect(readFileSync(join(dir, "file.txt"), "utf8")).toBe("two");
  });

  it("throws, and leaves no temporary file, when the file cannot be put in place", () => {
    const dir = folder();
    mkdirSync(join(dir, "file.txt")); // a folder where the file should go

    expect(() => writeFileAtomic(join(dir, "file.txt"), "text")).toThrow();

    expect(readdirSync(dir)).toEqual(["file.txt"]);
  });
});

describe("the frontier", () => {
  it("is undefined when the folder has none", () => {
    expect(readFrontier(folder())).toBeUndefined();
  });

  it("is read back as it was written", () => {
    const dir = folder();
    const fr = frontier({
      infra_streak: 2, heldout: { base: { S: 0.4, C: null }, final: { S: 0.6, C: 4400, hash: "cand-hash" } },
      incumbent: { t: 0, file: "base.harness.yaml", hash: "base-hash", eval_dir: "base", S: 0.5, C: null },
    });

    writeFrontier(dir, fr);

    expect(readFrontier(dir)).toEqual(fr);
    expect(readdirSync(dir)).toEqual(["frontier.json"]);
    expect(readFileSync(join(dir, "frontier.json"), "utf8")).toMatch(/^\{\n {2}"version": 1,/);
  });

  it("is replaced as a whole by the next write", () => {
    const dir = folder();
    writeFrontier(dir, frontier());

    writeFrontier(dir, frontier({ S_star: 0.9 }));

    expect(readFrontier(dir)?.S_star).toBe(0.9);
    expect(readdirSync(dir)).toEqual(["frontier.json"]);
  });

  it("fills in the config keys a file lacks, with their defaults", () => {
    const dir = folder();
    writeFrontier(dir, frontier());
    const raw = JSON.parse(readFileSync(join(dir, "frontier.json"), "utf8"));
    delete raw.pins.config.n_prune;
    writeFileSync(join(dir, "frontier.json"), JSON.stringify(raw));

    expect(readFrontier(dir)?.pins.config.n_prune).toBe(DEFAULT_CONFIG.n_prune);
  });

  it("throws, naming the file and the problem, for a file that is not a frontier", () => {
    const dir = folder();
    const file = join(dir, "frontier.json");
    const edit = (change: (raw: Record<string, any>) => void): void => {
      const raw = JSON.parse(JSON.stringify(frontier()));
      change(raw);
      writeFileSync(file, JSON.stringify(raw));
    };

    writeFileSync(file, "{ not json");
    expect(() => readFrontier(dir)).toThrow(`${file} is not JSON`);
    writeFileSync(file, "[]");
    expect(() => readFrontier(dir)).toThrow(`${file} is not a frontier file`);
    edit((raw) => { raw.version = 2; });
    expect(() => readFrontier(dir)).toThrow("version");
    edit((raw) => { raw.incumbent.hash = 7; });
    expect(() => readFrontier(dir)).toThrow("incumbent.hash");
    edit((raw) => { raw.trajectory = []; });
    expect(() => readFrontier(dir)).toThrow("trajectory");
    edit((raw) => { raw.extra = true; });
    expect(() => readFrontier(dir)).toThrow("extra");
    edit((raw) => { raw.pins.config.beta7 = 1; });
    expect(() => readFrontier(dir)).toThrow('unknown key "beta7"');
  });

  it("throws when the file cannot be read", () => {
    const dir = folder();
    mkdirSync(join(dir, "frontier.json"));

    expect(() => readFrontier(dir)).toThrow("cannot be read");
  });
});

describe("pinDiff", () => {
  it("is empty for the same pins", () => {
    expect(pinDiff(pins(), pins())).toEqual([]);
  });

  it("names the task set and the workflow, and says a hash is a hash", () => {
    const changed = pins({ taskSet: { path: "/other/set.tasks.yaml", hash: "other" }, workflow: { path: "/w/flow.harness.yaml", hash: "w-other" } });

    expect(pinDiff(pins(), changed)).toEqual(["task set (hash)", "task set (path /ts/set.tasks.yaml → /other/set.tasks.yaml)", "workflow (hash)"]);
  });

  it("names the provider, the model and the window, with their values, and the base URL without its value", () => {
    const changed = pins({ provider: { llmProvider: "openai-compatible", baseUrl: "http://host:8000/v1?key=secret", model: "qwen3:14b", numCtx: 32768 } });

    expect(pinDiff(pins(), changed)).toEqual([
      "provider (ollama → openai-compatible)", "base URL", "model (qwen3:8b → qwen3:14b)", "context window (16384 → 32768)",
    ]);
  });

  it("says k, and lists the config keys that differ with the old and the new value", () => {
    const config: EvolveConfig = { ...DEFAULT_CONFIG, beta1: 12.5, T: 10, delta: 0.1 };

    expect(pinDiff(pins(), pins({ k: 3, config }))).toEqual(["k (2 → 3)", "config: T (20 → 10), delta (measured → 0.1), beta1 (40 → 12.5)"]);
    expect(pinDiff(pins({ config }), pins())).toEqual(["config: T (10 → 20), delta (0.1 → measured), beta1 (12.5 → 40)"]);
  });

  it("lists a single config key as the plan shows it", () => {
    expect(pinDiff(pins(), pins({ config: { ...DEFAULT_CONFIG, beta1: 12.5 } }))).toEqual(["config: beta1 (40 → 12.5)"]);
  });
});

describe("the lock", () => {
  it("is taken, with this process's id, and given up", () => {
    const dir = folder();

    expect(acquireLock(dir)).toEqual({ ok: true });
    expect(readFileSync(join(dir, "evolve.lock"), "utf8").trim()).toBe(String(proc.pid));
    releaseLock(dir);

    expect(existsSync(join(dir, "evolve.lock"))).toBe(false);
  });

  it("makes the folder when it is not there yet", () => {
    const dir = join(folder(), "new", "run");

    expect(acquireLock(dir)).toEqual({ ok: true });
    expect(existsSync(join(dir, "evolve.lock"))).toBe(true);
  });

  it("is refused while the process that holds it is alive, naming the process", () => {
    const dir = folder();
    writeFileSync(join(dir, "evolve.lock"), `${proc.pid}\n`); // this process is alive

    const result = acquireLock(dir);

    expect(result).toEqual({ error: expect.stringContaining(`evolve.lock is in use by process ${proc.pid}`) });
    expect(readFileSync(join(dir, "evolve.lock"), "utf8").trim()).toBe(String(proc.pid));
  });

  it("is taken over when the process that held it is gone", () => {
    const dir = folder();
    writeFileSync(join(dir, "evolve.lock"), "424242\n");
    vi.spyOn(proc, "kill").mockImplementation((pid: number) => {
      if (pid === 424242) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      return true;
    });

    expect(acquireLock(dir)).toEqual({ ok: true });
    expect(readFileSync(join(dir, "evolve.lock"), "utf8").trim()).toBe(String(proc.pid));
  });

  it("counts a process it may not signal as alive", () => {
    const dir = folder();
    writeFileSync(join(dir, "evolve.lock"), "777\n");
    vi.spyOn(proc, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });

    expect(acquireLock(dir)).toEqual({ error: expect.stringContaining("is in use by process 777") });
  });

  it("is taken over when the file holds no process id", () => {
    const dir = folder();
    writeFileSync(join(dir, "evolve.lock"), "");
    expect(acquireLock(dir)).toEqual({ ok: true });
    releaseLock(dir);
    writeFileSync(join(dir, "evolve.lock"), "not a number");

    expect(acquireLock(dir)).toEqual({ ok: true });
  });

  it("is left alone by a process that does not hold it", () => {
    const dir = folder();
    writeFileSync(join(dir, "evolve.lock"), "424242\n");

    releaseLock(dir);

    expect(existsSync(join(dir, "evolve.lock"))).toBe(true);
    releaseLock(folder()); // and giving up a lock that is not there is fine
  });
});
