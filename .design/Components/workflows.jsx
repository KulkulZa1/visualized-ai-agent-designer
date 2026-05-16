// workflows.jsx — Sample workflow data shared across all three variations.
// Each node represents a HARNESS component, not just an agent: orchestrator,
// gateway router, worker, critic, memory, tool, hook, sandbox.

const ROLE_META = {
  orchestrator: { label: 'Orchestrator', tint: '#e5a142', glyph: '◆' },
  gateway:      { label: 'Gateway',      tint: '#7c9eff', glyph: '◇' },
  worker:       { label: 'Worker',       tint: '#5fbf7f', glyph: '●' },
  critic:       { label: 'Critic',       tint: '#e07575', glyph: '◐' },
  memory:       { label: 'Memory',       tint: '#b88bd9', glyph: '▣' },
  tool:         { label: 'Tool',         tint: '#9aa4b2', glyph: '⬡' },
  hook:         { label: 'Hook',         tint: '#d97757', glyph: '✕' },
  aggregator:   { label: 'Aggregator',   tint: '#5fbfb5', glyph: '⊕' },
};

const MODELS = {
  'claude-opus-4.6':   { short: 'Opus 4.6',   ctx: 200000, costIn: 15,   costOut: 75 },
  'claude-sonnet-4.6': { short: 'Sonnet 4.6', ctx: 200000, costIn: 3,    costOut: 15 },
  'claude-haiku-4.5':  { short: 'Haiku 4.5',  ctx: 200000, costIn: 0.8,  costOut: 4 },
  'gpt-5.4':           { short: 'GPT-5.4',    ctx: 256000, costIn: 10,   costOut: 30 },
  'local/llama-4-70b': { short: 'Llama 4 70B', ctx: 128000, costIn: 0,   costOut: 0 },
};

// ── WORKFLOW A: Parallel fan-out research with gateway router ──────────────
const WF_FANOUT = {
  id: 'wf-fanout',
  name: 'parallel-research.harness.yaml',
  description: 'Gateway routes query → 3 parallel workers → aggregator → critic',
  nodes: [
    { id: 'in',  kind: 'orchestrator', label: 'Coordinator', model: 'claude-opus-4.6',
      x: 60, y: 220, w: 240,
      prompt: 'You are the coordinator. Receive a user research query, decompose it into 1–3 sub-questions, and dispatch to the gateway. After workers return, hand off to the aggregator.',
      tools: ['todo_write', 'subagent_dispatch'], hooks: ['pre_run_consent'],
      tokens: { used: 4_120, budget: 32_000 }, status: 'idle' },

    { id: 'gw',  kind: 'gateway', label: 'Router', model: 'claude-haiku-4.5',
      x: 360, y: 220, w: 220,
      prompt: 'Classify each sub-question into {web, code, internal_docs}. Route to the matching worker. If confidence < 0.6, route to all three.',
      tools: ['classify'], hooks: [],
      tokens: { used: 880, budget: 8_000 }, status: 'idle',
      condition: 'classify.confidence ≥ 0.6' },

    { id: 'w1',  kind: 'worker', label: 'Web Searcher', model: 'claude-sonnet-4.6',
      x: 660, y: 60,  w: 240,
      prompt: 'You are a web research worker. Use search + fetch. Return a structured brief with citations. No speculation past your sources.',
      tools: ['web_search', 'web_fetch', 'cite'], hooks: ['url_allowlist'],
      tokens: { used: 12_400, budget: 40_000 }, status: 'running' },

    { id: 'w2',  kind: 'worker', label: 'Code Searcher', model: 'claude-sonnet-4.6',
      x: 660, y: 220, w: 240,
      prompt: 'You are a codebase research worker. Use grep + read_file. Return file paths + line ranges + one-paragraph explanation per finding.',
      tools: ['grep', 'read_file', 'list_files'], hooks: ['path_scope'],
      tokens: { used: 8_900, budget: 40_000 }, status: 'running' },

    { id: 'w3',  kind: 'worker', label: 'Docs Searcher', model: 'claude-haiku-4.5',
      x: 660, y: 380, w: 240,
      prompt: 'You are an internal docs worker. Query the vector store and return ranked passages. Always include the source doc path.',
      tools: ['vector_search', 'read_file'], hooks: [],
      tokens: { used: 3_100, budget: 20_000 }, status: 'done' },

    { id: 'mem', kind: 'memory', label: 'Scratchpad', model: null,
      x: 660, y: 540, w: 240,
      prompt: 'Append-only JSONL at .harness/scratch.jsonl. Shared across workers. Compacted at 80% of budget.',
      tools: ['fs.append', 'fs.read'], hooks: [],
      tokens: { used: 6_400, budget: 16_000 }, status: 'idle' },

    { id: 'agg', kind: 'aggregator', label: 'Synthesizer', model: 'claude-opus-4.6',
      x: 960, y: 220, w: 240,
      prompt: 'Merge worker outputs into a single brief. Deduplicate citations. Flag contradictions explicitly — do not paper over them.',
      tools: ['fs.read'], hooks: [],
      tokens: { used: 0, budget: 48_000 }, status: 'waiting' },

    { id: 'cr',  kind: 'critic', label: 'Verifier', model: 'claude-opus-4.6',
      x: 1260, y: 220, w: 240,
      prompt: 'Review the synthesized brief. Check every claim against its citation. Return PASS / REVISE with line-level feedback. Max 2 revision loops.',
      tools: ['fs.read', 'web_fetch'], hooks: [],
      tokens: { used: 0, budget: 24_000 }, status: 'waiting' },
  ],
  edges: [
    { from: 'in',  to: 'gw',  label: 'sub-questions' },
    { from: 'gw',  to: 'w1',  label: 'web?',  kind: 'conditional' },
    { from: 'gw',  to: 'w2',  label: 'code?', kind: 'conditional' },
    { from: 'gw',  to: 'w3',  label: 'docs?', kind: 'conditional' },
    { from: 'w1',  to: 'agg', label: 'brief' },
    { from: 'w2',  to: 'agg', label: 'findings' },
    { from: 'w3',  to: 'agg', label: 'passages' },
    { from: 'w1',  to: 'mem', kind: 'memory' },
    { from: 'w2',  to: 'mem', kind: 'memory' },
    { from: 'w3',  to: 'mem', kind: 'memory' },
    { from: 'agg', to: 'cr',  label: 'synthesis' },
    { from: 'cr',  to: 'agg', label: 'revise',  kind: 'feedback' },
  ],
};

// ── WORKFLOW B: Sequential pipeline ───────────────────────────────────────
const WF_PIPELINE = {
  id: 'wf-pipeline',
  name: 'spec-to-pr.harness.yaml',
  description: 'Linear: spec → plan → implement → verify → report',
  nodes: [
    { id: 's', kind: 'orchestrator', label: 'Spec Writer', model: 'claude-opus-4.6',
      x: 60, y: 260, w: 240,
      prompt: 'Expand the user request into a comprehensive feature spec. Enumerate ≥10 testable requirements. Mark each as PASS / FAIL initially.',
      tools: ['todo_write', 'fs.write'], hooks: ['pre_run_consent'],
      tokens: { used: 3_200, budget: 24_000 }, status: 'done' },
    { id: 'p', kind: 'worker', label: 'Planner', model: 'claude-sonnet-4.6',
      x: 360, y: 260, w: 240,
      prompt: 'Read the spec. Produce a depth-first task list. Each task ≤ 2 files of impact. Stop at first ambiguity and ask.',
      tools: ['fs.read', 'todo_write'], hooks: [],
      tokens: { used: 5_400, budget: 24_000 }, status: 'running' },
    { id: 'i', kind: 'worker', label: 'Implementer', model: 'claude-sonnet-4.6',
      x: 660, y: 260, w: 240,
      prompt: 'Execute one task at a time. Run tests after each change. Never mark a task complete without a green test run.',
      tools: ['fs.write', 'bash', 'test'], hooks: ['destructive_guard', 'test_gate'],
      tokens: { used: 0, budget: 60_000 }, status: 'idle' },
    { id: 'v', kind: 'critic', label: 'Verifier', model: 'claude-opus-4.6',
      x: 960, y: 260, w: 240,
      prompt: 'Run the full test suite + lint + typecheck. End-to-end browser test via Puppeteer. Block on any red.',
      tools: ['bash', 'puppeteer'], hooks: [],
      tokens: { used: 0, budget: 32_000 }, status: 'waiting' },
    { id: 'r', kind: 'aggregator', label: 'Reporter', model: 'claude-haiku-4.5',
      x: 1260, y: 260, w: 240,
      prompt: 'Summarize the diff, test results, and any caveats. Produce a PR description matching the team template.',
      tools: ['git', 'fs.read'], hooks: [],
      tokens: { used: 0, budget: 8_000 }, status: 'waiting' },
  ],
  edges: [
    { from: 's', to: 'p' }, { from: 'p', to: 'i' }, { from: 'i', to: 'v' },
    { from: 'v', to: 'i', label: 'revise', kind: 'feedback' },
    { from: 'v', to: 'r' },
  ],
};

// ── WORKFLOW C: Reflection / critic loop ──────────────────────────────────
const WF_CRITIC = {
  id: 'wf-critic',
  name: 'self-critic.harness.yaml',
  description: 'Drafter ↔ Critic with bounded iteration; gated by structural tests',
  nodes: [
    { id: 'd', kind: 'worker', label: 'Drafter', model: 'claude-sonnet-4.6',
      x: 220, y: 260, w: 260,
      prompt: 'Produce a first draft. Do not self-edit. Mark uncertain claims with [?]. Stop at ≤ 1200 words.',
      tools: ['fs.write'], hooks: [],
      tokens: { used: 9_800, budget: 32_000 }, status: 'running' },
    { id: 'c', kind: 'critic', label: 'Critic', model: 'claude-opus-4.6',
      x: 700, y: 260, w: 260,
      prompt: 'Critique the draft along axes: accuracy, structure, tone. Return line-level feedback. Be specific — vague feedback is worse than no feedback.',
      tools: ['fs.read'], hooks: [],
      tokens: { used: 7_200, budget: 32_000 }, status: 'idle' },
    { id: 'g', kind: 'gateway', label: 'Loop Gate', model: 'claude-haiku-4.5',
      x: 1180, y: 260, w: 240,
      prompt: 'Decide: ship | revise | escalate. If issues > 0 and iterations < 3, route back to Drafter. Otherwise ship or escalate.',
      tools: [], hooks: [],
      tokens: { used: 600, budget: 4_000 }, status: 'idle',
      condition: 'issues > 0 ∧ iter < 3' },
    { id: 'h', kind: 'hook', label: 'iter_counter', model: null,
      x: 700, y: 540, w: 260,
      prompt: 'Pre-loop hook. Increments .harness/state/iter.txt. Blocks if > 3 to prevent runaway cost.',
      tools: ['fs.read', 'fs.write'], hooks: [],
      tokens: { used: 0, budget: 0 }, status: 'idle' },
    { id: 'm', kind: 'memory', label: 'Revision Log', model: null,
      x: 220, y: 540, w: 260,
      prompt: 'Stores each draft + critique as .harness/revisions/{n}.md. Survives context resets.',
      tools: ['fs.append'], hooks: [],
      tokens: { used: 4_100, budget: 16_000 }, status: 'idle' },
  ],
  edges: [
    { from: 'd', to: 'c', label: 'draft' },
    { from: 'c', to: 'g', label: 'verdict' },
    { from: 'g', to: 'd', label: 'revise', kind: 'feedback' },
    { from: 'd', to: 'm', kind: 'memory' },
    { from: 'c', to: 'm', kind: 'memory' },
    { from: 'g', to: 'h', kind: 'control' },
  ],
};

const WORKFLOWS = {
  fanout:   WF_FANOUT,
  pipeline: WF_PIPELINE,
  critic:   WF_CRITIC,
};

// File tree shown in left panels
const WORKSPACE_FILES = [
  { type: 'dir', name: '.harness', children: [
    { type: 'file', name: 'parallel-research.harness.yaml', active: true },
    { type: 'file', name: 'spec-to-pr.harness.yaml' },
    { type: 'file', name: 'self-critic.harness.yaml' },
    { type: 'dir', name: 'hooks', children: [
      { type: 'file', name: 'pre_run_consent.sh' },
      { type: 'file', name: 'url_allowlist.py' },
      { type: 'file', name: 'path_scope.py' },
      { type: 'file', name: 'destructive_guard.sh' },
    ]},
    { type: 'dir', name: 'prompts', children: [
      { type: 'file', name: 'coordinator.md' },
      { type: 'file', name: 'web-searcher.md' },
      { type: 'file', name: 'verifier.md' },
    ]},
    { type: 'dir', name: 'trajectories', children: [
      { type: 'file', name: '2026-05-11_14-22.jsonl' },
      { type: 'file', name: '2026-05-11_11-08.jsonl' },
      { type: 'file', name: '2026-05-10_19-44.jsonl' },
    ]},
    { type: 'file', name: 'audit.log.jsonl' },
    { type: 'file', name: 'manifest.json' },
  ]},
  { type: 'file', name: 'AGENTS.md' },
  { type: 'file', name: 'CLAUDE.md' },
  { type: 'file', name: 'README.md' },
  { type: 'dir', name: 'src', children: [
    { type: 'dir', name: 'commands' },
    { type: 'dir', name: 'tools' },
    { type: 'file', name: 'index.ts' },
  ]},
  { type: 'file', name: '.env.local', muted: true },
];

// Trajectory / audit log entries (used by all variants)
const AUDIT_ENTRIES = [
  { t: '14:22:08.412', kind: 'run',    node: 'Coordinator',   msg: 'workflow started · query="impact of context rot on long-horizon agents"' },
  { t: '14:22:08.880', kind: 'tokens', node: 'Coordinator',   msg: '4,120 in · 312 out · $0.08' },
  { t: '14:22:09.104', kind: 'edge',   node: 'Coordinator→Router',   msg: 'sub-questions [3]' },
  { t: '14:22:09.501', kind: 'tool',   node: 'Router',        msg: 'classify({q1, q2, q3}) → {web, code, docs}' },
  { t: '14:22:09.722', kind: 'fanout', node: 'Router',        msg: 'dispatched 3 parallel workers' },
  { t: '14:22:10.318', kind: 'consent',node: 'Web Searcher',  msg: 'url_allowlist hook: arxiv.org → APPROVED' },
  { t: '14:22:11.044', kind: 'tool',   node: 'Web Searcher',  msg: 'web_search("context rot LLM long horizon") → 8 results' },
  { t: '14:22:12.766', kind: 'tool',   node: 'Code Searcher', msg: 'grep("context_rot|compaction") → 14 hits in 6 files' },
  { t: '14:22:14.219', kind: 'done',   node: 'Docs Searcher', msg: '3 passages · 3,100 tokens · 1.8s' },
  { t: '14:22:14.422', kind: 'warn',   node: 'Web Searcher',  msg: 'token budget 31% used · 12,400 / 40,000' },
  { t: '14:22:15.001', kind: 'tool',   node: 'Web Searcher',  msg: 'web_fetch("…/2604.25850") → 18,400 tokens (offloaded to fs)' },
];

Object.assign(window, { ROLE_META, MODELS, WORKFLOWS, WORKSPACE_FILES, AUDIT_ENTRIES });
