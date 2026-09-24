import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";
import { firedFeedbackEdges, revisionPath } from "@/services/execution/routing";

const forward = (source: string, target: string, label?: string): Edge =>
  ({ id: `${source}-${target}`, source, target, data: label ? { label } : undefined }) as Edge;
const feedback = (source: string, target: string, label?: string): Edge =>
  ({ id: `fb-${source}-${target}`, source, target, data: { edgeKind: "feedback", label } }) as Edge;

describe("firedFeedbackEdges", () => {
  const edges = [forward("W", "R"), feedback("R", "W", "revise")];
  const fired = (output: string, e: Edge[] = edges) => firedFeedbackEdges("R", output, e).map((x) => x.target);

  it("fires on a verdict naming the edge: JSON, key-value or a leading word", () => {
    expect(fired('{"verdict":"REVISE","notes":"fix the intro"}')).toEqual(["W"]);
    expect(fired("Verdict: revise\nThe intro is weak.")).toEqual(["W"]);
    expect(fired("REVISE — the intro is weak.")).toEqual(["W"]);
    expect(fired('{"route":"revise"}')).toEqual(["W"]);
  });

  it("does not fire on a pass, another verdict or ordinary prose", () => {
    expect(fired('{"verdict":"PASS"}')).toEqual([]);
    expect(fired("APPROVED. Nothing to change.")).toEqual([]);
    expect(fired("ESCALATE: needs a human.")).toEqual([]);
    expect(fired("I think it is fine; no need to revise.")).toEqual([]);
    expect(fired("")).toEqual([]);
  });

  it("fires only the edges whose label the verdict names, or all of them on a plain revise", () => {
    const two = [feedback("R", "A", "code-fix"), feedback("R", "B", "rust-fix")];
    expect(fired('{"verdict":"rust-fix"}', two)).toEqual(["B"]);
    expect(fired("REVISE: both need work.", two)).toEqual(["A", "B"]);
  });

  it("ignores forward edges and nodes without feedback edges", () => {
    expect(firedFeedbackEdges("W", "REVISE", edges)).toEqual([]);
  });
});

describe("revisionPath", () => {
  it("re-runs the path from the target back to the source, in order, without the source", () => {
    // Drafter → Critic → Loop Gate, with the gate's feedback edge back to the Drafter.
    const edges = [forward("D", "C"), forward("C", "G"), feedback("G", "D", "revise"), forward("G", "S", "ship")];
    expect(revisionPath(["D"], "G", edges)).toEqual(["D", "C"]);
  });

  it("includes every branch between target and source, in dependency order", () => {
    const edges = [forward("W", "Y"), forward("W", "X"), forward("X", "R"), forward("Y", "R"), forward("W", "Z")];
    const path = revisionPath(["W"], "R", edges);
    expect(path[0]).toBe("W");
    expect([...path].sort()).toEqual(["W", "X", "Y"]); // Z does not lead back to R
  });

  it("always re-runs a target, even one that does not lead back to the source", () => {
    expect(revisionPath(["T"], "R", [forward("W", "R")])).toEqual(["T"]);
  });
});
