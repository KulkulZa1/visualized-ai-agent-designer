import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";
import { firedFeedbackEdges, parseGatewayRoute, revisionPath } from "@/services/execution/routing";

const forward = (source: string, target: string, label?: string): Edge =>
  ({ id: `${source}-${target}`, source, target, data: label ? { label } : undefined }) as Edge;
const feedback = (source: string, target: string, label?: string): Edge =>
  ({ id: `fb-${source}-${target}`, source, target, data: { edgeKind: "feedback", label } }) as Edge;

// Replies whose JSON object sits next to braces that are not JSON.
const ROUTE_WITH_TRAILING_PROSE = '{"route":"backend"} (see {notes})';
const ROUTE_AFTER_CODE = [
  "Here is the helper I would use:",
  "```ts",
  'function pick(x: string) { if (x) { return {"a": 1}; } return null; }',
  "```",
  '{"route":"backend"}',
].join("\n");
const ROUTE_BEFORE_CODE = ['{"route":"backend"}', "```js", "function f() { return 1; }", "```"].join("\n");

describe("parseGatewayRoute", () => {
  it.each([
    ['{"route":"Backend"}', "backend"],
    ['{"target":"docs"}', "docs"],
    ['{"domain":"ui"}', "ui"],
    ['{"verdict":"REVISE"}', "revise"],
    ['{"action":"ship"}', "ship"],
    ['{ "route": "  a  " }', "a"],
    ['{"route":"a","verdict":"b"}', "a"],
    ['```json\n{"route":"backend"}\n```', "backend"],
    ["Route: backend", "backend"],
    ['route: "ui"', "ui"],
    ["Verdict: revise\nThe intro is weak.", "revise"],
    ["The intro is weak.\nVerdict: revise", "revise"],
  ])("accepts %j", (text, route) => {
    expect(parseGatewayRoute(text)).toBe(route);
  });

  it("finds the object when prose with braces follows it", () => {
    expect(parseGatewayRoute(ROUTE_WITH_TRAILING_PROSE)).toBe("backend");
  });

  it("finds the object after a code block that has braces", () => {
    expect(parseGatewayRoute(ROUTE_AFTER_CODE)).toBe("backend");
  });

  it("finds the object when code follows it", () => {
    expect(parseGatewayRoute(ROUTE_BEFORE_CODE)).toBe("backend");
  });

  it("finds the object after a lone opening brace in the prose", () => {
    expect(parseGatewayRoute('Blocks open with { in this language. {"route":"backend"}')).toBe("backend");
  });

  it("ignores braces, quotes and escapes inside JSON strings", () => {
    expect(parseGatewayRoute('{"route":"backend","why":"handles } and { and \\"quoted\\" text"} (see {notes})'))
      .toBe("backend");
    // The string ends in an escaped backslash: the quote after it closes the string.
    expect(parseGatewayRoute('{"route":"backend","dir":"C:\\\\"} then {x}')).toBe("backend");
  });

  it("takes the last object that carries a routing key", () => {
    expect(parseGatewayRoute('{"route":"a"} and on reflection {"route":"b"}')).toBe("b");
    expect(parseGatewayRoute('{"route":"a"}\n```json\n{"name":"example"}\n```')).toBe("a");
    expect(parseGatewayRoute('{"route":"a"} {"route":5} {"route":"  "}')).toBe("a");
  });

  it("does not read a key of an object nested in another object", () => {
    expect(parseGatewayRoute('{"route":"a","meta":{"route":"b"}}')).toBe("a");
  });

  it("returns null when no object, keyword or route names one", () => {
    expect(parseGatewayRoute("")).toBeNull();
    expect(parseGatewayRoute("No decision here {see notes}")).toBeNull();
    expect(parseGatewayRoute('{"route":5}')).toBeNull();
    expect(parseGatewayRoute('{"name":"x"}')).toBeNull();
  });

  it("does not take quadratic time on a runaway reply of objects that never close", () => {
    // Scanning from every `{"` to the end of the text takes seconds for these; the scan is bounded.
    const started = performance.now();
    expect(parseGatewayRoute('{"'.repeat(20_000))).toBeNull();
    expect(parseGatewayRoute('{"a":'.repeat(10_000))).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
});

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

  it("reads a verdict object that has braces that are not JSON around it", () => {
    expect(fired('{"verdict":"REVISE"} (see {notes})')).toEqual(["W"]);
    expect(fired(ROUTE_AFTER_CODE.replace('{"route":"backend"}', '{"verdict":"REVISE"}'))).toEqual(["W"]);
    expect(fired(ROUTE_BEFORE_CODE.replace('{"route":"backend"}', '{"verdict":"REVISE"}'))).toEqual(["W"]);
    expect(fired(ROUTE_AFTER_CODE.replace('{"route":"backend"}', '{"verdict":"APPROVED"}'))).toEqual([]);
    expect(fired(ROUTE_BEFORE_CODE.replace('{"route":"backend"}', '{"verdict":"APPROVED"}'))).toEqual([]);
  });

  it("uses the last verdict object", () => {
    expect(fired('{"verdict":"APPROVED"} On reflection: {"verdict":"REVISE"}')).toEqual(["W"]);
    expect(fired('{"verdict":"REVISE"} On reflection: {"verdict":"APPROVED"}')).toEqual([]);
  });

  it("lets an explicit leading verdict win over a keyword later in the reply", () => {
    const replies = [
      "APPROVED. Optional follow-up action: revise the headline.",
      "**APPROVED** — Optional follow-up action: revise the headline.",
      "> Approved\n\nOptional follow-up action: revise the headline.",
      "PASS\nOptional follow-up action: revise the headline.",
      "ESCALATE: needs a human. Next action: revise the headline.",
      "approved - target: revise",
      'APPROVED. Details: {"action":"revise"}',
    ];
    for (const reply of replies) expect(fired(reply), reply).toEqual([]);
  });

  it("lets an explicit leading verdict win over a later label too", () => {
    const two = [feedback("R", "A", "code-fix"), feedback("R", "B", "rust-fix")];
    expect(fired("APPROVED. Optional follow-up action: rust-fix", two)).toEqual([]);
  });

  it("still fires on a leading REVISE, whatever a later keyword says", () => {
    expect(fired("REVISE — the intro is weak. Optional follow-up action: none.")).toEqual(["W"]);
    expect(fired("**Revise**: the headline. Verdict: approved by the previous reviewer.")).toEqual(["W"]);
  });

  it("lets a leading REVISE be narrowed by a later keyword that names a feedback edge", () => {
    const two = [feedback("R", "A", "code-fix"), feedback("R", "B", "rust-fix")];
    expect(fired("REVISE — target: rust-fix", two)).toEqual(["B"]);
    expect(fired("REVISE: the Rust side is wrong.\nRoute: rust-fix", two)).toEqual(["B"]);
    expect(fired("REVISE. Optional follow-up action: rust-fix", two)).toEqual(["B"]);
    expect(fired('REVISE {"target":"rust-fix"}', two)).toEqual(["B"]);
    expect(fired("REVISE: both need work.", two)).toEqual(["A", "B"]);
  });

  it("does not treat FAIL as a closing verdict: it may still name the edge to fire", () => {
    // Only APPROVED, PASS and ESCALATE close a review. A Tester's FAIL leads to its "fix" edge
    // when it says so, as before.
    const fix = [feedback("R", "W", "fix")];
    expect(fired("FAIL — the tests break. Action: fix", fix)).toEqual(["W"]);
    expect(fired("FAIL — the tests break.", fix)).toEqual([]);
  });

  it("reads a `Verdict:` keyword ahead of a later action phrase", () => {
    expect(fired("Verdict: APPROVED. Optional follow-up action: revise the headline.")).toEqual([]);
  });

  it("does not let a leading word that is not a verdict hide a later verdict", () => {
    expect(fired("The intro is weak.\nVerdict: revise")).toEqual(["W"]);
    expect(fired("Review notes\nRoute: revise")).toEqual(["W"]);
    expect(fired('```json\n{"verdict":"REVISE"}\n```')).toEqual(["W"]);
    expect(fired('{"pass": false, "verdict":"REVISE"}')).toEqual(["W"]);
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
