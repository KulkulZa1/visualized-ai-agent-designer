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
    // Markdown around the keyword or its value.
    ["**Verdict:** REVISE - intro is weak.", "revise"],
    ["**Verdict**: REVISE", "revise"],
    ["_Route_: backend", "backend"],
    ["Verdict: **REVISE**", "revise"],
    ["Verdict: `REVISE`", "revise"],
    ["**Verdict:** **REVISE**", "revise"],
    // JSON that does not parse: cut off (Max tokens), or with a trailing comma.
    ['{"verdict":"REVISE","issues":[{"file":"a.ts"', "revise"],
    ['{"verdict": "REVISE",}', "revise"],
    ['{"route": "Backend", "why": "api",}', "backend"],
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

  it("reads only the given keys when asked", () => {
    expect(parseGatewayRoute('{"route":"a","verdict":"b"}', ["verdict"])).toBe("b");
    expect(parseGatewayRoute('{"verdict":"a"} then {"route":"b"}', ["verdict"])).toBe("a");
    expect(parseGatewayRoute("Route: a. Verdict: b", ["verdict"])).toBe("b");
    expect(parseGatewayRoute('{"route":"a"} and {"action":"c"}', ["verdict"])).toBeNull();
    expect(parseGatewayRoute("Route: a. Action: c", ["verdict"])).toBeNull();
    expect(parseGatewayRoute("Route: a. Action: c", ["route", "action"])).toBe("a");
    expect(parseGatewayRoute('{"verdict":"REVISE","issues":[{"file":"a.ts"', ["verdict"])).toBe("revise");
    expect(parseGatewayRoute('{"route":"a","verdict":"b",}', ["verdict"])).toBe("b");
    expect(parseGatewayRoute('{"route":"a",}', ["verdict"])).toBeNull();
  });

  it("reads a quoted pair of JSON that did not parse only when its value is a string", () => {
    expect(parseGatewayRoute('{"verdict": 5,}')).toBeNull();
    expect(parseGatewayRoute('{"verdict": "  ",}')).toBeNull();
    expect(parseGatewayRoute('{"name": "x",}')).toBeNull();
    expect(parseGatewayRoute('{"verdict": null, "route": "a",}')).toBe("a");
  });

  it("takes the keys it is given literally, not as a pattern", () => {
    expect(parseGatewayRoute("a.b: x", ["a.b"])).toBe("x");
    expect(parseGatewayRoute("aXb: x", ["a.b"])).toBeNull();
    expect(parseGatewayRoute('{"a.b": "x",}', ["a.b"])).toBe("x");
    expect(parseGatewayRoute('{"aXb": "x",}', ["a.b"])).toBeNull();
    expect(parseGatewayRoute("f(x: y", ["f(x"])).toBe("y"); // a pattern with an open group would throw
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

  it("revises on an explicit verdict that follows a leading closing word", () => {
    // A JSON `verdict` or a "Verdict:" keyword settles it; only that, not an `action` or a `target`.
    const replies = [
      'PASS\n{"verdict":"REVISE","reasons":["x"]}',
      'APPROVED. {"verdict":"REVISE"}',
      "APPROVED\nVerdict: REVISE - the intro is weak.",
      "**PASS** — Verdict: revise",
    ];
    for (const reply of replies) expect(fired(reply), reply).toEqual(["W"]);
  });

  it("does not take a first word for a verdict when another word, a question or an alternative follows it", () => {
    const replies = [
      "Pass 1 of the review is done. Verdict: REVISE - intro is weak.",
      "Approved changes so far: 3 of 5.\nVerdict: REVISE",
      "PASS/REVISE: REVISE - intro", // an echo of "Return PASS or REVISE"
      "APPROVED/REVISE: REVISE - intro",
      "Escalate? Not needed. REVISE: fix the intro.",
      // No explicit verdict here: the digit, or the word, after the first word is what decides.
      "Pass 1 of the review is done. REVISE: fix the intro.",
      "Approved changes so far: 3 of 5. REVISE: fix the intro.",
    ];
    for (const reply of replies) expect(fired(reply), reply).toEqual(["W"]);
  });

  it("reads a verdict however markdown wraps it, and one in JSON that did not parse", () => {
    const replies = [
      "Pass 1 of the review is done. **Verdict:** REVISE - intro is weak.",
      "Approved changes so far: 3 of 5.\n**Verdict**: REVISE",
      "PASS\n**Verdict:** REVISE",
      "Verdict: **REVISE**",
      "Verdict: `REVISE`",
      "**Verdict:** **REVISE**",
      '{"verdict":"REVISE","issues":[{"file":"a.ts"', // cut off at Max tokens
      '{"verdict": "REVISE",}', // a trailing comma
      'PASS\n{"verdict":"REVISE","issues":[{"file":"a.ts"',
    ];
    for (const reply of replies) expect(fired(reply), reply).toEqual(["W"]);
    // Wrapped the same way, a verdict that closes still closes.
    for (const reply of ["**Verdict:** PASS", "PASS\n**Verdict:** **APPROVED**", '{"verdict": "PASS",}']) {
      expect(fired(reply), reply).toEqual([]);
    }
  });

  it("lets an explicit verdict decide over a REVISE that only opens a sentence, a key or an option", () => {
    const replies = [
      '{\n  "verdict": "PASS",\n  "revise": []\n}',
      "Notes:\n- Revise: none\n- Verdict: PASS",
      "Notes:\n- Revise: none\n- **Verdict:** PASS",
      "PASS/REVISE: PASS - all good",
      "APPROVED/REVISE: APPROVED",
    ];
    for (const reply of replies) expect(fired(reply), reply).toEqual([]);
    // Without a verdict of its own, the REVISE still counts.
    expect(fired('{\n  "notes": "ok",\n  "revise": ["the intro"]\n}')).toEqual(["W"]);
    expect(fired("Notes:\n- Revise: the intro\n- Tone: fine")).toEqual(["W"]);
  });

  it("reads the choice that follows an echo of the options as the first word", () => {
    for (const reply of ["PASS/REVISE: PASS", "Pass/Fail: PASS - all green", "**PASS/REVISE:** **APPROVED**", "PASS/REVISE:\nPASS"]) {
      expect(fired(reply), reply).toEqual([]);
    }
    // A choice that is not one of them, or none, leaves both options open: it revises.
    for (const reply of ["PASS/REVISE: fix the intro.", "PASS/REVISE:", "PASS/REVISE", "**PASS/REVISE:** REVISE"]) {
      expect(fired(reply), reply).toEqual(["W"]);
    }
  });

  it("still closes on a leading closing verdict that stands alone", () => {
    const replies = [
      "PASS",
      "Approved.",
      "APPROVED!\nGreat work",
      "Pass: all checks green",
      "**PASS** — nothing to revise.",
      'APPROVED. Details: {"action":"revise"}',
      'PASS\n{"verdict":"PASS"}',
      "APPROVED. Revise: none.",
    ];
    for (const reply of replies) expect(fired(reply), reply).toEqual([]);
  });

  it("closes when a first word that is no verdict has nothing after it that asks for changes", () => {
    for (const reply of [
      "Escalate? Not needed.",
      "Approved changes so far: 3 of 5.",
      "Pass 1 of the review is done.",
      "PASS/FAIL: PASS - all green",
    ]) {
      expect(fired(reply), reply).toEqual([]);
    }
  });

  it("reads a REVISE that stands alone at the start of a later sentence, line or alternative", () => {
    for (const reply of [
      "Here is my review.\n\nREVISE - the intro is weak.",
      "Review notes.\nRevise: the intro is weak.",
      "Escalate? Not needed.\nREVISE\nThe intro is weak.",
      "Looks fine. **Revise**: the intro.",
    ]) {
      expect(fired(reply), reply).toEqual(["W"]);
    }
    // Not one inside a sentence, one followed by a word or a question, or another word.
    for (const reply of [
      "I think it is fine. No need to revise: the draft is good.",
      "Looks fine. Revise the headline if you like.",
      "Looks fine. Should we revise? No.",
      "The revised draft is fine. Revised: yes.",
      "Looks fine. Revise-me: yes.",
    ]) {
      expect(fired(reply), reply).toEqual([]);
    }
  });

  it("does not take quadratic time on a runaway reply", () => {
    // Scanning on from every newline or full stop over the runs that follow takes seconds for these.
    const started = performance.now();
    for (const reply of [
      "\n".repeat(50_000),
      ". ".repeat(25_000),
      `.${" ".repeat(50_000)}x`,
      ". revise x".repeat(20_000),
      "\nrevise".repeat(10_000) + " ".repeat(50_000) + "word",
      `APPROVED${" ".repeat(50_000)}x`,
      `APPROVED${"*_ ".repeat(20_000)}x`,
      // The keyword and quoted-pair fallbacks, and the options label.
      `verdict${"*".repeat(50_000)}x`,
      `verdict:${"_".repeat(50_000)}!`,
      `verdict: ${"`\"'".repeat(20_000)}!`,
      `"verdict"${" ".repeat(50_000)}x`,
      `"verdict":"${"x".repeat(50_000)}`,
      '"verdict":"'.repeat(5_000),
      "a/".repeat(25_000),
      `${"a".repeat(1_000)}/`.repeat(50),
    ]) {
      fired(reply);
    }
    expect(performance.now() - started).toBeLessThan(500);
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
