import { describe, it, expect } from "vitest";
import { EVOLVE_USAGE, parseEvolveArgs, type EvolveArgs } from "@/cli/evolveArgs";
import { PROVIDER_ENV_USAGE, PROVIDER_OPTIONS_USAGE } from "@/cli/runArgs";

type Env = Record<string, string | undefined>;

function ok(argv: string[], env: Env = {}): EvolveArgs {
  const parsed = parseEvolveArgs(argv, env);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.args;
}
function error(argv: string[], env: Env = {}): string | undefined {
  const parsed = parseEvolveArgs(argv, env);
  return "error" in parsed ? parsed.error : undefined;
}

describe("parseEvolveArgs", () => {
  it("reads the task set and every option", () => {
    expect(ok([
      "purchasing.tasks.yaml", "--workflow", "wf.harness.yaml", "--out", "runs/e1", "--rounds", "5", "--trials", "3", "--candidates", "4",
      "--delta", "0.05", "--calibrate", "3", "--config", "method.json", "--proposer", "p.harness.yaml", "--critic", "c.harness.yaml",
      "--proposer-model", "qwen3:32b", "--critic-model", "qwen3:8b", "--allow-scorer", " npm test ", "--allow-scorer", "node check.js",
      "--allow-command", "cargo test", "--provider", "ollama", "--base-url", "http://gpu:11434", "--model", "qwen3:8b", "--num-ctx", "32768",
      "--request-timeout", "1800", "--core", "bin/harness-core",
    ])).toEqual({
      taskSet: "purchasing.tasks.yaml", workflow: "wf.harness.yaml", out: "runs/e1", rounds: 5, trials: 3, candidates: 4, delta: 0.05, calibrate: 3,
      config: "method.json", proposer: "p.harness.yaml", critic: "c.harness.yaml", proposerModel: "qwen3:32b", criticModel: "qwen3:8b",
      allowScorers: ["npm test", "node check.js"], allowCommands: ["cargo test"], core: "bin/harness-core",
      provider: "ollama", baseUrl: "http://gpu:11434", model: "qwen3:8b", numCtx: 32768, requestTimeoutSecs: 1800,
    });
  });

  it("leaves everything but the task set unset: the defaults are the command's and the method's", () => {
    expect(ok(["t.tasks.yaml"])).toEqual({ taskSet: "t.tasks.yaml", provider: "auto", allowScorers: [], allowCommands: [] });
  });

  it("takes the number of trials from -k as well as --trials, the later one winning", () => {
    expect(ok(["t.yaml", "-k", "5"]).trials).toBe(5);
    expect(ok(["t.yaml", "--trials", "2"]).trials).toBe(2);
    expect(ok(["t.yaml", "--trials", "2", "-k", "7"]).trials).toBe(7);
  });

  it("checks that a count is a whole number and --delta a finite number, and leaves their bounds to the method's settings", () => {
    for (const flag of ["--rounds", "--trials", "-k", "--candidates", "--calibrate"]) {
      for (const bad of ["1.5", "two", "", " ", "NaN", "Infinity"]) expect(error(["t.yaml", flag, bad]), `${flag} ${bad}`).toBe(`${flag} must be a whole number`);
    }
    for (const bad of ["", " ", "x", "NaN", "Infinity", "-Infinity"]) expect(error(["t.yaml", "--delta", bad]), `--delta ${bad}`).toBe("--delta must be a number");
    // Bounds are configFromJson's (one place for the messages): these all parse here.
    expect(ok(["t.yaml", "--rounds", "0", "-k", "5000", "--candidates", "99", "--calibrate", "1000"])).toMatchObject({
      rounds: 0, trials: 5000, candidates: 99, calibrate: 1000,
    });
    expect(ok(["t.yaml", "--delta", "-1"]).delta).toBe(-1);
    expect(ok(["t.yaml", "--delta", "0"]).delta).toBe(0);
  });

  it("needs exactly one task set, a known option and a value for each option", () => {
    expect(error([])).toBe("Give exactly one task-set file.");
    expect(error(["a.yaml", "b.yaml"])).toBe("Give exactly one task-set file.");
    expect(error(["t.yaml", "--bogus"])).toBe("Unknown option: --bogus");
    expect(error(["t.yaml", "--json"])).toBe("Unknown option: --json"); // evolve has no --json, --split or --only
    expect(error(["t.yaml", "--rounds"])).toBe("--rounds needs a value");
    expect(error(["t.yaml", "--proposer"])).toBe("--proposer needs a value");
  });

  it("refuses a blank file, folder, model or command", () => {
    expect(error(["t.yaml", "--workflow", " "])).toBe("--workflow needs a file");
    expect(error(["t.yaml", "--out", ""])).toBe("--out needs a folder");
    expect(error(["t.yaml", "--config", " "])).toBe("--config needs a file");
    expect(error(["t.yaml", "--proposer", " "])).toBe("--proposer needs a file");
    expect(error(["t.yaml", "--critic", " "])).toBe("--critic needs a file");
    expect(error(["t.yaml", "--proposer-model", " "])).toBe("--proposer-model needs a model name");
    expect(error(["t.yaml", "--critic-model", ""])).toBe("--critic-model needs a model name");
    expect(error(["t.yaml", "--allow-scorer", " "])).toBe("--allow-scorer needs a command");
    expect(error(["t.yaml", "--allow-command", ""])).toBe("--allow-command needs a command");
  });

  it("takes --proposer-model and --critic-model where --model applies, and not for a hosted provider", () => {
    for (const provider of ["auto", "ollama", "ollama-cloud"]) {
      expect(ok(["t.yaml", "--provider", provider, "--proposer-model", "a", "--critic-model", "b"])).toMatchObject({ proposerModel: "a", criticModel: "b" });
    }
    expect(ok(["t.yaml", "--provider", "openai-compatible", "--base-url", "http://x/v1", "--proposer-model", "a"]).proposerModel).toBe("a");
    for (const provider of ["openai", "anthropic"]) {
      expect(error(["t.yaml", "--provider", provider, "--proposer-model", "a"])).toBe(
        `--proposer-model and --critic-model are for Ollama and OpenAI-compatible endpoints; ${provider} uses each agent's model.`,
      );
      expect(error(["t.yaml", "--provider", provider, "--critic-model", "a"])).toContain(`${provider} uses each agent's model`);
      expect(error(["t.yaml", "--provider", provider, "--model", "a"])).toContain("--base-url and --model are for Ollama"); // --model's own rule
    }
  });

  it("shares harness run's provider options: their checks, and the environment variables a flag wins over", () => {
    expect(error(["t.yaml", "--provider", "bogus"])).toContain("--provider must be one of");
    expect(error(["t.yaml", "--num-ctx", "-1"])).toContain("--num-ctx must be a whole number");
    expect(error(["t.yaml", "--request-timeout", "5"])).toContain("--request-timeout must be");
    expect(error(["t.yaml", "--provider", "openai-compatible"])).toBe("--provider openai-compatible needs --base-url (or HARNESS_CUSTOM_BASE_URL)");

    const env = { HARNESS_OLLAMA_NUM_CTX: "8192", HARNESS_REQUEST_TIMEOUT_SECS: "900", LLM_PROVIDER: "openai-compatible", HARNESS_CUSTOM_BASE_URL: "http://env/v1", HARNESS_CUSTOM_MODEL: "env-model" };
    expect(ok(["t.yaml"], env)).toMatchObject({ numCtx: 8192, requestTimeoutSecs: 900, baseUrl: "http://env/v1", model: "env-model" });
    expect(ok(["t.yaml", "--num-ctx", "0", "--model", "flag-model"], env)).toMatchObject({ numCtx: 0, model: "flag-model" });
    expect(error(["t.yaml"], { HARNESS_OLLAMA_NUM_CTX: "lots" })).toContain("HARNESS_OLLAMA_NUM_CTX");
  });
});

describe("EVOLVE_USAGE", () => {
  it("names every option, the provider options and the exit codes", () => {
    expect(EVOLVE_USAGE).toContain("Usage: harness evolve <tasks.yaml> [options]");
    for (const flag of [
      "--workflow <file>", "--out <dir>", "--rounds <T>", "--trials <n>", "-k <n>", "--candidates <m>", "--delta <x>", "--calibrate <R>", "--config <file.json>",
      "--proposer <file>", "--critic <file>", "--proposer-model <name>", "--critic-model <name>", "--allow-scorer", "--allow-command", "--core <path>",
    ]) expect(EVOLVE_USAGE, flag).toContain(flag);
    expect(EVOLVE_USAGE).toContain(PROVIDER_OPTIONS_USAGE);
    expect(EVOLVE_USAGE).toContain(PROVIDER_ENV_USAGE);
    expect(EVOLVE_USAGE).toContain("Exit codes: 0 the rounds are done, whatever the gain, 2 bad usage");
    expect(EVOLVE_USAGE).toContain("130 interrupted");
  });
});
