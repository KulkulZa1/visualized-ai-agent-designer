import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";
import {
  definitionHash, fingerprint, reusableNodes, runRecordPath, savedNodeId, type NodeRecord, type RunRecord,
} from "@/engine/runRecord";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import { AgentRole, type AgentNodeData } from "@/types/agent";
import type { AgentNode } from "@/types/workflow";

function data(name: string): AgentNodeData {
  return {
    name, role: AgentRole.Worker, model: "qwen2.5-coder:7b", temperature: 0.7, maxTokens: 1024, maxSteps: 3,
    timeoutSeconds: 300, promptSource: { type: "inline", content: `Be ${name}.` }, tools: [], memoryRead: [],
    memoryWrite: [], tokens: { used: 0, budget: 0 }, status: "idle",
  };
}

describe("fingerprint", () => {
  it("is the same for the same text and differs for another", () => {
    expect(fingerprint("abc")).toBe(fingerprint("abc"));
    expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
    expect(fingerprint("")).toMatch(/^[0-9a-f]{14}$/);
  });
});

describe("definitionHash", () => {
  it("changes with what shapes the work, not with the node's status or token count", () => {
    const base = definitionHash(data("A"), "Be A.");
    expect(definitionHash({ ...data("A"), status: "done", tokens: { used: 900, budget: 0 } }, "Be A.")).toBe(base);
    expect(definitionHash(data("A"), "Be A, but faster.")).not.toBe(base);
    expect(definitionHash({ ...data("A"), model: "qwen3:8b" }, "Be A.")).not.toBe(base);
    expect(definitionHash({ ...data("A"), tools: ["read_file"] as AgentNodeData["tools"] }, "Be A.")).not.toBe(base);
  });
});

describe("reusableNodes", () => {
  const node = (name: string, i: number): AgentNode =>
    ({ id: `n-${name}`, type: "agent", position: { x: i, y: 0 }, data: data(name) });
  // A → B → C, and D on its own; C sends feedback to A, which does not make A depend on C.
  const graph: WorkflowGraph = {
    nodes: ["A", "B", "C", "D"].map(node),
    edges: [
      { id: "ab", source: "n-A", target: "n-B" },
      { id: "bc", source: "n-B", target: "n-C" },
      { id: "ca", source: "n-C", target: "n-A", data: { edgeKind: "feedback" } },
    ] as Edge[],
    meta: { name: "W", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
    executionSettings: { maxParallel: 4, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
  };
  const hashes = new Map(graph.nodes.map((n) => [n.id, `hash-${n.data.name}`]));
  const saved = (changes: Record<string, Partial<NodeRecord> | null>): RunRecord => {
    const nodes: Record<string, NodeRecord> = {};
    graph.nodes.forEach((n, i) => {
      const change = changes[n.data.name];
      if (change === null) return; // the saved run never got to it
      nodes[savedNodeId(i)] = { agent: n.data.name, status: "done", definitionHash: `hash-${n.data.name}`, ...change };
    });
    return {
      version: 1, runId: "run-1", workflow: { name: "W", path: null, hash: null }, task: "t",
      provider: { llmProvider: "ollama", ollamaBaseUrl: "", ollamaModel: "", customApiUrl: "", customApiModel: "" },
      status: "error", startedAt: 0, attempts: 1, nodes, outputs: {}, memory: {}, gatewayRoutes: {}, changes: [], audit: [],
    };
  };
  const reused = (changes: Record<string, Partial<NodeRecord> | null>) =>
    [...reusableNodes(graph, saved(changes), hashes)].map((id) => id.slice(2)).sort();

  it("reuses every node that finished and did not change", () => {
    expect(reused({})).toEqual(["A", "B", "C", "D"]);
  });

  it("re-runs a changed node and everything after it", () => {
    expect(reused({ B: { definitionHash: "an older hash" } })).toEqual(["A", "D"]);
  });

  it("re-runs a node that failed or was stopped, and what comes after it", () => {
    expect(reused({ A: { status: "error" } })).toEqual(["D"]);
    expect(reused({ C: { status: "stopped" } })).toEqual(["A", "B", "D"]);
  });

  it("runs a node the saved run never reached", () => {
    expect(reused({ D: null })).toEqual(["A", "B", "C"]);
  });
});

describe("runRecordPath", () => {
  it("is under .harness/runs in the workspace", () => {
    expect(runRecordPath("run-7")).toBe(".harness/runs/run-7/run.json");
  });
});
