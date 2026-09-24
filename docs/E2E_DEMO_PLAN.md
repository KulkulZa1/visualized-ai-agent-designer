# End-to-End Demo Plan — Harness Studio

> **Goal:** A small, deterministic, beginner-friendly demo workflow that
> exercises the full Harness Studio stack — file load, canvas, context
> inspection, run, artifacts, audit log — without requiring paid API access.

---

## 1. Recommended first demo

**Title:** *Purchasing Decision Assistant*
**File:** `examples/purchasing-decision.harness.yaml` (scaffold created
in this slice — see Section 6).

### Why this demo

| Criterion | Met |
|---|---|
| Beginner-friendly domain | ✅ — "rank 3 suppliers" is universally understood. |
| Deterministic verification | ✅ — supplier scores are derivable from a fixed rubric. |
| Uses multiple agent roles | ✅ — orchestrator + worker + critic + aggregator + memory. |
| Uses 4 edge types | ✅ — data, memory, control, feedback. |
| Generates artifacts | ✅ — `ranking.md`, `risk-report.md`. |
| Runs in mock-provider mode | ✅ — works without OpenAI/Anthropic keys when local Ollama is installed. |
| Small enough to debug | ✅ — 5 agents, 7 edges. |
| Expandable | ✅ — easily extended with more suppliers, a budget gate, or supplier-doc retrieval. |
| Safe | ✅ — no `bash`, no network, no `fs.write` outside `.harness/`. |

### What this demo proves

- The user can load a workflow, see all nodes, inspect a prompt, click Run,
  and read the resulting artifact.
- The provider abstraction works against a local Ollama model.
- The audit strip captures the run in chronological order.
- The snapshot history persists per-node context.

### What this demo does **not** prove yet

- Live streaming (current implementation uses synthetic stream chunks).
- Live tool calling against an external API.
- Multi-workflow orchestration.
- VS Code access or MCP access. CLI v0 now exists for read-only status,
  validation, and provider catalog listing, but it does not run demos.
- MATLAB or code execution.

---

## 2. Workflow structure

```
                    ┌──────────────────────┐
                    │ ◆ Requirement Parser │ orchestrator
                    │   agent-0            │
                    └─────────┬────────────┘
                              │ data: parsed requirements
                              ▼
                    ┌──────────────────────┐
                    │ ● Supplier Evaluator │ worker
                    │   agent-1            │
                    └─────────┬────────────┘
                              │ data: scored suppliers
                              ▼
                    ┌──────────────────────┐    feedback (revise)
       ┌────────────│ ◐ Risk Reviewer      │◄──────────────┐
       │            │   agent-2            │               │
       │ control:   └─────────┬────────────┘               │
       │ approve            │ data: ranking + risks       │
       │                    ▼                              │
       │            ┌──────────────────────┐               │
       │            │ ⊕ Report Writer      │ aggregator    │
       │            │   agent-3            │───────────────┘
       │            └─────────┬────────────┘
       │ memory: decision log │ memory: decision log
       │                      ▼
       │            ┌──────────────────────┐
       └───────────►│ ▣ Decision Memory    │ memory
                    │   agent-4            │
                    └──────────────────────┘
```

### Agent roster

| # | Name | Role | Tools | Outputs |
|---|---|---|---|---|
| 0 | Requirement Parser | orchestrator | `read_file`, `todo_write` | parsed requirements JSON |
| 1 | Supplier Evaluator | worker | `read_file` | scored supplier list |
| 2 | Risk Reviewer | critic | `read_file` | risk verdict (PASS / REVISE) |
| 3 | Report Writer | aggregator | `fs.write`, `fs.read` | `ranking.md` artifact |
| 4 | Decision Memory | memory | `fs.append`, `fs.read` | append-only decision log |

### Edges

| From | To | Kind | Label |
|---|---|---|---|
| agent-0 | agent-1 | dataflow | parsed requirements |
| agent-1 | agent-2 | dataflow | scored suppliers |
| agent-2 | agent-3 | dataflow | ranking + risks |
| agent-2 | agent-1 | feedback | revise |
| agent-3 | agent-4 | memory | decision log |
| agent-1 | agent-4 | memory | scoring rationale |
| agent-2 | agent-4 | control | reviewer approval |

---

## 3. Demo inputs

```yaml
# .harness/inputs/requirements.yaml — provided by the user
budgetUsd: 50000
deliveryDays: 30
mustHaveCertifications: [ISO9001]
preferredRegion: APAC

suppliers:
  - id: SUP-A
    name: Acme Industrial
    unitPriceUsd: 480
    leadDays: 18
    certifications: [ISO9001, ISO14001]
    region: APAC
    historicalDefectRate: 0.012
  - id: SUP-B
    name: BlueOcean Components
    unitPriceUsd: 510
    leadDays: 12
    certifications: [ISO9001]
    region: EMEA
    historicalDefectRate: 0.008
  - id: SUP-C
    name: Cobalt Source
    unitPriceUsd: 460
    leadDays: 35
    certifications: []
    region: APAC
    historicalDefectRate: 0.024
```

---

## 4. Deterministic verification rubric

For each supplier, compute:

```
score = 100
       - max(0, unitPriceUsd - 460) * 0.05      # price penalty over $460
       - max(0, leadDays - deliveryDays) * 1.5  # late-delivery penalty
       - 30 * (cert_required - cert_present)    # missing cert penalty
       - 1000 * historicalDefectRate            # quality penalty
       + (region == preferredRegion ? 5 : 0)    # region bonus
```

Applied to the inputs above the expected ranking is:

1. **SUP-A** = 92.0 (price −1.0, quality −12.0, APAC region bonus +5)
2. **SUP-B** = 89.5 (price −2.5, quality −8.0; best quality and lead time, but no region bonus)
3. **SUP-C** = 43.5 (late −7.5, missing ISO9001 −30, quality −24.0, region bonus +5)

Verification test should compare the agent-produced ranking against the
deterministic computation within ±2 points. This protects against model
non-determinism while still catching obviously wrong agent reasoning.

---

## 5. Expected logs and artifacts

| Item | Path | Source |
|---|---|---|
| Spec parse | audit `info` entries × 1 | agent-0 |
| Score table | snapshot `.harness/snapshots/<id>.json` (indexed per node in `index.json`) | agent-1 |
| Risk verdict | snapshot `.harness/snapshots/<id>.json` | agent-2 |
| Ranking report | `.harness/artifacts/ranking.md` (only if the model calls `fs.write`) | agent-3 |
| Decision log | memory key `decision-log`, current run only (not written to disk) | agent-4 |

---

## 6. Implementation status

- [x] Workflow scaffold: `examples/purchasing-decision.harness.yaml` (this slice).
- [x] Demo input file: documented in section 3; not yet copied into a
      sample `.harness/inputs/` folder (deferred — not needed for canvas demo).
- [ ] Headless verification test: deferred (needs CLI scaffold from
      `CLI_MCP_PLAN.md`).
- [ ] Auto-load button in ExamplePicker: works via the existing
      `useExamples` registration once added. *(Deferred — add when next UX
      slice runs.)*
- [ ] Determinism assertion: deferred until `useWorkflowExecution` exposes
      a structured agent-output capture suitable for unit testing.

The scaffold validates against `workflowDefSchema`, so loading it via the
file tree (`.harness.yaml`) opens the canvas correctly. Until the example
is registered in `useExamples`, users can drag the file from
`examples/purchasing-decision.harness.yaml` into the file tree.

---

## 7. Failure cases the demo should expose

1. Missing certification on SUP-C → risk reviewer should REVISE.
2. Long lead time on SUP-C exceeding 30-day SLA → late-delivery penalty.
3. Region mismatch on SUP-B → region bonus applied to SUP-A and SUP-C only.
4. If the agent ranks SUP-C first, the deterministic check fails — clear
   regression signal.

---

## 8. Future demos (deferred)

- **Logistics route planning** (Demo B in the original brief).
- **Engineering parameter sweep** — links to `MATLAB_INTEGRATION_PLAN.md`
  Option A.
- **Finance expense analyzer** with mock CSV.
- **Coding agent demo** — once the CLI / engine extraction lands, build a
  spec→pr→tests demo against a small repo fixture under `examples/repos/`.

---

*Update this file when verification automation lands, when the example is
registered in `useExamples`, or when the demo workflow gets revised.*
