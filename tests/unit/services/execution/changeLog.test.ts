import { describe, it, expect } from "vitest";
import { lineCounts, normalizeChangePath, recordChange } from "@/services/execution/changeLog";

describe("recordChange", () => {
  it("keeps the first before, the latest after, and every agent once", () => {
    let log = recordChange([], "src/a.ts", "v1", "v2", "Coder");
    log = recordChange(log, "src\\a.ts", "v2", "v3", "Helper");
    log = recordChange(log, "./src/a.ts", "v3", "v4", "Coder");
    expect(log).toEqual([{ path: "src/a.ts", before: "v1", after: "v4", agents: ["Coder", "Helper"], edits: 3 }]);
  });

  it("drops a file changed back to its original content", () => {
    const log = recordChange(recordChange([], "a.ts", "same", "edited", "Coder"), "a.ts", "edited", "same", "Coder");
    expect(log).toEqual([]);
  });

  it("records a created file with no before", () => {
    expect(recordChange([], "new.ts", null, "x", "Coder"))
      .toEqual([{ path: "new.ts", before: null, after: "x", agents: ["Coder"], edits: 1 }]);
  });
});

describe("normalizeChangePath", () => {
  it("uses / separators without a leading ./", () => {
    expect(normalizeChangePath(" .\\src\\a.ts ")).toBe("src/a.ts");
  });
});

describe("lineCounts", () => {
  it("counts added and removed lines", () => {
    expect(lineCounts("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({ added: 2, removed: 1 });
    expect(lineCounts(null, "x\ny\n")).toEqual({ added: 2, removed: 0 });
  });
});
