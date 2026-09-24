import { describe, it, expect, vi } from "vitest";
import { runParallel } from "@/services/execution/parallelScheduler";
import { AgentRole } from "@/types/agent";
import type { AgentNode } from "@/types/workflow";
import type { Edge } from "@xyflow/react";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(id: string, role: AgentRole = AgentRole.Worker): AgentNode {
  return {
    id,
    type: "agent",
    position: { x: 0, y: 0 },
    data: {
      name: id,
      role,
      model: "qwen2.5-coder:7b",
      temperature: 0.7,
      maxTokens: 4096,
      maxSteps: 5,
      timeoutSeconds: 300,
      promptSource: { type: "inline", content: "" },
      tools: [],
      memoryRead: [],
      memoryWrite: [],
      tokens: { used: 0, budget: 16000 },
      status: "idle",
    },
  };
}

function makeEdge(
  source: string,
  target: string,
  label?: string,
  edgeKind?: "dataflow" | "memory" | "feedback" | "control",
): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    data: { label, edgeKind: edgeKind ?? "dataflow" },
  };
}

function defaultOptions(overrides: Partial<Parameters<typeof runParallel>[3]> = {}) {
  return {
    maxParallel: 4,
    isCancelled: () => false,
    onSkipped: vi.fn(),
    gatewayRoutes: new Map<string, string>(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runParallel — basic ordering", () => {
  it("executes a single node", async () => {
    const nodes = [makeNode("A")];
    const order: string[] = [];
    await runParallel(nodes, [], async (id) => { order.push(id); }, defaultOptions());
    expect(order).toEqual(["A"]);
  });

  it("linear chain A→B→C executes in order", async () => {
    const nodes = [makeNode("A"), makeNode("B"), makeNode("C")];
    const edges = [makeEdge("A", "B"), makeEdge("B", "C")];
    const order: string[] = [];
    await runParallel(nodes, edges, async (id) => { order.push(id); }, defaultOptions());
    expect(order).toEqual(["A", "B", "C"]);
  });

  it("empty workflow resolves immediately", async () => {
    await runParallel([], [], async () => {}, defaultOptions());
  });

  it("rejects a pure forward cycle instead of silently completing", async () => {
    const nodes = [makeNode("A"), makeNode("B")];
    const edges = [makeEdge("A", "B"), makeEdge("B", "A")];
    const executed: string[] = [];

    await expect(
      runParallel(nodes, edges, async (id) => { executed.push(id); }, defaultOptions()),
    ).rejects.toThrow(/cycle|No runnable/i);
    expect(executed).toEqual([]);
  });
});

describe("runParallel — parallel branches", () => {
  it("A→B and A→C: B and C run after A, in parallel", async () => {
    const nodes = [makeNode("A"), makeNode("B"), makeNode("C")];
    const edges = [makeEdge("A", "B"), makeEdge("A", "C")];
    const order: string[] = [];
    const running = new Set<string>();
    let maxConcurrent = 0;

    await runParallel(nodes, edges, async (id) => {
      running.add(id);
      maxConcurrent = Math.max(maxConcurrent, running.size);
      order.push(id);
      await new Promise<void>((r) => setTimeout(r, 10)); // simulate work
      running.delete(id);
    }, defaultOptions({ maxParallel: 4 }));

    expect(order[0]).toBe("A");
    expect(order).toContain("B");
    expect(order).toContain("C");
    expect(maxConcurrent).toBe(2); // B and C ran at the same time
  });

  it("fan-in: D waits for both B and C", async () => {
    // A→B, A→C, B→D, C→D
    const nodes = [makeNode("A"), makeNode("B"), makeNode("C"), makeNode("D")];
    const edges = [
      makeEdge("A", "B"), makeEdge("A", "C"),
      makeEdge("B", "D"), makeEdge("C", "D"),
    ];
    const order: string[] = [];
    await runParallel(nodes, edges, async (id) => { order.push(id); }, defaultOptions());
    expect(order[0]).toBe("A");
    expect(order[3]).toBe("D"); // D is always last
    expect(order.slice(1, 3).sort()).toEqual(["B", "C"]);
  });
});

describe("runParallel — maxParallel limit", () => {
  it("maxParallel=1 forces sequential execution even for independent branches", async () => {
    const nodes = [makeNode("A"), makeNode("B"), makeNode("C")];
    // No edges — all independent, could run in parallel
    let concurrent = 0;
    let maxConcurrent = 0;

    await runParallel(nodes, [], async (_id) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((r) => setTimeout(r, 10));
      concurrent--;
    }, defaultOptions({ maxParallel: 1 }));

    expect(maxConcurrent).toBe(1);
  });

  it("maxParallel=2 caps concurrent executions", async () => {
    const nodes = [makeNode("A"), makeNode("B"), makeNode("C"), makeNode("D")];
    // All independent
    let concurrent = 0;
    let maxConcurrent = 0;

    await runParallel(nodes, [], async (_id) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((r) => setTimeout(r, 20));
      concurrent--;
    }, defaultOptions({ maxParallel: 2 }));

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});

describe("runParallel — cancellation", () => {
  it("cancellation stops new nodes from starting", async () => {
    let cancelled = false;
    const nodes = [makeNode("A"), makeNode("B"), makeNode("C")];
    const edges = [makeEdge("A", "B"), makeEdge("B", "C")];
    const started: string[] = [];

    await runParallel(nodes, edges, async (id) => {
      started.push(id);
      if (id === "A") cancelled = true; // cancel after A runs
    }, defaultOptions({ isCancelled: () => cancelled }));

    // B might or might not start depending on exact timing, but C should not run after cancellation
    expect(started).toContain("A");
    expect(started).not.toContain("C"); // C requires B first, which requires A, and we cancelled
  });
});

describe("runParallel — error handling", () => {
  it("rejects when a node throws and continueOnError is not set", async () => {
    const nodes = [makeNode("A"), makeNode("B")];
    const edges = [makeEdge("A", "B")];

    await expect(
      runParallel(nodes, edges, async (id) => {
        if (id === "A") throw new Error("A failed");
      }, defaultOptions())
    ).rejects.toThrow("A failed");
  });

  it("does not start successors of in-flight nodes after the run has failed", async () => {
    // A fails while B is still running; C depends only on B.
    const nodes = [makeNode("A"), makeNode("B"), makeNode("C")];
    const edges = [makeEdge("B", "C")];
    const started: string[] = [];
    let finishB!: () => void;
    const bDone = new Promise<void>((resolve) => { finishB = resolve; });

    const run = runParallel(nodes, edges, async (id) => {
      started.push(id);
      if (id === "A") throw new Error("A failed");
      if (id === "B") await bDone;
    }, defaultOptions());
    const outcome = expect(run).rejects.toThrow("A failed");

    await new Promise((resolve) => setTimeout(resolve, 0));
    finishB();
    await outcome;

    expect(started).not.toContain("C");
  });

  it("settles a failed run only after in-flight nodes have finished", async () => {
    // Callers treat settlement as "no node of this run is still running".
    const nodes = [makeNode("A"), makeNode("B")];
    const events: string[] = [];
    let finishB!: () => void;
    const bDone = new Promise<void>((resolve) => { finishB = resolve; });

    const run = runParallel(nodes, [], async (id) => {
      if (id === "A") throw new Error("A failed");
      await bDone;
      events.push("B finished");
    }, defaultOptions()).catch(() => { events.push("run rejected"); });

    await new Promise((resolve) => setTimeout(resolve, 0));
    finishB();
    await run;

    expect(events).toEqual(["B finished", "run rejected"]);
  });

  it("nodes that throw don't block resolution if swallowed by caller", async () => {
    const nodes = [makeNode("A"), makeNode("B")];
    const completed: string[] = [];

    // Caller swallows errors (continueOnError pattern)
    await runParallel(nodes, [], async (id) => {
      try {
        if (id === "A") throw new Error("A failed");
        completed.push(id);
      } catch {
        // swallowed
      }
    }, defaultOptions());

    expect(completed).toContain("B");
  });
});

describe("runParallel — feedback edges", () => {
  it("feedback edges are ignored for dependency calculation", async () => {
    // A→B dataflow, B→A feedback (revision loop) — A should still start first
    const nodes = [makeNode("A"), makeNode("B")];
    const edges = [
      makeEdge("A", "B", "draft"),
      makeEdge("B", "A", "revise", "feedback"),
    ];
    const order: string[] = [];
    await runParallel(nodes, edges, async (id) => { order.push(id); }, defaultOptions());
    expect(order[0]).toBe("A"); // A starts first (no forward dependencies)
    expect(order[1]).toBe("B"); // B waits for A's dataflow edge
  });

  it("feedback edges stored as top-level edge type are ignored", async () => {
    const nodes = [makeNode("A"), makeNode("B")];
    const edges: Edge[] = [
      makeEdge("A", "B", "draft"),
      { id: "B->A-feedback", source: "B", target: "A", type: "feedback", label: "revise" },
    ];
    const order: string[] = [];

    await runParallel(nodes, edges, async (id) => { order.push(id); }, defaultOptions());

    expect(order).toEqual(["A", "B"]);
  });
});

describe("runParallel — gateway skip", () => {
  it("gateway routes to one branch and skips the other", async () => {
    // Gateway G → Branch1 (label "yes"), Gateway G → Branch2 (label "no")
    const gw = makeNode("G", AgentRole.Gateway);
    const b1 = makeNode("B1");
    const b2 = makeNode("B2");
    const nodes = [gw, b1, b2];
    const edges = [
      makeEdge("G", "B1", "yes"),
      makeEdge("G", "B2", "no"),
    ];

    const gatewayRoutes = new Map([["G", "yes"]]); // gateway chose "yes"
    const skipped: string[] = [];
    const executed: string[] = [];

    await runParallel(
      nodes,
      edges,
      async (id) => { executed.push(id); },
      defaultOptions({
        gatewayRoutes,
        onSkipped: (id) => skipped.push(id),
      }),
    );

    expect(executed).toContain("G");
    expect(executed).toContain("B1"); // "yes" branch runs
    expect(skipped).toContain("B2"); // "no" branch is skipped
    expect(executed).not.toContain("B2");
  });

  it("unlabelled gateway edges always follow regardless of route", async () => {
    const gw = makeNode("G", AgentRole.Gateway);
    const b1 = makeNode("B1");
    const nodes = [gw, b1];
    const edges = [makeEdge("G", "B1")]; // no label

    const gatewayRoutes = new Map([["G", "something-else"]]);
    const executed: string[] = [];

    await runParallel(nodes, edges, async (id) => { executed.push(id); },
      defaultOptions({ gatewayRoutes }));

    expect(executed).toContain("B1"); // unlabelled edge always follows
  });

  it("uses top-level edge labels when routing loaded workflows", async () => {
    const gw = makeNode("G", AgentRole.Gateway);
    const b1 = makeNode("B1");
    const b2 = makeNode("B2");
    const nodes = [gw, b1, b2];
    const edges: Edge[] = [
      { id: "G->B1", source: "G", target: "B1", label: "yes", type: "dataflow" },
      { id: "G->B2", source: "G", target: "B2", label: "no", type: "dataflow" },
    ];
    const skipped: string[] = [];
    const executed: string[] = [];

    await runParallel(
      nodes,
      edges,
      async (id) => { executed.push(id); },
      defaultOptions({
        gatewayRoutes: new Map([["G", "yes"]]),
        onSkipped: (id) => skipped.push(id),
      }),
    );

    expect(executed).toEqual(expect.arrayContaining(["G", "B1"]));
    expect(executed).not.toContain("B2");
    expect(skipped).toContain("B2");
  });

  it("skips descendants that depend only on a skipped gateway branch", async () => {
    const gw = makeNode("G", AgentRole.Gateway);
    const keep = makeNode("Keep");
    const skip = makeNode("Skip");
    const skipChild = makeNode("SkipChild");
    const join = makeNode("Join", AgentRole.Aggregator);
    const nodes = [gw, keep, skip, skipChild, join];
    const edges = [
      makeEdge("G", "Keep", "yes"),
      makeEdge("G", "Skip", "no"),
      makeEdge("Skip", "SkipChild"),
      makeEdge("Keep", "Join"),
      makeEdge("Skip", "Join"),
    ];

    const gatewayRoutes = new Map([["G", "yes"]]);
    const skipped: string[] = [];
    const executed: string[] = [];

    await runParallel(
      nodes,
      edges,
      async (id) => {
        executed.push(id);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      },
      defaultOptions({
        gatewayRoutes,
        onSkipped: (id) => skipped.push(id),
      }),
    );

    expect(executed).toEqual(expect.arrayContaining(["G", "Keep", "Join"]));
    expect(executed).not.toContain("Skip");
    expect(executed).not.toContain("SkipChild");
    expect(skipped).toEqual(expect.arrayContaining(["Skip", "SkipChild"]));
    expect(skipped).not.toContain("Join");
  });

  it("still runs a join fed by a live branch when the gateway's own edge into it is not taken", async () => {
    // G --no--> J and W --> J: route "yes" drops only G's edge; W still feeds J.
    const nodes = [makeNode("G", AgentRole.Gateway), makeNode("Y"), makeNode("W"), makeNode("J")];
    const edges = [makeEdge("G", "Y", "yes"), makeEdge("G", "J", "no"), makeEdge("W", "J")];
    const executed: string[] = [];

    await runParallel(nodes, edges, async (id) => { executed.push(id); },
      defaultOptions({ gatewayRoutes: new Map([["G", "yes"]]) }));

    expect(executed).toEqual(expect.arrayContaining(["G", "Y", "W", "J"]));
  });

  it("follows every branch when the route matches no edge label", async () => {
    // e.g. a router answering "mixed", or prose parsed into an unrelated word.
    const nodes = [makeNode("G", AgentRole.Gateway), makeNode("UI"), makeNode("Rust")];
    const edges = [makeEdge("G", "UI", "ui"), makeEdge("G", "Rust", "rust")];
    const executed: string[] = [];

    await runParallel(nodes, edges, async (id) => { executed.push(id); },
      defaultOptions({ gatewayRoutes: new Map([["G", "mixed"]]) }));

    expect(executed).toEqual(expect.arrayContaining(["G", "UI", "Rust"]));
  });
});
