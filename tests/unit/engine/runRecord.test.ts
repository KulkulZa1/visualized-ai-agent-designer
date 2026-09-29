import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Edge } from "@xyflow/react";
import {
  definitionHash, fingerprint, hookFingerprint, reusableNodes, runRecordPath, savedHookScripts, savedNodeId, sha256Hex,
  type NodeRecord, type RunRecord,
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

describe("sha256Hex", () => {
  it("is the SHA-256 of the text, in hex", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // The text's UTF-8 bytes (0xC3 0xA9 for "é"), not UTF-16.
    expect(await sha256Hex("é")).toBe("4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c");
  });

  it("differs for texts that differ by one character", async () => {
    expect(await sha256Hex("echo hi\n")).not.toBe(await sha256Hex("echo hi"));
  });
});

describe("hookFingerprint", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  it("is the SHA-256 of the JSON of the script's text and the env's names and values, sorted by name", async () => {
    expect(await hookFingerprint("echo hi\n", { B: "2", A: "1" })).toBe(sha('["echo hi\\n",[["A","1"],["B","2"]]]'));
  });

  it("counts an empty env, so that adding a variable always changes it", async () => {
    const bare = await hookFingerprint("echo hi\n", undefined);

    expect(bare).toBe(sha('["echo hi\\n",[]]'));
    expect(await hookFingerprint("echo hi\n", {})).toBe(bare);
    expect(await hookFingerprint("echo hi\n", { BASH_ENV: "/tmp/x" })).not.toBe(bare);
  });

  it("does not depend on the order the env is written in, and does on each of its names and values", async () => {
    const base = await hookFingerprint("echo hi\n", { A: "1", B: "2" });

    expect(await hookFingerprint("echo hi\n", { B: "2", A: "1" })).toBe(base);
    expect(await hookFingerprint("echo hi\n", { A: "1", B: "3" })).not.toBe(base);
    expect(await hookFingerprint("echo hi\n", { A: "1", C: "2" })).not.toBe(base);
    expect(await hookFingerprint("echo hi\n", { A: "1" })).not.toBe(base);
  });

  it("differs for another script, and from the script's plain SHA-256", async () => {
    expect(await hookFingerprint("echo hi", undefined)).not.toBe(await hookFingerprint("echo hi\n", undefined));
    expect(await hookFingerprint("echo hi\n", undefined)).not.toBe(await sha256Hex("echo hi\n"));
  });

  it("rejects where Web Crypto is missing: nothing weaker stands in for it", async () => {
    vi.stubGlobal("crypto", undefined);
    try {
      await expect(hookFingerprint("echo hi\n", undefined)).rejects.toThrow("Web Crypto");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("savedHookScripts", () => {
  const withScripts = (hookScripts: unknown) => ({ hookScripts }) as unknown as RunRecord;
  const SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

  it("is undefined for no record and for a record from before the field, so that attempt takes the baselines itself", () => {
    expect(savedHookScripts(undefined)).toBeUndefined();
    expect(savedHookScripts({} as RunRecord)).toBeUndefined();
  });

  it("keeps what the record has, fingerprints and nulls, and an empty map is still 'there'", () => {
    expect(savedHookScripts(withScripts({ "agent-0": SHA, "agent-1": null }))).toEqual({ "agent-0": SHA, "agent-1": null });
    expect(savedHookScripts(withScripts({}))).toEqual({});
  });

  it("counts a field that is there but not a map as empty, not as absent: nothing new is trusted on its strength", () => {
    for (const broken of [null, "abc", 7, true, [SHA]]) {
      expect(savedHookScripts(withScripts(broken)), JSON.stringify(broken)).toEqual({});
    }
  });

  it("drops the entries that are neither a fingerprint nor null, and keeps the rest", () => {
    expect(savedHookScripts(withScripts({ "agent-0": SHA, "agent-1": 7, "agent-2": {}, "agent-3": null, "agent-4": undefined })))
      .toEqual({ "agent-0": SHA, "agent-3": null });
  });

  it("returns a copy, so what a run adds is not written back into the record it resumed from", () => {
    const record = withScripts({ "agent-0": SHA });
    const saved = savedHookScripts(record);
    saved!["agent-1"] = null;
    expect(record.hookScripts).toEqual({ "agent-0": SHA });
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
