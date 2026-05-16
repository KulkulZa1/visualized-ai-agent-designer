import { useExecutionStore } from "@/store/executionStore";
import type { AgentRun } from "@/types/execution";

export function useNodeExecutionData(nodeId: string | null): AgentRun | null {
  const currentRun = useExecutionStore((s) => s.currentRun);
  if (!nodeId || !currentRun) return null;
  return currentRun.agents[nodeId] ?? null;
}
