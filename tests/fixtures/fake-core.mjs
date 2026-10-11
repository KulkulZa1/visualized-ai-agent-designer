/**
 * A stand-in for harness-core in the CLI tests: the same JSON-lines protocol
 * (src-tauri/src/commands/core_server.rs) with canned model replies.
 *
 * FAKE_CORE_SCENARIO: a JSON file { replies: { <agent>: (string | { text, usage? })[] }, usage?: { <agent>: { input, output } },
 *   healthFails?: true, healthFailsOn?: number[], olderCore?: true }.
 *   An agent's replies are used in order, and the last one repeats. A reply whose text
 *   starts with "ERROR:" is returned as that call's error. The text-protocol commands (call_ollama_api and
 *   call_openai_api) answer in one of the two shapes the real ones have had: a string reply is answered as a bare
 *   string, as a harness-core from before token usage did (no usage), unless the scenario's `usage` has an entry
 *   for the agent: then it is answered as { text, usage } with that entry, as the current one does. A reply that
 *   is an object { text, usage? } is answered as it is written: { text } for a server that sent no counts,
 *   { text, usage: { input, output } } for one that did (a different count per call, or a call with none in the
 *   middle of others). healthFails: every provider check fails;
 *   healthFailsOn: only the checks with these numbers (1 is the first) do. healthPull: the pull_command the failing
 *   checks carry (the engine adds "\nRun: <it>" to the error of a run that cannot start). olderCore: a harness-core
 *   from before hook_fingerprint, which answers that command with "Unknown command".
 *   hookRewrites: { <hook path>: { path, content } }: that hook, when it runs, writes `content` to
 *   the workspace file `path`, as an approved shell command in an agent would.
 *   commands: { <command line>: { exitCode?, stdout?, stderr?, timeout?: true, fail?: string, delayMs?, snapshot?: true, run?: true } }:
 *   what execute_command answers for that exact command; a command not listed answers exit 0 and
 *   `commandOutput` ("5 passed"). timeout: the error harness-core gives when the command runs out of time
 *   ("Command timed out after N s"); fail: "Could not start the command: <fail>"; delayMs: the answer
 *   comes after that long, or at once when cancel_command is given the command's id (a killed command
 *   answers exit 137); snapshot: stdout is a JSON object of every file in the workspace (not .harness)
 *   and its text, as it is when the command runs; die: harness-core exits when it is asked to run it;
 *   run: the command really runs, as `sh -c <command>` in the workspace (POSIX only), and its exit code and
 *   output are the answer.
 * FAKE_CORE_LOG: a file each request is appended to as a JSON line.
 * Test-only commands: "echo" (replies with its args), "fail", "slow", "die".
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { hookFingerprint } from "./hookFingerprint.mjs";

const scenario = process.env.FAKE_CORE_SCENARIO
  ? JSON.parse(readFileSync(process.env.FAKE_CORE_SCENARIO, "utf8"))
  : { replies: {} };
const calls = {};
let healthChecks = 0; // the provider checks so far, for healthFailsOn

function modelReply(system) {
  const agent = /^You are (.+?),/.exec(system ?? "")?.[1] ?? "?";
  const replies = scenario.replies?.[agent] ?? ["ok"];
  calls[agent] = (calls[agent] ?? 0) + 1;
  const reply = replies[Math.min(calls[agent], replies.length) - 1];
  const text = typeof reply === "string" ? reply : reply.text;
  if (text.startsWith("ERROR:")) throw text.slice("ERROR:".length).trim();
  if (typeof reply !== "string") return reply;
  const usage = scenario.usage?.[agent];
  return usage ? { text, usage } : text;
}

const file = (a) => join(a.workspacePath, a.relativePath);

// execute_command with a delayMs: the ids of the commands waiting, by the function that ends the wait.
const waiting = new Map();

// Every file under `dir` (not .harness) and its text, by path relative to `dir`.
function snapshot(dir, prefix = "") {
  const files = {};
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (rel === ".harness") continue;
    if (statSync(join(dir, rel)).isDirectory()) Object.assign(files, snapshot(dir, rel));
    else files[rel] = readFileSync(join(dir, rel), "utf8");
  }
  return files;
}

async function executeCommand(a) {
  const scripted = scenario.commands?.[a.command];
  const answer = { exitCode: 0, stdout: scenario.commandOutput ?? "5 passed", stderr: "", durationMs: 5 };
  if (!scripted) return answer;
  if (scripted.die) process.exit(1);
  if (scripted.timeout) throw `Command timed out after ${a.timeoutSecs} s`;
  if (scripted.fail !== undefined) throw `Could not start the command: ${scripted.fail}`;
  if (scripted.run) {
    const ran = spawnSync("sh", ["-c", a.command], { cwd: a.workspacePath, encoding: "utf8", timeout: (a.timeoutSecs ?? 60) * 1000 });
    if (ran.error) throw `Could not start the command: ${ran.error.message}`;
    return { exitCode: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr, durationMs: answer.durationMs };
  }
  if (scripted.delayMs) {
    const killed = await new Promise((resolve) => {
      const timer = setTimeout(() => { waiting.delete(a.commandId); resolve(false); }, scripted.delayMs);
      waiting.set(a.commandId, () => { clearTimeout(timer); waiting.delete(a.commandId); resolve(true); });
    });
    if (killed) return { ...answer, exitCode: 137, stdout: "", stderr: "killed" };
  }
  return {
    exitCode: scripted.exitCode ?? answer.exitCode,
    stdout: scripted.snapshot ? JSON.stringify(snapshot(a.workspacePath)) : scripted.stdout ?? answer.stdout,
    stderr: scripted.stderr ?? answer.stderr,
    durationMs: answer.durationMs,
  };
}

// Like harness-core's hook_fingerprint: the fingerprint of the hook script's bytes and the hook's env
// (hookFingerprint.mjs mirrors fingerprint_hook in src-tauri/src/commands/process_commands.rs), or null
// when there is no such file.
const hookNow = (a) => {
  try {
    return hookFingerprint(readFileSync(join(a.workspacePath, a.hookPath)), a.env);
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw `IO error: ${e?.message ?? e}`;
  }
};

const commands = {
  // Like harness-core, LLM_PROVIDER comes from the environment the CLI passed on.
  get_provider_defaults: () => ({
    llm_provider: process.env.LLM_PROVIDER || "auto", ollama_base_url: "http://localhost:11434", ollama_model: "qwen2.5-coder:7b",
    openai_api_key_configured: false, anthropic_api_key_configured: false,
    ollama_api_key_configured: false, suggested_ollama_models: [],
  }),
  check_provider_health: (a) => (scenario.healthFails || scenario.healthFailsOn?.includes(++healthChecks)
    ? { ok: false, provider: a.provider, latency_ms: 0, message: "Ollama is not running", model_available: false, pull_command: scenario.healthPull ?? null }
    : { ok: true, provider: a.provider, latency_ms: 1, message: "ok", model_available: true, pull_command: null }),
  call_ollama_api: (a) => modelReply(a.system),
  call_openai_api: (a) => modelReply(a.system),
  // Every agent uses the text tool protocol.
  chat_turn: () => ({ text: "", toolCalls: [], finishReason: "tools_unsupported", nativeToolsSupported: false }),
  read_workspace_file: (a) => {
    try { return readFileSync(file(a), "utf8"); } catch { throw "IO error: not found (os error 2)"; }
  },
  write_workspace_file: (a) => {
    mkdirSync(dirname(file(a)), { recursive: true });
    writeFileSync(file(a), a.content);
    return null;
  },
  delete_workspace_file: (a) => { rmSync(file(a)); return null; },
  list_workspace_files: () => [],
  write_audit_entry: () => null,
  hook_fingerprint: hookNow,
  // Does not run the script. Like harness-core, given a fingerprint it starts the hook only if the script and env still have it.
  execute_hook: (a) => {
    let now = null;
    try { now = hookNow(a); } catch { /* unreadable: nothing matches, as in harness-core */ }
    if (a.expectedFingerprint != null && a.expectedFingerprint !== now) {
      throw `Hook execution error: Hook script ${a.hookPath} or its environment changed after it was checked; it was not run.`;
    }
    const rewrite = scenario.hookRewrites?.[a.hookPath];
    if (rewrite) writeFileSync(join(a.workspacePath, rewrite.path), rewrite.content);
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
  },
  execute_command: executeCommand,
  cancel_command: (a) => { waiting.get(a?.commandId)?.(); return true; },
  echo: (a) => a,
  fail: () => { throw "boom"; },
  slow: () => new Promise((resolve) => setTimeout(() => resolve("slow"), 200)),
  die: () => process.exit(1),
};

if (scenario.olderCore) delete commands.hook_fingerprint;

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const { id, cmd, args } = JSON.parse(line);
  if (process.env.FAKE_CORE_LOG) appendFileSync(process.env.FAKE_CORE_LOG, `${JSON.stringify({ cmd, args })}\n`);
  let reply;
  try {
    if (!commands[cmd]) throw `Unknown command: ${cmd}`;
    reply = { id, ok: await commands[cmd](args ?? {}) };
  } catch (e) {
    reply = { id, err: String(e) };
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`);
});
