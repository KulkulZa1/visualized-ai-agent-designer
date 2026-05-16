import { z } from "zod";
import { AgentRole, ToolPermission } from "@/types/agent";

const promptSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inline"), content: z.string() }),
  z.object({ type: z.literal("file"), path: z.string().min(1) }),
]);

const hookConfigSchema = z.object({
  path: z.string().min(1, "Hook path cannot be empty"),
  requireConsent: z.boolean(),
  env: z.record(z.string(), z.string()).optional(),
});

const tokenBudgetSchema = z.object({
  used:   z.number().int().min(0),
  budget: z.number().int().min(0),
});

const fallbackPolicySchema = z.object({
  model:       z.string().min(1),
  trigger:     z.enum(["rate_limit", "error", "timeout", "any"]),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

export const agentNodeDataSchema = z.object({
  name:           z.string().min(1, "Agent name is required").max(64),
  role:           z.nativeEnum(AgentRole),
  model:          z.string(),
  fallback:       fallbackPolicySchema.optional(),
  temperature:    z.number().min(0).max(2),
  maxTokens:      z.number().int().min(0).max(200000),
  maxSteps:       z.number().int().min(1).max(1000),
  timeoutSeconds: z.number().int().min(1).max(86400),
  promptSource:   promptSourceSchema,
  tools:          z.array(z.nativeEnum(ToolPermission)),
  preHook:        hookConfigSchema.optional(),
  postHook:       hookConfigSchema.optional(),
  memoryRead:     z.array(z.string()),
  memoryWrite:    z.array(z.string()),
  tokens:         tokenBudgetSchema,
  status:         z.enum(["idle","running","waiting","done","error"]),
  condition:      z.string().optional(),
  description:    z.string().optional(),
  thinkDepth:     z.enum(["none", "low", "medium", "high"]).optional(),
});

export type AgentNodeDataInput  = z.input<typeof agentNodeDataSchema>;
export type AgentNodeDataOutput = z.output<typeof agentNodeDataSchema>;
