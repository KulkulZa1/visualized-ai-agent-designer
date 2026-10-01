import { describe, it, expect } from "vitest";
import { EVAL_USAGE, parseEvalArgs, type EvalArgs } from "@/cli/evalArgs";
import { PROVIDER_ENV_USAGE, PROVIDER_OPTIONS_USAGE, RUN_USAGE, providerSettings } from "@/cli/runArgs";

type Env = Record<string, string | undefined>;

function ok(argv: string[], env: Env = {}): EvalArgs {
  const parsed = parseEvalArgs(argv, env);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.args;
}
function error(argv: string[], env: Env = {}): string | undefined {
  const parsed = parseEvalArgs(argv, env);
  return "error" in parsed ? parsed.error : undefined;
}

describe("parseEvalArgs", () => {
  it("reads the task set and every option", () => {
    expect(ok([
      "purchasing.tasks.yaml", "--workflow", "wf.harness.yaml", "--split", "heldout", "--only", "laptop", "--only", "phone",
      "--trials", "3", "--max-parallel-trials", "2", "--out", "runs/e1", "--keep-workspaces", "--min-score", "0.6", "--json",
      "--allow-scorer", " npm test ", "--allow-scorer", "node check.js", "--allow-command", "cargo test",
      "--provider", "ollama", "--base-url", "http://gpu:11434", "--model", "qwen3:8b", "--num-ctx", "32768",
      "--request-timeout", "1800", "--core", "bin/harness-core",
    ])).toEqual({
      taskSet: "purchasing.tasks.yaml", workflow: "wf.harness.yaml", split: "heldout", only: ["laptop", "phone"], trials: 3,
      maxParallelTrials: 2, out: "runs/e1", keepWorkspaces: true, minScore: 0.6, json: true,
      allowScorers: ["npm test", "node check.js"], allowCommands: ["cargo test"], core: "bin/harness-core",
      provider: "ollama", baseUrl: "http://gpu:11434", model: "qwen3:8b", numCtx: 32768, requestTimeoutSecs: 1800,
    });
  });

  it("defaults to the evolve split, one trial at a time, no scorer or agent command allowed", () => {
    expect(ok(["t.tasks.yaml"])).toEqual({
      taskSet: "t.tasks.yaml", provider: "auto", split: "evolve", only: [], maxParallelTrials: 1, keepWorkspaces: false,
      json: false, allowScorers: [], allowCommands: [],
    });
  });

  it("takes the number of trials from -k as well as --trials", () => {
    expect(ok(["t.yaml", "-k", "5"]).trials).toBe(5);
    expect(ok(["t.yaml", "--trials", "2"]).trials).toBe(2);
    expect(ok(["t.yaml", "--trials", "2", "-k", "7"]).trials).toBe(7); // the later one
  });

  it("takes up to 1000 trials, and no more: a typo of 10000 is not a quiet day of compute", () => {
    expect(ok(["t.yaml", "--trials", "1000"]).trials).toBe(1000);
    expect(ok(["t.yaml", "-k", "1000"]).trials).toBe(1000);
    expect(ok(["t.yaml", "-k", "1"]).trials).toBe(1);
  });

  it("lists a task once however often --only names it", () => {
    expect(ok(["t.yaml", "--only", "a", "--only", "b", "--only", "a"]).only).toEqual(["a", "b"]);
  });

  it("takes every split", () => {
    for (const split of ["evolve", "heldout", "smoke", "all"]) expect(ok(["t.yaml", "--split", split]).split).toBe(split);
  });

  it.each([
    [[], /exactly one task-set file/],
    [["a.yaml", "b.yaml"], /exactly one task-set file/],
    [["t.yaml", "--verbose"], /Unknown option: --verbose/],
    [["t.yaml", "-x"], /Unknown option: -x/],
    [["t.yaml", "--workflow"], /--workflow needs a value/],
    [["t.yaml", "--workflow", " "], /--workflow needs a file/],
    [["t.yaml", "--out", " "], /--out needs a folder/],
    [["t.yaml", "-k"], /-k needs a value/],
    [["t.yaml", "--split", "dev"], /--split must be one of: evolve, heldout, smoke, all/],
    [["t.yaml", "--only", "a b"], /--only a b: a task id has letters, digits/],
    [["t.yaml", "--only", "../x"], /--only \.\.\/x: a task id/],
    [["t.yaml", "--trials", "0"], /--trials must be a whole number from 1 to 1000/],
    [["t.yaml", "--trials", "1.5"], /--trials must be a whole number from 1 to 1000/],
    [["t.yaml", "--trials", "many"], /--trials must be a whole number from 1 to 1000/],
    [["t.yaml", "--trials", "1001"], /--trials must be a whole number from 1 to 1000/],
    [["t.yaml", "-k", "0"], /-k must be a whole number from 1 to 1000/],
    [["t.yaml", "-k", "1001"], /-k must be a whole number from 1 to 1000/],
    [["t.yaml", "--max-parallel-trials", "0"], /--max-parallel-trials must be a whole number of at least 1/],
    [["t.yaml", "--min-score", "1.5"], /--min-score must be a number from 0 to 1/],
    [["t.yaml", "--min-score", "-0.1"], /--min-score must be a number from 0 to 1/],
    [["t.yaml", "--min-score", "high"], /--min-score must be a number from 0 to 1/],
    [["t.yaml", "--min-score", ""], /--min-score must be a number from 0 to 1/],
    [["t.yaml", "--allow-scorer", " "], /--allow-scorer needs a command/],
    [["t.yaml", "--allow-command", " "], /--allow-command needs a command/],
  ])("rejects %j", (argv, message) => {
    expect(error(argv)).toMatch(message);
  });

  it("accepts the ends of the --min-score range", () => {
    expect(ok(["t.yaml", "--min-score", "0"]).minScore).toBe(0);
    expect(ok(["t.yaml", "--min-score", "1"]).minScore).toBe(1);
    expect(ok(["t.yaml", "--min-score", ".5"]).minScore).toBe(0.5);
  });

  describe("the provider options, which are harness run's", () => {
    const base = ["t.yaml"];

    it.each([
      [["--provider", "gemini"], /--provider must be one of/],
      [["--num-ctx", "16k"], /--num-ctx must be a whole number of tokens, 0 or more/],
      [["--request-timeout", "29"], /--request-timeout must be a whole number of seconds from 30 to 86400/],
      [["--provider", "openai", "--model", "gpt-5"], /each agent's model/],
      [["--provider", "openai-compatible"], /needs --base-url \(or HARNESS_CUSTOM_BASE_URL\)/],
    ])("rejects %j with the same words as harness run", (flags, message) => {
      expect(error([...base, ...flags])).toMatch(message);
    });

    it("reads the context window and the timeout from the environment, and lets a flag win", () => {
      const env = { HARNESS_OLLAMA_NUM_CTX: "8192", HARNESS_REQUEST_TIMEOUT_SECS: "900" };
      expect(ok(base, env)).toMatchObject({ numCtx: 8192, requestTimeoutSecs: 900 });
      expect(ok([...base, "--num-ctx", "4096"], env)).toMatchObject({ numCtx: 4096, requestTimeoutSecs: 900 });
      expect(error(base, { HARNESS_OLLAMA_NUM_CTX: "lots" })).toMatch(/^HARNESS_OLLAMA_NUM_CTX must be/);
    });

    it("takes the Custom endpoint from the environment, with --provider or with LLM_PROVIDER alone", () => {
      const env = { HARNESS_CUSTOM_BASE_URL: "http://llm:8080/v1", HARNESS_CUSTOM_MODEL: "served" };
      expect(ok([...base, "--provider", "openai-compatible"], env)).toMatchObject({ baseUrl: "http://llm:8080/v1", model: "served" });
      expect(ok(base, { ...env, LLM_PROVIDER: "openai-compatible" })).toMatchObject({ provider: "auto", baseUrl: "http://llm:8080/v1" });
      expect(ok([...base, "--provider", "ollama"], env).baseUrl).toBeUndefined();
    });

    it("gives providerSettings what it gives a run: the same settings from the same options", () => {
      const env = { HARNESS_CUSTOM_API_KEY: "key" };
      const args = ok([...base, "--provider", "openai-compatible", "--base-url", "https://llm.example/v1", "--model", "m"], env);
      expect(providerSettings(args, env)).toEqual({
        llmProvider: "openai-compatible", apiKey: "", openaiApiKey: "", ollamaApiKey: "", ollamaBaseUrl: "", ollamaModel: "",
        customApiUrl: "https://llm.example/v1", customApiKey: "key", customApiModel: "m", ollamaNumCtx: 16384, requestTimeoutSecs: 600,
      });
    });
  });
});

describe("EVAL_USAGE", () => {
  const optionLines = EVAL_USAGE.split("\n").filter((line) => line.startsWith("  --"));

  it("names every option the parser reads", () => {
    for (const flag of [
      "--workflow", "--split", "--only", "--trials", "-k", "--max-parallel-trials", "--out", "--keep-workspaces", "--min-score",
      "--allow-scorer", "--allow-command", "--provider", "--base-url", "--model", "--num-ctx", "--request-timeout", "--json", "--core",
    ]) {
      expect(EVAL_USAGE, flag).toContain(flag);
    }
  });

  it("keeps the descriptions of the options in one column", () => {
    const columns = optionLines.map((line) => /^( {2}--[\w-]+(?: <[^>]+>| "<[^>]+>")? +)\S/.exec(line)?.[1].length);

    expect(columns.length).toBeGreaterThan(15);
    expect(columns.every((column) => typeof column === "number")).toBe(true);
    expect(new Set(columns).size).toBe(1);
  });

  it("prints the provider options and the variables as harness run does", () => {
    expect(EVAL_USAGE).toContain(PROVIDER_OPTIONS_USAGE);
    expect(EVAL_USAGE).toContain(PROVIDER_ENV_USAGE);
    expect(RUN_USAGE).toContain(PROVIDER_OPTIONS_USAGE);
    expect(RUN_USAGE).toContain(PROVIDER_ENV_USAGE);
  });

  it("says the number of trials is bounded, and what --keep-workspaces keeps: the folder as it is after scoring", () => {
    expect(EVAL_USAGE).toMatch(/--trials <n> +Trials per task, 1 to 1000, also -k <n>/);
    expect(EVAL_USAGE).toMatch(/--keep-workspaces +Keep each trial's folder, as it is after scoring: restored files back, grader files in/);
  });

  it("says that the output and file scorers read what the agent left, before any command scorer runs", () => {
    const text = EVAL_USAGE.replace(/\s+/g, " ");

    expect(text).toContain("Output and file scorers read the trial before any command scorer runs, so they see what the agent left, and a file scorer cannot check what a scorer command builds.");
  });

  it("says which scorer commands run, how the exit codes read, and that every trial checks the provider", () => {
    expect(EVAL_USAGE).toContain("--allow-scorer");
    expect(EVAL_USAGE).toMatch(/Exit codes: 0 the eval finished, 1 --min-score was given and S is below it, 2 bad usage/);
    expect(EVAL_USAGE).toContain("130 interrupted");
    expect(EVAL_USAGE).toContain("Every trial checks the provider first");
  });
});
