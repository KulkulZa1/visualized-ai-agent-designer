import { describe, it, expect } from "vitest";
import { findChange, lineCounts, normalizeChangePath, recordChange } from "@/services/execution/changeLog";

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

describe("findChange", () => {
  const logOf = (path: string) => recordChange([], path, "old", "new", "Coder");

  it.each([
    ["the same path", "/ws", "scripts/gate.sh", "scripts/gate.sh"],
    ["a relative change asked for by its absolute path", "/ws", "scripts/gate.sh", "/ws/scripts/gate.sh"],
    ["an absolute change asked for by its relative path", "/ws", "/ws/scripts/gate.sh", "scripts/gate.sh"],
    ["a workspace path with a trailing separator", "/ws/", "/ws/scripts/gate.sh", "scripts/gate.sh"],
    ["dot segments and doubled separators", "/ws", "./scripts//gate.sh", "scripts/./x/../gate.sh"],
    ["a path that leaves the workspace and comes back", "/ws", "scripts/gate.sh", "../ws/scripts/gate.sh"],
    ["a different case", "/ws", "Scripts/GATE.sh", "scripts/gate.sh"],
    ["Windows separators, drive letter and case", "C:\\Users\\Me\\Proj", "scripts\\gate.sh", "c:/users/me/proj/Scripts/Gate.SH"],
    ["an absolute Windows change asked for by its relative path", "C:\\Users\\Me\\Proj", "C:\\Users\\Me\\Proj\\Scripts\\Gate.sh", "scripts/gate.sh"],
    ["a path spelled with other separators and dot segments, without a workspace", null, ".\\scripts\\gate.sh", "scripts/./gate.sh"],
  ])("finds %s", (_what, workspace, recorded, asked) => {
    const log = logOf(recorded);
    expect(findChange(log, asked, workspace)).toEqual(log[0]);
  });

  it.each([
    ["another file with the same start", "/ws", "scripts/gate.sh", "scripts/gate.sh.bak"],
    ["the same name in another folder", "/ws", "scripts/gate.sh", "other/scripts/gate.sh"],
    ["a path outside a workspace that has the same start", "/ws", "scripts/gate.sh", "/ws2/scripts/gate.sh"],
    ["a path above the workspace", "/ws", "scripts/gate.sh", "../scripts/gate.sh"],
    ["another workspace's file", "C:\\Users\\Me\\Proj", "scripts/gate.sh", "C:\\Users\\Me\\Other\\scripts\\gate.sh"],
  ])("does not find %s", (_what, workspace, recorded, asked) => {
    expect(findChange(logOf(recorded), asked, workspace)).toBeUndefined();
  });

  it("finds nothing in an empty log", () => {
    expect(findChange([], "scripts/gate.sh", "/ws")).toBeUndefined();
  });
});

describe("lineCounts", () => {
  it("counts added and removed lines", () => {
    expect(lineCounts("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({ added: 2, removed: 1 });
    expect(lineCounts(null, "x\ny\n")).toEqual({ added: 2, removed: 0 });
  });
});
