/**
 * useExamples — provides the 3 built-in example workflows.
 * YAML strings are inlined so examples work without a workspace open.
 * Each can be validated + loaded into the canvas with one call.
 */
import { parse } from "yaml";
import { workflowDefSchema } from "@/schemas/workflowSchema";
import { useWorkflowStore } from "@/store/workflowStore";

export interface ExampleMeta {
  id: string;
  name: string;
  description: string;
  pattern: string;
  nodeCount: number;
  edgeCount: number;
  yaml: string;
}

// ── Raw YAML strings ─────────────────────────────────────────────────────────
// These match the files in examples/ exactly. Kept in sync manually.

const PARALLEL_RESEARCH_YAML = `\
meta:
  name: Parallel Research
  version: "1.0.0"
  description: Gateway routes a user query to web, code, or docs workers in parallel. An aggregator synthesizes and a critic verifies.
  projectRoot: ""
  createdAt: "2026-05-16T00:00:00Z"
  updatedAt: "2026-05-16T00:00:00Z"
agents:
  - name: Coordinator
    role: orchestrator
    model: claude-opus-4.6
    temperature: 0.7
    maxTokens: 4096
    maxSteps: 20
    timeoutSeconds: 300
    description: Receives the user query, decomposes it, dispatches to Router.
    promptSource:
      type: inline
      content: |
        You are the Coordinator. Decompose the query into ≤ 3 sub-questions
        and dispatch each to the Router. Output JSON array before dispatching.
    tools: [todo_write, subagent_dispatch]
    preHook:
      path: .harness/hooks/pre_run_consent.sh
      requireConsent: true
    memoryRead: []
    memoryWrite: [task-plan]
    tokens: { used: 0, budget: 32000 }
    status: idle
  - name: Router
    role: gateway
    model: claude-haiku-4.5
    temperature: 0.3
    maxTokens: 1024
    maxSteps: 5
    timeoutSeconds: 60
    condition: "classify.confidence >= 0.6"
    description: Classifies sub-questions and routes to web/code/docs workers.
    promptSource:
      type: inline
      content: 'Classify into web|code|docs. Output: {"target":"...","confidence":0.0-1.0}'
    tools: [classify]
    memoryRead: []
    memoryWrite: []
    tokens: { used: 0, budget: 8000 }
    status: idle
  - name: Web Searcher
    role: worker
    model: claude-sonnet-4.6
    temperature: 0.5
    maxTokens: 8192
    maxSteps: 15
    timeoutSeconds: 120
    description: Searches the web and returns structured briefs with citations.
    promptSource:
      type: inline
      content: Search web_search + web_fetch. Return {"summary":"...","citations":[]}.
    tools: [web_search, web_fetch, cite]
    preHook:
      path: .harness/hooks/url_allowlist.py
      requireConsent: false
    memoryRead: []
    memoryWrite: [web-results]
    tokens: { used: 0, budget: 40000 }
    status: idle
  - name: Code Searcher
    role: worker
    model: claude-sonnet-4.6
    temperature: 0.3
    maxTokens: 8192
    maxSteps: 15
    timeoutSeconds: 120
    description: Searches the codebase with grep and read_file.
    promptSource:
      type: inline
      content: Search grep + read_file. Return {"findings":[{"file":"...","lines":"...","explanation":"..."}]}.
    tools: [grep, read_file, list_files]
    preHook:
      path: .harness/hooks/path_scope.py
      requireConsent: false
    memoryRead: []
    memoryWrite: [code-results]
    tokens: { used: 0, budget: 40000 }
    status: idle
  - name: Docs Searcher
    role: worker
    model: claude-haiku-4.5
    temperature: 0.3
    maxTokens: 4096
    maxSteps: 10
    timeoutSeconds: 90
    description: Queries the vector store and returns ranked passages.
    promptSource:
      type: inline
      content: Query vector_search. Return {"passages":[{"content":"...","source":"..."}]}.
    tools: [vector_search, read_file]
    memoryRead: []
    memoryWrite: [docs-results]
    tokens: { used: 0, budget: 20000 }
    status: idle
  - name: Scratchpad
    role: memory
    model: ""
    temperature: 0.0
    maxTokens: 0
    maxSteps: 1
    timeoutSeconds: 30
    description: Append-only shared scratchpad for all worker results.
    promptSource: { type: inline, content: "" }
    tools: [fs.append, fs.read]
    memoryRead: [web-results, code-results, docs-results]
    memoryWrite: [scratch]
    tokens: { used: 0, budget: 16000 }
    status: idle
  - name: Synthesizer
    role: aggregator
    model: claude-opus-4.6
    temperature: 0.7
    maxTokens: 8192
    maxSteps: 10
    timeoutSeconds: 180
    description: Merges worker outputs into a single coherent brief.
    promptSource:
      type: inline
      content: Merge all results. Deduplicate citations. Flag contradictions explicitly.
    tools: [fs.read]
    memoryRead: [web-results, code-results, docs-results, scratch]
    memoryWrite: [synthesis]
    tokens: { used: 0, budget: 48000 }
    status: idle
  - name: Verifier
    role: critic
    model: claude-opus-4.6
    temperature: 0.3
    maxTokens: 4096
    maxSteps: 8
    timeoutSeconds: 120
    description: Checks every claim against its citation. Returns PASS or REVISE.
    promptSource:
      type: inline
      content: Review synthesis. Check claims against sources. Return PASS or REVISE with line-level feedback.
    tools: [fs.read, web_fetch]
    memoryRead: [synthesis]
    memoryWrite: [verdict]
    tokens: { used: 0, budget: 24000 }
    status: idle
connections:
  - { id: c-00, sourceAgentId: agent-0, targetAgentId: agent-1, label: sub-questions }
  - { id: c-01, sourceAgentId: agent-1, targetAgentId: agent-2, label: "web?" }
  - { id: c-02, sourceAgentId: agent-1, targetAgentId: agent-3, label: "code?" }
  - { id: c-03, sourceAgentId: agent-1, targetAgentId: agent-4, label: "docs?" }
  - { id: c-04, sourceAgentId: agent-2, targetAgentId: agent-5, edgeKind: memory }
  - { id: c-05, sourceAgentId: agent-3, targetAgentId: agent-5, edgeKind: memory }
  - { id: c-06, sourceAgentId: agent-4, targetAgentId: agent-5, edgeKind: memory }
  - { id: c-07, sourceAgentId: agent-2, targetAgentId: agent-6, label: brief }
  - { id: c-08, sourceAgentId: agent-3, targetAgentId: agent-6, label: findings }
  - { id: c-09, sourceAgentId: agent-4, targetAgentId: agent-6, label: passages }
  - { id: c-10, sourceAgentId: agent-6, targetAgentId: agent-7, label: synthesis }
  - { id: c-11, sourceAgentId: agent-7, targetAgentId: agent-6, label: revise, edgeKind: feedback }
executionSettings:
  maxParallel: 4
  timeoutSeconds: 600
  retryOnFailure: false
  maxRetries: 0
nodePositions:
  agent-0: { x: 60,   y: 220 }
  agent-1: { x: 380,  y: 220 }
  agent-2: { x: 680,  y: 50  }
  agent-3: { x: 680,  y: 220 }
  agent-4: { x: 680,  y: 390 }
  agent-5: { x: 680,  y: 560 }
  agent-6: { x: 1000, y: 220 }
  agent-7: { x: 1300, y: 220 }
`;

const SPEC_TO_PR_YAML = `\
meta:
  name: Spec to PR
  version: "1.0.0"
  description: Sequential pipeline — spec to plan to implementation to verification to PR description.
  projectRoot: ""
  createdAt: "2026-05-16T00:00:00Z"
  updatedAt: "2026-05-16T00:00:00Z"
agents:
  - name: Spec Writer
    role: orchestrator
    model: claude-opus-4.6
    temperature: 0.7
    maxTokens: 8192
    maxSteps: 10
    timeoutSeconds: 180
    description: Expands feature request into a spec with ≥ 10 testable requirements.
    promptSource:
      type: inline
      content: Write a spec with >= 10 requirements, each starting as FAIL. Save to .harness/spec.md.
    tools: [todo_write, fs.write]
    preHook:
      path: .harness/hooks/pre_run_consent.sh
      requireConsent: true
    memoryRead: []
    memoryWrite: [spec-path]
    tokens: { used: 0, budget: 24000 }
    status: idle
  - name: Planner
    role: worker
    model: claude-sonnet-4.6
    temperature: 0.5
    maxTokens: 4096
    maxSteps: 15
    timeoutSeconds: 120
    description: Reads the spec and produces a depth-first task list (each task <= 2 files).
    promptSource:
      type: inline
      content: Read spec. Produce depth-first task list with each task touching <= 2 files.
    tools: [read_file, todo_write, fs.write]
    memoryRead: [spec-path]
    memoryWrite: [task-list-path]
    tokens: { used: 0, budget: 24000 }
    status: idle
  - name: Implementer
    role: worker
    model: claude-sonnet-4.6
    temperature: 0.3
    maxTokens: 16384
    maxSteps: 40
    timeoutSeconds: 600
    description: Executes tasks one at a time. Runs tests after each change.
    promptSource:
      type: inline
      content: Execute tasks one at a time. Run tests after each. Only mark DONE with green tests.
    tools: [read_file, fs.write, fs.read, list_files, bash, test]
    preHook:
      path: .harness/hooks/destructive_guard.sh
      requireConsent: false
    memoryRead: [task-list-path]
    memoryWrite: [impl-status]
    tokens: { used: 0, budget: 60000 }
    status: idle
  - name: Verifier
    role: critic
    model: claude-opus-4.6
    temperature: 0.2
    maxTokens: 4096
    maxSteps: 10
    timeoutSeconds: 300
    description: Runs full test suite + linter + type-checker + e2e. Blocks on any red.
    promptSource:
      type: inline
      content: Run lint, typecheck, tests, e2e. Return PASS or REVISE with failure details.
    tools: [bash, puppeteer, read_file]
    memoryRead: [impl-status]
    memoryWrite: [verify-verdict]
    tokens: { used: 0, budget: 32000 }
    status: idle
  - name: Reporter
    role: aggregator
    model: claude-haiku-4.5
    temperature: 0.7
    maxTokens: 4096
    maxSteps: 5
    timeoutSeconds: 60
    description: Summarizes diff + test results into a PR description.
    promptSource:
      type: inline
      content: Write PR description with Summary, Changes, Test results, Caveats sections.
    tools: [git, fs.read, fs.write]
    memoryRead: [verify-verdict, impl-status]
    memoryWrite: [pr-path]
    tokens: { used: 0, budget: 8000 }
    status: idle
connections:
  - { id: c-00, sourceAgentId: agent-0, targetAgentId: agent-1 }
  - { id: c-01, sourceAgentId: agent-1, targetAgentId: agent-2 }
  - { id: c-02, sourceAgentId: agent-2, targetAgentId: agent-3 }
  - { id: c-03, sourceAgentId: agent-3, targetAgentId: agent-2, label: revise, edgeKind: feedback }
  - { id: c-04, sourceAgentId: agent-3, targetAgentId: agent-4 }
executionSettings:
  maxParallel: 1
  timeoutSeconds: 1800
  retryOnFailure: false
  maxRetries: 0
nodePositions:
  agent-0: { x: 60,   y: 220 }
  agent-1: { x: 360,  y: 220 }
  agent-2: { x: 660,  y: 220 }
  agent-3: { x: 960,  y: 220 }
  agent-4: { x: 1260, y: 220 }
`;

const SELF_CRITIC_YAML = `\
meta:
  name: Self-Critic Loop
  version: "1.0.0"
  description: Bounded reflection loop with Drafter, Critic, Loop Gate, iter_counter hook, and Revision Log memory.
  projectRoot: ""
  createdAt: "2026-05-16T00:00:00Z"
  updatedAt: "2026-05-16T00:00:00Z"
agents:
  - name: Drafter
    role: worker
    model: claude-sonnet-4.6
    temperature: 0.9
    maxTokens: 4096
    maxSteps: 10
    timeoutSeconds: 120
    description: Produces a first draft without self-editing. Marks uncertain claims with [?].
    promptSource:
      type: inline
      content: Write a first draft without self-editing. Mark uncertain claims with [?]. Stop at <= 1200 words.
    tools: [fs.write, fs.read]
    memoryRead: [critique, current-iter]
    memoryWrite: [current-draft]
    tokens: { used: 0, budget: 32000 }
    status: idle
  - name: Critic
    role: critic
    model: claude-opus-4.6
    temperature: 0.3
    maxTokens: 4096
    maxSteps: 5
    timeoutSeconds: 90
    description: Reviews draft on accuracy, structure, and tone with line-level feedback.
    promptSource:
      type: inline
      content: Review draft on accuracy, structure, tone. Return PASS, REVISE, or ESCALATE with specific line-level feedback.
    tools: [fs.read]
    memoryRead: [current-draft]
    memoryWrite: [critique]
    tokens: { used: 0, budget: 32000 }
    status: idle
  - name: Loop Gate
    role: gateway
    model: claude-haiku-4.5
    temperature: 0.1
    maxTokens: 512
    maxSteps: 3
    timeoutSeconds: 30
    condition: "issues.length > 0 and iter < 3"
    description: Routes to revise (back to Drafter), ship, or escalate based on verdict and iteration count.
    promptSource:
      type: inline
      content: "Read critique and current-iter. Route: PASS->ship, REVISE+iter<3->revise, else->ship with caveat."
    tools: []
    memoryRead: [critique, current-iter]
    memoryWrite: []
    tokens: { used: 0, budget: 4000 }
    status: idle
  - name: iter_counter
    role: hook
    model: ""
    temperature: 0.0
    maxTokens: 0
    maxSteps: 1
    timeoutSeconds: 10
    description: Increments loop counter. Blocks if iterations > 3 to prevent runaway cost.
    promptSource: { type: inline, content: "" }
    tools: [fs.read, fs.write]
    preHook:
      path: .harness/hooks/iter_counter.py
      requireConsent: false
    memoryRead: [current-iter]
    memoryWrite: [current-iter]
    tokens: { used: 0, budget: 0 }
    status: idle
  - name: Revision Log
    role: memory
    model: ""
    temperature: 0.0
    maxTokens: 0
    maxSteps: 1
    timeoutSeconds: 10
    description: Append-only log of every draft and critique. Survives context resets.
    promptSource: { type: inline, content: "" }
    tools: [fs.append]
    memoryRead: []
    memoryWrite: [revision-log]
    tokens: { used: 0, budget: 16000 }
    status: idle
connections:
  - { id: c-00, sourceAgentId: agent-0, targetAgentId: agent-1, label: draft }
  - { id: c-01, sourceAgentId: agent-1, targetAgentId: agent-2, label: verdict }
  - { id: c-02, sourceAgentId: agent-2, targetAgentId: agent-0, label: revise, edgeKind: feedback }
  - { id: c-03, sourceAgentId: agent-2, targetAgentId: agent-3, edgeKind: control }
  - { id: c-04, sourceAgentId: agent-0, targetAgentId: agent-4, edgeKind: memory }
  - { id: c-05, sourceAgentId: agent-1, targetAgentId: agent-4, edgeKind: memory }
executionSettings:
  maxParallel: 1
  timeoutSeconds: 600
  retryOnFailure: false
  maxRetries: 0
nodePositions:
  agent-0: { x: 180,  y: 220 }
  agent-1: { x: 560,  y: 220 }
  agent-2: { x: 940,  y: 220 }
  agent-3: { x: 560,  y: 490 }
  agent-4: { x: 180,  y: 490 }
`;

const HARNESS_STUDIO_DEV_YAML = `\
meta:
  name: Harness Studio — Self-Development
  version: "1.0.0"
  description: Recursive self-improvement — Harness Studio building itself. Architect plans, Code Searcher maps the codebase, Implementer writes code, Tester + Reviewer gate quality, Documenter writes docs.
  projectRoot: ""
  createdAt: "2026-05-16T00:00:00Z"
  updatedAt: "2026-05-16T00:00:00Z"
agents:
  - name: Architect
    role: orchestrator
    model: claude-opus-4.6
    temperature: 0.7
    maxTokens: 8192
    maxSteps: 15
    timeoutSeconds: 300
    description: Plans the next development increment. Reads PROJECT_STATUS.md and TODO.md.
    promptSource:
      type: file
      path: docs/PROJECT_STATUS.md
    tools: [read_file, list_files, todo_write, subagent_dispatch]
    preHook: { path: .harness/hooks/pre_run_consent.sh, requireConsent: true }
    memoryRead: [current-goal, test-results, review-verdict]
    memoryWrite: [task-plan, architect-context]
    tokens: { used: 0, budget: 48000 }
    status: idle
  - name: Code Searcher
    role: worker
    model: claude-sonnet-4.6
    temperature: 0.3
    maxTokens: 8192
    maxSteps: 20
    timeoutSeconds: 180
    description: Maps relevant parts of the Harness Studio codebase. Read-only.
    promptSource:
      type: inline
      content: Read the codebase (src/, tests/, docs/) and return a structured map of relevant files, types, patterns, and tests for the given task. Never write files.
    tools: [read_file, list_files, grep, fs.read]
    preHook: { path: .harness/hooks/path_scope.py, requireConsent: false }
    memoryRead: [task-plan]
    memoryWrite: [codebase-map]
    tokens: { used: 0, budget: 40000 }
    status: idle
  - name: Implementer
    role: worker
    model: claude-sonnet-4.6
    temperature: 0.3
    maxTokens: 16384
    maxSteps: 40
    timeoutSeconds: 600
    description: Writes TypeScript/React code following Atelier design tokens and existing patterns.
    promptSource:
      type: inline
      content: |
        Write code following these rules:
        - Use CSS variables (var(--accent) etc.) never hex colors
        - Use NodeIcon for icons
        - All IPC through src/ipc/tauriCommands.ts
        - State in Zustand stores
        - Run npx tsc --noEmit after each file change
        - No files > 300 lines
    tools: [read_file, fs.write, fs.read, fs.append, list_files, grep, bash]
    preHook: { path: .harness/hooks/destructive_guard.sh, requireConsent: false }
    memoryRead: [task-plan, codebase-map, review-verdict]
    memoryWrite: [impl-status, changed-files]
    tokens: { used: 0, budget: 80000 }
    status: idle
  - name: Tester
    role: critic
    model: claude-sonnet-4.6
    temperature: 0.1
    maxTokens: 4096
    maxSteps: 10
    timeoutSeconds: 300
    description: Runs npx tsc --noEmit, npx vitest run, cargo test. Returns PASS or FAIL.
    promptSource:
      type: inline
      content: Run the full verification suite. Return PASS only if all three checks exit 0.
    tools: [bash, read_file]
    memoryRead: [changed-files]
    memoryWrite: [test-results]
    tokens: { used: 0, budget: 16000 }
    status: idle
  - name: Reviewer
    role: critic
    model: claude-opus-4.6
    temperature: 0.3
    maxTokens: 8192
    maxSteps: 10
    timeoutSeconds: 240
    description: Reviews design, architecture, security, and code quality. Returns APPROVED or REVISE.
    promptSource:
      type: inline
      content: Review changed files for design violations, security issues, architectural drift, and test coverage. Return APPROVED, REVISE, or ESCALATE.
    tools: [read_file, fs.read, grep]
    memoryRead: [changed-files, test-results]
    memoryWrite: [review-verdict]
    tokens: { used: 0, budget: 32000 }
    status: idle
  - name: Documenter
    role: worker
    model: claude-haiku-4.5
    temperature: 0.5
    maxTokens: 4096
    maxSteps: 8
    timeoutSeconds: 120
    description: Updates PROJECT_STATUS.md, DEVELOPMENT_LOG.md, CHANGELOG.md after a successful cycle.
    promptSource:
      type: inline
      content: Update docs/PROJECT_STATUS.md, docs/DEVELOPMENT_LOG.md, and docs/CHANGELOG.md. Follow existing format exactly.
    tools: [read_file, fs.write, fs.read]
    memoryRead: [task-plan, changed-files, test-results, review-verdict]
    memoryWrite: [docs-updated]
    tokens: { used: 0, budget: 16000 }
    status: idle
  - name: Progress Log
    role: memory
    model: ""
    temperature: 0.0
    maxTokens: 0
    maxSteps: 1
    timeoutSeconds: 10
    description: Append-only log of every development cycle. Survives context resets.
    promptSource: { type: inline, content: "" }
    tools: [fs.append, fs.read]
    memoryRead: []
    memoryWrite: [dev-history]
    tokens: { used: 0, budget: 32000 }
    status: idle
connections:
  - { id: c-00, sourceAgentId: agent-0, targetAgentId: agent-1, label: task-plan }
  - { id: c-01, sourceAgentId: agent-1, targetAgentId: agent-2, label: codebase-map }
  - { id: c-02, sourceAgentId: agent-2, targetAgentId: agent-3, label: impl-complete }
  - { id: c-03, sourceAgentId: agent-3, targetAgentId: agent-4, label: test-pass }
  - { id: c-04, sourceAgentId: agent-4, targetAgentId: agent-5, label: approved }
  - { id: c-05, sourceAgentId: agent-3, targetAgentId: agent-2, label: fix, edgeKind: feedback }
  - { id: c-06, sourceAgentId: agent-4, targetAgentId: agent-2, label: revise, edgeKind: feedback }
  - { id: c-07, sourceAgentId: agent-2, targetAgentId: agent-6, edgeKind: memory }
  - { id: c-08, sourceAgentId: agent-3, targetAgentId: agent-6, edgeKind: memory }
  - { id: c-09, sourceAgentId: agent-4, targetAgentId: agent-6, edgeKind: memory }
  - { id: c-10, sourceAgentId: agent-5, targetAgentId: agent-6, edgeKind: memory }
executionSettings:
  maxParallel: 2
  timeoutSeconds: 3600
  retryOnFailure: false
  maxRetries: 1
nodePositions:
  agent-0: { x: 60,   y: 240 }
  agent-1: { x: 380,  y: 240 }
  agent-2: { x: 700,  y: 240 }
  agent-3: { x: 1020, y: 120 }
  agent-4: { x: 1020, y: 360 }
  agent-5: { x: 1340, y: 240 }
  agent-6: { x: 700,  y: 500 }
`;

const HARNESS_STUDIO_PROJECT_YAML = `\
meta:
  name: Harness Studio — Active Project
  version: "1.1.0"
  description: "Production harness. GPT-5.5 primary (Orchestrator/Workers/Critic). Claude Sonnet for Visual Inspector. Claude as fallback."
  projectRoot: "D:\\\\toy_project\\\\AI_agent"
  createdAt: "2026-05-16T00:00:00Z"
  updatedAt: "2026-05-16T00:00:00Z"
agents:
  - name: Project Orchestrator
    role: orchestrator
    model: gpt-5.5-xhigh
    fallback: { model: claude-opus-4.6, trigger: error }
    temperature: 0.7
    maxTokens: 8192
    maxSteps: 20
    timeoutSeconds: 300
    description: Reads PROJECT_STATUS.md + TODO.md, selects highest-priority task, routes to Task Router.
    promptSource: { type: file, path: docs/PROJECT_STATUS.md }
    tools: [read_file, list_files, todo_write, subagent_dispatch]
    preHook: { path: .harness/hooks/pre_run_consent.sh, requireConsent: true }
    memoryRead: [current-goal, test-results, review-verdict, visual-verdict, dev-history]
    memoryWrite: [task-plan, orchestrator-context]
    tokens: { used: 0, budget: 64000 }
    status: idle
  - name: Task Router
    role: gateway
    model: gpt-5.5-mid
    temperature: 0.2
    maxTokens: 1024
    maxSteps: 5
    timeoutSeconds: 30
    condition: "domain in {ui, rust, test, doc, mixed}"
    description: Classifies task into domain (ui/rust/test/doc/mixed) and routes to appropriate workers.
    promptSource:
      type: inline
      content: Classify the task into ui/rust/test/doc/mixed. Output JSON with domain and rationale.
    tools: [classify]
    memoryRead: [task-plan]
    memoryWrite: [routing-decision]
    tokens: { used: 0, budget: 4000 }
    status: idle
  - name: Frontend Worker
    role: worker
    model: gpt-5.5-high
    fallback: { model: claude-haiku-4.5, trigger: error }
    temperature: 0.3
    maxTokens: 16384
    maxSteps: 40
    timeoutSeconds: 600
    description: React/TypeScript changes. Atelier design tokens. No hex colors. IPC through tauriCommands.ts.
    promptSource:
      type: inline
      content: "Implement React/TypeScript changes following Atelier design system. CSS vars only, NodeIcon for icons, state in Zustand. Run tsc --noEmit after each file."
    tools: [read_file, fs.write, fs.read, fs.append, list_files, grep, bash]
    preHook: { path: .harness/hooks/path_scope.py, requireConsent: false }
    memoryRead: [task-plan, routing-decision, review-verdict]
    memoryWrite: [frontend-changes, impl-status]
    tokens: { used: 0, budget: 80000 }
    status: idle
  - name: Backend Worker
    role: worker
    model: gpt-5.5-high
    fallback: { model: claude-haiku-4.5, trigger: error }
    temperature: 0.3
    maxTokens: 12288
    maxSteps: 30
    timeoutSeconds: 600
    description: Rust/Tauri backend. resolve_safe_path(), atomic writes, AppError, cargo build after changes.
    promptSource:
      type: inline
      content: "Implement Rust/Tauri changes. Always use resolve_safe_path(). Atomic writes only. Register commands in lib.rs. Run cargo build after each file."
    tools: [read_file, fs.write, fs.read, list_files, grep, bash]
    preHook: { path: .harness/hooks/destructive_guard.sh, requireConsent: false }
    memoryRead: [task-plan, routing-decision, review-verdict]
    memoryWrite: [backend-changes, impl-status]
    tokens: { used: 0, budget: 48000 }
    status: idle
  - name: Test Worker
    role: worker
    model: gpt-5.5-mid
    fallback: { model: claude-haiku-4.5, trigger: error }
    temperature: 0.2
    maxTokens: 8192
    maxSteps: 20
    timeoutSeconds: 300
    description: Writes Vitest + Rust tests for changed code. Runs full suite. Reports pass/fail counts.
    promptSource:
      type: inline
      content: "Write tests for changed code. Run npx vitest run and cargo test. Report N/M passing. Only mark done when all pass."
    tools: [read_file, fs.write, fs.read, list_files, grep, bash, test]
    memoryRead: [frontend-changes, backend-changes, impl-status]
    memoryWrite: [test-results]
    tokens: { used: 0, budget: 32000 }
    status: idle
  - name: Visual Inspector
    role: critic
    model: claude-sonnet-4.6
    temperature: 0.4
    maxTokens: 8192
    maxSteps: 10
    timeoutSeconds: 180
    description: "Claude 전용 — Atelier 디자인 시스템 컴플라이언스 검토. CSS 토큰, 다크 테마, 노드 구조 확인."
    promptSource:
      type: inline
      content: "Review frontend changes for Atelier compliance: CSS vars, dark theme, spacing grid, node anatomy (header/prompt/footer/token bar). Return APPROVED or REVISE with specific fixes."
    tools: [read_file, fs.read, grep]
    memoryRead: [frontend-changes, test-results]
    memoryWrite: [visual-verdict]
    tokens: { used: 0, budget: 24000 }
    status: idle
  - name: Code Critic
    role: critic
    model: gpt-5.5-xhigh
    fallback: { model: claude-opus-4.6, trigger: error }
    temperature: 0.3
    maxTokens: 8192
    maxSteps: 12
    timeoutSeconds: 240
    description: Architecture + security + quality gate. Returns APPROVED, REVISE, or ESCALATE.
    promptSource:
      type: inline
      content: "Review for: architecture (Zustand state, typed IPC, file size ≤300 lines), security (no keys in code, path traversal, hook consent), code quality (no any, error handling, no TODOs). Return APPROVED / REVISE / ESCALATE."
    tools: [read_file, fs.read, grep, list_files]
    memoryRead: [frontend-changes, backend-changes, test-results, visual-verdict]
    memoryWrite: [review-verdict]
    tokens: { used: 0, budget: 32000 }
    status: idle
  - name: Documentation Worker
    role: worker
    model: gpt-5.5-mid
    fallback: { model: claude-haiku-4.5, trigger: error }
    temperature: 0.5
    maxTokens: 4096
    maxSteps: 10
    timeoutSeconds: 120
    description: Updates PROJECT_STATUS.md, DEVELOPMENT_LOG.md, CHANGELOG.md after each approved cycle.
    promptSource:
      type: inline
      content: "Update docs after successful cycle. Follow existing format exactly. Update status, log entry, changelog."
    tools: [read_file, fs.write, fs.read]
    memoryRead: [task-plan, frontend-changes, backend-changes, test-results, review-verdict]
    memoryWrite: [docs-updated]
    tokens: { used: 0, budget: 16000 }
    status: idle
  - name: Codebase Memory
    role: memory
    model: ""
    temperature: 0.0
    maxTokens: 0
    maxSteps: 1
    timeoutSeconds: 10
    description: Persists codebase map (key files, types, patterns) across sessions. Path .harness/memory/codebase.jsonl.
    promptSource: { type: inline, content: "" }
    tools: [fs.append, fs.read]
    memoryRead: []
    memoryWrite: [codebase-map]
    tokens: { used: 0, budget: 32000 }
    status: idle
  - name: Progress Log
    role: memory
    model: ""
    temperature: 0.0
    maxTokens: 0
    maxSteps: 1
    timeoutSeconds: 10
    description: Append-only journal of every dev cycle. Enables multi-session continuity. Path .harness/dev-progress.jsonl.
    promptSource: { type: inline, content: "" }
    tools: [fs.append, fs.read]
    memoryRead: []
    memoryWrite: [dev-history]
    tokens: { used: 0, budget: 16000 }
    status: idle
  - name: Test Gate
    role: hook
    model: ""
    temperature: 0.0
    maxTokens: 0
    maxSteps: 1
    timeoutSeconds: 120
    description: Runs tsc + vitest + cargo test before inspectors. Blocks on any failure.
    promptSource: { type: inline, content: "" }
    tools: [bash]
    preHook: { path: .harness/hooks/test_gate.sh, requireConsent: false }
    memoryRead: [impl-status]
    memoryWrite: [gate-result]
    tokens: { used: 0, budget: 0 }
    status: idle
  - name: Rate Limit Sentinel
    role: hook
    model: ""
    temperature: 0.0
    maxTokens: 0
    maxSteps: 1
    timeoutSeconds: 10
    description: Checks .harness/state/rate_limit.json. Sets CLAUDE_RATE_LIMITED=1 if Anthropic is limited so workers use fallback models.
    promptSource: { type: inline, content: "" }
    tools: [fs.read, fs.write]
    preHook: { path: .harness/hooks/rate_limit_sentinel.py, requireConsent: false }
    memoryRead: [rate-limit-status]
    memoryWrite: [rate-limit-status]
    tokens: { used: 0, budget: 0 }
    status: idle
connections:
  - { id: c-00, sourceAgentId: agent-0,  targetAgentId: agent-1,  label: task }
  - { id: c-01, sourceAgentId: agent-1,  targetAgentId: agent-2,  label: "ui?" }
  - { id: c-02, sourceAgentId: agent-1,  targetAgentId: agent-3,  label: "rust?" }
  - { id: c-03, sourceAgentId: agent-1,  targetAgentId: agent-4,  label: "test?" }
  - { id: c-04, sourceAgentId: agent-1,  targetAgentId: agent-7,  label: "doc?" }
  - { id: c-05, sourceAgentId: agent-2,  targetAgentId: agent-10, edgeKind: control }
  - { id: c-06, sourceAgentId: agent-3,  targetAgentId: agent-10, edgeKind: control }
  - { id: c-07, sourceAgentId: agent-4,  targetAgentId: agent-10, edgeKind: control }
  - { id: c-08, sourceAgentId: agent-10, targetAgentId: agent-5,  label: gate-pass }
  - { id: c-09, sourceAgentId: agent-5,  targetAgentId: agent-6,  label: visual-ok }
  - { id: c-10, sourceAgentId: agent-6,  targetAgentId: agent-7,  label: approved }
  - { id: c-11, sourceAgentId: agent-5,  targetAgentId: agent-2,  label: visual-fix, edgeKind: feedback }
  - { id: c-12, sourceAgentId: agent-6,  targetAgentId: agent-2,  label: code-fix,   edgeKind: feedback }
  - { id: c-13, sourceAgentId: agent-6,  targetAgentId: agent-3,  label: rust-fix,   edgeKind: feedback }
  - { id: c-14, sourceAgentId: agent-2,  targetAgentId: agent-8,  edgeKind: memory }
  - { id: c-15, sourceAgentId: agent-3,  targetAgentId: agent-8,  edgeKind: memory }
  - { id: c-16, sourceAgentId: agent-7,  targetAgentId: agent-9,  edgeKind: memory }
  - { id: c-17, sourceAgentId: agent-11, targetAgentId: agent-0,  edgeKind: control }
executionSettings:
  maxParallel: 3
  timeoutSeconds: 3600
  retryOnFailure: true
  maxRetries: 1
nodePositions:
  agent-0:  { x: 60,   y: 300 }
  agent-1:  { x: 380,  y: 300 }
  agent-2:  { x: 700,  y: 80  }
  agent-3:  { x: 700,  y: 280 }
  agent-4:  { x: 700,  y: 480 }
  agent-5:  { x: 1060, y: 160 }
  agent-6:  { x: 1060, y: 380 }
  agent-7:  { x: 1380, y: 300 }
  agent-8:  { x: 700,  y: 680 }
  agent-9:  { x: 1380, y: 560 }
  agent-10: { x: 860,  y: 300 }
  agent-11: { x: 60,   y: 560 }
`;

const PURCHASING_DECISION_YAML = `\
meta:
  name: Purchasing Decision Assistant
  version: "1.0.0"
  description: >
    Five-agent demo workflow that ranks suppliers against a requirements file.
    Deterministic verification rubric in docs/E2E_DEMO_PLAN.md.
  projectRoot: ""
  createdAt: "2026-05-17T00:00:00Z"
  updatedAt: "2026-05-17T00:00:00Z"
agents:
  - name: Requirement Parser
    role: orchestrator
    model: claude-haiku-4.5
    temperature: 0.2
    maxTokens: 4096
    maxSteps: 5
    timeoutSeconds: 60
    description: Reads requirements.yaml and emits a parsed requirements object.
    promptSource:
      type: inline
      content: |
        You are the Requirement Parser. Read .harness/inputs/requirements.yaml.
        Parse into JSON: budgetUsd, deliveryDays, mustHaveCertifications, preferredRegion, suppliers.
        If the file is missing, output {"error":"requirements_missing"} and stop.
    tools: [read_file, todo_write]
    memoryRead: []
    memoryWrite: [parsed-requirements]
    tokens: { used: 0, budget: 6000 }
    status: idle
  - name: Supplier Evaluator
    role: worker
    model: claude-haiku-4.5
    temperature: 0.0
    maxTokens: 4096
    maxSteps: 10
    timeoutSeconds: 90
    description: Scores each supplier using a deterministic rubric and outputs a ranked list.
    promptSource:
      type: inline
      content: |
        Score each supplier: score = 100
          - max(0, unitPriceUsd - 460) * 0.05
          - max(0, leadDays - deliveryDays) * 1.5
          - 30 * missing_required_certifications
          - 1000 * historicalDefectRate
          + (region == preferredRegion ? 5 : 0)
        Sort descending. Round to 1 decimal.
    tools: [read_file]
    memoryRead: [parsed-requirements]
    memoryWrite: [scored-suppliers]
    tokens: { used: 0, budget: 8000 }
    status: idle
  - name: Risk Reviewer
    role: critic
    model: claude-sonnet-4.6
    temperature: 0.1
    maxTokens: 3072
    maxSteps: 5
    timeoutSeconds: 90
    description: Validates the top-ranked supplier against hard constraints. Returns PASS or REVISE.
    promptSource:
      type: inline
      content: |
        Inspect the top-ranked supplier. Check certs, lead time vs SLA, defect rate <= 0.02.
        Output {"verdict":"PASS","topId":"..."} or {"verdict":"REVISE","reasons":[...]}.
    tools: [read_file]
    memoryRead: [scored-suppliers]
    memoryWrite: [risk-verdict]
    tokens: { used: 0, budget: 4000 }
    status: idle
  - name: Report Writer
    role: aggregator
    model: claude-haiku-4.5
    temperature: 0.3
    maxTokens: 4096
    maxSteps: 5
    timeoutSeconds: 90
    description: Writes the final ranking report to .harness/artifacts/ranking.md.
    promptSource:
      type: inline
      content: |
        Write .harness/artifacts/ranking.md with:
          ## Recommended Supplier
          ## Ranking Table (id | name | score | reason)
          ## Risk Reviewer Verdict
          ## Rubric Citation
    tools: [fs.read, fs.write]
    memoryRead: [scored-suppliers, risk-verdict]
    memoryWrite: [report-path]
    tokens: { used: 0, budget: 6000 }
    status: idle
  - name: Decision Memory
    role: memory
    model: ""
    temperature: 0.0
    maxTokens: 0
    maxSteps: 1
    timeoutSeconds: 30
    description: Appends a JSONL line per workflow run to .harness/decision-log.jsonl.
    promptSource: { type: inline, content: "" }
    tools: [fs.append, fs.read]
    memoryRead: [scored-suppliers, risk-verdict, report-path]
    memoryWrite: [decision-log]
    tokens: { used: 0, budget: 0 }
    status: idle
connections:
  - { id: edge-parse-evaluate,  sourceAgentId: agent-0, targetAgentId: agent-1, label: parsed requirements,  edgeKind: dataflow }
  - { id: edge-evaluate-review, sourceAgentId: agent-1, targetAgentId: agent-2, label: scored suppliers,     edgeKind: dataflow }
  - { id: edge-review-report,   sourceAgentId: agent-2, targetAgentId: agent-3, label: ranking + risks,      edgeKind: dataflow }
  - { id: edge-review-revise,   sourceAgentId: agent-2, targetAgentId: agent-1, label: revise,               edgeKind: feedback }
  - { id: edge-report-memory,   sourceAgentId: agent-3, targetAgentId: agent-4, label: decision log,         edgeKind: memory }
  - { id: edge-evaluate-memory, sourceAgentId: agent-1, targetAgentId: agent-4, label: scoring rationale,    edgeKind: memory }
  - { id: edge-review-memory,   sourceAgentId: agent-2, targetAgentId: agent-4, label: reviewer approval,    edgeKind: control }
executionSettings:
  maxParallel: 1
  timeoutSeconds: 600
  retryOnFailure: false
  maxRetries: 0
nodePositions:
  agent-0: { x: 80,  y: 220 }
  agent-1: { x: 320, y: 220 }
  agent-2: { x: 560, y: 220 }
  agent-3: { x: 800, y: 220 }
  agent-4: { x: 560, y: 440 }
`;

const RESEARCH_SYNTHESIS_YAML = `\
meta:
  name: Research & Synthesis Pipeline
  version: "1.0.0"
  description: >
    Full Ollama demo: Orchestrator decomposes a topic, two Workers analyse pros and cons in
    parallel, a Critic issues a verdict, Memory persists findings, and a Final Check produces
    a complete report. All agents use qwen2.5-coder:7b (local Ollama, no cloud key needed).
  projectRoot: ""
  createdAt: "2026-05-17T00:00:00Z"
  updatedAt: "2026-05-17T00:00:00Z"
agents:
  - name: Orchestrator
    role: orchestrator
    model: qwen2.5-coder:7b
    temperature: 0.6
    maxTokens: 1024
    maxSteps: 3
    timeoutSeconds: 120
    description: Receives the user's topic and produces a structured JSON plan for both workers.
    promptSource:
      type: inline
      content: |
        You are the Orchestrator. The user gave you a topic or question to analyze.
        Your job:
        1. Restate the topic clearly in ONE sentence.
        2. Break it into 3-4 specific sub-questions.
        3. Assign Worker 1 (Pro Analyst) to research BENEFITS/ADVANTAGES/OPPORTUNITIES.
        4. Assign Worker 2 (Con Analyst) to research RISKS/CHALLENGES/LIMITATIONS.
        Output EXACTLY this JSON (no extra text before or after):
        {"topic":"<one-sentence topic>","questions":["<q1>","<q2>","<q3>"],"worker1_task":"<what pro analyst should focus on>","worker2_task":"<what con analyst should focus on>"}
    tools: []
    memoryRead: []
    memoryWrite: [task-plan]
    tokens: { used: 0, budget: 8000 }
    status: idle
  - name: Pro Analyst
    role: worker
    model: qwen2.5-coder:7b
    temperature: 0.5
    maxTokens: 1500
    maxSteps: 3
    timeoutSeconds: 120
    description: Analyzes benefits, advantages, and opportunities using the Orchestrator's plan.
    promptSource:
      type: inline
      content: |
        You are the Pro Analyst. The Orchestrator's plan is in your UPSTREAM OUTPUTS.
        Read the plan JSON and focus on the "worker1_task" assignment.
        Produce a structured benefits analysis:
        ## Benefits & Advantages
        For EACH benefit (aim for 3-5):
        **Benefit N: <name>**
        - Why it matters: <explanation>
        - Concrete example: <specific example>
        - Impact level: High / Medium / Low
        ## Summary
        <2-3 sentences overall assessment of the opportunities>
    tools: [read_file, list_files]
    memoryRead: [task-plan]
    memoryWrite: [analysis-pros]
    tokens: { used: 0, budget: 12000 }
    status: idle
  - name: Con Analyst
    role: worker
    model: qwen2.5-coder:7b
    temperature: 0.5
    maxTokens: 1500
    maxSteps: 3
    timeoutSeconds: 120
    description: Analyzes risks, challenges, and limitations using the Orchestrator's plan.
    promptSource:
      type: inline
      content: |
        You are the Con Analyst. The Orchestrator's plan is in your UPSTREAM OUTPUTS.
        Read the plan JSON and focus on the "worker2_task" assignment.
        Produce a structured risks analysis:
        ## Risks & Challenges
        For EACH risk (aim for 3-5):
        **Risk N: <name>**
        - Why it matters: <explanation>
        - Real-world impact: <specific scenario>
        - Mitigation: <how to address it>
        - Severity: High / Medium / Low
        ## Summary
        <2-3 sentences overall assessment of the risks>
    tools: [read_file, list_files]
    memoryRead: [task-plan]
    memoryWrite: [analysis-cons]
    tokens: { used: 0, budget: 12000 }
    status: idle
  - name: Critic
    role: critic
    model: qwen2.5-coder:7b
    temperature: 0.3
    maxTokens: 1200
    maxSteps: 3
    timeoutSeconds: 120
    description: Reviews both worker analyses, identifies gaps, and issues a structured verdict.
    promptSource:
      type: inline
      content: |
        You are the Critic. In your UPSTREAM OUTPUTS you have:
        - Pro Analyst output (from: Pro Analyst -> pros)
        - Con Analyst output (from: Con Analyst -> cons)
        Read both analyses. Then:
        1. Identify any major gaps or inconsistencies.
        2. Assess balance (are risks overstated or understated vs benefits?).
        3. Issue a verdict.
        Output EXACTLY this JSON:
        {"verdict":"PROCEED"|"PROCEED WITH CAUTION"|"DO NOT PROCEED","rationale":"<2-3 sentences>","gaps_found":["<gap1>","<gap2>"],"key_insight":"<most important finding>","recommendations":["<rec1>","<rec2>","<rec3>"]}
    tools: []
    memoryRead: [analysis-pros, analysis-cons]
    memoryWrite: [critic-verdict]
    tokens: { used: 0, budget: 10000 }
    status: idle
  - name: Findings Log
    role: memory
    model: ""
    temperature: 0.0
    maxTokens: 0
    maxSteps: 1
    timeoutSeconds: 30
    description: Aggregates Pro analysis, Con analysis, and Critic verdict into memory keys for the Final Check.
    promptSource: { type: inline, content: "" }
    tools: [fs.append, fs.read]
    memoryRead: []
    memoryWrite: [synthesis, analysis-pros, analysis-cons, critic-verdict]
    tokens: { used: 0, budget: 0 }
    status: idle
  - name: Final Check
    role: aggregator
    model: qwen2.5-coder:7b
    temperature: 0.4
    maxTokens: 2000
    maxSteps: 3
    timeoutSeconds: 120
    description: Reads all findings from memory and upstream, produces a polished Markdown executive report.
    promptSource:
      type: inline
      content: |
        You are the Final Check. Your MEMORY context contains all findings from the pipeline,
        and your UPSTREAM OUTPUTS show the full agent chain.
        Write a polished executive report in Markdown:
        # Analysis Report: [Topic Name]
        ## Executive Summary
        [3-5 sentences: topic, key finding, recommendation]
        ## Key Findings
        | Category | Finding | Impact |
        |----------|---------|--------|
        [3-5 rows mixing pros and cons]
        ## Critic's Verdict
        **[VERDICT]** — [rationale]
        ## Recommendations
        1. [rec1]
        2. [rec2]
        3. [rec3]
        ## Confidence Level
        **[High / Medium / Low]** — [1 sentence]
        ---
        *Research & Synthesis Pipeline · Ollama (qwen2.5-coder:7b)*
    tools: [fs.read]
    memoryRead: [synthesis, analysis-pros, analysis-cons, critic-verdict]
    memoryWrite: [final-report]
    tokens: { used: 0, budget: 16000 }
    status: idle
connections:
  - { id: orch-to-pro,    sourceAgentId: agent-0, targetAgentId: agent-1, label: task plan,    edgeKind: dataflow }
  - { id: orch-to-con,    sourceAgentId: agent-0, targetAgentId: agent-2, label: task plan,    edgeKind: dataflow }
  - { id: pro-to-critic,  sourceAgentId: agent-1, targetAgentId: agent-3, label: pros,         edgeKind: dataflow }
  - { id: con-to-critic,  sourceAgentId: agent-2, targetAgentId: agent-3, label: cons,         edgeKind: dataflow }
  - { id: pro-to-memory,  sourceAgentId: agent-1, targetAgentId: agent-4, label: pros log,     edgeKind: memory   }
  - { id: con-to-memory,  sourceAgentId: agent-2, targetAgentId: agent-4, label: cons log,     edgeKind: memory   }
  - { id: crit-to-memory, sourceAgentId: agent-3, targetAgentId: agent-4, label: verdict,      edgeKind: memory   }
  - { id: memory-to-final,sourceAgentId: agent-4, targetAgentId: agent-5, label: all findings, edgeKind: memory   }
executionSettings:
  maxParallel: 2
  timeoutSeconds: 900
  retryOnFailure: false
  maxRetries: 0
nodePositions:
  agent-0: { x: 60,   y: 240 }
  agent-1: { x: 320,  y: 100 }
  agent-2: { x: 320,  y: 380 }
  agent-3: { x: 580,  y: 240 }
  agent-4: { x: 840,  y: 240 }
  agent-5: { x: 1100, y: 240 }
`;

// ── Public API ────────────────────────────────────────────────────────────────

export const EXAMPLES: ExampleMeta[] = [
  {
    id: "parallel-research",
    name: "Parallel Research",
    description: "Gateway routes query → 3 parallel workers → Aggregator → Critic. Demonstrates fan-out, memory edges, and feedback loops.",
    pattern: "Fan-out / Fan-in",
    nodeCount: 8,
    edgeCount: 12,
    yaml: PARALLEL_RESEARCH_YAML,
  },
  {
    id: "spec-to-pr",
    name: "Spec to PR",
    description: "Sequential pipeline: Spec Writer → Planner → Implementer → Verifier → Reporter. Verifier loops back on failure.",
    pattern: "Sequential pipeline",
    nodeCount: 5,
    edgeCount: 5,
    yaml: SPEC_TO_PR_YAML,
  },
  {
    id: "self-critic",
    name: "Self-Critic Loop",
    description: "Drafter ↔ Critic bounded by a Loop Gate and iter_counter hook. Uses all 4 edge types: data, feedback, control, memory.",
    pattern: "Reflection loop",
    nodeCount: 5,
    edgeCount: 6,
    yaml: SELF_CRITIC_YAML,
  },
  {
    id: "harness-studio-dev",
    name: "Harness Studio — Self-Development",
    description: "Recursive: the tool building itself. Architect → Code Searcher → Implementer → Tester + Reviewer (feedback loops) → Documenter → Progress Log.",
    pattern: "Recursive self-improvement",
    nodeCount: 7,
    edgeCount: 11,
    yaml: HARNESS_STUDIO_DEV_YAML,
  },
  {
    id: "harness-studio-project",
    name: "Harness Studio — Active Project",
    description: "Production harness. GPT-5.5-xHigh Orchestrator/Critic, GPT-5.5-High Workers, Claude Sonnet Visual Inspector. Claude fallback on error.",
    pattern: "Production project harness",
    nodeCount: 12,
    edgeCount: 18,
    yaml: HARNESS_STUDIO_PROJECT_YAML,
  },
  {
    id: "purchasing-decision",
    name: "Purchasing Decision Assistant",
    description: "Beginner-friendly deterministic demo: 5 agents rank 3 suppliers using a scoring rubric. Verifiable without paid API — runs on local Ollama. See docs/E2E_DEMO_PLAN.md.",
    pattern: "Deterministic pipeline",
    nodeCount: 5,
    edgeCount: 7,
    yaml: PURCHASING_DECISION_YAML,
  },
  {
    id: "research-synthesis",
    name: "Research & Synthesis Pipeline",
    description: "Runnable demo: Orchestrator → Pro Analyst | Con Analyst → Critic → Memory → Final Check. All agents use qwen2.5-coder:7b. Enter any topic in the Run dialog and it produces a full analysis report.",
    pattern: "Parallel fan-in + memory chain",
    nodeCount: 6,
    edgeCount: 8,
    yaml: RESEARCH_SYNTHESIS_YAML,
  },
];

/** Parses and validates an example YAML, then loads it into the canvas. */
export function useExamples() {
  const loadWorkflow = useWorkflowStore((s) => s.loadWorkflow);

  function loadExample(example: ExampleMeta): { ok: boolean; error?: string } {
    try {
      const raw = parse(example.yaml);
      const result = workflowDefSchema.safeParse(raw);
      if (!result.success) {
        const msg = result.error.issues.map((e) => `${String(e.path.join("."))}: ${e.message}`).join("; ");
        return { ok: false, error: msg };
      }
      loadWorkflow(result.data);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  return { examples: EXAMPLES, loadExample };
}
