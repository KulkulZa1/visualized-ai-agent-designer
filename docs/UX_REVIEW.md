# UX Review

Updated: 2026-05-18

## Verification Method

The frontend was launched with `npm run dev` and inspected through browser DOM
automation at `http://127.0.0.1:1420/`. Screenshot capture was attempted twice
but the Browser CDP `Page.captureScreenshot` call timed out, so this review is
based on DOM state and interaction evidence.

The real Tauri dev app was also launched with `npm run tauri -- dev`; process
evidence showed `target\\debug\\agent-workflow-builder.exe` and WebView2 child
processes.

## Verified UI Behavior

- Empty canvas onboarding renders and explains the first steps.
- AuditStrip renders with kind chips, `All`, ordering, event count, and the empty state.
- `Create from Goal` opens the rule-based recommender.
- Goal `I want to automate blog writing.` recommends `Blog Writing Pipeline`.
- The blog template details include agents, setup requirements, expected artifacts, verification method, and privacy notes.
- `Load this workflow` creates a 7-node / 8-edge canvas workflow.
- Settings show provider mode choices and Ollama local/cloud controls.
- The Ollama Cloud preset exposes `https://ollama.com/api`, `gemma4:31b-cloud`, auth token guidance, and `OLLAMA_API_KEY`.
- Run preflight dialog opens and explicitly says `sequential topological order` and `streaming simulated`.

## UX Strengths

- Beginner start path exists without reading source code.
- Provider/model guidance is visible before run.
- The wizard clearly labels itself rule-based and does not imply live AI.
- The guide assistant is always available and rule-based.
- Sequential execution is visible in the run dialog.
- Mock/preview status is present in several inspector surfaces.

## UX Risks

| Risk | Current status | Fix |
|---|---|---|
| Screenshots/visual regression | No reliable automated screenshot capture in this pass | Add Playwright/E2E screenshot pipeline independent of Browser CDP |
| Context inspector | Still partly preview/mock | Wire actual run payloads and label snapshot status consistently |
| Artifacts | Mock placeholders | Persist real artifacts per run/source node |
| Settings density | Large modal with many controls | Add focused provider setup wizard for beginners |
| Production clarity | App can run without workspace but save needs workspace | Keep no-workspace warnings prominent |
| Parallel example naming | Fan-out graphs may imply concurrency | Keep run dialog/docs explicit until scheduler exists |

## Recommended Next UX Work

1. Add an E2E smoke test for first launch, Create from Goal, Settings, Run dialog, AuditStrip, and Context Inspector.
2. Add stable screenshot capture in CI or local verification.
3. Replace artifact mock panel with real persisted run artifacts or a stronger preview-only banner.
4. Add a provider setup checklist modal for local Ollama, Ollama Cloud, and OpenAI/Anthropic.
