import type { Edge } from "@xyflow/react";
import type { AgentNode } from "@/types/workflow";
import type { AgentRun } from "@/types/execution";
import type { Artifact, ExecutionContextSnapshot, UpstreamOutput } from "@/types/inspection";
import { getProviderById } from "@/services/model-providers/providerCatalog";
import { inferProvider } from "@/utils/modelRegistry";

export interface BuildContextSnapshotInput {
  node: AgentNode;
  nodes: AgentNode[];
  edges: Edge[];
  agentRun?: AgentRun | null;
  artifacts: Artifact[];
}

function promptContent(node: AgentNode): string {
  const source = node.data.promptSource;
  return source.type === "inline"
    ? source.content
    : `[Prompt file: ${source.path}]`;
}

function upstreamOutputs({
  node,
  nodes,
  edges,
}: Pick<BuildContextSnapshotInput, "node" | "nodes" | "edges">): UpstreamOutput[] {
  return edges
    .filter((edge) => edge.target === node.id)
    .map((edge) => {
      const source = nodes.find((candidate) => candidate.id === edge.source);
      return {
        nodeId: edge.source,
        nodeName: source?.data.name ?? edge.source,
        output: source
          ? `[preview] Output from ${source.data.name} will appear here after execution tracing is persisted.`
          : "[preview] Upstream node output unavailable.",
      };
    });
}

function providerIdForModel(model: string): string {
  const inferred = inferProvider(model);
  if (inferred === "openrouter") return "openai-compatible";
  if (inferred === "custom") return "openai-compatible";
  return inferred;
}

export function buildContextSnapshot({
  node,
  nodes,
  edges,
  agentRun,
  artifacts,
}: BuildContextSnapshotInput): ExecutionContextSnapshot {
  const staticPrompt = promptContent(node);
  const providerId = providerIdForModel(node.data.model);
  const provider = getProviderById(providerId);
  const upstream = upstreamOutputs({ node, nodes, edges });
  const output = agentRun?.output ?? "";
  const warnings = [
    "Preview scaffold only: final request capture and persisted trace storage are not implemented yet.",
  ];

  const finalContext = [
    `System: You are ${node.data.name}, a ${node.data.role} agent.`,
    node.data.description ? `Developer notes: ${node.data.description}` : "Developer notes: none",
    staticPrompt ? `Static prompt: ${staticPrompt}` : "Static prompt: none",
    upstream.length
      ? `Upstream outputs: ${upstream.map((item) => item.nodeName).join(", ")}`
      : "Upstream outputs: none",
    `Allowed tools: ${node.data.tools.join(", ") || "none"}`,
  ].join("\n\n");

  return {
    nodeId: node.id,
    nodeName: node.data.name,
    status: agentRun?.status ?? node.data.status,
    providerId,
    model: node.data.model,
    prompt: {
      staticPrompt,
      systemPrompt: `You are ${node.data.name}, a ${node.data.role} agent.`,
      developerNotes: node.data.description ?? "",
      userPrompt: "[preview] Runtime user prompt will be captured by the execution engine.",
    },
    finalContext: {
      previewLabel: "Preview final context - not a persisted live model payload",
      content: finalContext,
      tokenEstimate: Math.ceil(finalContext.length / 4),
      warnings,
    },
    inputs: {
      upstreamOutputs: upstream,
      userInput: "[preview] Workflow run input is not persisted in this slice.",
      toolResults: [],
    },
    tools: {
      allowedTools: node.data.tools,
    },
    files: {
      selectedFiles: node.data.promptSource.type === "file" ? [node.data.promptSource.path] : [],
    },
    outputStream: {
      isStreaming: agentRun?.status === "running",
      content: output || "[preview] Streaming output will appear here during a future live trace.",
    },
    artifacts: artifacts.filter((artifact) => artifact.sourceNodeId === node.id),
    debugInfo: {
      providerId,
      model: node.data.model,
      localOnly: provider?.isLocal ?? false,
      notes: [
        provider?.notes ?? "Provider inferred from current node model.",
        "Context inspector is read-only in this slice.",
      ],
    },
  };
}
