# Setup Guide

## Prerequisites

### 1. Rust (required for Tauri)

```powershell
winget install Rustlang.Rustup
# Restart terminal, then:
rustup default stable
cargo --version  # must be 1.86+ (Cargo.lock pins icu_* 2.2 crates, which need 1.86)
```

### 2. Visual C++ Build Tools 2022

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools
# Select: "Desktop development with C++" workload
```

### 3. Node.js ^20.19.0 or >=22.12.0 (required by Vite 7) and npm

Download from nodejs.org or use:
```powershell
winget install OpenJS.NodeJS.LTS
```

### 4. Tauri CLI

```powershell
npm install -g @tauri-apps/cli@2
tauri --version  # must be 2.x
```

## Development

```powershell
npm install
npm run tauri -- dev
```

## Tests

```powershell
# TypeScript unit tests
npx vitest run

# Rust unit tests
cd src-tauri
cargo test
```

## Build

```powershell
npm run tauri -- build
# Output: src-tauri/target/release/bundle/
```

## Environment Variables

The app does not load `.env` or `.env.local` files. Set these as OS (or
launching-process) environment variables before starting the app; `.env.example`
lists the names. In-app Settings values take precedence. Never commit real key
values.

Provider configuration:

```powershell
LLM_PROVIDER=ollama
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5-coder:7b
OLLAMA_API_KEY=
OLLAMA_REMOTE_API_KEY=
```

For local fallback, install Ollama and pull a model:

```powershell
ollama serve
ollama pull qwen2.5-coder:7b
```

Suggested local models: `qwen2.5-coder:7b`, `qwen2.5-coder:14b`, `llama3.1:8b`, `deepseek-coder`, `codellama`.

Do not expose real API keys in logs or screenshots. Harness Studio masks keys in diagnostics and does not print full keys.

## Provider Troubleshooting

**OpenAI 429 quota/billing error**

Message: `OpenAI API is configured, but the current account has exceeded its quota or billing limit. Please check OpenAI Platform Billing, Usage, and Limits settings.`

Check OpenAI Platform Billing, Usage, project, organization, and monthly limits. This is not retried automatically because it is not temporary.

**OpenAI rate limit**

Message: `OpenAI API rate limit reached. The application will retry with exponential backoff.`

The app retries temporary rate-limit failures with exponential backoff. If retries are exhausted, wait and try again or reduce request volume.

**Anthropic insufficient credits**

Message: `Anthropic API is configured, but the account has insufficient API credits. Please recharge credits in Anthropic Console Plans & Billing.`

Recharge or purchase Anthropic API credits. This is not retried automatically because it is billing-related.

**Switch to Ollama fallback**

Set `LLM_PROVIDER=ollama`, or choose **Ollama** in Settings. Default endpoint: `http://localhost:11434`.

Verify Ollama:

```powershell
Invoke-WebRequest http://localhost:11434/api/tags -UseBasicParsing
```

If the selected model is missing, run:

```powershell
ollama pull qwen2.5-coder:7b
```

**Use Ollama Cloud or authenticated remote Ollama**

Set `LLM_PROVIDER=ollama-cloud`, `OLLAMA_BASE_URL=https://ollama.com/api`, `OLLAMA_MODEL=gemma4:31b-cloud`, and `OLLAMA_API_KEY` in the environment, or use Settings to select **Ollama Cloud**. The dash-form alias `gemma4-31b:cloud` is accepted and normalized to `gemma4:31b-cloud`. For a private remote Ollama gateway, set `OLLAMA_BASE_URL` to the remote endpoint and use `OLLAMA_REMOTE_API_KEY` if the gateway requires authentication.

Ollama Cloud and remote Ollama are hosted execution paths. Treat prompts, files, and context sent there as cloud data, not local-only processing. `OLLAMA_API_KEY` is scoped to `ollama.com`; use `OLLAMA_REMOTE_API_KEY` or the Settings token field for private remote Ollama gateways.

## Notes

- First `cargo build` takes 3–10 minutes (compiling ~200 crates)
- Subsequent builds are incremental and fast
- The app window appears at 1400×900 by default
