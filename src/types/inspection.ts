import type { ToolPermission } from "./agent";

export type ArtifactType =
  | "markdown"
  | "code"
  | "json"
  | "yaml"
  | "html"
  | "image"
  | "diagram"
  | "log"
  | "prompt"
  | "report";

export type ArtifactPreviewMode = "rendered" | "code" | "raw" | "image" | "log";
export type ArtifactStatus = "mock" | "draft" | "persisted" | "live" | "error";

export interface Artifact {
  id: string;
  title: string;
  type: ArtifactType;
  sourceNodeId: string;
  content: string;
  previewMode: ArtifactPreviewMode;
  createdAt: string;
  updatedAt: string;
  version: number;
  filePath?: string;
  status: ArtifactStatus;
}

export interface PromptInspection {
  staticPrompt: string;
  systemPrompt: string;
  developerNotes: string;
  userPrompt: string;
}

export interface UpstreamOutput {
  nodeId: string;
  nodeName: string;
  output: string;
}

export interface ExecutionContextSnapshot {
  nodeId: string;
  nodeName: string;
  status: string;
  providerId: string;
  model: string;
  prompt: PromptInspection;
  finalContext: {
    previewLabel: string;
    content: string;
    tokenEstimate?: number;
    warnings: string[];
  };
  inputs: {
    upstreamOutputs: UpstreamOutput[];
    userInput: string;
    toolResults: string[];
  };
  tools: {
    allowedTools: ToolPermission[];
  };
  files: {
    selectedFiles: string[];
  };
  outputStream: {
    isStreaming: boolean;
    content: string;
  };
  artifacts: Artifact[];
  debugInfo: {
    providerId: string;
    model: string;
    localOnly: boolean;
    notes: string[];
  };
}
