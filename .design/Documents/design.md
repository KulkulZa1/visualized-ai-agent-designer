# Harness Studio — Design Guide

> A visual workflow builder for AI Harness Engineering (AHE).
> Two chosen directions: **Atelier** (refined dark, builder-first) and **Observatory** (telemetry-first, operator-first). Same data model, different lens.

---

## 1. What is this UI?

A **harness** is everything around the model: orchestration, prompts, tools, hooks, memory, sandboxes, file layouts, eval loops. The model is *the dependency*, not *the product*. This UI's job is to make the harness — every piece of it — **visible, editable, and reproducible**.

The medium is the filesystem. Every node on the canvas maps to a file in `.harness/`. Every edit is a real diff. Nothing lives only in the UI.

---

## 2. The six principles that drive the design

| # | Principle | How it shows up in the UI |
|---|---|---|
| 1 | **Component observability** — every harness piece is a file | Left tree mirrors `.harness/`; selecting a node highlights the file. Save = git-style write. |
| 2 | **Experience observability** — drill-down trajectory replay | Bottom strip in Atelier, full timeline + scrubber in Observatory. |
| 3 | **Decision observability** — every edit makes a prediction | `Prediction` field on each prompt revision; later marked verified/falsified. |
| 4 | **Context is a scarce resource** | Token gauges on every node. Compaction threshold visible. Per-node budget vs. used. |
| 5 | **Hooks, sandboxes, permission gates are first-class** | Orange shield chips on nodes. Consent gate fires in the audit log inline. Dedicated Hooks tab. |
| 6 | **Reproducibility over magic** | YAML view always available. Trajectories are JSONL files. No hidden state. |

---

## 3. The two directions

### A · Atelier — "the editor"
**For:** building, iterating, reviewing diffs.
**Lineage:** Linear, Zed, Raycast — refined dark surfaces, restrained color, tight type.
**When to use:** authoring the harness. The canvas is dense; nodes show prompt previews and tool chips so you can scan without selecting.

**Anatomy**
- **Top:** path breadcrumbs · validation state · run/save/validate buttons (amber accent for primary)
- **Left:** workspace + file tree with `.harness/` always expanded
- **Center:** canvas with detailed node cards (header / prompt clamp / model / tools / token bar / hooks)
- **Right:** 5-tab inspector — Role, Prompt, Tools, Hooks, Memory
- **Bottom:** collapsible audit strip (filterable by kind)

**Why detailed cards?** AHE work is mostly reading. A glanceable card with role, model, prompt snippet, and tool list lets you understand the graph without clicking 8 nodes.

### C · Observatory — "the op room"
**For:** running, monitoring, debugging.
**Lineage:** Datadog, Honeycomb, Grafana — but for agents.
**When to use:** when a workflow is live or you're replaying yesterday's trajectory. The canvas is the live op view; nodes are gauges.

**Anatomy**
- **Top:** workspace badge · live tokens/cost/wall/errors as stat pills · Replay button
- **Center:** nodes as cards with a **token ring** (radial gauge), three mini-metrics, and a **live sparkline** when running. Edges have animated dots that show data movement in real time.
- **Right:** node detail with a **stacked bar context viz** (system / tool defs / convo / free) — the most important resource visualized as area
- **Bottom:** **swimlane timeline + scrubber** — replay any past run, scrub by time, see which nodes were active when

**Why a gauge ring?** Operators glance at dozens of nodes. A ring resolves "how full is this context?" in 50ms.

---

## 4. Shared design system

### Color
Use neutral surfaces; reserve color for **role** and **state**.

| Token | Atelier | Observatory | Use |
|---|---|---|---|
| `bg`        | `#0e0f13` | `#0d1116` | Page background |
| `surface`   | `#15171c` | `#161b22` | Panels, sidebars |
| `surface-2` | `#1c1f26` | `#1e242d` | Cards, nodes |
| `border`    | `rgba(255,255,255,0.06)` | `#2d3441` | Hairlines |
| `text`      | `#e6e7eb` | `#d6dde5` | Body |
| `muted`     | `#9097a3` | `#8a95a3` | Labels |
| `accent`    | `#e5a142` (amber) | `#4dd4ff` (cyan) | Primary action / selection |

**Role tints** (used in both):
- Orchestrator `#e5a142` — Gateway `#7c9eff` — Worker `#5fbf7f` — Critic `#e07575` — Memory `#b88bd9` — Hook `#d97757` — Aggregator `#5fbfb5`

**State**: running `#5fbf7f` (pulsing), waiting `#e5a142`, done `#7c9eff`, error `#e07575`.

### Type
- **UI**: Inter / system-ui — 11/12/13 for chrome, 14 for headers
- **Code, IDs, tool names**: JetBrains Mono — always for tool names, token counts, file paths, model IDs
- **Never**: mix-case in tool chips. Always lowercased mono.

### Spacing & radii
- 4 / 6 / 8 / 12 / 16 / 24 px grid
- Nodes: 8px radius (Atelier), 14px (Observatory — softer, more "card")
- Buttons: 4–6px radius
- Hairlines `1px` `rgba(255,255,255,0.06)` — never thicker

### Iconography
Lucide-style line icons, 1.6 stroke. Role glyphs use the geometric symbols `◆ ◇ ● ◐ ▣ ✕ ⊕` consistently across both directions — they are part of the brand.

---

## 5. Component vocabulary

### Node (graph)
- **Header**: role glyph + label + status pill
- **Body**: short prompt preview (3-line clamp) or live metrics
- **Footer**: model · tools · token bar · hooks
- **Ports**: 10px circles on left/right edges, colored by role

### Edge
- **Solid** `border-strong` — data flow
- **Dashed purple** `#b88bd9` — memory write
- **Dashed gray** — control flow
- **Solid red** `#e07575` — feedback loop (always routed below)

### Status
Tiny dot + lowercased label. Pulse animation only on `running`.

### Inspector (5 tabs)
1. **Role** — name, kind, model, limits (budget, max steps, timeout)
2. **Prompt** — system prompt monaco-style block + variables + schema + prediction
3. **Tools** — full tool catalog with checkboxes; sub-config per tool
4. **Hooks** — attached hooks; ledger of fires/blocks; consent settings
5. **Memory** — context window breakdown; long-term memory strategy

### Audit / trace
Monospaced rows: `time · KIND · node · message`. Kinds color-coded. Filterable.

---

## 6. Interaction patterns

| Action | Atelier | Observatory |
|---|---|---|
| Select node | Click — selection ring | Click — selection ring |
| Move node | Drag the body | n/a (auto-layout in op view) |
| Edit prompt | Click prompt in Right rail → opens Monaco | Read-only — opens Atelier |
| Run workflow | `⌘R` or Run button → preflight dialog | n/a — already running |
| Replay | n/a | Click ▶ in bottom strip; scrub timeline |
| Open file | Click in tree | n/a |

**Keyboard model** (planned):
- `⌘K` — command palette (everything)
- `⌘S` — save · `⌘R` — run · `⌘.` — validate
- `⌥click` node — open file in editor
- `/` in canvas — fuzzy search nodes
- `?` — keymap

---

## 7. Information hierarchy rules

1. **Role color is communicated once per node** — in the glyph chip. Don't repaint the whole card.
2. **Numbers in tabular mono.** Token counts, costs, durations.
3. **Tool names are mono lowercase with dots.** `web_search`, `fs.read`. Never `Web Search`.
4. **Status is always a small dot + word.** Never a big badge.
5. **Hooks get the alarm color.** Orange `#d97757`. They are gates — they should feel like gates.
6. **Empty states are honest.** "No hooks attached. Tool calls run with default permissions." Not "Get started by…".

---

## 8. When to use which

| Scenario | Direction |
|---|---|
| Authoring a new workflow | Atelier |
| Reviewing a teammate's harness | Atelier (read-mode) |
| Debugging a failed run | Observatory → click node → "Open in Atelier" |
| Live monitoring of a long-running agent | Observatory |
| Pair-programming with an agent (single thread) | Atelier with audit strip expanded |
| Cost / token postmortem | Observatory timeline + node detail |

The two are **complementary, not redundant**. Atelier owns *write*, Observatory owns *read*. A future v1 would let you switch with a single keystroke (`⌘1` / `⌘2`) without losing selection.

---

## 9. Expansion surface (see section 2 of the canvas)

The two directions are floors, not ceilings. Five additional surfaces address gaps:

- **Command palette (`⌘K`)** — central navigation hub for an app with this many primitives
- **Run preflight** — cost estimate + hook consent ledger + dry-run preview before any run
- **Trajectory replay deep-dive** — step-by-step inspector with token deltas per turn
- **Eval harness** — regression dashboard, test cases × workflow versions
- **Prediction ledger** — every edit's hypothesis, verified or falsified (the AHE feedback loop)

See those screens in the second canvas section for hi-fi mocks.
