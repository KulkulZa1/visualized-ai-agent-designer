# Air-Gapped Deployment

How to run Harness Studio on a workstation with **no internet access**, against a
**local OpenAI-compatible server** (URL, API key, and model name provided at that
machine). It also covers building and testing the source on such a workstation.

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
| **Model** | `qwen2.5-coder:7b` | The exact model name your server serves. |

Then:

1. Enter the **Model** first, then click **Test connection**. It sends a real
   one-token completion to `<base-url>/chat/completions`, with a 10 s limit, for
   the model in that field, or `gpt-4o-mini` when the field is blank. A green
   result means the server answered that request with a success status. A server
   that is still loading the model can take longer than 10 s, and the test then
   fails: wait, and test again.
2. (Optional) Click **Load models** to list `<base-url>/models`.
3. **Save.**
4. Set the run provider to **Custom**: in **Provider Settings**, set
   **Active Provider Mode** to **Custom**. This forces every agent to the custom
   endpoint. **Auto** never picks Custom: it chooses OpenAI, Anthropic or local
   Ollama from each agent's model name, and nodes have no provider setting of
   their own. From a terminal, run
   `harness run --provider openai-compatible --base-url <base-url> --model <model>`
   (`docs/HEADLESS.md`).

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
| Test connection / Load models (Custom) | Your local server (Rust → reqwest) | Works |
| Open a `.md` / `.yaml` file in the editor | — (Monaco is bundled into the app) | Works |
| Local Ollama (if installed) | `http://localhost:11434` | Works (allowed by CSP) |
| OpenAI / Anthropic / Ollama Cloud | Public cloud hosts | Unreachable offline; leave unconfigured |
| Per-node ModelPicker **Load from API** (Ollama, OpenRouter) | In-WebView `fetch()` | Subject to CSP; not used by the Custom endpoint path. Use the Settings → Custom "Load models" button instead. |
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
| **Test connection** fails with "Cannot reach …" | Server not running, wrong host/port, or a firewall block between the workstation and the server. Confirm the URL in a local tool first. It can also be a server that is still loading the model: the test gives up after 10 s. |
| "Authentication failed — check your API key" | Server requires a key but the field is blank or wrong. |
| Agents error with "Custom endpoint URL is not configured." | Provider mode is **Custom** but no Base URL is saved. Enter it in Settings → Custom. |
| Run says no model / HTTP 404 on `/chat/completions` | Model name doesn't match what the server serves, or the Base URL is missing a required suffix like `/v1`. |
