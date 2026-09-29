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
  ])("accepts %j", (text, route) => {
    expect(parseGatewayRoute(text)).toBe(route);
  });

  // JSON that does not parse: cut off (Max tokens), or with a trailing comma. Only a call that passes
  // the keys reads it (a reviewer's verdict); a gateway's route does not (see the test after this one).
  it.each([
    ['{"verdict":"REVISE","issues":[{"file":"a.ts"', ["verdict"], "revise"],
    ['{"verdict": "REVISE",}', ["verdict"], "revise"],
    ['{"route": "Backend", "why": "api",}', ["route"], "backend"],
  ])("accepts %j for the keys %j", (text, keys, route) => {
    expect(parseGatewayRoute(text, keys)).toBe(route);
  });

  it("routes nothing on JSON that did not parse, an echoed template, a list of routes or a quoted phrase", () => {
    // No route means every branch is followed. A quoted `"key": "value"` pair anywhere in the reply is
    // not a route: it would send the run down one branch on a template the model echoes, the first of
    // a list of objects, a phrase in prose, or an argument of a tool call.
    for (const reply of [
      '{"route": "ship" | "revise" | "escalate"}',
      '{"routes":[{"route":"a"},{"route":"b"}]}',
      'I will not use "action": "delete" here.',
      '{"tool_call":{"name":"grep","args":{"target":"src"}}}',
      '{"route": "Backend", "why": "api",}', // a trailing comma
      '{"verdict": "REVISE",}',
      '{"verdict":"REVISE","issues":[{"file":"a.ts"', // cut off
      '{"route":"backend","why":"api"',
    ]) {
      expect(parseGatewayRoute(reply), reply).toBeNull();
    }
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
    expect(parseGatewayRoute('{"verdict": 5,}', ["verdict"])).toBeNull();
    expect(parseGatewayRoute('{"verdict": "  ",}', ["verdict"])).toBeNull();
    expect(parseGatewayRoute('{"name": "x",}', ["verdict"])).toBeNull();
    expect(parseGatewayRoute('{"verdict": null, "route": "a",}', ["verdict", "route"])).toBe("a");
  });

  it("reads a parenthesized options list before the colon of a keyword only when given the keys", () => {
    for (const [text, verdict] of [
      ["Verdict (PASS/REVISE): PASS", "pass"],
      ["Verdict (PASS/REVISE): REVISE - intro", "revise"],
      ["**Verdict (PASS/REVISE):** REVISE", "revise"],
      ["**Verdict** (PASS/REVISE): **REVISE**", "revise"],
      ["Verdict (APPROVED / REVISE / ESCALATE): REVISE", "revise"], // blanks around the slashes
      ["Verdict (PASS or REVISE): PASS", "pass"], // any note, not only a slash
      ["Verdict (PASS/REVISE): PASS\nVerdict (PASS/REVISE): REVISE", "pass"], // the first, as for a plain keyword
    ] as const) {
      expect(parseGatewayRoute(text, ["verdict"]), text).toBe(verdict);
    }
    // Not a route: with no keys the reply names none, so a gateway follows every branch.
    expect(parseGatewayRoute("Verdict (PASS/REVISE): PASS")).toBeNull();
    expect(parseGatewayRoute("Route (backend/frontend): backend")).toBeNull();
    // The note must be closed on its line and followed by the colon.
    for (const text of ["Verdict (PASS/REVISE is next", "Verdict (PASS/REVISE) is REVISE", "Verdict (PASS/\nREVISE): REVISE"]) {
      expect(parseGatewayRoute(text, ["verdict"]), text).toBeNull();
    }
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

  it("lets an explicit verdict win over another key or keyword that comes first", () => {
    // Reading every key finds route, target or domain before verdict, and an earlier keyword before a later one.
    const replies = [
      '{"verdict":"REVISE","target":"frontend","issues":["a"]}',
      '{"verdict":"REVISE","domain":"frontend","issues":["a"]}',
      '{"verdict":"REVISE","route":"frontend","issues":["a"]}',
      // Cut off (no object closes around the verdict), with a `target:` in a message before the cut.
      '{"verdict":"REVISE","issues":[{"severity":"error","file":"src/a.ts","message":"Path traversal: target: user input reaches fs"},{"severity":"warn","file":"src/b.ts","message":"missing',
      "Action: rewrite the intro.\nVerdict: REVISE",
      "Route: frontend\nVerdict: REVISE",
      "Target: docs. **Verdict:** REVISE",
      "Domain: ui\nVerdict (PASS/REVISE): REVISE",
    ];
    for (const reply of replies) expect(fired(reply), reply).toEqual(["W"]);
    // A verdict that closes still closes.
    for (const reply of [
      '{"verdict":"PASS","target":"frontend","issues":[]}',
      "Action: rewrite the intro.\nVerdict: PASS",
      "Route: frontend\nVerdict (PASS/REVISE): PASS",
    ]) {
      expect(fired(reply), reply).toEqual([]);
    }
    // And it can name the edge to fire.
    const two = [feedback("R", "A", "code-fix"), feedback("R", "B", "rust-fix")];
    expect(fired('{"verdict":"rust-fix","target":"frontend"}', two)).toEqual(["B"]);
    expect(fired("Action: rewrite the intro.\nVerdict: rust-fix", two)).toEqual(["B"]);
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
      // An echo of the options that makes no choice leaves REVISE open, unless there is a verdict.
      "PASS/REVISE: fix the intro.\nVerdict: PASS",
      "Review complete.\nPASS/REVISE:\nVerdict: PASS",
      'Review complete.\nPASS/REVISE\n{"verdict":"PASS"}',
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

  it("reads the choice after an options label at the start of any line, as at the start of the reply", () => {
    for (const reply of [
      "Review complete.\nPASS/REVISE: REVISE",
      "Review complete.\n\n**PASS/REVISE:** REVISE - the intro is weak.",
      "Review complete.\n**PASS/REVISE**: REVISE",
      "Review complete.\n- Pass/Revise: revise",
      "Review complete.\n> PASS/REVISE:\nREVISE",
      "Review complete.\nAPPROVED/REVISE/ESCALATE: REVISE",
      // A choice that is not one of the options or a closing verdict, one that does not stand alone, or
      // none, leaves REVISE open.
      "Review complete.\nPASS/REVISE: fix the intro.",
      "Review complete.\nPASS/REVISE: Pass 1 of the review is done.",
      "Review complete.\nPASS/REVISE:",
      "Review complete.\nPASS/REVISE",
      "Review complete.\r\nPASS/REVISE\r\nThe intro is weak.", // Windows line breaks
    ]) {
      expect(fired(reply), reply).toEqual(["W"]);
    }
    for (const reply of [
      "Review complete.\nPASS/REVISE: PASS",
      "Review complete.\n**PASS/REVISE:** **APPROVED**",
      "Review complete.\nPASS/REVISE:\nPASS - all good",
      "Review complete.\n- Pass/Fail: PASS - all green",
      "Review complete.\nApprove/Revise: Approve", // the choice is one of its options
      "Review complete.\nPASS/REVISE: PASS\nPASS/REVISE: PASS",
      "Review complete.\r\nPASS/REVISE: PASS\r\n",
    ]) {
      expect(fired(reply), reply).toEqual([]);
    }
    // The choice can name the edge to fire.
    const two = [feedback("R", "A", "code-fix"), feedback("R", "B", "rust-fix")];
    expect(fired("Review complete.\nPASS/REVISE: rust-fix", two)).toEqual(["B"]);
  });

  it("reads an options label that has blanks around its slashes, as the example prompts write them", () => {
    // "Return APPROVED / REVISE / ESCALATE." is how the example reviewers are told to answer.
    for (const reply of [
      "APPROVED / REVISE / ESCALATE: REVISE",
      "PASS / REVISE: REVISE - intro",
      "PASS /REVISE: REVISE",
      "PASS/ REVISE: REVISE",
      "**PASS / REVISE:** REVISE",
      "Review complete.\nAPPROVED / REVISE / ESCALATE: REVISE",
      "Review complete.\n- Pass / Revise: revise",
      // A choice that is not one of the options, or none, leaves REVISE open.
      "PASS / REVISE: fix the intro.",
      "PASS / REVISE:",
      "PASS / REVISE",
      "Review complete.\nAPPROVED / REVISE / ESCALATE",
    ]) {
      expect(fired(reply), reply).toEqual(["W"]);
    }
    for (const reply of [
      "APPROVED / REVISE / ESCALATE: APPROVED",
      "APPROVED / REVISE / ESCALATE: ESCALATE",
      "PASS / REVISE: PASS - all good",
      "**PASS / REVISE:** **PASS**",
      "PASS / REVISE:\nPASS",
      "Pass / Fail: PASS - all green",
      "Review complete.\nAPPROVED / REVISE / ESCALATE: APPROVED",
      "Review complete.\nPASS / REVISE: PASS",
      "Review complete.\nApprove / Revise: Approve", // the choice is one of its options
      // The choice that opens the reply settles it, as a leading closing word does.
      "PASS / REVISE: PASS\nOptional follow-up action: revise the headline.",
      "APPROVED / REVISE / ESCALATE: APPROVED. Optional follow-up action: revise the headline.",
      // No verdict word among the options: nothing to read.
      "Input / output: fine",
      "Review complete.\nInput / output: fine",
    ]) {
      expect(fired(reply), reply).toEqual([]);
    }
    const two = [feedback("R", "A", "code-fix"), feedback("R", "B", "rust-fix")];
    expect(fired("Review complete.\nAPPROVED / REVISE / ESCALATE: rust-fix", two)).toEqual(["B"]);
  });

  it("keeps the blanks of an options label on one line, and takes a slash in prose for no label", () => {
    for (const reply of [
      "PASS\n/ REVISE: fix the intro.", // a line that starts with a slash is no label; PASS stands alone
      "Review complete.\nPASS\n/ REVISE: fix the intro.",
      "Approve / revise later, once the tests pass.", // text follows the options: not an echo
      "Review complete.\nApprove / revise later, once the tests pass.",
      "lib / revise.js looks correct.",
      "The change in lib / revise looks correct.",
      "All good. See ` / revise`.",
    ]) {
      expect(fired(reply), reply).toEqual([]);
    }
  });

  it("does not take a REVISE after a slash for a stated one", () => {
    // Before, a REVISE that followed a "/" anywhere counted: most of these revised.
    for (const reply of [
      "Verdict (PASS/REVISE): PASS",
      "Review complete.\nPASS/REVISE: PASS",
      "The change in lib/revise.js looks correct. No issues found.",
      "All good. See `/revise`.",
      "Looks fine. See https://example.com/revise for the guide.",
      "Looks fine. Compare src/revise/index.ts with docs/revise.md.",
      "lib/revise.js: looks correct", // a path with an extension is no options label
      "- src/revise/index.ts:12: renamed",
    ]) {
      expect(fired(reply), reply).toEqual([]);
    }
    // The options after a verdict's colon are read, not the ones before it.
    expect(fired("Verdict (PASS/REVISE): REVISE")).toEqual(["W"]);
    expect(fired("Verdict (APPROVED / REVISE / ESCALATE): REVISE - intro")).toEqual(["W"]);
    expect(fired("**Verdict (PASS/REVISE):** REVISE")).toEqual(["W"]);
  });

  it("revises on a REVISE line after a passing one, as it always did", () => {
    // A false revise costs up to two rounds; a false close ships work that needed changes. So a line that
    // opens with "Revise:" counts even when it says "none". This pins that behavior; it is not a goal.
    for (const reply of ["Overall: PASS\nRevise: none", "Looks good.\nRevise: nothing."]) {
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

  it("reads a REVISE that stands alone at the start of a later sentence or line", () => {
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
      // The options label at the start of every line, the choice after it, and the note before a colon.
      "a/b\n".repeat(12_500),
      "a/b:\n".repeat(10_000),
      "PASS/REVISE\n".repeat(5_000),
      "a/b: ".repeat(10_000),
      `a/b:${"\n".repeat(50_000)}!`,
      `a/b:${" ".repeat(50_000)}!`,
      `a/b:${"*".repeat(50_000)}`,
      `${" ".repeat(50_000)}a/b`,
      `${"-".repeat(50_000)}x`,
      `a/b${"*".repeat(50_000)}x`,
      "verdict (".repeat(30_000),
      `verdict (${"x".repeat(50_000)}`,
      `verdict (${"a/".repeat(25_000)}`,
      `verdict ${" ".repeat(50_000)}(x`,
      `verdict (x)${"*".repeat(50_000)}!`,
      `verdict (x)${" ".repeat(50_000)}!`,
      "verdict (x) ".repeat(5_000),
      // Blanks around the slashes of an options label: a long list, one that fails at its end, long runs of blanks.
      "a / ".repeat(12_500),
      "a /".repeat(16_000),
      "a  /  ".repeat(8_000) + "b!",
      `${"a".repeat(1_000)} / `.repeat(50),
      `${"a / ".repeat(1_000)}\n`.repeat(50),
      "a / b\n".repeat(8_000),
      `a${" ".repeat(50_000)}x`,
      `a${" ".repeat(50_000)}/`,
      `a /${" ".repeat(50_000)}!`,
      "a\t/\t".repeat(12_500),
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
