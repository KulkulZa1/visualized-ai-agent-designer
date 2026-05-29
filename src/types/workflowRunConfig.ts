import type { LlmProvider } from "@/utils/providerConfig";

/**
 * User-supplied configuration collected in the WorkflowInputDialog before
 * a workflow run starts. Passed into `executeWorkflow(config)`.
 */
export interface WorkflowRunConfig {
  /** Free-text prompt sent to entry-point nodes as the user turn. */
  userInput: string;
  /** Workspace-relative paths to read and prepend as context for entry nodes. */
  contextFilePaths: string[];
  /** Override think-depth for all o-series / GPT-5.5 nodes. null = use node setting. */
  thinkDepthOverride: "none" | "low" | "medium" | "high" | null;
  /** Override the active provider for this run only. null = use Settings. */
  providerOverride: LlmProvider | null;
}

export const DEFAULT_RUN_CONFIG: WorkflowRunConfig = {
  userInput: "",
  contextFilePaths: [],
  thinkDepthOverride: null,
  providerOverride: null,
};
