# Air-Gapped Deployment

How to run Harness Studio on a workstation with **no internet access**, against a
**local OpenAI-compatible server** (URL, API key, and model name provided at that
machine).

Updated: 2026-05-31.

---

## Summary

Harness Studio works air-gapped without code changes to the runtime. The key facts:

- **All provider HTTP is made by the Rust backend** (`reqwest`), not the WebView.
  The WebView Content-Security-Policy (`connect-src`) therefore does **not** block
  your local server, whatever host/port it runs on.
- **Nothing phones home.** No analytics, no auto-updater, no web fonts/CDN, and no
  background provider checks. Health checks run only when you press **Run**, and
  only for the providers you have configured.
- **The "Custom" provider** is an OpenAI-compatible client: it POSTs to
  `<base-url>/chat/completions` and lists models from `<base-url>/models`. The API
  key is optional — when blank, no `Authorization` header is sent.

The only piece that needs the internet is **building the installer**, which you do
once on a connected machine. The air-gapped workstation only runs the installer.

---

## 1. Build the installer (on an internet-connected machine)

Prerequisites on the **build** machine (not the target): Node.js 20+ LTS, Rust
(stable), and VS Build Tools with "Desktop development with C++".

```powershell
# From the repo root
npm ci
.\scripts\build-installer.ps1 -Offline
```

`-Offline` embeds the **full WebView2 runtime** (~150 MB) into the installer so the
target needs no internet at install time. (Without `-Offline`, the installer would
try to download WebView2 from Microsoft on first install — which fails on an
air-gapped box unless WebView2 is already present.)

Output (printed with size + SHA-256):

```
src-tauri\target\release\bundle\nsis\Harness Studio_0.1.0_x64-setup.exe
src-tauri\target\release\bundle\msi\Harness Studio_0.1.0_x64_en-US.msi
```

Either file is the deliverable. The NSIS `-setup.exe` is recommended.

---

## 2. Transfer and install (on the air-gapped workstation)

1. Copy the `*-setup.exe` (or `.msi`) over your approved transfer path (USB, secure
   share, etc.). Optionally verify the SHA-256 printed by the build script.
2. Run the installer **as Administrator**. It installs for all users under
   `Program Files`. No internet is required.
3. Launch **Harness Studio**.

---

## 3. Point it at your local server

Open **Settings** (gear icon) → **Custom Endpoint (OpenAI-compatible)** and enter
the three values provided at that machine:

| Field | Example | Notes |
|---|---|---|
| **Base URL** | `http://localhost:8000/v1` | Whatever your server exposes. The app appends `/chat/completions` and `/models`. Include the `/v1` if your server uses it. |
| **API key** | `sk-local-...` or *(blank)* | Optional. Blank = no `Authorization` header. |
| **Model** | `qwen2.5-coder:7b` | The exact model name your server serves. |

Then:

1. Click **Test connection** — this calls the backend health probe against
   `<base-url>/chat/completions`. A green result confirms reachability and auth.
2. (Optional) Click **Load models** to list `<base-url>/models`.
3. **Save.**
4. Set the run provider to **Custom**: top-level provider mode → **Custom**
   (this forces every agent to the custom endpoint), or leave **Auto** and set each
   node's provider individually.

---

## 4. Verify a real run

1. Press **Ctrl+E** → load a small example (e.g. *Purchasing Decision*), or build a
   2–3 node workflow.
2. Press **Run**. Each agent should call your local server and show output.
3. Check the audit strip — each agent logs `▶ <name> — <model> via openai-compatible`.

If the server is unreachable, an agent fails with `Cannot reach <base-url>: ...`
rather than hanging. Generation calls are also time-bounded: connect fails after
10 s, and a response that never completes is cut off after 10 min, so a wedged
server can never hang a run forever.

---

## What does and doesn't touch the network

| Action | Network target | Air-gapped behavior |
|---|---|---|
| Run a workflow (Custom provider) | Your local server (Rust → reqwest) | Works |
| Test connection / Load models (Custom) | Your local server (Rust → reqwest) | Works |
| Open a `.md` / `.yaml` file in the editor | — (Monaco is bundled into the app) | Works |
| Local Ollama (if installed) | `http://localhost:11434` | Works (allowed by CSP) |
| OpenAI / Anthropic / Ollama Cloud | Public cloud hosts | Unreachable offline; leave unconfigured |
| Per-node ModelPicker "live fetch" for Ollama/OpenRouter | In-WebView `fetch()` | Subject to CSP; not used by the Custom endpoint path. Use the Settings → Custom "Load models" button instead. |
| App startup, fonts, updates, telemetry | — | None. The app makes no startup network calls. |

---

## Notes and limitations

- **Building on the air-gapped box is out of scope.** This guide assumes you build
  the installer on a connected machine and ship the `.exe`. Compiling on a fully
  offline machine would require vendoring all npm and cargo dependencies.
- **CSP still lists cloud hosts** (`api.openai.com`, `api.anthropic.com`,
  `ollama.com`, `openrouter.ai`) in `connect-src`. Offline these are simply
  unreachable. Because provider calls are made by the Rust process — not the
  WebView — this list does not affect whether your local server works, and tightening
  it would not change the app's actual outbound behavior.
- **API keys are stored in the app's local storage**, not an OS keychain. This is a
  known limitation tracked in `docs/DEPLOYMENT_READINESS.md`.
- **No code signing.** Windows SmartScreen may warn on first launch; this is
  expected for an unsigned internal build.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Installer asks for internet / "downloading WebView2" | Built without `-Offline`. Rebuild with `-Offline`, or pre-install the WebView2 Evergreen runtime on the target. |
| **Test connection** fails with "Cannot reach …" | Server not running, wrong host/port, or a firewall block between the workstation and the server. Confirm the URL in a local tool first. |
| "Authentication failed — check your API key" | Server requires a key but the field is blank or wrong. |
| Agents error with "Custom endpoint URL is not configured." | Provider mode is **Custom** but no Base URL is saved. Enter it in Settings → Custom. |
| Run says no model / HTTP 404 on `/chat/completions` | Model name doesn't match what the server serves, or the Base URL is missing a required suffix like `/v1`. |
