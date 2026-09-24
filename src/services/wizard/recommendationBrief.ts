import type { GoalTemplate, MatchResult, ProviderRecommendation } from "./goalTemplates";

export type RecommendationConfidence = "strong" | "moderate" | "fallback";

export interface RecommendationBrief {
  templateId: string;
  title: string;
  confidence: RecommendationConfidence;
  headline: string;
  why: string[];
  workflowShape: string;
  provider: {
    category: ProviderRecommendation["category"];
    ready: boolean;
    reason: string;
    setupSteps: string[];
  };
  evidenceArtifacts: string[];
  verification: string;
  privacy: string;
  safetyWarnings: string[];
  nextSteps: string[];
}

function confidenceForScore(score: number): RecommendationConfidence {
  if (score >= 2) return "strong";
  if (score === 1) return "moderate";
  return "fallback";
}

function edgeSummary(template: GoalTemplate): string {
  const feedback = template.recommendedEdges.filter((edge) => edge.kind === "feedback").length;
  const memory = template.recommendedEdges.filter((edge) => edge.kind === "memory").length;
  const control = template.recommendedEdges.filter((edge) => edge.kind === "control").length;
  const parts = [
    `${template.recommendedAgents.length} agents`,
    `${template.recommendedEdges.length} edges`,
  ];
  if (feedback > 0) parts.push(`${feedback} feedback loop${feedback === 1 ? "" : "s"}`);
  if (memory > 0) parts.push(`${memory} memory edge${memory === 1 ? "" : "s"}`);
  if (control > 0) parts.push(`${control} control edge${control === 1 ? "" : "s"}`);
  return parts.join(", ");
}

function matchedReason(match: MatchResult): string {
  if (match.matchedTriggers.length > 0) {
    return `Matched goal keywords: ${match.matchedTriggers.join(", ")}.`;
  }
  return "No exact keyword matched; this is a beginner-friendly fallback template.";
}

function buildNextSteps(template: GoalTemplate, provider: ProviderRecommendation): string[] {
  if (provider.ready) {
    return [
      "Load the workflow onto the canvas.",
      "Review each agent prompt and model before running.",
      `After the run, verify: ${template.verificationMethod}`,
    ];
  }

  return [
    ...provider.setupSteps.slice(0, 3),
    "Return to this wizard and load the workflow after setup is complete.",
  ];
}

export function buildRecommendationBrief(
  match: MatchResult,
  provider: ProviderRecommendation,
): RecommendationBrief {
  const template = match.template;
  const confidence = confidenceForScore(match.score);
  const workflowShape = edgeSummary(template);
  const capabilities = template.modelCapabilities.join(", ");

  const why = [
    matchedReason(match),
    `Workflow shape: ${workflowShape}.`,
    `Model capability needs: ${capabilities}.`,
    provider.ready
      ? `Provider is ready: ${provider.reason}`
      : `Provider setup required: ${provider.reason}`,
  ];

  if (template.localFriendly) {
    why.push("Local-first path is available with Ollama; no cloud call is required if local setup is ready.");
  }

  return {
    templateId: template.id,
    title: template.title,
    confidence,
    headline: `${template.title} is a ${confidence} recommendation for this goal.`,
    why,
    workflowShape,
    provider: {
      category: provider.category,
      ready: provider.ready,
      reason: provider.reason,
      setupSteps: provider.setupSteps,
    },
    evidenceArtifacts: template.expectedArtifacts,
    verification: template.verificationMethod,
    privacy: template.privacyNotes,
    safetyWarnings: template.safetyWarnings,
    nextSteps: buildNextSteps(template, provider),
  };
}
