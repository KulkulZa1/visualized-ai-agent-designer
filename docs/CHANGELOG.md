# Changelog

All notable changes to this project will be documented here.

## [Unreleased]

### Added
- Initial Tauri + React TypeScript project scaffold
- Visual workflow canvas with 6 agent node types (Orchestrator, Worker, Critic, Tool Caller, Memory, Gateway)
- Per-agent configuration panel with 5 tabs (Role, Prompt, Tools, Hooks, Memory)
- YAML workflow save/load via Tauri Rust commands
- File tree + Monaco editor for workspace files
- Audit log (append-only JSONL) for file writes and hook executions
- Path traversal protection in all Rust filesystem commands
- User consent gate for hook execution
- Zustand stores with undo/redo via `zundo`
- Zod schema validation at all IPC boundaries
- 17 TypeScript unit tests + 5 Rust unit tests
