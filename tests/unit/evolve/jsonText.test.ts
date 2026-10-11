// @vitest-environment node
import { describe, expect, it } from "vitest";
import { jsonObjectsIn } from "@/evolve/jsonText";

describe("jsonObjectsIn: where the objects are", () => {
  it("reads an object in a ```json block", () => {
    expect(jsonObjectsIn('```json\n{"verdict": "accept", "reasons": []}\n```')).toEqual([{ verdict: "accept", reasons: [] }]);
  });

  it("reads a block whose lines end in CRLF", () => {
    expect(jsonObjectsIn('Here:\r\n```json\r\n{\r\n  "a": 1\r\n}\r\n```\r\nDone.')).toEqual([{ a: 1 }]);
  });

  it("reads an object in a plain ``` block, and in an indented one", () => {
    expect(jsonObjectsIn('```\n{"a": 1}\n```')).toEqual([{ a: 1 }]);
    expect(jsonObjectsIn('  ```json\n  {"a": 1}\n  ```  ')).toEqual([{ a: 1 }]);
  });

  it("reads a bare object", () => {
    expect(jsonObjectsIn('{"a": 1, "b": [1, 2, {"c": null}]}')).toEqual([{ a: 1, b: [1, 2, { c: null }] }]);
  });

  it("reads an object among prose, before it and after it", () => {
    const text = 'Here is my proposal.\n\n{"edits": []}\n\nI hope it helps. Tell me if {something} is unclear.';
    expect(jsonObjectsIn(text)).toEqual([{ edits: [] }]);
  });

  it("reads a fenced block among prose", () => {
    const text = 'I looked at the traces.\n```json\n{\n  "summary": "one",\n  "edits": []\n}\n```\nThat is all.';
    expect(jsonObjectsIn(text)).toEqual([{ summary: "one", edits: [] }]);
  });

  it("gives no object for a text without one, for an empty text, and for arrays and scalars", () => {
    expect(jsonObjectsIn("")).toEqual([]);
    expect(jsonObjectsIn("no json here, just words")).toEqual([]);
    expect(jsonObjectsIn("[1, 2, 3] and 42 and \"text\"")).toEqual([]);
  });

  it("finds the objects inside an array, as top-level spans", () => {
    expect(jsonObjectsIn('[{"a": 1}, {"b": 2}]')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("jsonObjectsIn: several objects", () => {
  it("returns them in the order of the text, fenced and bare mixed", () => {
    const text = [
      'First a draft: {"n": 1}',
      "",
      "```json",
      '{"n": 2}',
      "```",
      "",
      'and then {"n": 3} bare, and a second block:',
      "```",
      '{"n": 4}',
      "```",
      'end {"n": 5}',
    ].join("\n");
    expect(jsonObjectsIn(text).map((o) => (o as { n: number }).n)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns two objects of one block, and two bare ones side by side", () => {
    expect(jsonObjectsIn('```json\n{"a": 1}\n{"b": 2}\n```')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(jsonObjectsIn('{"a": 1}{"b": 2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("does not return an object nested in another one separately", () => {
    expect(jsonObjectsIn('{"outer": {"inner": {"deep": 1}}}')).toEqual([{ outer: { inner: { deep: 1 } } }]);
  });
});

describe("jsonObjectsIn: strings", () => {
  it("does not count braces inside strings", () => {
    expect(jsonObjectsIn('{"a": "}{", "b": "{", "c": "}"}')).toEqual([{ a: "}{", b: "{", c: "}" }]);
    expect(jsonObjectsIn('{"old": "if (x) { y(); }", "new": "if (x) {"}')).toEqual([{ old: "if (x) { y(); }", new: "if (x) {" }]);
  });

  it("does not count an escaped quote as the end of a string", () => {
    expect(jsonObjectsIn('{"a": "say \\"}\\" now", "b": 1}')).toEqual([{ a: 'say "}" now', b: 1 }]);
  });

  it("counts a quote after an escaped backslash as the end of the string", () => {
    expect(jsonObjectsIn('{"path": "C:\\\\dir\\\\", "b": 1} {"c": 2}')).toEqual([{ path: "C:\\dir\\", b: 1 }, { c: 2 }]);
  });

  it("keeps a ``` inside a string of a block whole", () => {
    const text = '```json\n{"new": "write it like ```code``` here", "n": 1}\n```';
    expect(jsonObjectsIn(text)).toEqual([{ new: "write it like ```code``` here", n: 1 }]);
  });

  it("keeps escaped line breaks and unicode in a string", () => {
    expect(jsonObjectsIn('{"text": "line one\\nline two \\u00e9 🌍"}')).toEqual([{ text: "line one\nline two é 🌍" }]);
  });
});

describe("jsonObjectsIn: spans that are not JSON", () => {
  it("skips a span that does not parse, and goes on with the next", () => {
    expect(jsonObjectsIn('{ not json } then {"ok": 1}')).toEqual([{ ok: 1 }]);
    expect(jsonObjectsIn('{"a": } {"b": 2}')).toEqual([{ b: 2 }]);
    expect(jsonObjectsIn("{'single': 'quotes'} {\"b\": 2}")).toEqual([{ b: 2 }]);
    expect(jsonObjectsIn('{"a": 1,} {"b": 2}')).toEqual([{ b: 2 }]);
  });

  it("skips code in a block", () => {
    expect(jsonObjectsIn("```js\nfunction f() { return 1; }\n```")).toEqual([]);
  });

  it("skips a { that never closes, and still finds the object after it", () => {
    expect(jsonObjectsIn('use { to open. {"ok": true}')).toEqual([{ ok: true }]);
    expect(jsonObjectsIn('{ {"ok": true}')).toEqual([{ ok: true }]);
    expect(jsonObjectsIn('{"cut": "off')).toEqual([]);
  });

  it("is not thrown off by a quote in the prose before an object", () => {
    expect(jsonObjectsIn('He said "hello and then {"ok": 1}')).toEqual([{ ok: 1 }]);
  });

  it("is not thrown off by a stray { before a block, or a stray } after it", () => {
    const text = 'see { for details.\n```json\n{"ok": 1}\n```\nand } that is it';
    expect(jsonObjectsIn(text)).toEqual([{ ok: 1 }]);
  });

  it("reads the object of a block that was cut off before its closing fence", () => {
    expect(jsonObjectsIn('```json\n{"ok": 1}\n')).toEqual([{ ok: 1 }]);
  });

  it("does not read a half-written object", () => {
    expect(jsonObjectsIn('```json\n{"edits": [{"id": "C1"')).toEqual([]);
  });

  it("keeps __proto__ as an ordinary key", () => {
    const [object] = jsonObjectsIn('{"__proto__": {"x": 1}}');
    expect(Object.keys(object as object)).toEqual(["__proto__"]);
    expect(({} as { x?: number }).x).toBeUndefined();
  });
});
