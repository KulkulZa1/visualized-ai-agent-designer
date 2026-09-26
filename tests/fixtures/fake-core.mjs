/**
 * A stand-in for harness-core in the CLI tests: the same JSON-lines protocol
 * (src-tauri/src/commands/core_server.rs) with canned model replies.
 *
 * FAKE_CORE_SCENARIO: a JSON file { replies: { <agent>: string[] }, healthFails?: true }.
 *   An agent's replies are used in order, and the last one repeats. A reply that
 *   starts with "ERROR:" is returned as that call's error.
 * FAKE_CORE_LOG: a file each request is appended to as a JSON line.
 * Test-only commands: "echo" (replies with its args), "fail", "slow", "die".
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const scenario = process.env.FAKE_CORE_SCENARIO
  ? JSON.parse(readFileSync(process.env.FAKE_CORE_SCENARIO, "utf8"))
  : { replies: {} };
const calls = {};

function modelReply(system) {
  const agent = /^You are (.+?),/.exec(system ?? "")?.[1] ?? "?";
  const replies = scenario.replies?.[agent] ?? ["ok"];
  calls[agent] = (calls[agent] ?? 0) + 1;
  const reply = replies[Math.min(calls[agent], replies.length) - 1];
  if (reply.startsWith("ERROR:")) throw reply.slice("ERROR:".length).trim();
  return reply;
}

const file = (a) => join(a.workspacePath, a.relativePath);

const commands = {
  get_provider_defaults: () => ({
    llm_provider: "auto", ollama_base_url: "http://localhost:11434", ollama_model: "qwen2.5-coder:7b",
    openai_api_key_configured: false, anthropic_api_key_configured: false,
    ollama_api_key_configured: false, suggested_ollama_models: [],
  }),
  check_provider_health: (a) => (scenario.healthFails
    ? { ok: false, provider: a.provider, latency_ms: 0, message: "Ollama is not running", model_available: false, pull_command: null }
    : { ok: true, provider: a.provider, latency_ms: 1, message: "ok", model_available: true, pull_command: null }),
  call_ollama_api: (a) => modelReply(a.system),
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
  execute_hook: () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
  execute_command: () => ({ exitCode: 0, stdout: scenario.commandOutput ?? "5 passed", stderr: "", durationMs: 5 }),
  cancel_command: () => true,
  echo: (a) => a,
  fail: () => { throw "boom"; },
  slow: () => new Promise((resolve) => setTimeout(() => resolve("slow"), 200)),
  die: () => process.exit(1),
};

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
