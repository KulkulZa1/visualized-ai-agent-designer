# Agent Workflow Builder

A local-first visual desktop app for designing, configuring, and managing multi-agent AI workflows.

## What It Does

- **Visual canvas** — drag-drop nodes to design multi-agent systems (Orchestrator, Worker, Critic, Tool Caller, Memory, Gateway)
- **Per-agent configuration** — set role, model, system prompt, tool permissions, pre/post hooks, and memory keys
- **Config file management** — create and edit CLAUDE.md, AGENTS.md, system prompt files, and hook scripts from one place
- **YAML workflow files** — version-controlled, human-readable workflow definitions
- **Audit log** — every file write and hook execution is logged to `.agent-audit/audit.log.jsonl`

## Quick Start

See [SETUP.md](SETUP.md) for prerequisites.

```powershell
git clone <repo>
cd AI_agent
npm install
npm run tauri -- dev
```

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `src/` | React frontend (TypeScript) |
| `src-tauri/` | Rust backend (Tauri) |
| `docs/` | Project documentation |
| `tests/` | Unit and component tests |

## Current Status

See [PROJECT_STATUS.md](PROJECT_STATUS.md) for current phase and what's working.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for system design details.
