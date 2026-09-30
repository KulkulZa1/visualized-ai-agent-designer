import { describe, it, expect } from "vitest";
import { parseRunArgs, providerSettings, RUN_USAGE, type RunArgs } from "@/cli/runArgs";

type Env = Record<string, string | undefined>;

function ok(argv: string[], env: Env = {}): RunArgs {
  const parsed = parseRunArgs(argv, env);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.args;
}
function error(argv: string[], env: Env = {}): string | undefined {
  const parsed = parseRunArgs(argv, env);
  return "error" in parsed ? parsed.error : undefined;
}

describe("parseRunArgs", () => {
  it("reads the workflow, the task and every option", () => {
    expect(ok([
      "wf.harness.yaml", "--task", "Fix it", "--workspace", "repo", "--provider", "ollama",
      "--base-url", "http://gpu:11434", "--model", "qwen3:8b", "--max-parallel", "2", "--continue-on-error",
      "--allow-command", " npm test ", "--allow-command", "cargo test", "--json", "--core", "bin/harness-core",
      "--num-ctx", "32768", "--request-timeout", "1800",
    ])).toEqual({
      workflow: "wf.harness.yaml", task: "Fix it", workspace: "repo", provider: "ollama",
      baseUrl: "http://gpu:11434", model: "qwen3:8b", maxParallel: 2, continueOnError: true,
      allowCommands: ["npm test", "cargo test"], json: true, core: "bin/harness-core",
      numCtx: 32768, requestTimeoutSecs: 1800,
    });
  });

  it("defaults to the auto provider, stopping at the first failure, with no commands allowed", () => {
    expect(ok(["wf.yaml", "--task-file", "task.md"])).toEqual({
      workflow: "wf.yaml", taskFile: "task.md", provider: "auto", continueOnError: false, json: false,
      allowCommands: [],
    });
  });

  it("takes --resume, which makes the task optional", () => {
    expect(ok(["wf.yaml", "--resume", "run-17"])).toEqual({
      workflow: "wf.yaml", resume: "run-17", provider: "auto", continueOnError: false, json: false, allowCommands: [],
    });
  });

  it.each([
    [["--task", "t"], /one workflow file/],
    [["a.yaml", "b.yaml", "--task", "t"], /one workflow file/],
    [["wf.yaml"], /--task or --task-file/],
    [["wf.yaml", "--task", "t", "--task-file", "f"], /--task or --task-file/],
    [["wf.yaml", "--task", "  "], /task is empty/],
    [["wf.yaml", "--task"], /--task needs a value/],
    [["wf.yaml", "--task", "t", "--verbose"], /Unknown option: --verbose/],
    [["wf.yaml", "--task", "t", "--provider", "gemini"], /--provider must be one of/],
    [["wf.yaml", "--task", "t", "--max-parallel", "0"], /--max-parallel/],
    [["wf.yaml", "--task", "t", "--allow-command", " "], /--allow-command needs a command/],
    [["wf.yaml", "--task", "t", "--provider", "openai", "--model", "gpt-5"], /each agent's model/],
    [["wf.yaml", "--task", "t", "--provider", "openai-compatible"], /needs --base-url \(or HARNESS_CUSTOM_BASE_URL\)/],
    [["wf.yaml", "--task", "t", "--num-ctx", "-1"], /--num-ctx must be a whole number of tokens, 0 or more/],
    [["wf.yaml", "--task", "t", "--num-ctx", "16k"], /--num-ctx must be a whole number/],
    [["wf.yaml", "--task", "t", "--num-ctx", "8192.5"], /--num-ctx must be a whole number/],
    [["wf.yaml", "--task", "t", "--num-ctx", ""], /--num-ctx must be a whole number/],
    [["wf.yaml", "--task", "t", "--num-ctx"], /--num-ctx needs a value/],
    [["wf.yaml", "--task", "t", "--request-timeout", "29"], /--request-timeout must be a whole number of seconds from 30 to 86400/],
    [["wf.yaml", "--task", "t", "--request-timeout", "86401"], /--request-timeout must be a whole number of seconds from 30 to 86400/],
    [["wf.yaml", "--task", "t", "--request-timeout", "ten"], /--request-timeout must be a whole number/],
  ])("rejects %j", (argv, message) => {
    expect(error(argv)).toMatch(message);
  });
});

describe("parseRunArgs: the options the environment can give", () => {
  const base = ["wf.yaml", "--task", "t"];

  it("takes --num-ctx and --request-timeout from HARNESS_OLLAMA_NUM_CTX and HARNESS_REQUEST_TIMEOUT_SECS", () => {
    const args = ok(base, { HARNESS_OLLAMA_NUM_CTX: "8192", HARNESS_REQUEST_TIMEOUT_SECS: "900" });
    expect(args).toMatchObject({ numCtx: 8192, requestTimeoutSecs: 900 });
  });

  it("leaves them unset when neither a flag nor a variable gives one, for the defaults to apply", () => {
    const args = ok(base, {});
    expect(args.numCtx).toBeUndefined();
    expect(args.requestTimeoutSecs).toBeUndefined();
  });

  it("lets a flag win over its variable", () => {
    const env = { HARNESS_OLLAMA_NUM_CTX: "8192", HARNESS_REQUEST_TIMEOUT_SECS: "900" };
    expect(ok([...base, "--num-ctx", "4096", "--request-timeout", "1200"], env))
      .toMatchObject({ numCtx: 4096, requestTimeoutSecs: 1200 });
    // Each option on its own.
    expect(ok([...base, "--num-ctx", "4096"], env)).toMatchObject({ numCtx: 4096, requestTimeoutSecs: 900 });
    expect(ok([...base, "--request-timeout", "1200"], env)).toMatchObject({ numCtx: 8192, requestTimeoutSecs: 1200 });
  });

  it("counts 0 as a value, from a flag and from the variable: the server's default, asked for", () => {
    expect(ok([...base, "--num-ctx", "0"], { HARNESS_OLLAMA_NUM_CTX: "8192" }).numCtx).toBe(0);
    expect(ok(base, { HARNESS_OLLAMA_NUM_CTX: "0" }).numCtx).toBe(0);
  });

  it("does not read a flag's bad variable: the flag wins, and a bad variable alone is an error naming it", () => {
    expect(ok([...base, "--num-ctx", "4096"], { HARNESS_OLLAMA_NUM_CTX: "lots" }).numCtx).toBe(4096);
    expect(error(base, { HARNESS_OLLAMA_NUM_CTX: "lots" })).toMatch(/^HARNESS_OLLAMA_NUM_CTX must be a whole number of tokens, 0 or more/);
    expect(error(base, { HARNESS_OLLAMA_NUM_CTX: "-5" })).toMatch(/^HARNESS_OLLAMA_NUM_CTX /);
    expect(error(base, { HARNESS_REQUEST_TIMEOUT_SECS: "5" })).toMatch(/^HARNESS_REQUEST_TIMEOUT_SECS must be a whole number of seconds from 30 to 86400/);
    expect(ok([...base, "--request-timeout", "60"], { HARNESS_REQUEST_TIMEOUT_SECS: "5" }).requestTimeoutSecs).toBe(60);
  });

  it("treats a blank variable as unset", () => {
    const args = ok(base, { HARNESS_OLLAMA_NUM_CTX: "", HARNESS_REQUEST_TIMEOUT_SECS: "  ", HARNESS_CUSTOM_BASE_URL: "" });
    expect(args.numCtx).toBeUndefined();
    expect(args.requestTimeoutSecs).toBeUndefined();
  });

  describe("for an OpenAI-compatible endpoint", () => {
    const custom = { HARNESS_CUSTOM_BASE_URL: "http://llm:8080/v1", HARNESS_CUSTOM_MODEL: "served" };

    it("takes --base-url and --model from HARNESS_CUSTOM_BASE_URL and HARNESS_CUSTOM_MODEL with --provider openai-compatible", () => {
      const args = ok([...base, "--provider", "openai-compatible"], custom);
      expect(args).toMatchObject({ provider: "openai-compatible", baseUrl: "http://llm:8080/v1", model: "served" });
    });

    it("takes them with LLM_PROVIDER=openai-compatible and no --provider at all", () => {
      const args = ok(base, { ...custom, LLM_PROVIDER: "openai-compatible" });
      expect(args).toMatchObject({ provider: "auto", baseUrl: "http://llm:8080/v1", model: "served" });
    });

    it("lets the flags win over the variables", () => {
      const args = ok([...base, "--provider", "openai-compatible", "--base-url", "http://flag/v1", "--model", "from-flag"], custom);
      expect(args).toMatchObject({ baseUrl: "http://flag/v1", model: "from-flag" });
      // Each on its own.
      expect(ok([...base, "--provider", "openai-compatible", "--base-url", "http://flag/v1"], custom))
        .toMatchObject({ baseUrl: "http://flag/v1", model: "served" });
      expect(ok([...base, "--provider", "openai-compatible", "--model", "from-flag"], custom))
        .toMatchObject({ baseUrl: "http://llm:8080/v1", model: "from-flag" });
    });

    it("needs a base URL from one of them, and says where it can come from", () => {
      expect(error([...base, "--provider", "openai-compatible"], { HARNESS_CUSTOM_MODEL: "served" }))
        .toMatch(/--provider openai-compatible needs --base-url \(or HARNESS_CUSTOM_BASE_URL\)/);
    });

    it("runs on with no model: each agent is sent its own", () => {
      const args = ok([...base, "--provider", "openai-compatible"], { HARNESS_CUSTOM_BASE_URL: "http://llm:8080/v1" });
      expect(args.model).toBeUndefined();
    });

    it("leaves other providers alone: the variables are not their --base-url or --model", () => {
      for (const provider of ["auto", "ollama", "ollama-cloud", "openai", "anthropic"]) {
        const args = ok([...base, "--provider", provider], custom);
        expect(args.baseUrl, provider).toBeUndefined();
        expect(args.model, provider).toBeUndefined();
      }
    });
  });
});

describe("RUN_USAGE", () => {
  const optionLines = RUN_USAGE.split("\n").filter((line) => line.startsWith("  --"));

  it("says beside --request-timeout that an agent's own timeoutSeconds still bounds its whole run", () => {
    expect(optionLines.find((line) => line.includes("--request-timeout"))).toBe(
      "  --request-timeout <secs>   How long one model call may take in total, 30 to 86400 (default 600); " +
      "an agent's own timeoutSeconds still bounds its whole run");
  });

  it("keeps the descriptions of the options in one column", () => {
    const columns = optionLines.map((line) => /^( {2}--[\w-]+(?: <[^>]+>| "<[^>]+>")? +)\S/.exec(line)?.[1].length);

    expect(columns.length).toBeGreaterThan(10);
    expect(new Set(columns)).toEqual(new Set([29]));
  });
});

describe("providerSettings", () => {
  const env = {
    OPENAI_API_KEY: "sk-openai", ANTHROPIC_API_KEY: "sk-ant", OLLAMA_API_KEY: "ol",
    HARNESS_CUSTOM_API_KEY: "custom-key",
  };

  it("leaves the hosted and Ollama keys in the environment, where harness-core reads them", () => {
    const args = ok(["wf.yaml", "--task", "t", "--provider", "ollama", "--base-url", "http://gpu:11434", "--model", "qwen3:8b"]);
    expect(providerSettings(args, env)).toEqual({
      llmProvider: "ollama", apiKey: "", openaiApiKey: "", ollamaApiKey: "",
      ollamaBaseUrl: "http://gpu:11434", ollamaModel: "qwen3:8b",
      customApiUrl: "", customApiKey: "", customApiModel: "",
      ollamaNumCtx: 16384, requestTimeoutSecs: 600,
    });
  });

  it("gives HARNESS_CUSTOM_API_KEY only to an OpenAI-compatible endpoint", () => {
    const args = ok(["wf.yaml", "--task", "t", "--provider", "openai-compatible",
      "--base-url", "https://llm.example/v1", "--model", "m"]);
    expect(providerSettings(args, env)).toEqual({
      llmProvider: "openai-compatible", apiKey: "", openaiApiKey: "", ollamaApiKey: "",
      ollamaBaseUrl: "", ollamaModel: "",
      customApiUrl: "https://llm.example/v1", customApiKey: "custom-key", customApiModel: "m",
      ollamaNumCtx: 16384, requestTimeoutSecs: 600,
    });
  });

  it("carries the context window and the timeout, 16384 tokens and 600 s when none was given", () => {
    const args = ok(["wf.yaml", "--task", "t", "--num-ctx", "0", "--request-timeout", "7200"]);
    expect(providerSettings(args, {})).toMatchObject({ ollamaNumCtx: 0, requestTimeoutSecs: 7200 });
    expect(providerSettings(ok(["wf.yaml", "--task", "t"]), {})).toMatchObject({ ollamaNumCtx: 16384, requestTimeoutSecs: 600 });
    expect(providerSettings(ok(["wf.yaml", "--task", "t"], { HARNESS_OLLAMA_NUM_CTX: "4096" }), {}))
      .toMatchObject({ ollamaNumCtx: 4096 });
  });

  it("sends a Custom endpoint from the environment alone: the URL and the model, with the key", () => {
    const fromEnv = { ...env, HARNESS_CUSTOM_BASE_URL: "http://llm:8080/v1", HARNESS_CUSTOM_MODEL: "served" };
    const args = ok(["wf.yaml", "--task", "t", "--provider", "openai-compatible"], fromEnv);

    expect(providerSettings(args, fromEnv)).toMatchObject({
      llmProvider: "openai-compatible", ollamaBaseUrl: "", ollamaModel: "",
      customApiUrl: "http://llm:8080/v1", customApiKey: "custom-key", customApiModel: "served",
    });
  });

  it("selects the Custom endpoint with LLM_PROVIDER alone, and sends --base-url and --model to it", () => {
    const fromEnv = { LLM_PROVIDER: "openai-compatible", HARNESS_CUSTOM_API_KEY: "custom-key" };
    const args = ok(["wf.yaml", "--task", "t", "--base-url", "http://llm:8080/v1", "--model", "served"], fromEnv);

    expect(providerSettings(args, fromEnv)).toMatchObject({
      llmProvider: "auto", ollamaBaseUrl: "", ollamaModel: "",
      customApiUrl: "http://llm:8080/v1", customApiKey: "custom-key", customApiModel: "served",
    });
  });

  it("does not use the Custom endpoint for another provider, whatever the environment holds", () => {
    const fromEnv = { ...env, HARNESS_CUSTOM_BASE_URL: "http://llm:8080/v1", HARNESS_CUSTOM_MODEL: "served" };
    for (const provider of ["auto", "ollama", "openai"]) {
      const args = ok(["wf.yaml", "--task", "t", "--provider", provider], fromEnv);
      expect(providerSettings(args, fromEnv)).toMatchObject({ customApiUrl: "", customApiKey: "", customApiModel: "" });
      expect(args.baseUrl).toBeUndefined();
      expect(args.model).toBeUndefined();
    }
    // LLM_PROVIDER names the Custom endpoint only when no --provider was given.
    const args = ok(["wf.yaml", "--task", "t", "--provider", "ollama"], { ...fromEnv, LLM_PROVIDER: "openai-compatible" });
    expect(providerSettings(args, { ...fromEnv, LLM_PROVIDER: "openai-compatible" })).toMatchObject({ customApiUrl: "" });
  });
});
