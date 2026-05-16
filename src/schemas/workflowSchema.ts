import { z } from "zod";
import { agentNodeDataSchema } from "./agentSchema";

const workflowConnectionSchema = z.object({
  id:            z.string().min(1),
  sourceAgentId: z.string().min(1),
  targetAgentId: z.string().min(1),
  label:         z.string().optional(),
  edgeKind:      z.enum(["dataflow","memory","feedback","control"]).optional(),
});

const executionSettingsSchema = z.object({
  maxParallel:    z.number().int().min(1).max(32),
  timeoutSeconds: z.number().int().min(1).max(3600),
  retryOnFailure: z.boolean(),
  maxRetries:     z.number().int().min(0).max(10),
});

const workflowMetaSchema = z.object({
  name:        z.string().min(1, "Workflow name is required").max(128),
  version:     z.string().regex(/^\d+\.\d+\.\d+$/, "Must be semver e.g. 1.0.0"),
  description: z.string().max(512),
  projectRoot: z.string(),
  createdAt:   z.string(),
  updatedAt:   z.string(),
});

export const workflowDefSchema = z.object({
  meta:              workflowMetaSchema,
  agents:            z.array(agentNodeDataSchema),
  connections:       z.array(workflowConnectionSchema),
  executionSettings: executionSettingsSchema,
  nodePositions:     z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
});

export type WorkflowDefInput  = z.input<typeof workflowDefSchema>;
export type WorkflowDefOutput = z.output<typeof workflowDefSchema>;
