# Installation and Build

Updated: 2026-09-24

## Development Prerequisites

- Node.js ^20.19.0 or >=22.12.0 (required by Vite 7)
- npm 10+
- Rust toolchain and Cargo, Rust 1.86 or newer (`Cargo.lock` pins `icu_*` 2.2 crates, which need 1.86)
- WebView2 Runtime on Windows

## Run From Source

```powershell
npm install
npm run tauri -- dev
```

Verified on 2026-05-18: this command compiled the Rust dev profile, launched
`target\\debug\\agent-workflow-builder.exe`, and spawned WebView2.

For frontend-only browser inspection:

```powershell
npm run dev
```

## Verify

```powershell
npm run check:ts
npm test
npm run test:rust
npm run build
```

Latest verified results (2026-09-24):

- TypeScript passed.
- Vitest passed, 487 tests / 44 files.
- Rust tests passed, 63 tests.
- Frontend build passed with Vite chunk warnings only.

## Build Installers

```powershell
npm run tauri -- build
```

Verified on 2026-05-18. Output:

```text
src-tauri/target/release/bundle/msi/Harness Studio_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/Harness Studio_0.1.0_x64-setup.exe
```

The first release build can take several minutes because Rust release
dependencies and bundler tooling are compiled/downloaded.

## App Identity

| Field | Value |
|---|---|
| Product name | Harness Studio |
| Identifier | `com.kulkulza.harness-studio` |
| Version | `0.1.0` |
| Window | 1400 x 900, min 1024 x 700 |

## Environment Variables

No environment variables are required to launch the app.

Optional provider variables. Set them as OS (or launching-process) environment
variables; the app does not load `.env` files. In-app Settings values take
precedence over them.

```powershell
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5-coder:7b
OLLAMA_API_KEY=...          # Ollama Cloud / ollama.com
OLLAMA_REMOTE_API_KEY=...   # authenticated non-local Ollama gateway
LLM_PROVIDER=auto           # auto | openai | anthropic | ollama | ollama-cloud
```

Do not commit `.env` files or raw secrets.

## Release Caveats

- Generated installers are unsigned; Windows SmartScreen warnings are expected.
- Clean-machine installer smoke testing is still required.
- API keys still use localStorage/env development storage, not OS keychain.


