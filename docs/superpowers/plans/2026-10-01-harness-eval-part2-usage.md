# `harness eval`, part 2: real token usage (plan)

Spec: `docs/superpowers/specs/2026-10-01-harness-eval-design.md` §5 (token usage),
and the "Keys in commands" paragraph of §4. Part 1 is done (commits 92789e8,
54515a5, eb87b5d); its report already has the final token shape, with `null`
everywhere.

Read `AGENT.md` for the project rules.

## Goal

Every model call reports the tokens the provider says it used. The engine sums
them per node, and the run record keeps them. `harness eval` fills each trial's
`tokens` and the eval's `C`. Agents' commands, hooks and scorer commands stop
receiving `HARNESS_CUSTOM_API_KEY`.

## Rust (`src-tauri/src/commands/`)

1. **A usage type.** `Usage { input: u64, output: u64 }`, serialized
   `{ "input": …, "output": … }`.
2. **Reading it from each provider's response** (non-streaming):
   - **OpenAI and OpenAI-compatible:** `usage.prompt_tokens` and
     `usage.completion_tokens`.
   - **Anthropic:** `usage.input_tokens` plus `cache_creation_input_tokens` and
     `cache_read_input_tokens` when present, as input; `usage.output_tokens` as
     output.
   - **Ollama:** `prompt_eval_count` and `eval_count`.
   - **What counts as "no usage."** A response without these is `None`. So is one
     with a missing or non-numeric field, which is not an error. A local server
     may leave them out.
3. **`chat_turn`.** `ChatReply` (`chat_turn.rs:63`) gains
   `usage: Option<Usage>`, left out of the JSON when `None`. `parse_anthropic`
   (:285), `parse_openai` (:301) and `parse_ollama` (:320) fill it; the full
   `Value` is already in scope there.
4. **The text-protocol commands.** `call_openai_api`, `call_anthropic_api`,
   `call_claude_api` and `call_ollama_api` (`api_commands.rs`) return
   `TextReply { text, usage: Option<Usage> }` instead of `String`.
   - They keep their names, arguments and Tauri registrations.
   - Where the full `Value` is discarded today (survey: around :434, :577,
     :776), read the usage first.
   - Update `core_server.rs` dispatch and the Rust mock-server tests.
5. **Streaming (the app only; `harness run` never streams).**
   - Anthropic and Ollama streams carry usage without any change to the request:
     - **Anthropic:** `message_start` holds the input usage, and `message_delta`
       holds the output usage;
     - **Ollama:** the final NDJSON line has the counts.

     Include these if it stays small.
   - OpenAI streams carry usage only when the request sets
     `stream_options.include_usage`. Don't change the request, which some
     OpenAI-compatible servers may refuse. Leave usage `None` there.
   - Say in your report what you did.
6. **Keys.**
   - Add `HARNESS_CUSTOM_API_KEY` to `PROVIDER_KEY_ENV_VARS`
     (`process_commands.rs:17`), with a test that a command no longer sees it.
   - Add a `[KEEP-IN-SYNC]` comment beside the two error texts
     (`process_commands.rs:~344`, `:347`), naming `src/cli/trial.ts`.
   - Add a Rust test that pins both texts.

## TypeScript

1. **`src/services/model-providers/providerAdapter.ts`.**
   - `callProvider` accepts either a string, which is what old cores, the VS Code
     extension and test mocks return, or `{ text, usage? }`.
   - `ProviderCallResult` gains `usage?: { input; output } | null`.
   - The `ChatReply` type gains `usage?`.
   - The billing fallback to Ollama: count the fallback call's usage. It is still
     a model call.
2. **The engine.** Sum the usage of every model call a node makes:
   - native turns and text calls (`agentLoop.ts`);
   - compaction summaries (`runWorkflow.ts`, through `shared.callTurn` /
     `callText`);
   - helpers (`subAgents.ts`).

   The result is `AgentRun.usage = { input, output, calls, callsWithoutUsage }`.
   - A call whose reply has no usage counts in `calls` and `callsWithoutUsage`.
   - The probe (`check_provider_health`) is not a call.
3. **The run record.** `NodeRecord.usage`, the same shape. The field is additive:
   `RUN_RECORD_VERSION` stays 1, and older records without it load.
4. **`harness eval`.** A trial's `tokens` becomes `{ input, output }` summed over
   its nodes. It stays `null` when any node has `callsWithoutUsage > 0` or no
   `usage`. `per_task.tokens` and `C` follow (`C` is the mean of totals > 0, as
   in part 1). `tokenEstimate` stays.
5. **`harness run`'s output** doesn't change: no new lines or events. The usage is
   in the run record.

## Tests

- **Rust:**
  - usage parsed for each provider, with usage present, missing or partial;
  - `ChatReply` JSON without usage has no `usage` key;
  - each `call_*` returns `{ text, usage }` against the mock servers;
  - the key is stripped;
  - the two error texts are pinned.
- **TypeScript:**
  - `callProvider` with a string reply and with an object reply, and with the
    fallback;
  - the engine's sums over turns, a text call, a compaction summary and a helper;
  - `callsWithoutUsage`;
  - the run record field, and an old record loading;
  - eval aggregation with real tokens: `C`, and a trial with a call without
    usage becoming `null`.
- **`fake-core`.** Script usage per reply, for example a scenario key
  `usage: { "<Agent>": { input, output } }`, or reply objects.
  - Keep string replies working: they mean no usage.
  - `call_*` answers `{ text, usage }` when usage is scripted, and a bare string
    otherwise, so both shapes stay tested end to end.
- **End to end.**
  - `harness eval` against `fake-core` with scripted usage: check the trials'
    `tokens`, `per_task.tokens` and `C`.
  - A `harness run` record holds `usage`.

## Checks before you report

- `npx tsc --noEmit`;
- `npx vitest run`, with the counts (part 1 ended at 83 files, 1885 passed and 2
  skipped);
- `cd src-tauri && cargo test`;
- `cargo test --no-default-features --features core`;
- `npm run build:cli`;
- `git diff --check`.

**Revert checks** for:
- each provider's parsing;
- `callsWithoutUsage` making a trial's `tokens` null;
- the key stripping.

**A live run** of the real debug `harness-core` against small scripted local
servers, Ollama and OpenAI-compatible, that send usage. Show the run record's
`usage` and an eval's `C`. Do the same for a server that sends no usage
(`tokens` null, `C` null).

## Constraints

- **No new dependencies.**
- **The Tauri command names and arguments don't change.** Only the four `call_*`
  return shapes do.
- **The VS Code extension isn't edited.** It must keep working through the
  string branch.
- **No docs beyond code comments.** Part 3 writes the docs.
- **No git commands that change anything.** The director commits.
