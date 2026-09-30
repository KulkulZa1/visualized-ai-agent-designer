# Air-Gapped Deployment

How to run Harness Studio on a workstation with **no internet access**, against a
**local OpenAI-compatible server** (URL, API key, and model name provided at that
machine) or against **Ollama** on the same machine or network. It also covers
building and testing the source on such a workstation.

Updated: 2026-09-30.

---

## Summary

Harness Studio works air-gapped without code changes to the runtime. The key facts:

- **All provider HTTP is made by the Rust backend** (`reqwest`), not the WebView.
  The WebView Content-Security-Policy (`connect-src`) therefore does **not** block
  your local server, whatever host/port it runs on.
- **Nothing phones home.** No analytics, no auto-updater, no web fonts/CDN, and no
  background provider checks. Health checks run only when you press **Run** (or
  **Test connection**), and only for the providers that run will use. Local Ollama
  is probed only when the run uses Ollama, or uses OpenAI or Anthropic, whose
  billing-error fallback it is. A run that uses only the Custom endpoint does not
  probe it.
- **The "Custom" provider** is an OpenAI-compatible client: it POSTs to
  `<base-url>/chat/completions` and lists models from `<base-url>/models`. The API
  key is optional — when blank, no `Authorization` header is sent.
- **Ollama on this machine or the network** works too. Every request to it asks for
  a context window (`num_ctx`, 16384 tokens by default), because Ollama's own
  default is small and it cuts a longer prompt without a word. See §5.

There are two ways to use Harness Studio on an air-gapped workstation. Each needs
the internet once, on a connected machine:

- **Install the app.** Build the installer (§1), move it over, and run it (§2). The
  workstation only runs the installer.
- **Build and test from source.** Make an **offline bundle**: every npm package and
  Rust crate that `package-lock.json` and `src-tauri/Cargo.lock` name, and prebuilt
  binaries for its platform. Move it with the source, then run
  `npm run offline:setup` and `npm run offline:verify` on the workstation. See
  "Build and test from source, offline". It does not cover the Windows installer
  build, which still needs the internet.

---

## 1. Build the installer (on an internet-connected machine)

Prerequisites on the **build** machine (not the target): Node.js
^20.19.0 or >=22.12.0 (LTS), Rust 1.88 or newer (stable), and VS Build Tools
with "Desktop development with C++".

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
| **Model name** | `qwen2.5-coder:7b` | The exact model name your server serves. There is no default. Blank sends each agent's own model, and a server only has the models its owner put on it. |

Then:

1. Enter the **Model name** first, then click **Test connection**. It sends a real
   one-token completion to `<base-url>/chat/completions` for the model in that
   field, and waits up to 120 s in total (connecting fails after 10 s), because a
   server that is still loading the model can be slow to answer. A green result
   means the server answered that request with a success status. A server that
   takes longer than that fails the test: wait, and test again. With the field
   blank, nothing is sent: the test says "No model name is set, so there is nothing
   to test. Enter the model name your server serves, or click ↻ Models to list the
   models it has."
2. (Optional) Click **↻ Models** to list `<base-url>/models`. Open **Available
   models**, click a name to copy it, and paste it into **Model name**.
3. **Save.**
4. Set the run provider to **Custom**: in **Provider Settings**, set
   **Active Provider Mode** to **Custom**. This forces every agent to the custom
   endpoint. (For one run only, pick **Custom** under **Provider Override** in the
   Run dialog.) **Auto** never picks Custom: it chooses OpenAI, Anthropic or local
   Ollama from each agent's model name, and nodes have no provider setting of
   their own. From a terminal, run
   `harness run --provider openai-compatible --base-url <base-url> --model <model>`
   (`docs/HEADLESS.md`), or set the `HARNESS_CUSTOM_*` variables (§5).

---

## 4. Verify a real run

1. Press **Ctrl+E** → load a small example (e.g. *Purchasing Decision*), or build a
   2–3 node workflow.
2. Press **Run**. Each agent should call your local server and show output.
3. Check the audit strip — each agent logs `▶ <name> — <model> via openai-compatible`.

If the server is unreachable when you press **Run**, the run does not start: the
preflight says `Cannot reach <base-url>: ...`. If it goes away during a run, the
agent fails with `Network error: ...`. Neither hangs. Generation calls are
time-bounded: connecting fails after 10 s, and a call that has not finished after
600 s (10 min, the default of the model call timeout: see §5) is cut off, so a
wedged server can never hang a run forever.

---

## 5. Tune it for a local model

A model on the same machine or network is slower, and has less memory, than a
hosted one. Four things matter: Ollama's context window, the model's name, how
`harness run` gets its settings, and the timeouts.

### Ollama's context window

Ollama cuts a prompt that does not fit its context window, and says nothing. Its own
default window is small, a few thousand tokens, and an agent's prompt with its tool
results is longer. So every request to Ollama (`/api/chat`: the text-protocol call, a
native tool-calling turn and the app's streaming turn) carries `options.num_ctx`.

- **Default:** 16384 tokens. There is one value for the whole run.
- **`0`** sends none, so the server's own default stands (for example its
  `OLLAMA_CONTEXT_LENGTH`).
- **Never sent to Ollama's hosted service** (ollama.com and its subdomains), which
  sizes its own context. A server on this machine or the LAN always gets it, whatever
  its URL looks like.
- **In the app:** **Settings → Ollama — Local or Cloud → Ollama context window
  (tokens)**, saved with **Save all & close**. A value that is not a whole number of
  0 or more turns red and switches **Save all & close** off.
- **In `harness run`:** `--num-ctx <n>` or `HARNESS_OLLAMA_NUM_CTX`. The flag wins,
  and a blank variable counts as unset. A value that is not a whole number from 0 to
  4294967295 is exit 2, and the message names the flag or the variable.
- **In the run record:** `provider.ollamaNumCtx` in `.harness/runs/<id>/run.json`. A
  resume does not compare it.

What the server's admin should know:

- **The request's window overrides the server's own.** If the server is set up with
  its own context length (`OLLAMA_CONTEXT_LENGTH`), set the app's window to 0, or to
  the same value.
- **A larger window needs more memory** on the Ollama server (the KV cache). If the
  model no longer fits, lower the window.
- **Ollama reloads a model** when a request asks for a different window than the one
  it has loaded. So another tool that uses the same server with another window causes
  reloads.

An example on the Ollama server, then from a terminal:

```bash
ollama pull qwen2.5-coder:7b              # downloads the model: do it where there is a route
OLLAMA_CONTEXT_LENGTH=32768 ollama serve  # only if the server should decide the window
```

If the server decides, set the app's window to `0` (and pass `--num-ctx 0` to
`harness run`), so that its 32768 stands. If the app should decide, leave
`OLLAMA_CONTEXT_LENGTH` alone and set the window in Settings. However you start the
server, set the variable in its environment and restart it.

```bash
node cli/harness.mjs run examples/purchasing-decision.harness.yaml --task "Pick a laptop" \
  --provider ollama --base-url http://192.168.1.20:11434 --model qwen2.5-coder:7b --num-ctx 32768
```

**The warning.** When a node's estimated prompt plus its `maxTokens` is more than the
window, the run warns, once for that node. The prompt is estimated at about 4
characters per token, over the system message and the user message. `maxTokens` is
the agent's own (2048 if it is 0). For example:

```
warning: ⚠ Coder: about 18,048 tokens (a prompt of ~16,000 plus up to 2,048 for the reply) do not fit Ollama's context window of 16,384 tokens, so Ollama may cut off the start of the prompt. Raise the context window (Settings → Ollama context window; harness run: --num-ctx).
```

- It is an audit warning (action `context_window`) and never fails the run. The app
  shows it in the audit strip (the `warn` chip).
- `harness run` prints it on stderr as `warning: …`. With `--json` it is an `audit`
  event with `warning: true`.
- The estimate is a minimum. It covers the first prompt only, and leaves out the tool
  definitions and the steps after it.
- There is no warning when the window is 0, for ollama.com, or for another provider.
- To clear it: raise the window (mind the memory), shorten what the agent is given,
  or lower its `maxTokens`.

### Model names (the Custom endpoint)

- **No default.** The model name no longer defaults to `gpt-4o-mini`. Enter the name
  your server serves, or click **↻ Models** beside **Test connection** to list what
  it has.
- **Blank** means each agent's own model is sent. A server only has the models its
  owner put on it.
- **Test connection with a blank name** sends nothing and says: "No model name is
  set, so there is nothing to test. Enter the model name your server serves, or click
  ↻ Models to list the models it has."
- **The run's preflight** asks the server about the model the run will send: the
  **Model name** (`--model` or `HARNESS_CUSTOM_MODEL` in `harness run`), or, when that
  is blank, the first agent's own model (Hook and Memory nodes call no model).
- **An old saved value stays.** A `gpt-4o-mini` saved in Settings earlier stays until
  you clear the field and save.

### `harness run` without flags

These variables are read by `harness run` only, and a flag wins over its variable. A
blank variable counts as unset. The app does not read them: set the same things in
Settings.

| Variable | Same as | Notes |
|---|---|---|
| `HARNESS_CUSTOM_BASE_URL` | `--base-url` | An OpenAI-compatible endpoint only |
| `HARNESS_CUSTOM_MODEL` | `--model` | An OpenAI-compatible endpoint only |
| `HARNESS_CUSTOM_API_KEY` | (the key) | As before; there is no key flag |
| `HARNESS_OLLAMA_NUM_CTX` | `--num-ctx` | |
| `HARNESS_REQUEST_TIMEOUT_SECS` | `--request-timeout` | |

The two `HARNESS_CUSTOM_*` settings apply when the run uses the Custom endpoint:
`--provider openai-compatible`, or `--provider auto` (the default) with
`LLM_PROVIDER=openai-compatible`. `harness-core` reads `LLM_PROVIDER`, as the app
does. So this needs no flag:

```bash
export LLM_PROVIDER=openai-compatible
export HARNESS_CUSTOM_BASE_URL=http://localhost:8000/v1
export HARNESS_CUSTOM_MODEL=qwen2.5-coder:7b
node cli/harness.mjs run examples/purchasing-decision.harness.yaml --task "Pick a laptop"
```

With no URL from a flag or a variable, `--provider openai-compatible` is exit 2
(`--provider openai-compatible needs --base-url (or HARNESS_CUSTOM_BASE_URL)`).
`LLM_PROVIDER=openai-compatible` alone gets past that check, and the engine then
refuses to start the run, before any agent runs: exit 3, `Custom endpoint URL is not
configured. Add it in Settings → Custom Endpoint.` That message is the app's wording:
in `harness run`, set the URL with `--base-url` or `HARNESS_CUSTOM_BASE_URL`.

### Timeouts

| What | Limit | Change it |
|---|---|---|
| Connecting to a server | 10 s | Fixed |
| Test connection, and the run's preflight probe: Ollama, Ollama Cloud and Custom | 120 s in total | Fixed |
| The same probe for OpenAI and Anthropic | 10 s in total | Fixed |
| One model call | 600 s in total; 30 to 86400 | **Settings → Execution Behavior → Model call timeout (seconds)**; `harness run --request-timeout <secs>` or `HARNESS_REQUEST_TIMEOUT_SECS` (the flag wins) |
| An agent's whole run: all its model calls and tools | 300 s for an agent made in the app | The agent's **Timeout (s)** (Role tab, Limits), or `timeoutSeconds` in the workflow file (1 to 86400) |

The probe limit is longer for a local server because it may still be loading its
model (the Custom probe asks for one token of a model, so a server that has not
loaded it yet must do so first). The model call timeout covers the whole call,
including a streamed reply, and applies to every provider's model calls, not to the
probes.

A call that runs out of it fails with: "The model did not answer within the request
timeout. On slow hardware, raise the model call timeout (Settings in the app,
--request-timeout in harness run)." It is the message for calls to Ollama and to
OpenAI-style endpoints (OpenAI and the Custom endpoint), and for streamed replies. A
refused connection keeps its own message (Ollama: "… is not reachable at `<url>`";
the Custom endpoint: "Network error: …").

**The agent's own Timeout is a second limit, and it comes first by default.** It
bounds the agent's whole run: all its model calls and tools (time spent waiting for
you to approve a command does not count). The agent stops waiting when it runs out,
and fails with "`<name>` timed out after `<N>`s", even if a model call is still
going. The call itself cannot be cancelled, and its late answer is thrown away. So a
call cannot outlast its agent. With the defaults (600 s for a call, 300 s for an
agent made in the app) the agent's limit ends a slow call before the call's own
does. On slow hardware, raise both: the model call timeout above your slowest single
reply, and each agent's Timeout above what the whole agent needs. The workflow-level
`timeoutSeconds` is saved but not applied.

### What was checked

2026-09-30, on Linux: unit tests against scripted fake servers. The Rust tests use a
mock Ollama server and a mock OpenAI-compatible server (the request bodies, the probe
limits, the timeout message); the `harness run` tests use a fake `harness-core`;
component tests cover Settings and the Run dialog. **Not run:** a real model server
(Ollama, llama.cpp, vLLM or LM Studio), Windows, macOS, and the Tauri window. The
notes about Ollama's own behavior above (its small default window,
`OLLAMA_CONTEXT_LENGTH`, memory use, reloads) were not tested here.

---

## Build and test from source, offline

Use this to build, test and change Harness Studio's source on a workstation with no
internet. Sections 1 and 2 install the finished app; this path is for the source.
It was checked on Linux x64 only: see "What was verified" below.

An **offline bundle** covers the two lockfiles the build reads, `package-lock.json`
and `src-tauri/Cargo.lock`: every npm package and Rust crate they name, and prebuilt
binaries for the platform it was made on. You make it once on a connected machine,
move it with the source, and set it up. After that, `cargo` and the builds fetch
nothing (the installer build excepted: see Not covered).

On the workstation, only setup's own `npm ci` uses the bundle's npm cache, and only
cargo stays offline: setup writes `.cargo/config.toml` for it. A plain `npm ci`
afterwards goes to the npm registry, and with no route out it stalls for a while,
then fails. To reinstall `node_modules`, run setup again, or run
`npm ci --offline --cache <bundle>/npm-cache` (`<bundle>` is the bundle folder).

It is `scripts/offline-bundle.mjs`, with three npm scripts. With npm, put `--` before
the options.

### Make the bundle (connected machine)

From the repo root, after `npm ci` (the binaries are built from `node_modules`). The
machine needs Node, npm and Rust (cargo and rustc):

```bash
npm run offline:bundle                       # writes ./offline-bundle
npm run offline:bundle -- ../harness-bundle  # or to a folder you choose
```

| Option | What it does |
|---|---|
| `<dir>` | Where to write the bundle. Default: `offline-bundle` in the repo root (gitignored). A relative path is taken from the folder you ran npm in. |
| `--no-binaries` | Leave out the prebuilt `harness-run.mjs` and `harness-core`. |
| `--force` | Re-create a folder this script made, and only such a folder. It keeps `npm-cache` and replaces the rest. |

`create` refuses a folder that is not empty. Before it clears anything, it also
refuses a `package.json` or `package-lock.json` that is not valid JSON, and a
lockfile without a `packages` list (lockfileVersion 1). It writes:

| Path | Holds |
|---|---|
| `.offline-bundle` | A marker file, written first, so that `--force` knows a folder `create` made even if it stopped halfway |
| `npm-cache/` | Every package in `package-lock.json` (an entry without `resolved` or `integrity` is left out, with a warning; the current lock has none), including the optional platform packages of every OS: the esbuild, rollup and Tauri CLI binaries for Windows, macOS and Linux |
| `cargo-vendor/` | `cargo vendor --locked`: every platform's crates |
| `bin/<platform>-<arch>/` | `harness-run.mjs` and `harness-core`, prebuilt for the platform the bundle was made on only |
| `MANIFEST.json` | `formatVersion` 3; the git commit; hashes of `package-lock.json` (as canonical JSON without the root project's name and version, so a bump of the project's own version, indentation or line endings do not matter), `src-tauri/Cargo.lock` (line endings normalized) and the dependency fields of `package.json`; the node, npm, cargo and rustc versions; the platform and arch, and glibc on Linux; counts; binary checksums; the longest path inside the bundle |

It checks the npm cache: for every package and every OS, the content is there and
hashes to the sha512 that `package-lock.json` pins (an entry with no sha512 is not
hashed, and a warning says so; the current lock has none). An offline install then
runs for the platform the bundle was made on. A `package.json` that disagrees with
the lock fails only at that install check, after `--force` has removed the old parts.

Measured on Linux x64: about 1.1 GB (`npm-cache` about 307 MB, `cargo-vendor` about
836 MB, binaries about 6 MB), and about 2 minutes with binaries on a fast machine.

About `--force`:

- It keeps `npm-cache` and replaces `cargo-vendor`, `bin` and `MANIFEST.json`. The
  npm cache only grows: to start it clean, delete `npm-cache` or use a new folder.
- A `--force` that fails partway has already removed the old `cargo-vendor`, `bin`
  and `MANIFEST.json`. Keep a copy of a working bundle if you need one.
- It repairs a damaged bundle: npm fetches again only what is missing or damaged.
  That needs the connected machine.
- It recognises a bundle by the `.offline-bundle` marker file, or by a
  `MANIFEST.json` with a numeric `formatVersion` and a `sha256` object. It refuses
  any other folder that is not empty.

### Move it

Copy the bundle folder over your approved transfer path. The bundle holds
dependencies only, so move the source too, at the commit `MANIFEST.json` records:

```bash
git bundle create harness-studio.bundle --all   # connected machine
git clone harness-studio.bundle harness-studio  # air-gapped machine
```

An archive of the repo works too, for example `git archive -o harness-studio.tar.gz HEAD`.

Setup only checks that the dependencies match (see Set up). It does not check that
the source is the commit the prebuilt binaries were built from, so use that commit.

### Set up (air-gapped machine)

From the repo root of the moved source:

```bash
npm run offline:setup                       # the bundle in ./offline-bundle
npm run offline:setup -- ../harness-bundle  # or the folder you made
```

Setup:

- Refuses a bundle made for other dependencies, and names the file that differs.
  A bump of the project's own version, a reformatted `package-lock.json` and CRLF
  line endings do not count as a difference; a changed dependency does.
- Refuses a bundle of another format version, made by an older or a newer version
  of the script (this one reads `formatVersion` 3): make a new bundle.
- Refuses a missing or damaged npm package, names it, and changes nothing. Every
  package's content must be in the bundle's cache and hash to the sha512 that
  `package-lock.json` pins, for every OS. This catches a damaged copy of the npm
  cache. The prebuilt binaries' checksums (below) do the same for them. Setup does
  not check the vendored crates: cargo does, when it builds ("the listed checksum
  of … has changed").
- Warns when node, npm, cargo or rustc differ from the bundle's versions.
- Runs `npm ci --offline` from the bundle's cache.
- Writes a gitignored `.cargo/config.toml` in the repo root, once `npm ci` has
  worked. It points cargo at the vendored crates and sets `net.offline = true`. It
  refuses to overwrite a `.cargo/config.toml` it did not write.
- Installs the prebuilt `cli/dist/harness-run.mjs` and
  `src-tauri/target/release/harness-core` where they are missing, after checking
  their sha256 against `MANIFEST.json`. That catches a damaged copy, not a swapped
  file: the manifest is in the same folder.

Every refusal comes before setup changes anything: the prebuilt binaries' checksums
are checked before `npm ci` runs.

Keep the bundle folder where it is: cargo reads the vendored crates from it on every
build, and the config holds its path. If you move it, run setup again.

To go back online, delete `.cargo/config.toml`. (`create` also refuses to run in a
checkout that still has the file `setup` wrote.)

### Verify

```bash
npm run offline:verify
npm run offline:verify -- --skip cargo-app   # no Tauri system libraries
```

It runs these steps in order, prints a pass/fail table, and exits 1 if any step
fails:

| Step | Runs |
|---|---|
| `tsc` | `tsc --noEmit` |
| `vitest` | `vitest run` |
| `cargo-core` | `cargo test` without Tauri (`--no-default-features --features core`) |
| `cargo-app` | `cargo test` with Tauri (the app build) |
| `build-cli` | `npm run build:cli` |
| `build-core` | `npm run build:core` |
| `vite-build` | `vite build` |

`--skip` takes step names separated by commas. Use `--skip cargo-app` on a machine
without Tauri's system libraries.

### Run workflows without Rust

The prebuilt binaries let a workstation run `harness run` without building anything.
`setup` puts them where the CLI looks. Running them needs Node, and on Linux the
system's `libssl.so.3`, but no Rust toolchain.

```bash
node cli/harness.mjs run examples/purchasing-decision.harness.yaml --task "Pick a laptop" \
  --provider openai-compatible --base-url http://localhost:8000/v1 --model qwen2.5-coder:7b
```

Set `HARNESS_CUSTOM_API_KEY` if the server needs a key. See `docs/HEADLESS.md`.

The binaries suit only the platform the bundle was made on (see Prerequisites). On
another platform, build them: `npm run build:cli` and `npm run build:core` (that
needs Rust).

### Prerequisites (not in the bundle)

The bundle holds dependencies, not toolchains or system packages. Install these on
the workstation first:

- **Node.js** ^20.19.0 or >=22.12.0 (what Vite 7 needs), and npm.
- **Rust** 1.88 or newer: the locked crates need it (`rust-version = "1.88.0"` in
  darling 0.23.0, plist 1.9.0, serde_with 3.19.0 and time 0.3.47). Setup warns when
  your rustc differs from the one that made the bundle, and says to update Rust when
  yours is older.
- **A C compiler.** `rusqlite` builds its bundled SQLite.
- **Linux:** `pkg-config` and the OpenSSL development files (`harness-core` links
  `libssl.so.3`). For the app build (`cargo-app`) only, also webkit2gtk and Tauri's
  other system packages.
- **Windows:** MSVC Build Tools ("Desktop development with C++"). Keep the bundle in
  a short folder, such as `C:\offline-bundle`: some paths inside it are long, and
  Windows stops at 260 characters unless long paths are enabled. Not run on Windows.
- **macOS:** the npm packages for macOS are in the bundle, but a macOS build was not
  run.
- **The bundle's platform**, to use its prebuilt binaries. They run only on the
  platform the bundle was made on. The Linux ones are also tied to its glibc (2.39 in
  the verified bundle; `MANIFEST.json` records it).

### Not covered

- **The Windows installer build.** The Tauri bundler downloads WiX and NSIS
  utilities, and the WebView2 bootstrapper (with `-Offline`, the full WebView2
  offline installer instead). It needs the network either way. Build installers on a
  connected machine, as in §1.
- **`vscode-extension/`.** It has its own `package-lock.json`, which is not in the
  bundle.
- **The toolchains and system packages themselves** (see Prerequisites).

### What was verified

2026-09-30, on Linux x64 (node 22.22.2, npm 10.9.7, cargo and rustc 1.94.1), with
the final script (commit `0e95a27`). This check is not part of the test suite or CI.
A bundle was made with network access. Then, in a fresh clone inside a network
namespace with no route out (`unshare -rn`), and with empty cargo and npm caches so
that the bundle was the only source:

- **Setup** installed 271 packages offline and placed both binaries.
- **The shipped binary.** `harness-core` ran
  `harness run examples/purchasing-decision.harness.yaml --provider openai` with no
  key, before anything was built. It exited 3 with `not_started`, which is CI's own
  check.
- **Verify** passed all 7 steps: vitest 1413 tests / 73 files, and 1 skipped (it
  needs a non-root user; it runs on CI); `cargo test` 143 (app) and 143 + 2 (core);
  both release builds and the vite build. The compile took about 6 minutes.
- **No downloads.** Every crate compiled from the vendored folder, none from the
  machine's own cache, and nothing was downloaded.
- **Negative controls.** Without the bundle, the same steps fail at once:
  `cargo fetch` cannot resolve crates.io, and `npm ci --offline` gives ENOTCACHED.
- **Refusals.** A changed dependency version was refused, naming the file, and a
  `.cargo/config.toml` that setup did not write was refused; the file was left
  unchanged.
- **Accepted.** A bump of the project's own version, a reformatted
  `package-lock.json` and CRLF line endings.
- **A damaged cache.** A missing, a truncated and a same-size-corrupted package for
  another OS were each refused, with the package named, and nothing was written.
- **`create --force`** repaired a damaged bundle (on the connected machine: npm
  fetched again only what was missing or damaged), and refused a folder it did not
  make.

**Not verified:** Windows; macOS; a physically air-gapped machine (a network
namespace is not one); the installer build; the prebuilt binary on another Linux
distro; a machine with no Rust toolchain.

---

## What does and doesn't touch the network

| Action | Network target | Air-gapped behavior |
|---|---|---|
| Run a workflow (Custom provider) | Your local server (Rust → reqwest) | Works |
| Test connection / ↻ Models (Custom) | Your local server (Rust → reqwest) | Works |
| Open a `.md` / `.yaml` file in the editor | — (Monaco is bundled into the app) | Works |
| Local Ollama (if installed) | `http://localhost:11434` | Works (allowed by CSP) |
| OpenAI / Anthropic / Ollama Cloud | Public cloud hosts | Unreachable offline; leave unconfigured |
| Per-node ModelPicker **Load from API** (Ollama, OpenRouter) | In-WebView `fetch()` | Subject to CSP; not used by the Custom endpoint path. Use the Settings → Custom **↻ Models** button instead. |
| App startup, fonts, updates, telemetry | — | None. The app makes no startup network calls. |

---

## Notes and limitations

- **CSP still lists cloud hosts** (`api.openai.com`, `api.anthropic.com`,
  `ollama.com`, `api.ollama.com`, `openrouter.ai`) in `connect-src`. Offline these are
  simply unreachable. Because provider calls are made by the Rust process — not the
  WebView — this list does not affect whether your local server works, and tightening
  it would not change those calls. It does govern the model picker's **Load from
  API**, the in-WebView `fetch()` in the table above (local Ollama's tag list at
  `http://localhost:11434`, and `openrouter.ai`): a tighter list would block it.
- **API keys are stored in the app's local storage**, not an OS keychain. This is a
  known limitation tracked in `docs/DEPLOYMENT_READINESS.md`.
- **No code signing.** Windows SmartScreen may warn on first launch; this is
  expected for an unsigned internal build.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Installer asks for internet / "downloading WebView2" | Built without `-Offline`. Rebuild with `-Offline`, or pre-install the WebView2 Evergreen runtime on the target. |
| **Test connection** fails with "Cannot reach …" | Server not running, wrong host/port, or a firewall block between the workstation and the server. Confirm the URL in a local tool first. It can also be a server that is still loading the model: the test gives up after 120 s in total, and connecting fails after 10 s. |
| **Test connection** says "No model name is set …" | The **Model name** field is blank, so nothing was sent. Enter the name your server serves, or click **↻ Models** and copy one (§5). |
| "Authentication failed — check your API key" | Server requires a key but the field is blank or wrong. |
| The run does not start, with "Custom endpoint URL is not configured." | Provider mode is **Custom** but no Base URL is saved. Enter it in Settings → Custom. In `harness run`, pass `--base-url` or set `HARNESS_CUSTOM_BASE_URL` (exit 3 when only `LLM_PROVIDER=openai-compatible` is set). |
| Run says no model / HTTP 404 on `/chat/completions` | Model name doesn't match what the server serves, or the Base URL is missing a required suffix like `/v1`. |
| An agent fails with "The model did not answer within the request timeout …" | One model call ran past the model call timeout (600 s by default). Raise it in Settings → Execution Behavior, or with `--request-timeout`, and raise the agent's **Timeout (s)** too (§5). |
| An agent fails with "`<name>` timed out after `<N>`s" | The agent's own Timeout (300 s for an agent made in the app) ran out. It bounds all the agent's model calls and tools: raise **Timeout (s)** in its Role tab, or `timeoutSeconds` in the workflow file (§5). |
| A warning says a prompt does not fit "Ollama's context window", or an Ollama agent acts as if it had not seen the start of its prompt | Raise the context window (Settings → Ollama context window; `--num-ctx`), or shorten what the agent is given. A larger window needs more memory on the Ollama server (§5). |
