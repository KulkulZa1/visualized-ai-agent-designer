/**
 * `harness run`'s command line: the workflow, the task and the options
 * (docs/HEADLESS.md). Pure, so the parsing is tested without a process.
 */
import type { ProviderSettings } from "@/engine/runWorkflow";
import type { LlmProvider } from "@/utils/providerConfig";

export interface RunArgs {
  workflow: string;
  task?: string;
  taskFile?: string;
  workspace?: string;
  provider: LlmProvider;
  baseUrl?: string;
  model?: string;
  maxParallel?: number;
  continueOnError: boolean;
  json: boolean;
  core?: string;
  /** Exact command lines agents may run; every other command is denied. */
  allowCommands: string[];
  /** A saved run to resume (its run id). */
  resume?: string;
}

export const RUN_USAGE = `Usage: harness run <workflow.harness.yaml> --task "…" [options]

  --task "<text>"            What the run should do (or --task-file <path>)
  --resume <runId>           Resume a saved run (.harness/runs/<runId>): finished, unchanged agents are reused
  --workspace <dir>          The folder the agents work in (default: the current folder)
  --provider <name>          auto, openai, anthropic, ollama, ollama-cloud or openai-compatible (default: auto)
  --base-url <url>           The Ollama or OpenAI-compatible endpoint
  --model <name>             The Ollama or OpenAI-compatible model (hosted providers use each agent's model)
  --max-parallel <n>         Agents running at once (default: the workflow's setting)
  --continue-on-error        Keep running the other agents after one fails
  --allow-command "<cmd>"    Let agents run this exact command (repeatable); every other command is denied
  --json                     One JSON event per line on stdout
  --core <path>              The harness-core binary (default: HARNESS_CORE, then src-tauri/target/release)

Keys come from the environment only: OPENAI_API_KEY, ANTHROPIC_API_KEY, OLLAMA_API_KEY,
OLLAMA_REMOTE_API_KEY, and HARNESS_CUSTOM_API_KEY for an OpenAI-compatible endpoint.
Exit codes: 0 done, 1 an agent failed, 2 bad usage or workflow, 3 could not start, 130 interrupted.`;

const PROVIDERS: readonly LlmProvider[] = ["auto", "openai", "anthropic", "ollama", "ollama-cloud", "openai-compatible"];
const TAKES_VALUE = new Set([
  "--task", "--task-file", "--workspace", "--provider", "--base-url", "--model", "--max-parallel", "--core",
  "--allow-command", "--resume",
]);

export function parseRunArgs(argv: string[]): { args: RunArgs } | { error: string } {
  const args: RunArgs = { workflow: "", provider: "auto", continueOnError: false, json: false, allowCommands: [] };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") { args.json = true; continue; }
    if (flag === "--continue-on-error") { args.continueOnError = true; continue; }
    if (!flag.startsWith("--")) { positionals.push(flag); continue; }
    if (!TAKES_VALUE.has(flag)) return { error: `Unknown option: ${flag}` };
    const value = argv[++i];
    if (value === undefined) return { error: `${flag} needs a value` };
    switch (flag) {
      case "--task": args.task = value; break;
      case "--task-file": args.taskFile = value; break;
      case "--workspace": args.workspace = value; break;
      case "--base-url": args.baseUrl = value; break;
      case "--model": args.model = value; break;
      case "--core": args.core = value; break;
      case "--resume": args.resume = value; break;
      case "--provider":
        if (!PROVIDERS.includes(value as LlmProvider)) {
          return { error: `--provider must be one of: ${PROVIDERS.join(", ")}` };
        }
        args.provider = value as LlmProvider;
        break;
      case "--max-parallel": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) return { error: "--max-parallel must be a whole number of at least 1" };
        args.maxParallel = n;
        break;
      }
      case "--allow-command":
        if (!value.trim()) return { error: "--allow-command needs a command" };
        args.allowCommands.push(value.trim());
        break;
    }
  }
  if (positionals.length !== 1) return { error: "Give exactly one workflow file." };
  args.workflow = positionals[0];
  if (args.task !== undefined && args.taskFile !== undefined) {
    return { error: "Give the task with --task or --task-file (one of them)." };
  }
  if (args.task === undefined && args.taskFile === undefined && args.resume === undefined) {
    return { error: "Give the task with --task or --task-file (one of them)." };
  }
  if (args.task !== undefined && !args.task.trim()) return { error: "The task is empty." };
  if ((args.provider === "openai" || args.provider === "anthropic") && (args.baseUrl || args.model)) {
    return { error: `--base-url and --model are for Ollama and OpenAI-compatible endpoints; ${args.provider} uses each agent's model.` };
  }
  if (args.provider === "openai-compatible" && !args.baseUrl) {
    return { error: "--provider openai-compatible needs --base-url" };
  }
  return { args };
}

/** The run's provider settings. harness-core reads OPENAI_API_KEY, ANTHROPIC_API_KEY,
 *  OLLAMA_API_KEY and OLLAMA_REMOTE_API_KEY itself when the key it gets is empty;
 *  Rust has no fallback for a custom endpoint, so its key (HARNESS_CUSTOM_API_KEY) is passed. */
export function providerSettings(args: RunArgs, env: Record<string, string | undefined>): ProviderSettings {
  const custom = args.provider === "openai-compatible";
  return {
    llmProvider: args.provider,
    apiKey: "",
    openaiApiKey: "",
    ollamaApiKey: "",
    ollamaBaseUrl: custom ? "" : args.baseUrl ?? "",
    ollamaModel: custom ? "" : args.model ?? "",
    customApiUrl: custom ? args.baseUrl ?? "" : "",
    customApiKey: custom ? env.HARNESS_CUSTOM_API_KEY ?? "" : "",
    customApiModel: custom ? args.model ?? "" : "",
  };
}
