import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/layout/Sidebar";
import { mockInvokeHandler } from "@/ipc/mockTauri";
import { useWorkflowStore } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { searchFileTree } from "@/utils/fileTreeFilter";
import type { FileTreeEntry } from "@/types/filesystem";

// The real search, counted: how often the tree is filtered is part of what is tested.
vi.mock("@/utils/fileTreeFilter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/fileTreeFilter")>();
  return { ...actual, searchFileTree: vi.fn(actual.searchFileTree) };
});

const file = (path: string): FileTreeEntry => ({ name: path.split("/").at(-1)!, path, isDirectory: false });
const dir = (path: string, children: FileTreeEntry[]): FileTreeEntry =>
  ({ name: path.split("/").at(-1)!, path, isDirectory: true, children });
/** `subs` sub-folders of `perSub` files in each of `top` folders: until a search opens them
 *  only the top folders and their sub-folders show. */
const bigTree = (top: number, subs: number, perSub: number): FileTreeEntry[] =>
  Array.from({ length: top }, (_, d) => dir(`pkg${d}`, Array.from({ length: subs }, (_, s) =>
    dir(`pkg${d}/sub${s}`, Array.from({ length: perSub }, (_, f) => file(`pkg${d}/sub${s}/file${f}.txt`))))));

beforeEach(() => {
  vi.mocked(searchFileTree).mockClear();
  useWorkflowStore.getState().reset();
  useWorkspaceStore.setState({
    workspacePath: "/ws",
    isLoading: false,
    fileTree: [
      file("AGENTS.md"),
      { name: "src", path: "src", isDirectory: true, children: [
        { name: "lib", path: "src/lib", isDirectory: true, children: [file("src/lib/sum.mjs")] },
      ] },
    ],
  });
});

describe("Sidebar files", () => {
  it("re-reads the workspace folder with the Refresh button", async () => {
    mockInvokeHandler("list_workspace_files", () => [file("AGENTS.md"), file("new.txt")]);
    render(<Sidebar />);

    await act(async () => { fireEvent.click(screen.getByTitle("Refresh files")); });

    expect(await screen.findByText("new.txt")).toBeTruthy();
  });
});

describe("Sidebar file search", () => {
  const DELAY_MS = 150;
  const typeSearch = (value: string) =>
    fireEvent.change(screen.getByPlaceholderText("search files"), { target: { value } });
  const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  const search = (value: string) => { typeSearch(value); wait(DELAY_MS); };
  /** The queries the tree was filtered for. */
  const queriesFiltered = () => vi.mocked(searchFileTree).mock.calls.map((call) => call[1]).filter((q) => q !== "");
  const listedFiles = () => screen.queryAllByText(/^file\d+\.txt$/);
  const note = (shown: number, total: number) =>
    `First ${shown.toLocaleString()} of ${total.toLocaleString()} matches`;
  /** The note about a cut-off list, or null when there is none. (Not getByRole: too slow on hundreds of rows.) */
  const shownNote = () => document.querySelector('[role="status"]')?.textContent ?? null;

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("filters the file tree by name, opening the folders that hold matches", () => {
    render(<Sidebar />);
    expect(screen.queryByText("sum.mjs")).toBeNull(); // src/lib starts closed

    search("SUM");

    expect(screen.getByText("sum.mjs")).toBeTruthy();
    expect(screen.queryByText("AGENTS.md")).toBeNull();
  });

  it("says when no file matches", () => {
    render(<Sidebar />);

    search("nope");

    expect(screen.getByText("No files match")).toBeTruthy();
  });

  it("holds the filtering back until typing has paused for 150 ms", () => {
    render(<Sidebar />);

    typeSearch("nope");
    wait(DELAY_MS - 1);

    expect(screen.queryByText("No files match")).toBeNull();
    expect(screen.getByText("AGENTS.md")).toBeTruthy(); // still the whole tree
    expect(queriesFiltered()).toEqual([]);

    wait(1);

    expect(screen.getByText("No files match")).toBeTruthy();
    expect(screen.queryByText("AGENTS.md")).toBeNull();
  });

  it("restarts the wait with each keystroke and filters once, for the query it ends on", () => {
    render(<Sidebar />);

    typeSearch("s"); wait(100);
    typeSearch("su"); wait(100);
    typeSearch("sum"); wait(100);

    expect(queriesFiltered()).toEqual([]);
    expect(screen.getByText("AGENTS.md")).toBeTruthy();

    wait(50);

    expect(queriesFiltered()).toEqual(["sum"]);
    expect(screen.getByText("sum.mjs")).toBeTruthy();
  });

  it("does not filter the tree again when the sidebar renders for another reason", () => {
    render(<Sidebar />);
    search("sum");
    expect(queriesFiltered()).toEqual(["sum"]);

    fireEvent.change(screen.getByPlaceholderText("Filter nodes…"), { target: { value: "x" } });
    act(() => { useWorkflowStore.setState({ nodes: [] }); });

    expect(queriesFiltered()).toEqual(["sum"]);
    expect(screen.getByText("sum.mjs")).toBeTruthy();
  });

  it("filters again when the workspace's files change, so a new file shows in the results", () => {
    render(<Sidebar />);
    search("sum");

    act(() => {
      useWorkspaceStore.getState().setFileTree([file("AGENTS.md"), file("summary.md")]);
    });

    expect(queriesFiltered()).toEqual(["sum", "sum"]);
    expect(screen.getByText("summary.md")).toBeTruthy();
    expect(screen.queryByText("sum.mjs")).toBeNull();
  });

  it("shows the whole tree again, with the folders as they were, once the search is cleared", () => {
    render(<Sidebar />);
    search("SUM");
    expect(screen.getByText("sum.mjs")).toBeTruthy();

    search("");

    expect(screen.getByText("AGENTS.md")).toBeTruthy();
    expect(screen.queryByText("sum.mjs")).toBeNull(); // src/lib is closed again
  });

  // Each test mounts about 500 rows in jsdom, which takes seconds when the machine is busy:
  // the timeout of every test in here is 30 s, not the default 5 s.
  describe("on a big workspace", { timeout: 30_000 }, () => {
    it("shows at most 500 of the matching files, and says how many match", () => {
      useWorkspaceStore.setState({ fileTree: bigTree(10, 10, 50) }); // 5,000 files
      render(<Sidebar />);
      expect(shownNote()).toBeNull();

      search("e"); // every file name has an e

      expect(listedFiles()).toHaveLength(500);
      expect(shownNote()).toBe(note(500, 5000));
    });

    it("opens only the folders that hold a shown match", () => {
      // pkg0 has 600 files and pkg1 one: the first 500 are pkg0's sub0 to sub9.
      useWorkspaceStore.setState({ fileTree: [...bigTree(1, 12, 50), dir("pkg1", [dir("pkg1/sub0", [file("pkg1/sub0/file0.txt")])])] });
      render(<Sidebar />);

      search("file");

      expect(listedFiles()).toHaveLength(500);
      expect(screen.getByText("sub9")).toBeTruthy();  // open, its files show
      expect(screen.queryByText("sub10")).toBeNull(); // its files are cut off
      expect(screen.queryByText("sub11")).toBeNull();
      expect(screen.queryByText("pkg1")).toBeNull();
      expect(shownNote()).toBe(note(500, 601));
    });

    it("shows no note while every match is shown, and drops it when the search narrows to that", () => {
      useWorkspaceStore.setState({ fileTree: bigTree(10, 10, 5) }); // 500 files
      render(<Sidebar />);

      search("e");
      expect(listedFiles()).toHaveLength(500);
      expect(shownNote()).toBeNull();

      act(() => { useWorkspaceStore.setState({ fileTree: [...bigTree(10, 10, 5), file("one-more.txt")] }); }); // 501
      expect(shownNote()).toBe(note(500, 501));

      search("file0.");
      expect(listedFiles()).toHaveLength(100); // one per sub-folder
      expect(shownNote()).toBeNull();
    });

    it("keeps the note away while the search box is empty", () => {
      useWorkspaceStore.setState({ fileTree: bigTree(10, 10, 60) }); // 6,000 files, but nothing searched
      render(<Sidebar />);

      expect(shownNote()).toBeNull();
      search("e");
      expect(shownNote()).toBe(note(500, 6000));
      search("");
      expect(shownNote()).toBeNull();
    });
  });
});
