# Architecture Decisions

## ADR-001: Tauri over Electron

**Decision:** Use Tauri 2.0 as the desktop shell.

**Options considered:**
- Electron: 100+ MB bundle, 150-300 MB RAM, but battle-tested
- Tauri: 8-12 MB bundle, 30-40 MB RAM, security-by-design
- VS Code Extension: limited by webview deprecation and security sandbox issues
- Local web server: no native OS integration, poor UX

**Rationale:** Tauri's bundle size, memory footprint, and security model are decisive advantages for a local-first tool. Tauri 2.0 (released Oct 2024) is stable and production-ready.

**Consequences:** Requires learning Rust for the backend.

---

## ADR-002: React Flow v12 for canvas

**Decision:** Use `@xyflow/react` v12.

**Rationale:** Industry standard for node-based editors; used by Flowise and Langflow. v12 integrates cleanly with external state management (Zustand).

**Consequences:** Breaking changes from v11; fewer StackOverflow examples for v12 API.

---

## ADR-003: Zustand + zundo for state management

**Decision:** Zustand 5 with `zundo` undo/redo middleware.

**Rationale:** Action-based mutations fit workflow CRUD better than Jotai atoms. `zundo` gives undo/redo at 8 KB total. Redux would add boilerplate.

**Consequences:** Manual state migration if schema changes.

---

## ADR-004: YAML workflow files

**Decision:** Store workflows as YAML, not JSON.

**Rationale:** Human-readable with inline comments, easy to diff in git. YAML 1.2 (yaml npm package v2) avoids legacy pitfalls (Norway problem).

**Consequences:** Marginally slower parse than JSON; serde_yaml for Rust parsing.

---

## ADR-005: `std::fs` for file I/O in Rust commands

**Decision:** Use Rust's `std::fs` directly rather than Tauri's `fs` plugin from the frontend.

**Rationale:** Centralizes path validation and audit logging in Rust, preventing bypasses from the frontend. Tauri `fs` plugin permissions only apply to JavaScript-side calls.

**Consequences:** Need to write and maintain `resolve_safe_path()` and atomic write logic.

---

## ADR-006: Monaco Editor over CodeMirror

**Decision:** Use `@monaco-editor/react` for in-app file editing.

**Rationale:** VS Code-grade UX, JSON Schema validation, familiar keybindings. The ~2 MB chunk is lazy-loaded only when editing is triggered.

**Consequences:** Larger bundle; Monaco's API surface is complex.
