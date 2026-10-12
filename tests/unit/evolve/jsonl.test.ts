// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendJsonl, readJsonl } from "@/evolve/jsonl";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "evolve-jsonl-"));
  dirs.push(dir);
  return dir;
}

describe("readJsonl", () => {
  it("gives [] for a file that does not exist", () => {
    expect(readJsonl(join(folder(), "none.jsonl"))).toEqual([]);
  });

  it("gives [] for an empty file and for one of blank lines", () => {
    const file = join(folder(), "a.jsonl");
    writeFileSync(file, "");
    expect(readJsonl(file)).toEqual([]);
    writeFileSync(file, "\n  \n\t\n");
    expect(readJsonl(file)).toEqual([]);
  });

  it("parses each non-empty line, in order", () => {
    const file = join(folder(), "a.jsonl");
    writeFileSync(file, '{"a":1}\n\n{"b":[1,2]}\n  {"c":null}  \n');

    expect(readJsonl(file)).toEqual([{ a: 1 }, { b: [1, 2] }, { c: null }]);
  });

  it("reads CRLF line ends, and a last line with no end", () => {
    const file = join(folder(), "a.jsonl");
    writeFileSync(file, '{"a":1}\r\n{"b":2}');

    expect(readJsonl(file)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("throws a line that is not JSON, naming the file and the line counted from 1, blank lines included", () => {
    const file = join(folder(), "a.jsonl");
    writeFileSync(file, '{"a":1}\n\nnot json\n{"b":2}\n');

    expect(() => readJsonl(file)).toThrow(`${file} line 3 is not JSON: `);
  });

  it("says why in the error: it carries the parser's message", () => {
    const file = join(folder(), "a.jsonl");
    writeFileSync(file, '{"a":\n');

    expect(() => readJsonl(file)).toThrow(/line 1 is not JSON: .+/);
  });

  it("throws the first bad line", () => {
    const file = join(folder(), "a.jsonl");
    writeFileSync(file, "{bad\nalso bad\n");

    expect(() => readJsonl(file)).toThrow("line 1 is not JSON");
  });

  it("keeps a line that is JSON but not an object", () => {
    const file = join(folder(), "a.jsonl");
    writeFileSync(file, '5\n"s"\nnull\n[1]\n');

    expect(readJsonl(file)).toEqual([5, "s", null, [1]]);
  });

  it("does not take the separators U+2028 and U+2029 inside a string for line ends", () => {
    const file = join(folder(), "a.jsonl");
    appendJsonl(file, [{ detail: "one two three" }, { detail: "next" }]);

    expect(readJsonl(file)).toEqual([{ detail: "one two three" }, { detail: "next" }]);
  });
});

describe("appendJsonl", () => {
  it("writes one line per record, each ending in a newline", () => {
    const file = join(folder(), "a.jsonl");
    appendJsonl(file, [{ a: 1 }, { b: "x" }]);

    expect(readFileSync(file, "utf8")).toBe('{"a":1}\n{"b":"x"}\n');
  });

  it("appends to what is there", () => {
    const file = join(folder(), "a.jsonl");
    appendJsonl(file, [{ a: 1 }]);
    appendJsonl(file, [{ b: 2 }, { c: 3 }]);

    expect(readJsonl(file)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("makes the folders of the file", () => {
    const file = join(folder(), "r1", "deeper", "a.jsonl");
    appendJsonl(file, [{ a: 1 }]);

    expect(readJsonl(file)).toEqual([{ a: 1 }]);
  });

  it("makes the folder but writes no file for no records, not even an empty one", () => {
    const dir = folder();
    const file = join(dir, "sub", "a.jsonl");
    appendJsonl(file, []);

    expect(existsSync(join(dir, "sub"))).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(readJsonl(file)).toEqual([]);
  });

  it("leaves what is there as it is for no records", () => {
    const file = join(folder(), "a.jsonl");
    appendJsonl(file, [{ a: 1 }]);
    appendJsonl(file, []);

    expect(readFileSync(file, "utf8")).toBe('{"a":1}\n');
  });

  it("round-trips text that holds line ends, quotes and non-ASCII characters", () => {
    const file = join(folder(), "a.jsonl");
    const record = { text: 'line one\nline "two"\r\n\ttab', unicode: "é — 日本語 😀", empty: "", nested: { list: [1, null, true] } };
    appendJsonl(file, [record]);

    expect(readFileSync(file, "utf8").split("\n")).toHaveLength(2);
    expect(readJsonl(file)).toEqual([record]);
  });
});
