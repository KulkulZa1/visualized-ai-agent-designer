# Troubleshooting

Updated: 2026-09-30

## App Launch

### Tauri dev command does not open a window

Run:

```powershell
npm run tauri -- dev
```

Expected evidence: Vite starts on port 1420, Cargo builds, and
`target\debug\agent-workflow-builder.exe` starts. On Windows, WebView2 child
processes should appear.

If it fails:

- confirm Rust/Cargo is installed;
- confirm WebView2 runtime is installed;
- check whether port 1420 is already in use;
- run `npm run build` to separate frontend build errors from Tauri runtime errors.

### Browser screenshot capture fails

In the 2026-05-18 verification pass, Browser DOM inspection worked but CDP
screenshots timed out. A later pass captured `docs/assets/empty-state.png` with
Chrome headless instead. If CDP screenshots time out, use Chrome headless or a
separate Playwright pipeline, or fall back to DOM evidence.

## Provider Issues

### No API key configured

The selected cloud provider needs a key. Open Settings and add the key, or
switch to Ollama local.

### Ollama local not reachable

- Start Ollama.
- Confirm `http://localhost:11434`.
- Pull the selected model, for example `ollama pull qwen2.5-coder:7b`.

### Ollama Cloud not working

- Base URL should be `https://ollama.com/api`.
- Model should be `gemma4:31b-cloud`.
- Set the Settings auth token or `OLLAMA_API_KEY`.
- Treat this as cloud/hosted execution; prompts leave the device.

### Remote Ollama gateway not working

- Confirm the base URL.
- If auth is required, use the Settings auth token or `OLLAMA_REMOTE_API_KEY`.
- Do not assume a remote gateway has the same privacy as local Ollama.

### A model call fails with "The model did not answer within the request timeout"

Full message: "The model did not answer within the request timeout. On slow hardware,
raise the model call timeout (Settings in the app, --request-timeout in harness
run)." One model call to Ollama or an OpenAI-compatible server ran past the model
call timeout (600 s by default). It used to read like an unreachable server.

- Raise it: Settings → Execution Behavior → **Model call timeout (seconds)** (30 to
  86400), then **Save all & close**. In `harness run`: `--request-timeout <secs>` or
  `HARNESS_REQUEST_TIMEOUT_SECS`.
- Raise the agent's **Timeout (s)** too (Role tab, Limits; `timeoutSeconds` in the
  workflow file). It bounds the agent's whole run, all its model calls and tools, and
  the agent gives up at it, with "`<name>` timed out after `<N>`s", even if a call is
  still going. A new agent has 300 s, which is shorter than the default 600 s call
  timeout.
- A refused connection keeps its own message (Ollama: "… is not reachable at
  `<url>`"; the Custom endpoint: "Network error: …"). Connecting fails after 10 s,
  whatever the timeout.
- **Test connection** and the run's preflight have their own limits: 120 s for
  Ollama, Ollama Cloud and the Custom endpoint (a local server may still be loading
  its model), 10 s for OpenAI and Anthropic. The model call timeout does not change
  them.

### Ollama cuts off a prompt, or the run warns about its context window

Ollama cuts a prompt that does not fit its context window, without a word, so an
agent can act as if it had not seen the start of its prompt. The app asks for 16384
tokens by default, and the run warns when a node's estimated prompt (about 4
characters per token) plus its `maxTokens` does not fit:

```
⚠ Coder: about 18,048 tokens (a prompt of ~16,000 plus up to 2,048 for the reply) do not fit Ollama's context window of 16,384 tokens, so Ollama may cut off the start of the prompt. Raise the context window (Settings → Ollama context window; harness run: --num-ctx).
```

It is in the audit strip (the `warn` chip), and `harness run` prints it on stderr as
`warning: …`. It never stops the run.

- Raise Settings → Ollama — Local or Cloud → **Ollama context window (tokens)**, or
  `harness run --num-ctx <n>`. A larger window needs more memory (KV cache) on the
  Ollama server: lower it if the model no longer fits.
- Or shorten what the agent is given, or lower its `maxTokens`.
- The app's window overrides the server's `OLLAMA_CONTEXT_LENGTH`. If the server sets
  its own, set the window to `0` (sends none, so the server's stands) or to the same
  value. With `0` there is no warning.
- Ollama reloads a model when a request asks for a different window. Another tool on
  the same server with another window makes it reload.
- The window is not sent to ollama.com, and there is no warning for it.
- The estimate is a minimum. It covers the first prompt, and leaves out the tool
  definitions and the steps after it, so a long run can still pass the window with no
  warning.

### Test connection says "No model name is set"

The Custom endpoint's **Test connection** asks the server for one token of a model.
With no **Model name** it sends nothing, and says: "No model name is set, so there is
nothing to test. Enter the model name your server serves, or click ↻ Models to list
the models it has."

- Type the name your server serves, or click **↻ Models**, open **Available models**,
  click a name to copy it and paste it into **Model name**. There is no default (it
  used to be `gpt-4o-mini`).
- A run with the field blank sends each agent's own model, and the run's preflight
  asks the server about the first agent's model. A server only has the models its
  owner put on it: set the Model name unless every agent's own model is one of them.
- A `gpt-4o-mini` saved in Settings earlier stays until you clear the field. If the
  server does not have it, the test fails: clear it or enter the right name.

## Workflow Execution

### Workflow fan-out does not run in parallel

Expected behavior: independent forward-edge branches can run concurrently up to
`executionSettings.maxParallel`.

If fan-out still appears serial:

- check the workflow's `maxParallel` value;
- check whether the branches actually share upstream dependencies;
- check whether a gateway route skipped a branch;
- check whether provider calls are slow and only one branch is ready at a time;
- remember that only native tool-calling turns stream live; text-protocol replies appear after each full response.

### Hook node fails with consent message

Hooks marked `requireConsent` cannot run automatically from workflow execution.
Run the hook manually from the Hooks tab, or disable `requireConsent` only after
reviewing the script.

### Hook node fails with "Hook script … or its environment was changed during this run"

A hook that runs without asking is refused when its script or its `env` changed
after the run started (an agent or a command changed the script; the `env` in the
workflow file was edited), or, in a resumed run, when it has no baseline from the
run's first attempt. Review the script, then run it from the
Hooks tab or start a new run: a resume refuses it again.

Resuming a run record saved by an older build refuses its hooks that run without
asking with the same message. That build hashed the script's text, and those
hashes never match the fingerprints `harness-core` takes now. Start a new run.

### Hook node fails with "Hook script … could not be checked (…)"

The Rust command `hook_fingerprint` (in the app and in `harness-core`) could not
fingerprint the script, so the hook is not run unasked. The reason is in the
parentheses:

- `Path traversal detected: ../outside.sh`: the script's path leads outside the
  workspace.
- `IO error: not a regular file`: the path is a folder or a FIFO, not a file.
- `Unknown command: hook_fingerprint`: `harness-core` is older than the CLI
  bundle. Rebuild it with `npm run build:core`.

A resumed run whose saved baseline could not be checked says "the script could
not be read, or harness-core is older than the app" instead. Fix the cause, then
start a new run.

### Windows: Hook node fails with "… a path cmd.exe would not run as written"

A hook that runs without asking and starts through cmd.exe (`.bat`, `.cmd`,
`.exe`, or any extension other than `.sh`/`.bash`, `.ps1` and `.py`) is refused
when its full resolved path contains one of `& | < > ^ % ! ( ) @ , ; =`, because
cmd.exe reads the path as a command line and could run another file. The whole
path counts: the hook's own path, the workspace folder and the folders above it.
The set is broad on purpose, so a workspace under a folder named
`OneDrive - Acme, Inc` or `proj(1)` refuses even `.harness/hooks/gate.bat`. Moving
the hook inside the workspace does not help: move or rename the workspace or the
hook so that the full path has none of these characters. The Hooks tab does not
check this: run a hook from there only if you know cmd.exe runs its path as
written. How cmd.exe parses the path was reasoned from its documented rules, not
tested on Windows.

### Artifacts look fake

They are mock placeholders until execution is wired to real artifact
persistence.

## CLI

### Missing workflow exits nonzero

This is expected:

```powershell
npm run harness -- workflow validate missing-file-does-not-exist.harness.yaml
```

The CLI returns a structured JSON error.

## MCP

### MCP cannot validate a path outside the project

This is expected. `validate_workflow` rejects `..` and absolute paths outside
the project root.

### MCP run_tests filter is rejected

The optional filter only accepts a safe file/name pattern. Avoid spaces, quotes,
semicolons, pipes, ampersands, path traversal, and a leading `-` (CLI options such
as `--watch` are rejected).

## Packaging

### Installer build takes a long time

`npm run tauri -- build` compiles Rust in release mode and may download bundler
tools. The verified Windows build produced MSI and NSIS outputs under
`src-tauri/target/release/bundle/`.

### Windows SmartScreen warning

Expected for unsigned installers. Code signing is not configured yet.
