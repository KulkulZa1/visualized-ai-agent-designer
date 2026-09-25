import { describe, it, expect } from "vitest";
import { applyEdit } from "@/services/execution/editFile";

describe("applyEdit", () => {
  it("replaces a snippet that occurs once", () => {
    expect(applyEdit("const x = 1;\nconst y = 2;\n", "x = 1", "x = 10"))
      .toEqual({ ok: true, content: "const x = 10;\nconst y = 2;\n", replacements: 1 });
  });

  it("refuses a snippet that is not in the file", () => {
    const result = applyEdit("const x = 1;\n", "x = 2", "x = 3");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/not found/);
  });

  it("refuses an ambiguous snippet unless replace_all is set", () => {
    const text = "a();\na();\n";
    const refused = applyEdit(text, "a()", "b()");
    expect(!refused.ok && refused.error).toMatch(/occurs 2 times/);
    expect(applyEdit(text, "a()", "b()", true)).toEqual({ ok: true, content: "b();\nb();\n", replacements: 2 });
  });

  it("matches a \\n snippet in a \\r\\n file and keeps the file's line endings", () => {
    expect(applyEdit("one\r\ntwo\r\nthree\r\n", "one\ntwo", "one\n2"))
      .toEqual({ ok: true, content: "one\r\n2\r\nthree\r\n", replacements: 1 });
  });

  it("refuses an empty or unchanged snippet", () => {
    expect(applyEdit("x", "", "y").ok).toBe(false);
    expect(applyEdit("x", "x", "x").ok).toBe(false);
  });

  it("inserts the replacement literally, even with $ patterns", () => {
    expect(applyEdit("price", "price", "$& $1 $$")).toEqual({ ok: true, content: "$& $1 $$", replacements: 1 });
  });
});
