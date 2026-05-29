# Guide Assistant - Current Implementation

Updated: 2026-05-18

The Guide Assistant is a floating rule-based helper panel. It is not a live AI
assistant and does not call providers or the network.

## Current State

| Area | State |
|---|---|
| UI shell | Implemented in `src/components/guide/GuidePanel.tsx` |
| Access | Floating `?` button; mounted globally from `App.tsx` |
| Knowledge base | Pre-written answers for common beginner/expert questions |
| Live AI | Not implemented |
| Ollama local bridge | Planned, opt-in only |
| Gemini/Gemma cloud bridge | Planned only; must require explicit consent before cloud use |

## Topics Covered

- How to start.
- Which model/provider to use.
- How to get API keys.
- How to use Ollama local and Ollama Cloud.
- Why workflows fail.
- What context snapshots and artifacts are.
- What MCP does.
- Whether agents are independent and whether execution is parallel.
- Streaming status.
- Panel layout.

## Safety Boundary

- No live AI calls.
- No hidden cloud calls.
- No secrets are requested or read.
- Search text stays in component state.
- Answers are rendered from typed text/code/bold segments, not raw HTML.

## Future Live Mode Requirements

1. Default to local Ollama when available.
2. Require explicit user opt-in before sending any question/context to a cloud provider.
3. Label provider, cost/privacy tradeoff, and model before each cloud answer.
4. Never execute commands or mutate files from guide answers.
5. Keep rule-based fallback available offline.
