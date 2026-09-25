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
