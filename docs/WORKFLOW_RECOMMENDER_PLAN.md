# Workflow Recommender - Current Implementation

Updated: 2026-06-28

The `Create from Goal` wizard is implemented as a rule-based recommender. It
makes no AI call, no provider call, and no hidden network request.

## Files

| File | Role |
|---|---|
| `src/services/wizard/goalTemplates.ts` | Typed template catalog, keyword matcher, provider recommender |
| `src/services/wizard/recommendationBrief.ts` | Explainable recommendation brief: match rationale, provider readiness, evidence artifacts, privacy/safety, next steps |
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

Verified 2026-06-28: focused wizard tests cover catalog shape, matching,
provider readiness, recommendation briefs, and workflow conversion.

## Safety Boundary

- No live AI call.
- No cloud call.
- No secret access.
- No auto-run.
- No inferred local-provider readiness: the wizard does not mark Ollama local ready unless a future health signal is wired in.
- User sees setup requirements, expected artifacts, verification method, and privacy notes before loading a workflow.
- User sees why a template was recommended, what provider readiness means, what evidence artifacts should be produced, and what the next setup/run steps are.

## Provider Guidance

The recommender ranks local Ollama, Ollama Cloud, Anthropic, OpenAI, and
OpenAI-compatible options according to the template and configured availability.
Cloud options must be treated as transmitting prompt/context data off-device.

## Next Work

1. Add UI filtering by difficulty/provider.
2. Add a preview of generated workflow YAML before loading.
3. Add provider/model capability checks against each template's model capabilities.
4. Add optional live AI customization only behind explicit opt-in and a cloud/local disclosure.
