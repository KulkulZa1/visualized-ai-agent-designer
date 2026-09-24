/**
 * goalTemplates — rule-based workflow recommendation catalog.
 *
 * Beginners describe their goal in plain text; the wizard matches keywords
 * against this catalog and recommends a workflow template + provider + model.
 *
 * Pure data + pure functions — no AI calls, no network.
 */
import { AgentRole } from "@/types/agent";

export type ProviderCategory =
  | "local"           // Ollama local — free, private
  | "ollama-cloud"    // Ollama Cloud — hosted, key required
  | "anthropic"       // Claude — paid, best for reasoning
  | "openai"          // GPT — paid, balanced
  | "openai-compatible"; // Custom / Gemini / Kilo gateway

export type ModelCapability = "general" | "coding" | "reasoning" | "long-context" | "vision" | "math";

export interface RecommendedAgent {
  name: string;
  role: AgentRole;
  description: string;
  /** Hint for the model the user should pick. Free-form. */
  modelHint: string;
}

export interface RecommendedEdge {
  /** index into the agents array */
  from: number;
  to: number;
  label?: string;
  kind?: "dataflow" | "memory" | "feedback" | "control";
}

export type Difficulty = "beginner" | "intermediate" | "advanced";

export interface GoalTemplate {
  id: string;
  title: string;
  description: string;
  /** Keywords used by the matcher (lowercase). */
  triggers: string[];
  /** Free-text examples of how a user might phrase the goal. */
  userGoalExamples: string[];
  recommendedAgents: RecommendedAgent[];
  recommendedEdges: RecommendedEdge[];
  /** Best-fit provider categories, in order of preference. */
  recommendedProviders: ProviderCategory[];
  /** Capabilities the recommended model should have. */
  modelCapabilities: ModelCapability[];
  setupRequirements: string[];
  expectedArtifacts: string[];
  verificationMethod: string;
  difficulty: Difficulty;
  /** True if the workflow can run with Ollama local only (no cloud key needed). */
  localFriendly: boolean;
  privacyNotes: string;
  safetyWarnings: string[];
}

// ── Templates ────────────────────────────────────────────────────────────────

export const GOAL_TEMPLATES: GoalTemplate[] = [
  {
    id: "blog-automation",
    title: "Blog Writing Pipeline",
    description: "Topic → outline → draft → SEO review → editor → publish-ready post. Suitable for content marketing or technical blogs.",
    triggers: ["blog", "article", "post", "writing", "content", "marketing", "seo", "publish"],
    userGoalExamples: [
      "Automate my blog writing",
      "Generate weekly tech blog posts",
      "Build a content pipeline",
    ],
    recommendedAgents: [
      { name: "Topic Planner",    role: AgentRole.Orchestrator, description: "Decomposes the topic into angle, audience, key points.", modelHint: "claude-sonnet-4.6 or qwen2.5:14b" },
      { name: "Researcher",       role: AgentRole.Worker,        description: "Gathers facts, sources, and statistics for the topic.",   modelHint: "claude-sonnet-4.6 or qwen2.5-coder:7b" },
      { name: "Outline Writer",   role: AgentRole.Worker,        description: "Produces a structured outline with H2/H3 sections.",      modelHint: "claude-haiku-4.5 or qwen2.5:7b" },
      { name: "Draft Writer",     role: AgentRole.Worker,        description: "Writes the full draft from the outline.",                 modelHint: "claude-sonnet-4.6 (best prose) or qwen2.5:14b" },
      { name: "SEO Reviewer",     role: AgentRole.Critic,        description: "Checks title, keywords, readability.",                    modelHint: "claude-haiku-4.5 or qwen2.5:7b" },
      { name: "Editor",           role: AgentRole.Critic,        description: "Polishes tone, fixes redundancy, validates claims.",      modelHint: "claude-sonnet-4.6 or qwen2.5:14b" },
      { name: "Publish Checklist",role: AgentRole.Aggregator,    description: "Final pass: title, meta-description, summary, status.",   modelHint: "claude-haiku-4.5 or qwen2.5:7b" },
    ],
    recommendedEdges: [
      { from: 0, to: 1, label: "topic plan" },
      { from: 1, to: 2, label: "research" },
      { from: 2, to: 3, label: "outline" },
      { from: 3, to: 4, label: "draft" },
      { from: 3, to: 5, label: "draft" },
      { from: 4, to: 6 },
      { from: 5, to: 6 },
      { from: 5, to: 3, kind: "feedback", label: "revise" },
    ],
    recommendedProviders: ["anthropic", "local", "openai"],
    modelCapabilities: ["general", "long-context"],
    setupRequirements: [
      "An API key for Anthropic/OpenAI, OR Ollama running locally with qwen2.5:7b or larger",
      "Workspace folder open (to save drafts as artifacts)",
    ],
    expectedArtifacts: ["blog-draft.md", "seo-report.md", "publish-checklist.md"],
    verificationMethod: "Run with a known topic; verify the final draft contains all H2 sections from the outline, has a meta-description ≤ 160 chars, and no flagged SEO issues.",
    difficulty: "beginner",
    localFriendly: true,
    privacyNotes: "If using cloud providers, your topic and any reference material are sent to the provider. Use Ollama local for fully private writing.",
    safetyWarnings: ["Always fact-check AI-generated claims before publishing."],
  },

  {
    id: "harness-self-improvement",
    title: "Harness Studio Self-Improvement",
    description: "The benchmark workflow: the tool inspecting itself to find issues, plan fixes, write tests, and prepare release notes. Recursive use of Harness Studio.",
    triggers: ["self", "improve", "improvement", "harness", "studio", "recursive", "meta", "develop tool", "fix bug", "review code"],
    userGoalExamples: [
      "Improve Harness Studio itself",
      "Review the project and propose fixes",
      "Self-development workflow",
    ],
    recommendedAgents: [
      { name: "Project Inspector",  role: AgentRole.Orchestrator, description: "Reads current state: PROJECT_STATUS.md, TODO.md, tests, build output.", modelHint: "claude-opus-4.6 or qwen2.5-coder:14b" },
      { name: "UX Reviewer",        role: AgentRole.Critic,        description: "Reviews UI components against design tokens & UX checklist.",          modelHint: "claude-sonnet-4.6 or qwen2.5:14b" },
      { name: "Bug Reproducer",     role: AgentRole.Worker,        description: "Reproduces issues from audit logs and test failures.",                 modelHint: "claude-haiku-4.5 or qwen2.5-coder:7b" },
      { name: "Test Planner",       role: AgentRole.Worker,        description: "Designs Vitest/cargo tests for proposed fixes.",                       modelHint: "claude-sonnet-4.6 or qwen2.5-coder:7b" },
      { name: "Change Planner",     role: AgentRole.Worker,        description: "Proposes surgical code changes (no auto-apply).",                     modelHint: "claude-opus-4.6 or qwen2.5-coder:14b" },
      { name: "Security Reviewer",  role: AgentRole.Critic,        description: "Flags any change that touches secrets, IPC, or hook execution.",      modelHint: "claude-sonnet-4.6 or qwen2.5:14b" },
      { name: "Docs Updater",       role: AgentRole.Worker,        description: "Drafts docs/DEVELOPMENT_LOG.md and AGENT.md updates.",                modelHint: "claude-haiku-4.5 or qwen2.5:7b" },
      { name: "Release Readiness",  role: AgentRole.Aggregator,    description: "Final go/no-go report combining all reviews.",                       modelHint: "claude-sonnet-4.6 or qwen2.5-coder:14b" },
    ],
    recommendedEdges: [
      { from: 0, to: 1, label: "current state" },
      { from: 0, to: 2, label: "audit log" },
      { from: 2, to: 3, label: "repro steps" },
      { from: 1, to: 4, label: "ux issues" },
      { from: 3, to: 4, label: "test plan" },
      { from: 4, to: 5, label: "proposed changes" },
      { from: 5, to: 4, kind: "feedback", label: "security flag" },
      { from: 5, to: 6, label: "approved" },
      { from: 6, to: 7, label: "docs draft" },
      { from: 4, to: 7, label: "changes" },
    ],
    recommendedProviders: ["anthropic", "local", "openai"],
    modelCapabilities: ["coding", "reasoning", "long-context"],
    setupRequirements: [
      "Open the Harness Studio project folder as your workspace",
      "Either: claude-opus-4.6 API access, OR Ollama with qwen2.5-coder:14b pulled",
      "Run npx vitest run + cargo test BEFORE this workflow so results are fresh",
    ],
    expectedArtifacts: ["issue-list.md", "proposed-changes.md", "test-plan.md", "security-report.md", "release-readiness.md"],
    verificationMethod: "Read the release-readiness artifact: must list specific files, specific test counts, and an explicit go/no-go decision. No auto-applied changes.",
    difficulty: "advanced",
    localFriendly: true,
    privacyNotes: "Reads source code. If using cloud providers, source code is sent to the provider. Use Ollama local for fully private review.",
    safetyWarnings: [
      "This workflow proposes changes only — it does NOT auto-apply. Always review before editing.",
      "Do not commit AI-proposed code without human review.",
      "Do not include .env.local or any secrets in the workspace if cloud providers are active.",
    ],
  },

  {
    id: "purchasing-decision",
    title: "Purchasing Decision Assistant",
    description: "Ranks suppliers using a scoring rubric. Deterministic output suitable for procurement decisions.",
    triggers: ["purchase", "buy", "supplier", "vendor", "procurement", "decision", "rank", "compare", "rfq"],
    userGoalExamples: [
      "Pick the best supplier for X",
      "Compare three vendors",
      "Procurement decision",
    ],
    recommendedAgents: [
      { name: "Requirements Clarifier", role: AgentRole.Orchestrator, description: "Restates needs in machine-readable form.",   modelHint: "claude-haiku-4.5 or qwen2.5:7b" },
      { name: "Supplier Researcher",    role: AgentRole.Worker,        description: "Looks up each supplier's specs and prices.", modelHint: "claude-sonnet-4.6 or qwen2.5:14b" },
      { name: "Rubric Scorer",          role: AgentRole.Worker,        description: "Applies the scoring rubric to each option.", modelHint: "claude-haiku-4.5 or qwen2.5-coder:7b" },
      { name: "Risk Reviewer",          role: AgentRole.Critic,        description: "Checks long-term risk: lock-in, support, SLA.", modelHint: "claude-sonnet-4.6 or qwen2.5:14b" },
      { name: "Recommendation",         role: AgentRole.Aggregator,    description: "Final ranked list with justifications.",     modelHint: "claude-sonnet-4.6 or qwen2.5:14b" },
    ],
    recommendedEdges: [
      { from: 0, to: 1, label: "requirements" },
      { from: 1, to: 2, label: "supplier facts" },
      { from: 2, to: 3, label: "scores" },
      { from: 3, to: 4, label: "risk-adjusted" },
    ],
    recommendedProviders: ["local", "anthropic", "openai"],
    modelCapabilities: ["general", "reasoning"],
    setupRequirements: [
      "Provide a list of suppliers and a scoring rubric in the workflow input",
      "Any provider works — local Ollama is sufficient",
    ],
    expectedArtifacts: ["supplier-facts.json", "scores.json", "recommendation.md"],
    verificationMethod: "Re-run with the same input; ranking order should be deterministic (temperature 0.0 recommended).",
    difficulty: "beginner",
    localFriendly: true,
    privacyNotes: "Supplier names and your scoring criteria are sent to the provider if cloud is used.",
    safetyWarnings: ["Always validate AI-suggested suppliers against your own due diligence."],
  },

  {
    id: "coding-task-assistant",
    title: "Coding Task Assistant",
    description: "Spec → plan → implement → test → review. Best for small, well-scoped features.",
    triggers: ["code", "coding", "implement", "feature", "bug fix", "refactor", "function", "class", "test"],
    userGoalExamples: [
      "Help me build a feature",
      "Implement a coding task",
      "Refactor this function",
    ],
    recommendedAgents: [
      { name: "Spec Writer",     role: AgentRole.Orchestrator, description: "Turns the request into a tight spec.",          modelHint: "claude-sonnet-4.6 or qwen2.5-coder:14b" },
      { name: "Planner",         role: AgentRole.Worker,        description: "Produces a step-by-step implementation plan.", modelHint: "claude-sonnet-4.6 or qwen2.5-coder:7b" },
      { name: "Implementer",     role: AgentRole.Worker,        description: "Writes the actual code (file by file).",       modelHint: "claude-sonnet-4.6 or qwen2.5-coder:14b" },
      { name: "Test Writer",     role: AgentRole.Worker,        description: "Writes Vitest/cargo unit tests.",              modelHint: "claude-haiku-4.5 or qwen2.5-coder:7b" },
      { name: "Code Reviewer",   role: AgentRole.Critic,        description: "Checks quality, security, style.",             modelHint: "claude-opus-4.6 or qwen2.5-coder:14b" },
      { name: "Report",          role: AgentRole.Aggregator,    description: "Combines everything into a PR-ready summary.", modelHint: "claude-haiku-4.5 or qwen2.5:7b" },
    ],
    recommendedEdges: [
      { from: 0, to: 1, label: "spec" },
      { from: 1, to: 2, label: "plan" },
      { from: 2, to: 3, label: "code" },
      { from: 2, to: 4, label: "code for review" },
      { from: 3, to: 5 },
      { from: 4, to: 5 },
      { from: 4, to: 2, kind: "feedback", label: "revise" },
    ],
    recommendedProviders: ["anthropic", "local"],
    modelCapabilities: ["coding", "reasoning"],
    setupRequirements: [
      "Workspace open in the relevant codebase",
      "Coding-strong model: claude-sonnet-4.6 OR qwen2.5-coder:7b or larger",
    ],
    expectedArtifacts: ["spec.md", "plan.md", "code.diff", "tests.md", "review.md", "report.md"],
    verificationMethod: "Generated tests should pass against the generated code. Reviewer flags any security/style issues.",
    difficulty: "intermediate",
    localFriendly: true,
    privacyNotes: "Code is sent to the provider if cloud is used. Use Ollama local for proprietary code.",
    safetyWarnings: ["AI-generated code is not automatically applied — always review the diff before applying."],
  },

  {
    id: "research-synthesis",
    title: "Research & Synthesis",
    description: "Two analysts argue pro and con on a topic; a critic synthesizes a balanced view. Good for exploring tradeoffs.",
    triggers: ["research", "analyze", "compare", "tradeoff", "pros", "cons", "synthesis", "analysis"],
    userGoalExamples: [
      "Research the tradeoffs between X and Y",
      "Pros and cons of approach Z",
      "Balanced analysis",
    ],
    recommendedAgents: [
      { name: "Orchestrator",  role: AgentRole.Orchestrator, description: "Plans the research scope and questions.",      modelHint: "claude-sonnet-4.6 or qwen2.5:7b" },
      { name: "Pro Analyst",   role: AgentRole.Worker,        description: "Argues in favor.",                           modelHint: "claude-sonnet-4.6 or qwen2.5:7b" },
      { name: "Con Analyst",   role: AgentRole.Worker,        description: "Argues against.",                            modelHint: "claude-sonnet-4.6 or qwen2.5:7b" },
      { name: "Critic",        role: AgentRole.Critic,        description: "Reviews both sides and writes a verdict.",    modelHint: "claude-opus-4.6 or qwen2.5:14b" },
      { name: "Findings Log",  role: AgentRole.Memory,        description: "Stores the verdict.",                        modelHint: "—" },
      { name: "Final Check",   role: AgentRole.Aggregator,    description: "Combines analysis and verdict.",             modelHint: "claude-sonnet-4.6 or qwen2.5:7b" },
    ],
    recommendedEdges: [
      { from: 0, to: 1, label: "scope" },
      { from: 0, to: 2, label: "scope" },
      { from: 1, to: 3, label: "pros" },
      { from: 2, to: 3, label: "cons" },
      { from: 3, to: 4, kind: "memory" },
      { from: 0, to: 5 },
      { from: 1, to: 5 },
      { from: 2, to: 5 },
      { from: 4, to: 5, kind: "memory" },
    ],
    recommendedProviders: ["local", "anthropic", "openai"],
    modelCapabilities: ["general", "reasoning"],
    setupRequirements: ["Any provider — local Ollama is sufficient"],
    expectedArtifacts: ["pros.md", "cons.md", "verdict.md", "final-analysis.md"],
    verificationMethod: "The final analysis should reference at least 2 points from each analyst.",
    difficulty: "beginner",
    localFriendly: true,
    privacyNotes: "Topic is sent to the provider if cloud is used.",
    safetyWarnings: [],
  },

  {
    id: "logistics-routing-assistant",
    title: "Logistics Routing Assistant",
    description: "Turns delivery constraints into route options, risk checks, and a dispatch-ready recommendation.",
    triggers: ["logistics", "routing", "route", "delivery", "fleet", "dispatch", "warehouse", "shipment", "transport"],
    userGoalExamples: [
      "Plan delivery routes for my fleet",
      "Compare logistics routes",
      "Optimize shipment dispatch",
    ],
    recommendedAgents: [
      { name: "Dispatch Planner", role: AgentRole.Orchestrator, description: "Normalizes stops, vehicles, deadlines, and constraints.", modelHint: "claude-sonnet-4.6 or qwen2.5:14b" },
      { name: "Route Analyst", role: AgentRole.Worker, description: "Drafts candidate routes and highlights distance/time tradeoffs.", modelHint: "qwen2.5-coder:7b or gpt-4o" },
      { name: "Constraint Checker", role: AgentRole.Critic, description: "Checks capacity, delivery windows, restricted roads, and missing data.", modelHint: "claude-sonnet-4.6 or qwen2.5:14b" },
      { name: "Risk Monitor", role: AgentRole.Worker, description: "Flags weather, traffic, customs, and delay risks for each option.", modelHint: "claude-haiku-4.5 or qwen2.5:7b" },
      { name: "Dispatch Summary", role: AgentRole.Aggregator, description: "Creates the final route recommendation and verification checklist.", modelHint: "claude-sonnet-4.6 or qwen2.5:14b" },
    ],
    recommendedEdges: [
      { from: 0, to: 1, label: "normalized constraints" },
      { from: 0, to: 2, label: "constraints" },
      { from: 1, to: 2, label: "candidate routes" },
      { from: 1, to: 3, label: "route options" },
      { from: 2, to: 4, label: "constraint issues" },
      { from: 3, to: 4, label: "risk notes" },
    ],
    recommendedProviders: ["local", "anthropic", "openai"],
    modelCapabilities: ["reasoning", "math", "long-context"],
    setupRequirements: [
      "Provide stops, vehicle capacities, time windows, and any fixed constraints.",
      "Use a real routing engine or map data for production distances; this template is a planning assistant.",
    ],
    expectedArtifacts: ["route-options.json", "constraint-check.md", "dispatch-summary.md"],
    verificationMethod: "Compare the final route list against known stop count, capacity limits, and delivery windows. No stop should be missing.",
    difficulty: "intermediate",
    localFriendly: true,
    privacyNotes: "Routes may reveal customers, facilities, and schedules. Use local Ollama for private logistics data.",
    safetyWarnings: ["Do not use LLM-only route distances for live dispatch. Verify with mapping/routing software."],
  },

  {
    id: "finance-expense-analysis",
    title: "Finance Expense Analysis",
    description: "Analyzes expenses, categorizes spend, flags anomalies, and prepares a review summary.",
    triggers: ["finance", "expense", "expenses", "spend", "budget", "invoice", "receipt", "accounting", "csv"],
    userGoalExamples: [
      "Analyze my expense CSV",
      "Find unusual spend",
      "Categorize invoices",
    ],
    recommendedAgents: [
      { name: "Data Intake", role: AgentRole.Orchestrator, description: "Defines expected columns, date range, and review goals.", modelHint: "claude-haiku-4.5 or qwen2.5:7b" },
      { name: "Categorizer", role: AgentRole.Worker, description: "Maps transactions into categories and vendors.", modelHint: "qwen2.5-coder:7b or gpt-4o-mini" },
      { name: "Anomaly Analyst", role: AgentRole.Worker, description: "Finds outliers, duplicates, and unexpected vendors.", modelHint: "claude-sonnet-4.6 or qwen2.5-coder:14b" },
      { name: "Policy Reviewer", role: AgentRole.Critic, description: "Checks spending against provided policy rules.", modelHint: "claude-sonnet-4.6 or qwen2.5:14b" },
      { name: "Finance Report", role: AgentRole.Aggregator, description: "Summarizes totals, risks, and recommended follow-up actions.", modelHint: "claude-haiku-4.5 or qwen2.5:7b" },
    ],
    recommendedEdges: [
      { from: 0, to: 1, label: "schema" },
      { from: 1, to: 2, label: "categorized spend" },
      { from: 1, to: 3, label: "categories" },
      { from: 2, to: 4, label: "anomalies" },
      { from: 3, to: 4, label: "policy findings" },
    ],
    recommendedProviders: ["local", "openai", "anthropic"],
    modelCapabilities: ["math", "reasoning", "long-context"],
    setupRequirements: [
      "Provide a sanitized CSV or table with date, vendor, amount, and description.",
      "Provide expense policy text if policy review is required.",
    ],
    expectedArtifacts: ["expense-categories.csv", "anomalies.md", "finance-summary.md"],
    verificationMethod: "Check that totals match the source CSV and every anomaly cites the source row or transaction id.",
    difficulty: "beginner",
    localFriendly: true,
    privacyNotes: "Expense data can include personal or company financial details. Prefer local Ollama unless cloud processing is approved.",
    safetyWarnings: ["Do not treat this as accounting advice. Verify calculations in a spreadsheet or finance system."],
  },

  {
    id: "matlab-parameter-sweep",
    title: "MATLAB Parameter Sweep Assistant",
    description: "Plans a MATLAB experiment sweep, expected outputs, verification checks, and safe execution boundaries.",
    triggers: ["matlab", "parameter", "sweep", "simulation", "simulink", "experiment", "monte carlo", "plot"],
    userGoalExamples: [
      "Plan a MATLAB parameter sweep",
      "Design simulation runs and plots",
      "Organize my MATLAB experiment",
    ],
    recommendedAgents: [
      { name: "Experiment Planner", role: AgentRole.Orchestrator, description: "Defines parameters, ranges, metrics, and stopping criteria.", modelHint: "claude-sonnet-4.6 or qwen2.5-coder:14b" },
      { name: "Script Designer", role: AgentRole.Worker, description: "Drafts MATLAB pseudocode and function boundaries without executing MATLAB.", modelHint: "qwen2.5-coder:14b or claude-sonnet-4.6" },
      { name: "Result Schema Designer", role: AgentRole.Worker, description: "Defines result table columns, filenames, and plot outputs.", modelHint: "qwen2.5-coder:7b or claude-haiku-4.5" },
      { name: "Verification Critic", role: AgentRole.Critic, description: "Checks reproducibility, random seeds, units, and runtime risks.", modelHint: "claude-sonnet-4.6 or qwen2.5:14b" },
      { name: "Runbook", role: AgentRole.Aggregator, description: "Creates a step-by-step MATLAB runbook and post-run validation checklist.", modelHint: "claude-haiku-4.5 or qwen2.5:7b" },
    ],
    recommendedEdges: [
      { from: 0, to: 1, label: "sweep plan" },
      { from: 0, to: 2, label: "metrics" },
      { from: 1, to: 3, label: "script draft" },
      { from: 2, to: 3, label: "result schema" },
      { from: 3, to: 4, label: "verification notes" },
      { from: 1, to: 4, label: "script outline" },
    ],
    recommendedProviders: ["local", "anthropic", "openai"],
    modelCapabilities: ["coding", "math", "reasoning"],
    setupRequirements: [
      "Provide MATLAB function names, parameter ranges, expected metrics, and runtime limits.",
      "MATLAB execution is not performed by Harness Studio in this template.",
    ],
    expectedArtifacts: ["sweep-plan.md", "matlab-pseudocode.m", "result-schema.md", "runbook.md"],
    verificationMethod: "Review that every parameter has units, min/max/step, output metric, and a post-run plot or assertion.",
    difficulty: "intermediate",
    localFriendly: true,
    privacyNotes: "Simulation code and parameters may be proprietary. Use local Ollama for private projects.",
    safetyWarnings: ["This template plans MATLAB work only. Do not claim MATLAB execution unless run separately in MATLAB."],
  },
];

// ── Matcher ──────────────────────────────────────────────────────────────────

export interface MatchResult {
  template: GoalTemplate;
  score: number;
  matchedTriggers: string[];
}

/**
 * Match a user's free-text goal against the template catalog.
 * Returns up to `topN` templates ranked by trigger keyword overlap.
 * If no template matches, returns the most generic templates first.
 */
export function matchGoal(input: string, topN = 3): MatchResult[] {
  const text = input.toLowerCase();
  const results: MatchResult[] = GOAL_TEMPLATES.map((template) => {
    const matched = template.triggers.filter((t) => text.includes(t));
    return { template, score: matched.length, matchedTriggers: matched };
  });

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break: prefer beginner difficulty
    const dRank: Record<Difficulty, number> = { beginner: 0, intermediate: 1, advanced: 2 };
    return dRank[a.template.difficulty] - dRank[b.template.difficulty];
  });

  // If nothing matched, surface beginner-friendly templates
  if (results[0].score === 0) {
    const fallbacks = GOAL_TEMPLATES.filter((t) => t.difficulty === "beginner");
    return fallbacks.slice(0, topN).map((template) => ({ template, score: 0, matchedTriggers: [] }));
  }

  return results.slice(0, topN);
}

// ── Provider availability matcher ────────────────────────────────────────────

export interface ProviderAvailability {
  hasOpenAIKey: boolean;
  hasAnthropicKey: boolean;
  ollamaReady: boolean;
  hasOllamaCloudKey: boolean;
  hasCustomEndpoint: boolean;
}

export interface ProviderRecommendation {
  category: ProviderCategory;
  ready: boolean;
  reason: string;
  setupSteps: string[];
}

/**
 * Given a template's recommended provider list and what the user has configured,
 * return a ranked recommendation with concrete setup steps.
 */
export function recommendProvider(
  template: GoalTemplate,
  avail: ProviderAvailability,
): ProviderRecommendation {
  // Walk preferences in order; pick the first that's ready, else first that's recommended.
  for (const cat of template.recommendedProviders) {
    if (cat === "local" && avail.ollamaReady) {
      return {
        category: "local",
        ready: true,
        reason: "Ollama is running locally — free, private, no key required.",
        setupSteps: ["Ollama already detected on localhost:11434. Just click Run."],
      };
    }
    if (cat === "anthropic" && avail.hasAnthropicKey) {
      return {
        category: "anthropic",
        ready: true,
        reason: "Anthropic key configured — best for reasoning and writing quality.",
        setupSteps: ["Anthropic key already set. Click Run."],
      };
    }
    if (cat === "openai" && avail.hasOpenAIKey) {
      return {
        category: "openai",
        ready: true,
        reason: "OpenAI key configured — balanced quality and speed.",
        setupSteps: ["OpenAI key already set. Click Run."],
      };
    }
    if (cat === "ollama-cloud" && avail.hasOllamaCloudKey) {
      return {
        category: "ollama-cloud",
        ready: true,
        reason: "Ollama Cloud key configured — strong open-weight models without local hardware.",
        setupSteps: ["Ollama Cloud key already set. Click Run."],
      };
    }
    if (cat === "openai-compatible" && avail.hasCustomEndpoint) {
      return {
        category: "openai-compatible",
        ready: true,
        reason: "Custom OpenAI-compatible endpoint configured.",
        setupSteps: ["Custom endpoint already set. Click Run."],
      };
    }
  }

  // Nothing is ready. Prefer local setup for local-friendly templates, even
  // when a cloud provider is the quality preference, so the first path remains
  // private and does not imply a hidden cloud requirement.
  const firstPreference = template.localFriendly && template.recommendedProviders.includes("local")
    ? "local"
    : template.recommendedProviders[0];
  if (firstPreference === "local") {
    return {
      category: "local",
      ready: false,
      reason: "Recommended: Ollama (free, private, no API key required).",
      setupSteps: [
        "Install Ollama from ollama.com",
        "In a terminal, run: ollama pull qwen2.5-coder:7b",
        "Make sure Ollama is running (ollama serve)",
        "In Harness Studio Settings, click ▶ Test to verify",
      ],
    };
  }
  if (firstPreference === "anthropic") {
    return {
      category: "anthropic",
      ready: false,
      reason: "Recommended: Anthropic Claude (best quality for this workflow).",
      setupSteps: [
        "Go to console.anthropic.com and sign up",
        "Create an API key (Settings → API Keys)",
        "In Harness Studio ⚙ Settings, paste the key in 'Anthropic API Key'",
        "Click Save, then Provider Mode → Anthropic",
      ],
    };
  }
  if (firstPreference === "openai") {
    return {
      category: "openai",
      ready: false,
      reason: "Recommended: OpenAI (broad capability, good fallback).",
      setupSteps: [
        "Go to platform.openai.com and sign up",
        "Create an API key (Settings → API Keys)",
        "In Harness Studio ⚙ Settings, paste the key in 'OpenAI API Key'",
        "Click Save, then Provider Mode → OpenAI",
      ],
    };
  }
  return {
    category: firstPreference,
    ready: false,
    reason: "No provider is configured yet.",
    setupSteps: ["Open Settings and configure at least one provider."],
  };
}
