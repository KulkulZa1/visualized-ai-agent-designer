# Troubleshooting

Updated: 2026-09-24

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
