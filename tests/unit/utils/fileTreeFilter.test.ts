import { describe, it, expect } from "vitest";
import { filterFileTree } from "@/utils/fileTreeFilter";
import type { FileTreeEntry } from "@/types/filesystem";

const file = (path: string): FileTreeEntry => ({ name: path.split("/").at(-1)!, path, isDirectory: false });
const dir = (path: string, children: FileTreeEntry[]): FileTreeEntry =>
  ({ name: path.split("/").at(-1)!, path, isDirectory: true, children });

const tree: FileTreeEntry[] = [
  file("AGENTS.md"),
  dir("src", [file("src/sum.mjs"), file("src/util.mjs"), dir("src/lib", [file("src/lib/Summary.ts")])]),
  dir("docs", [file("docs/guide.md")]),
  file("sum.test.mjs"),
];
const paths = (entries: FileTreeEntry[]): string[] =>
  entries.flatMap((e) => [e.path, ...paths(e.children ?? [])]);

describe("filterFileTree", () => {
  it("keeps the whole tree without a query", () => {
    expect(filterFileTree(tree, "  ")).toBe(tree);
  });

  it("keeps the files whose name matches, in any case, inside the folders that hold them", () => {
    expect(paths(filterFileTree(tree, "SUM"))).toEqual(
      ["src", "src/sum.mjs", "src/lib", "src/lib/Summary.ts", "sum.test.mjs"]);
  });

  it("keeps everything in a folder whose name matches", () => {
    expect(paths(filterFileTree(tree, "docs"))).toEqual(["docs", "docs/guide.md"]);
  });

  it("returns nothing when no name matches", () => {
    expect(filterFileTree(tree, "nope")).toEqual([]);
  });
});
