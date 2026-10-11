/**
 * usage — adds up the tokens a node's model calls used, as the providers reported them (AgentRun.usage).
 *
 * The engine counts a call where it is made (runWorkflow.ts: the node's turns and text calls; helpers and the
 * summaries that compact a conversation go through the same two functions), not where the agent loop ends, so
 * a call whose loop then fails or is cut off is in the total too.
 */
import { isTokenCount, readProviderUsage, type ProviderUsage } from "@/services/model-providers/providerAdapter";
import type { NodeUsage } from "@/types/execution";

/** What a node that has made no model call has used. */
export const noUsage = (): NodeUsage => ({ input: 0, output: 0, calls: 0, callsWithoutUsage: 0 });

/** `value` as a node's usage when it is four token counts; otherwise undefined. For a run record read from disk:
 *  it may be from before usage was kept, or edited. */
export function readNodeUsage(value: unknown): NodeUsage | undefined {
  const counts = readProviderUsage(value);
  if (!counts) return undefined;
  const { calls, callsWithoutUsage } = value as Record<string, unknown>;
  return isTokenCount(calls) && isTokenCount(callsWithoutUsage) ? { ...counts, calls, callsWithoutUsage } : undefined;
}

/** The running total of one node. `start` is what the node's earlier attempts used: a revision runs the node
 *  again, and the tokens of its first attempt were spent all the same. */
export function createUsageMeter(start?: NodeUsage) {
  const total = start ? { ...start } : noUsage();
  return {
    /** A model call has been answered. `usage` is what its reply carried: a reply with no counts (null, left
     *  out, or not a pair of token counts) is still a call, and is told apart from the ones that had them. A
     *  call that failed has no reply and is not counted. */
    count(usage: ProviderUsage | null | undefined): void {
      const counts = readProviderUsage(usage);
      total.calls++;
      if (counts) {
        total.input += counts.input;
        total.output += counts.output;
      } else {
        total.callsWithoutUsage++;
      }
    },
    totals: (): NodeUsage => ({ ...total }),
  };
}
