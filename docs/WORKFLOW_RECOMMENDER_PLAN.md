# Workflow Recommender - Current Implementation

Updated: 2026-05-18

The `Create from Goal` wizard is implemented as a rule-based recommender. It
makes no AI call, no provider call, and no hidden network request.

## Files

| File | Role |
|---|---|
| `src/services/wizard/goalTemplates.ts` | Typed template catalog, keyword matcher, provider recommender |
| `src/services/wizard/templateToWorkflow.ts` | Converts templates to schema-valid workflows |
| `src/components/wizard/WorkflowWizard.tsx` | Modal UI and template detail view |
| `tests/unit/services/wizard/goalTemplates.test.ts` | Catalog, matcher, provider, and workflow conversion tests |

## Templates

| ID | Title | Difficulty | Local first |
|---|---|---|---|
| `blog-automation` | Blog Writing Pipeline | beginner | yes |
| `purchasing-decision` | Purchasing Decision Assistant | beginner | yes |
| `logistics-routing-assistant` | Logistics Routing Assistant | intermediate | yes |
| `finance-expense-analysis` | Finance Expense Analysis | beginner | yes |
| `coding-task-assistant` | Coding Task Assistant | intermediate | yes |
| `matlab-parameter-sweep` | MATLAB Parameter Sweep Assistant | intermediate | yes |
| `harness-self-improvement` | Harness Studio Self-Improvement | advanced | yes |
| `research-synthesis` | Research and Synthesis | beginner | yes |

Verified 2026-05-18: focused wizard test passes 26 tests, including matching
for logistics, finance, and MATLAB goals.

## Safety Boundary

- No live AI call.
- No cloud call.
- No secret access.
- No auto-run.
- User sees setup requirements, expected artifacts, verification method, and privacy notes before loading a workflow.

## Provider Guidance

The recommender ranks local Ollama, Ollama Cloud, Anthropic, OpenAI, and
OpenAI-compatible options according to the template and configured availability.
Cloud options must be treated as transmitting prompt/context data off-device.

## Next Work

1. Add UI filtering by difficulty/provider.
2. Add a preview of generated workflow YAML before loading.
3. Add optional live AI customization only behind explicit opt-in and a cloud/local disclosure.
