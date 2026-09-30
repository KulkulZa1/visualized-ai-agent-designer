import { describe, it, expect, vi } from "vitest";
import { prunedNodes, runParallel } from "@/services/execution/parallelScheduler";
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

describe("runParallel — gateway label matching", () => {
  /** Run gateway G with one branch per edge label; report which labels ran and which were skipped. */
  async function routeGateway(route: string, labels: string[]) {
    const branches = labels.map((_, i) => `B${i}`);
    const nodes = [makeNode("G", AgentRole.Gateway), ...branches.map((id) => makeNode(id))];
    const edges = labels.map((label, i) => makeEdge("G", branches[i], label));
    const executed: string[] = [];
    const skipped: string[] = [];

    await runParallel(nodes, edges, async (id) => { executed.push(id); },
      defaultOptions({ gatewayRoutes: new Map([["G", route]]), onSkipped: (id) => skipped.push(id) }));

    return {
      ran: labels.filter((_, i) => executed.includes(branches[i])),
      skipped: labels.filter((_, i) => skipped.includes(branches[i])),
    };
  }

  it.each([
    ["valid", ["valid", "invalid"]],
    ["valid", ["invalid", "valid"]],
    ["safe", ["safe", "unsafe"]],
    ["ok", ["ok", "not ok"]],
    ["ok", ["not ok", "ok"]],
  ])("route %j among labels %j follows only the exact label", async (route, labels) => {
    const { ran, skipped } = await routeGateway(route, labels);
    expect(ran).toEqual([route]);
    expect(skipped).toEqual(labels.filter((label) => label !== route));
  });

  it("compares the route and the labels trimmed and case-insensitively", async () => {
    const { ran, skipped } = await routeGateway("  VALID ", [" Valid", "invalid "]);
    expect(ran).toEqual([" Valid"]);
    expect(skipped).toEqual(["invalid "]);
  });

  it("follows every branch that carries the exact label", async () => {
    const { ran, skipped } = await routeGateway("ok", ["ok", "OK ", "not ok"]);
    expect(ran).toEqual(["ok", "OK "]);
    expect(skipped).toEqual(["not ok"]);
  });

  it("still follows unlabelled edges when a label matches exactly", async () => {
    const { ran, skipped } = await routeGateway("safe", ["safe", "unsafe", ""]);
    expect(ran).toEqual(["safe", ""]);
    expect(skipped).toEqual(["unsafe"]);
  });

  it("falls back to substring matching only when no label equals the route", async () => {
    // The route sits inside a label.
    expect(await routeGateway("backend", ["backend-api", "frontend"]))
      .toEqual({ ran: ["backend-api"], skipped: ["frontend"] });
    // A label sits inside the route.
    expect(await routeGateway("approved-with-changes", ["approved", "rejected"]))
      .toEqual({ ran: ["approved"], skipped: ["rejected"] });
    // Several labels match by substring: all of them are followed.
    expect(await routeGateway("api", ["backend-api", "frontend-api", "docs"]))
      .toEqual({ ran: ["backend-api", "frontend-api"], skipped: ["docs"] });
  });
});

describe("prunedNodes", () => {
  const G = AgentRole.Gateway;

  /** What runParallel skips for these routes, set before the run: the reference. */
  async function skippedByScheduler(nodes: AgentNode[], edges: Edge[], routes: Map<string, string>) {
    const skipped = new Set<string>();
    await runParallel(nodes, edges, async () => {},
      defaultOptions({ gatewayRoutes: routes, onSkipped: (id) => skipped.add(id) }));
    return skipped;
  }
  /** The same, with the routes produced as the engine produces them: a gateway sets its route when it runs, so a
   *  gateway that is pruned never does. Returns what was skipped and the routes the run ended with. */
  async function skippedWithProducedRoutes(nodes: AgentNode[], edges: Edge[], decisions: Map<string, string>) {
    const produced = new Map<string, string>();
    const skipped = new Set<string>();
    await runParallel(nodes, edges, async (id) => {
      const decision = decisions.get(id);
      if (decision !== undefined) produced.set(id, decision);
    }, defaultOptions({ gatewayRoutes: produced, onSkipped: (id) => skipped.add(id) }));
    return { skipped, produced };
  }
  const sorted = (ids: Iterable<string>) => [...ids].sort();

  /** prunedNodes must equal what runParallel skips, whether the routes are there from the start or produced as
   *  the run goes, and all of it must equal `expected`: that keeps the test from being merely self-consistent. */
  async function expectPruned(nodes: AgentNode[], edges: Edge[], routes: Record<string, string>, expected: string[]) {
    const map = new Map(Object.entries(routes));
    expect(sorted(await skippedByScheduler(nodes, edges, map))).toEqual(sorted(expected));
    expect(sorted(prunedNodes(nodes, edges, map))).toEqual(sorted(expected));
    const { skipped, produced } = await skippedWithProducedRoutes(nodes, edges, map);
    expect(sorted(skipped)).toEqual(sorted(expected));
    expect(sorted(prunedNodes(nodes, edges, produced))).toEqual(sorted(expected));
  }

  it("prunes the branch a gateway with two branches does not take", async () => {
    await expectPruned(
      [makeNode("G", G), makeNode("B1"), makeNode("B2")],
      [makeEdge("G", "B1", "yes"), makeEdge("G", "B2", "no")],
      { G: "yes" }, ["B2"]);
    await expectPruned(
      [makeNode("G", G), makeNode("B1"), makeNode("B2")],
      [makeEdge("G", "B1", "yes"), makeEdge("G", "B2", "no")],
      { G: "no" }, ["B1"]);
  });

  it("prunes what only the dropped branch feeds, and keeps a join that has one live input", async () => {
    // G -yes-> Y -> J, G -no-> N -> J, N -> Child (fed only by N)
    const nodes = [makeNode("G", G), makeNode("Y"), makeNode("N"), makeNode("J"), makeNode("Child")];
    const edges = [
      makeEdge("G", "Y", "yes"), makeEdge("G", "N", "no"),
      makeEdge("Y", "J"), makeEdge("N", "J"), makeEdge("N", "Child"),
    ];
    await expectPruned(nodes, edges, { G: "yes" }, ["N", "Child"]); // J still has Y
    await expectPruned(nodes, edges, { G: "no" }, ["Y"]);           // J still has N; Child is live
  });

  it("prunes a join whose every input is dead, however each one died", async () => {
    // G1 -a-> A, G1 -b-> B; G2 -c-> C, G2 -d-> D; B and D both feed J. Route a and c: B is pruned
    // (its only input is a dead edge), D is pruned likewise, so J has nothing live left.
    const nodes = [makeNode("G1", G), makeNode("G2", G), makeNode("A"), makeNode("B"), makeNode("C"), makeNode("D"), makeNode("J")];
    const edges = [
      makeEdge("G1", "A", "a"), makeEdge("G1", "B", "b"), makeEdge("G2", "C", "c"), makeEdge("G2", "D", "d"),
      makeEdge("B", "J"), makeEdge("D", "J"),
    ];
    await expectPruned(nodes, edges, { G1: "a", G2: "c" }, ["B", "D", "J"]);
    await expectPruned(nodes, edges, { G1: "a", G2: "d" }, ["B", "C"]);           // D is live, so J runs
  });

  it("handles nested gateways, including the stale route of a gateway that is itself pruned", async () => {
    // G1 -left-> G2, G1 -right-> Z; G2 -a-> A, G2 -b-> B
    const nodes = [makeNode("G1", G), makeNode("G2", G), makeNode("Z"), makeNode("A"), makeNode("B")];
    const edges = [
      makeEdge("G1", "G2", "left"), makeEdge("G1", "Z", "right"), makeEdge("G2", "A", "a"), makeEdge("G2", "B", "b"),
    ];
    await expectPruned(nodes, edges, { G1: "left", G2: "a" }, ["Z", "B"]);
    // G2 is pruned, so everything behind it is, whatever route it once had.
    await expectPruned(nodes, edges, { G1: "right", G2: "a" }, ["G2", "A", "B"]);
    await expectPruned(nodes, edges, { G1: "right" }, ["G2", "A", "B"]);
  });

  it("prunes nothing when the route matches no label, or a gateway has no route", async () => {
    const nodes = [makeNode("G", G), makeNode("UI"), makeNode("Rust")];
    const edges = [makeEdge("G", "UI", "ui"), makeEdge("G", "Rust", "rust")];
    await expectPruned(nodes, edges, { G: "mixed" }, []);
    await expectPruned(nodes, edges, {}, []);
  });

  it("always follows an unlabelled gateway edge", async () => {
    const nodes = [makeNode("G", G), makeNode("X"), makeNode("Y"), makeNode("Z")];
    const edges = [makeEdge("G", "X"), makeEdge("G", "Y", "a"), makeEdge("G", "Z", "c")];
    await expectPruned(nodes, edges, { G: "a" }, ["Z"]);
    await expectPruned(nodes, edges, { G: "zz" }, []);
  });

  it("keeps a node the gateway feeds by a taken edge and an untaken one, and drops a node it feeds by a plain and an untaken one", async () => {
    // Dead edges are kept by node pair: an untaken labelled edge to U also kills the unlabelled edge to U.
    const nodes = [makeNode("G", G), makeNode("Y"), makeNode("T"), makeNode("U")];
    const edges = [
      makeEdge("G", "Y", "yes"),
      makeEdge("G", "T", "yes"), makeEdge("G", "T", "no"),
      makeEdge("G", "U", "no"), makeEdge("G", "U"),
    ];
    await expectPruned(nodes, edges, { G: "yes" }, ["U"]);
  });

  it("does not count feedback edges as inputs", async () => {
    // B's only forward input is the untaken edge; R feeds it back, which does not keep it alive.
    const nodes = [makeNode("G", G), makeNode("Y"), makeNode("B"), makeNode("R")];
    const edges = [
      makeEdge("G", "Y", "yes"), makeEdge("G", "B", "no"), makeEdge("Y", "R"), makeEdge("R", "B", "revise", "feedback"),
    ];
    await expectPruned(nodes, edges, { G: "yes" }, ["B"]);
  });

  it("agrees with runParallel on random graphs", async () => {
    // mulberry32: a small seeded generator, so a failure names a graph that can be rebuilt.
    const seeded = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(random: () => number, items: T[]) => items[Math.floor(random() * items.length)];
    let withPruning = 0;
    let deeperThanOneHop = 0;

    for (let seed = 1; seed <= 400; seed++) {
      const random = seeded(seed);
      const count = 3 + Math.floor(random() * 8);
      // The first node is always a gateway, so that most graphs have a branch to prune.
      const nodes = Array.from({ length: count }, (_, i) => makeNode(`n${i}`, i === 0 || random() < 0.4 ? G : AgentRole.Worker));
      const edges: Edge[] = [];
      for (let from = 0; from < count; from++) {
        const isGateway = nodes[from].data.role === G;
        for (let to = from + 1; to < count; to++) {
          if (random() >= (isGateway ? 0.6 : 0.3)) continue;
          // A gateway's edges mostly carry one of three labels; some carry none (always followed).
          const label = isGateway ? (random() < 0.15 ? "" : pick(random, ["a", "b", "c"])) : undefined;
          edges.push(makeEdge(`n${from}`, `n${to}`, label));
        }
      }
      // A few feedback edges: never inputs.
      for (let i = 0; i < 2; i++) {
        const from = Math.floor(random() * count);
        const to = Math.floor(random() * count);
        if (from !== to) edges.push({ ...makeEdge(`n${from}`, `n${to}`, "revise", "feedback"), id: `fb${i}` });
      }
      // Mostly a route that names a label; sometimes one that matches none ("zz": follow every branch).
      const routes = new Map(nodes.filter((n) => n.data.role === G)
        .map((n): [string, string] => [n.id, random() < 0.85 ? pick(random, ["a", "b", "c"]) : "zz"]));

      const reference = sorted(await skippedByScheduler(nodes, edges, routes));
      const description = `seed ${seed}: edges ${edges.map((e) => `${e.source}${e.data?.edgeKind === "feedback" ? "~" : "-"}${(e.data as { label?: string }).label ?? ""}>${e.target}`).join(" ")}; routes ${JSON.stringify([...routes])}`;
      expect(sorted(prunedNodes(nodes, edges, routes)), description).toEqual(reference);
      // Routes produced as the run goes: the same skips, and prunedNodes agrees with the routes that came out.
      const produced = await skippedWithProducedRoutes(nodes, edges, routes);
      expect(sorted(produced.skipped), description).toEqual(reference);
      expect(sorted(prunedNodes(nodes, edges, produced.produced)), description).toEqual(reference);

      if (reference.length > 0) withPruning++;
      if (reference.some((id) => !edges.some((e) => e.target === id && routes.has(e.source) && !reference.includes(e.source)))) deeperThanOneHop++;
    }
    // The generator must actually exercise pruning, and pruning that spreads.
    expect(withPruning).toBeGreaterThan(80);
    expect(deeperThanOneHop).toBeGreaterThan(10);
  });
});
