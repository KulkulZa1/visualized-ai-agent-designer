import { describe, it, expect } from "vitest";
import { parseRunArgs, providerSettings, type RunArgs } from "@/cli/runArgs";

function ok(argv: string[]): RunArgs {
  const parsed = parseRunArgs(argv);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.args;
}
function error(argv: string[]): string | undefined {
  const parsed = parseRunArgs(argv);
  return "error" in parsed ? parsed.error : undefined;
}

describe("parseRunArgs", () => {
  it("reads the workflow, the task and every option", () => {
    expect(ok([
      "wf.harness.yaml", "--task", "Fix it", "--workspace", "repo", "--provider", "ollama",
      "--base-url", "http://gpu:11434", "--model", "qwen3:8b", "--max-parallel", "2", "--continue-on-error",
      "--allow-command", " npm test ", "--allow-command", "cargo test", "--json", "--core", "bin/harness-core",
    ])).toEqual({
      workflow: "wf.harness.yaml", task: "Fix it", workspace: "repo", provider: "ollama",
      baseUrl: "http://gpu:11434", model: "qwen3:8b", maxParallel: 2, continueOnError: true,
      allowCommands: ["npm test", "cargo test"], json: true, core: "bin/harness-core",
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
    [["wf.yaml", "--task", "t", "--provider", "openai-compatible"], /needs --base-url/],
  ])("rejects %j", (argv, message) => {
    expect(error(argv)).toMatch(message);
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
    });
  });

  it("gives HARNESS_CUSTOM_API_KEY only to an OpenAI-compatible endpoint", () => {
    const args = ok(["wf.yaml", "--task", "t", "--provider", "openai-compatible",
      "--base-url", "https://llm.example/v1", "--model", "m"]);
    expect(providerSettings(args, env)).toEqual({
      llmProvider: "openai-compatible", apiKey: "", openaiApiKey: "", ollamaApiKey: "",
      ollamaBaseUrl: "", ollamaModel: "",
      customApiUrl: "https://llm.example/v1", customApiKey: "custom-key", customApiModel: "m",
    });
  });
});
