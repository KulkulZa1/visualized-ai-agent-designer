/**
 * parallelScheduler — dependency-respecting async agent execution scheduler.
 *
 * Replaces the sequential `for (const nodeId of order)` loop in
 * useWorkflowExecution.ts with a concurrent scheduler that:
 *   1. Runs independent nodes in parallel (up to maxParallel)
 *   2. Only starts a node after ALL its forward-edge predecessors complete
 *   3. Handles gateway skip logic at scheduling time
 *   4. Supports cancellation at every scheduling decision point
 *
 * JavaScript concurrency note:
 *   V8 is single-threaded. Map reads/writes are synchronous and atomic.
 *   A node starting only after its predecessors complete guarantees their
 *   agentOutputs.set() and memory.writeAll() are visible — no stale reads.
 *
 * Feedback edges (edgeKind === "feedback") are SKIPPED for dependency
 * calculations — they represent revision loops, not data prerequisites.
 */

import type { AgentNode } from "@/types/workflow";
import type { Edge } from "@xyflow/react";
import { AgentRole } from "@/types/agent";

// ── Types ────────────────────────────────────────────────────────────────────

type EdgeData = { label?: string; edgeKind?: string };

export interface SchedulerOptions {
  /** Maximum number of nodes running concurrently. Must be ≥ 1. */
  maxParallel: number;
  /** Return true when the run has been cancelled by the user. */
  isCancelled: () => boolean;
  /** Called after a gateway decides to skip a branch. */
  onSkipped: (nodeId: string) => void;
  /** Map populated by gateway nodes — read after each gateway completes. */
  gatewayRoutes: Map<string, string>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isForwardEdge(e: Edge): boolean {
  const kind = (e.data as EdgeData | undefined)?.edgeKind;
  return kind !== "feedback" && e.type !== "feedback";
}

function edgeLabel(e: Edge): string {
  const dataLabel = (e.data as EdgeData | undefined)?.label;
  const label = dataLabel ?? (typeof e.label === "string" ? e.label : "");
  return label.toLowerCase().trim();
}

/**
 * For a completed gateway node `gwId`, return the direct successors whose edge
 * from the gateway is NOT taken for the chosen route.
 *
 * An edge is not taken when:
 * - Its source is a gateway that has set a route
 * - The edge has a non-empty label
 * - The label does not contain (or is not contained by) the chosen route
 *
 * If the route matches none of the labels (e.g. "mixed", or an unparseable
 * reply), every branch is followed — the same as when no route was produced.
 */
function computeSkipped(
  gwId: string,
  nodes: AgentNode[],
  edges: Edge[],
  gatewayRoutes: Map<string, string>,
): Set<string> {
  const skipped = new Set<string>();
  const gwNode = nodes.find((n) => n.id === gwId);
  if (!gwNode || gwNode.data.role !== AgentRole.Gateway) return skipped;

  const route = gatewayRoutes.get(gwId);
  if (!route) return skipped; // gateway ran but produced no routing decision → skip nothing

  const taken = new Set<string>();
  const notTaken = new Set<string>();
  for (const e of edges) {
    if (e.source !== gwId || !isForwardEdge(e)) continue;
    const label = edgeLabel(e);
    if (!label) continue; // unlabelled outgoing edge → always follow
    if (label.includes(route) || route.includes(label)) taken.add(e.target);
    else notTaken.add(e.target);
  }
  if (taken.size === 0) return skipped; // route matched no branch → follow all

  for (const target of notTaken) {
    if (!taken.has(target)) skipped.add(target);
  }
  return skipped;
}

// ── Main scheduler ────────────────────────────────────────────────────────────

/**
 * Run all nodes with dependency-aware parallel scheduling.
 *
 * @param nodes        The workflow's agent nodes (used for gateway detection).
 * @param edges        All edges (used to build dependency graph).
 * @param processNode  Async callback for each node. Called once per node.
 * @param options      Scheduling options (maxParallel, cancellation, …).
 * @returns            Resolves when all nodes are done/skipped/cancelled.
 */
export function runParallel(
  nodes: AgentNode[],
  edges: Edge[],
  processNode: (nodeId: string) => Promise<void>,
  options: SchedulerOptions,
): Promise<void> {
  const { maxParallel, isCancelled, onSkipped, gatewayRoutes } = options;
  const limit = Math.max(1, maxParallel);

  // ── Build dependency graph from forward edges only ──────────────────────
  const inDegree  = new Map<string, number>();
  const successors = new Map<string, string[]>(); // nodeId → direct successors
  const predecessors = new Map<string, string[]>(); // nodeId → direct predecessors

  for (const n of nodes) {
    inDegree.set(n.id, 0);
    successors.set(n.id, []);
    predecessors.set(n.id, []);
  }
  for (const e of edges) {
    if (!isForwardEdge(e)) continue;
    if (!inDegree.has(e.target) || !inDegree.has(e.source)) continue;
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    successors.get(e.source)!.push(e.target);
    predecessors.get(e.target)!.push(e.source);
  }

  // ── Initial ready set: all nodes with no forward dependencies ───────────
  const ready: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) ready.push(id);
  }

  const running  = new Set<string>();
  const done     = new Set<string>(); // includes skipped nodes
  const skipped  = new Set<string>();
  // Gateway edges not taken for the chosen route ("source->target").
  const deadEdges = new Set<string>();
  let   rejected = false;
  // First node error. The run stops scheduling immediately but only settles once
  // in-flight nodes have finished, so callers never see a failed run as over
  // while its nodes are still writing results.
  let   failure: { error: unknown } | null = null;

  return new Promise<void>((resolve, reject) => {
    function finish(err?: unknown) {
      if (rejected) return;
      rejected = true;
      err ? reject(err) : resolve();
    }

    function remainingIds(): string[] {
      return nodes
        .map((node) => node.id)
        .filter((id) => !done.has(id) && !running.has(id));
    }

    /** True when every forward input of `nodeId` comes from a skipped node or a
     *  gateway edge that was not taken — the node is branch-only and must skip. */
    function allInputsDead(nodeId: string): boolean {
      const preds = predecessors.get(nodeId) ?? [];
      return preds.length > 0 &&
        preds.every((pred) => skipped.has(pred) || deadEdges.has(`${pred}->${nodeId}`));
    }

    function markSkipped(nodeId: string) {
      if (done.has(nodeId)) return;
      skipped.add(nodeId);
      done.add(nodeId);
      onSkipped(nodeId);

      // Unblock successors of the skipped node as if it completed normally.
      // If every forward input of a successor is dead, the successor is
      // branch-only and should be skipped too. If at least one input is live,
      // the successor is a join/aggregator and can still run after its
      // remaining required predecessors complete.
      for (const succ of successors.get(nodeId) ?? []) {
        if (allInputsDead(succ)) {
          markSkipped(succ);
          continue;
        }
        const deg = (inDegree.get(succ) ?? 1) - 1;
        inDegree.set(succ, deg);
        if (deg <= 0 && !done.has(succ) && !running.has(succ)) {
          ready.push(succ);
        }
      }
    }

    function schedule() {
      // Once a node has failed (or the run settled), nothing new may start.
      if (rejected || failure) return;

      // Drain: launch as many ready nodes as the limit allows
      while (running.size < limit && ready.length > 0 && !isCancelled()) {
        const nodeId = ready.shift()!;
        if (done.has(nodeId)) { schedule(); return; }

        running.add(nodeId);

        processNode(nodeId)
          .then(() => {
            running.delete(nodeId);
            done.add(nodeId);
            if (failure) {
              if (running.size === 0) finish(failure.error);
              return;
            }

            // If this was a gateway, its edges that don't match the route are dead
            const gw = nodes.find((n) => n.id === nodeId);
            if (gw?.data.role === AgentRole.Gateway) {
              for (const target of computeSkipped(nodeId, nodes, edges, gatewayRoutes)) {
                deadEdges.add(`${nodeId}->${target}`);
              }
            }

            // Unblock successors; a successor fed only by dead inputs is skipped
            for (const succ of successors.get(nodeId) ?? []) {
              if (done.has(succ)) continue;
              const deg = (inDegree.get(succ) ?? 1) - 1;
              inDegree.set(succ, deg);
              if (allInputsDead(succ)) {
                markSkipped(succ);
              } else if (deg <= 0 && !running.has(succ)) {
                ready.push(succ);
              }
            }

            // Terminate if all nodes are processed
            if (running.size === 0 && ready.length === 0) {
              const remaining = remainingIds();
              if (remaining.length > 0 && !isCancelled()) {
                finish(new Error(`No runnable nodes remain. Workflow may contain a cycle or blocked dependency: ${remaining.join(", ")}`));
              } else {
                finish();
              }
            } else {
              schedule();
            }
          })
          .catch((err) => {
            running.delete(nodeId);
            done.add(nodeId);
            // Propagate error (caller decides whether to continue via continueOnError)
            if (!failure) failure = { error: err };
            if (running.size === 0) finish(failure.error);
          });
      }

      // Cancelled and nothing running: resolve cleanly
      if (isCancelled() && running.size === 0) {
        finish();
        return;
      }

      // Nothing left (everything done or all remaining are still running)
      if (ready.length === 0 && running.size === 0 && !isCancelled()) {
        const remaining = remainingIds();
        if (remaining.length > 0) {
          finish(new Error(`No runnable nodes remain. Workflow may contain a cycle or blocked dependency: ${remaining.join(", ")}`));
        } else {
          finish();
        }
      }
    }

    // Kick off
    if (ready.length === 0) {
      if (nodes.length === 0) {
        finish();
      } else {
        finish(new Error(`No runnable nodes found. Workflow may contain a cycle: ${nodes.map((node) => node.id).join(", ")}`));
      }
    } else {
      schedule();
    }
  });
}
