import { AgentRole } from "@/types/agent";
import type { AgentNodeData } from "@/types/agent";
import type { NodeTypes } from "@xyflow/react";

// Populated by the WorkflowCanvas after all node components are defined
export let agentNodeTypes: NodeTypes = {};

export function setNodeTypes(types: NodeTypes) {
  agentNodeTypes = types;
}

export function makeDefaultData(role: AgentRole): AgentNodeData {
  return {
    name: role.charAt(0).toUpperCase() + role.slice(1).replace("_", " "),
    role,
    model: "claude-sonnet-4.6",
    temperature: 0.7,
    maxTokens: 4096,
    maxSteps: 20,
    timeoutSeconds: 300,
    promptSource: { type: "inline", content: "" },
    tools: [],
    memoryRead: [],
    memoryWrite: [],
    tokens: { used: 0, budget: 32000 },
    status: "idle",
  };
}

export const AVAILABLE_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-haiku-4-5",
  "gpt-4o",
  "gpt-4o-mini",
  "gemini-2.0-flash",
  "custom",
];

export const ALL_ROLES = Object.values(AgentRole);
