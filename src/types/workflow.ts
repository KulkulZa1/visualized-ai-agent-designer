import type { AgentNodeData } from "./agent";
import type { Node, Edge } from "@xyflow/react";

export type AgentNode = Node<AgentNodeData, "agent">;

export interface WorkflowConnection {
  id: string;
  sourceAgentId: string;
  targetAgentId: string;
  label?: string;
  edgeKind?: "dataflow" | "memory" | "feedback" | "control";
}

export interface ExecutionSettings {
  maxParallel: number;
  timeoutSeconds: number;
  retryOnFailure: boolean;
  maxRetries: number;
}

export interface WorkflowMeta {
  name: string;
  version: string;
  description: string;
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDef {
  meta: WorkflowMeta;
  agents: AgentNodeData[];
  connections: WorkflowConnection[];
  executionSettings: ExecutionSettings;
  nodePositions: Record<string, { x: number; y: number }>;
}

export interface WorkflowState {
  nodes: AgentNode[];
  edges: Edge[];
  meta: WorkflowMeta;
  executionSettings: ExecutionSettings;
  isDirty: boolean;
  filePath: string | null;
}

/** Validation result for a workflow graph. */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  nodeId?: string;
  message: string;
  kind: "cycle" | "disconnected" | "missing_prompt" | "no_model";
}

export interface ValidationWarning {
  nodeId?: string;
  message: string;
  kind: "high_token_budget" | "many_tools" | "no_hooks_on_bash";
}
