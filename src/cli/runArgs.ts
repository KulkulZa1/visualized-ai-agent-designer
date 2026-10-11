/**
 * `harness run`'s command line: the workflow, the task and the options
 * (docs/HEADLESS.md). Pure, so the parsing is tested without a process.
 */
import type { ProviderSettings } from "@/engine/runWorkflow";
import {
  DEFAULT_OLLAMA_NUM_CTX,
  DEFAULT_REQUEST_TIMEOUT_SECS,
  parseNumCtx,
  parseRequestTimeoutSecs,
  type LlmProvider,
} from "@/utils/providerConfig";

type Env = Record<string, string | undefined>;

/** The provider options `harness run` and `harness eval` share. */
export interface ProviderArgs {
  provider: LlmProvider;
  /** --base-url; for an OpenAI-compatible endpoint, else HARNESS_CUSTOM_BASE_URL. */
  baseUrl?: string;
  /** --model; for an OpenAI-compatible endpoint, else HARNESS_CUSTOM_MODEL. */
  model?: string;
  /** Ollama's context window in tokens: --num-ctx, else HARNESS_OLLAMA_NUM_CTX. 0 sends none. */
  numCtx?: number;
  /** Seconds one model call may take in total: --request-timeout, else HARNESS_REQUEST_TIMEOUT_SECS. */
  requestTimeoutSecs?: number;
}

export interface RunArgs extends ProviderArgs {
  workflow: string;
  task?: string;
  taskFile?: string;
  workspace?: string;
  maxParallel?: number;
  continueOnError: boolean;
  json: boolean;
  core?: string;
  /** Exact command lines agents may run; every other command is denied. */
  allowCommands: string[];
  /** A saved run to resume (its run id). */
  resume?: string;
}

/** The usage lines of the provider options, as `harness run` and `harness eval` both print them. */
export const PROVIDER_OPTIONS_USAGE = `  --provider <name>          auto, openai, anthropic, ollama, ollama-cloud or openai-compatible (default: auto)
  --base-url <url>           The Ollama or OpenAI-compatible endpoint
  --model <name>             The Ollama or OpenAI-compatible model (hosted providers use each agent's model)
  --num-ctx <n>              Ollama's context window in tokens, sent as num_ctx (default 16384; 0 sends none, so the server's own default stands)
  --request-timeout <secs>   How long one model call may take in total, 30 to 86400 (default 600); an agent's own timeoutSeconds still bounds its whole run`;

/** The usage paragraph on the keys and the environment variables of the provider options. */
export const PROVIDER_ENV_USAGE = `Keys come from the environment only: OPENAI_API_KEY, ANTHROPIC_API_KEY, OLLAMA_API_KEY,
OLLAMA_REMOTE_API_KEY, and HARNESS_CUSTOM_API_KEY for an OpenAI-compatible endpoint.
Some options can come from the environment too; a flag wins over its variable:
  HARNESS_OLLAMA_NUM_CTX        --num-ctx
  HARNESS_REQUEST_TIMEOUT_SECS  --request-timeout
  HARNESS_CUSTOM_BASE_URL       --base-url, for an OpenAI-compatible endpoint
  HARNESS_CUSTOM_MODEL          --model, for an OpenAI-compatible endpoint
With LLM_PROVIDER=openai-compatible, --provider is not needed.`;

export const RUN_USAGE = `Usage: harness run <workflow.harness.yaml> --task "…" [options]

  --task "<text>"            What the run should do (or --task-file <path>)
  --resume <runId>           Resume a saved run (.harness/runs/<runId>): finished, unchanged agents are reused
  --workspace <dir>          The folder the agents work in (default: the current folder)
${PROVIDER_OPTIONS_USAGE}
  --max-parallel <n>         Agents running at once (default: the workflow's setting)
  --continue-on-error        Keep running the other agents after one fails
  --allow-command "<cmd>"    Let agents run this exact command (repeatable); every other command is denied
  --json                     One JSON event per line on stdout
  --core <path>              The harness-core binary (default: HARNESS_CORE, then src-tauri/target/release)

${PROVIDER_ENV_USAGE}
Exit codes: 0 done, 1 an agent failed, 2 bad usage or workflow, 3 could not start, 130 interrupted.`;

const PROVIDERS: readonly LlmProvider[] = ["auto", "openai", "anthropic", "ollama", "ollama-cloud", "openai-compatible"];
/** The flags that carry the provider options, which harness eval takes too. */
export const PROVIDER_FLAGS: ReadonlySet<string> = new Set([
  "--provider", "--base-url", "--model", "--num-ctx", "--request-timeout",
]);
const TAKES_VALUE = new Set([
  "--task", "--task-file", "--workspace", "--max-parallel", "--core", "--allow-command", "--resume", ...PROVIDER_FLAGS,
]);

const NUM_CTX_RULE = "must be a whole number of tokens, 0 or more";
const REQUEST_TIMEOUT_RULE = "must be a whole number of seconds from 30 to 86400";

/** True when the run's model calls go to the Custom endpoint: --provider openai-compatible, or no
 *  --provider and LLM_PROVIDER=openai-compatible (harness-core reads that variable, as the app does). */
export function usesCustomEndpoint(provider: LlmProvider, env: Env): boolean {
  return provider === "openai-compatible" || (provider === "auto" && env.LLM_PROVIDER === "openai-compatible");
}

/** An environment variable's value, or undefined when it is unset or blank. */
function envText(env: Env, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

/** Takes the value of one of the provider flags (PROVIDER_FLAGS) into `args`; what is wrong with it, if anything. */
export function parseProviderFlag(args: ProviderArgs, flag: string, value: string): string | undefined {
  switch (flag) {
    case "--base-url": args.baseUrl = value; break;
    case "--model": args.model = value; break;
    case "--provider":
      if (!PROVIDERS.includes(value as LlmProvider)) return `--provider must be one of: ${PROVIDERS.join(", ")}`;
      args.provider = value as LlmProvider;
      break;
    case "--num-ctx": {
      const n = parseNumCtx(value);
      if (n === null) return `--num-ctx ${NUM_CTX_RULE}`;
      args.numCtx = n;
      break;
    }
    case "--request-timeout": {
      const n = parseRequestTimeoutSecs(value);
      if (n === null) return `--request-timeout ${REQUEST_TIMEOUT_RULE}`;
      args.requestTimeoutSecs = n;
      break;
    }
  }
  return undefined;
}

/** After the flags are read: the provider options the environment gives when no flag did, and the checks
 *  that need them; what is wrong, if anything. */
export function finishProviderArgs(args: ProviderArgs, env: Env): string | undefined {
  if ((args.provider === "openai" || args.provider === "anthropic") && (args.baseUrl || args.model)) {
    return `--base-url and --model are for Ollama and OpenAI-compatible endpoints; ${args.provider} uses each agent's model.`;
  }
  // The options the environment can give, when no flag did.
  const numCtx = envText(env, "HARNESS_OLLAMA_NUM_CTX");
  if (args.numCtx === undefined && numCtx !== undefined) {
    const n = parseNumCtx(numCtx);
    if (n === null) return `HARNESS_OLLAMA_NUM_CTX ${NUM_CTX_RULE}`;
    args.numCtx = n;
  }
  const timeout = envText(env, "HARNESS_REQUEST_TIMEOUT_SECS");
  if (args.requestTimeoutSecs === undefined && timeout !== undefined) {
    const n = parseRequestTimeoutSecs(timeout);
    if (n === null) return `HARNESS_REQUEST_TIMEOUT_SECS ${REQUEST_TIMEOUT_RULE}`;
    args.requestTimeoutSecs = n;
  }
  if (usesCustomEndpoint(args.provider, env)) {
    args.baseUrl ??= envText(env, "HARNESS_CUSTOM_BASE_URL");
    args.model ??= envText(env, "HARNESS_CUSTOM_MODEL");
  }
  if (args.provider === "openai-compatible" && !args.baseUrl) {
    return "--provider openai-compatible needs --base-url (or HARNESS_CUSTOM_BASE_URL)";
  }
  return undefined;
}

/** `env` is where the options that can also come from the environment are read; a flag wins. */
export function parseRunArgs(argv: string[], env: Env = {}): { args: RunArgs } | { error: string } {
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
    if (PROVIDER_FLAGS.has(flag)) {
      const problem = parseProviderFlag(args, flag, value);
      if (problem) return { error: problem };
      continue;
    }
    switch (flag) {
      case "--task": args.task = value; break;
      case "--task-file": args.taskFile = value; break;
      case "--workspace": args.workspace = value; break;
      case "--core": args.core = value; break;
      case "--resume": args.resume = value; break;
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
  const problem = finishProviderArgs(args, env);
  if (problem) return { error: problem };
  return { args };
}

/** The run's provider settings. harness-core reads OPENAI_API_KEY, ANTHROPIC_API_KEY,
 *  OLLAMA_API_KEY and OLLAMA_REMOTE_API_KEY itself when the key it gets is empty;
 *  Rust has no fallback for a custom endpoint, so its key (HARNESS_CUSTOM_API_KEY) is passed. */
export function providerSettings(args: ProviderArgs, env: Env): ProviderSettings {
  const custom = usesCustomEndpoint(args.provider, env);
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
    ollamaNumCtx: args.numCtx ?? DEFAULT_OLLAMA_NUM_CTX,
    requestTimeoutSecs: args.requestTimeoutSecs ?? DEFAULT_REQUEST_TIMEOUT_SECS,
  };
}
