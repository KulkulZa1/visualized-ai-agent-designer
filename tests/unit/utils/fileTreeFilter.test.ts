import { describe, it, expect } from "vitest";
import { filterFileTree, searchFileTree } from "@/utils/fileTreeFilter";
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

describe("searchFileTree", () => {
  const filesIn = (entries: FileTreeEntry[]): string[] =>
    entries.flatMap((e) => e.isDirectory ? filesIn(e.children ?? []) : [e.path]);

  it("returns the tree as it is, with nothing counted, without a query", () => {
    const result = searchFileTree(tree, "  ", 2);
    expect(result.tree).toBe(tree);
    expect(result.total).toBe(0);
  });

  it("lists every match, as filterFileTree does, while there are no more than the limit", () => {
    const result = searchFileTree(tree, "SUM", 3);
    expect(result.tree).toEqual(filterFileTree(tree, "SUM"));
    expect(result.total).toBe(3);
  });

  it("keeps the first files in tree order and counts them all", () => {
    const result = searchFileTree(tree, "SUM", 2);
    expect(paths(result.tree)).toEqual(["src", "src/sum.mjs", "src/lib", "src/lib/Summary.ts"]);
    expect(result.total).toBe(3);
  });

  it("leaves out a folder that holds none of the shown files", () => {
    const result = searchFileTree(tree, "SUM", 1);
    expect(paths(result.tree)).toEqual(["src", "src/sum.mjs"]); // src/lib and sum.test.mjs are cut
    expect(result.total).toBe(3);
  });

  it("cuts the files of a folder whose name matches too: they are listed, so they count", () => {
    const result = searchFileTree(tree, "src", 2);
    expect(paths(result.tree)).toEqual(["src", "src/sum.mjs", "src/util.mjs"]);
    expect(result.total).toBe(3);
  });

  it("keeps an empty folder whose name matches, and finds nothing for a name that matches nothing", () => {
    expect(paths(searchFileTree([dir("data", []), file("a.txt")], "data", 1).tree)).toEqual(["data"]);
    expect(searchFileTree(tree, "nope", 5)).toEqual({ tree: [], total: 0 });
  });

  it("leaves the tree it was given as it was", () => {
    const before = JSON.stringify(tree);
    searchFileTree(tree, "SUM", 1);
    expect(JSON.stringify(tree)).toBe(before);
  });

  it("caps a big workspace: the shown files are the limit, and the total is all of them", () => {
    const big = Array.from({ length: 20 }, (_, d) =>
      dir(`pkg${d}`, Array.from({ length: 20 }, (_, s) =>
        dir(`pkg${d}/sub${s}`, Array.from({ length: 50 }, (_, f) => file(`pkg${d}/sub${s}/file${f}.txt`))))));

    const result = searchFileTree(big, "e", 500);

    expect(result.total).toBe(20_000);
    expect(filesIn(result.tree)).toHaveLength(500);
    expect(filesIn(result.tree)[0]).toBe("pkg0/sub0/file0.txt");
    // Only the folders that hold shown files are left: 500 files fill pkg0's sub0..sub9.
    expect(result.tree.map((e) => e.path)).toEqual(["pkg0"]);
    expect(result.tree[0].children).toHaveLength(10);
  });
});
