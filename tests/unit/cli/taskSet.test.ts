// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import { AgentRole } from "@/types/agent";
import type { AgentNode } from "@/types/workflow";
import {
  isInsideDir, loadTaskSet, nodeProblems, relativePathProblem, selectTasks, unapprovedScorerCommands, type TaskDef, type TaskSet,
} from "@/cli/taskSet";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A folder holding `files` (path → text), made fresh. */
function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-taskset-"));
  scratch.push(dir);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  put("fixtures/laptop/package.json", "{}\n");
  put("fixtures/laptop/test/a.test.js", "// a\n");
  put("grader/hidden.test.js", "// hidden\n");
  put("tasks/laptop.md", "Rank the three offers for 40 laptops.\n");
  for (const [path, text] of Object.entries(files)) put(path, text);
  return dir;
}

const scorer = (extra: Record<string, unknown> = {}) => ({
  name: "tests", command: "npm test --silent", restore: ["test", "package.json"],
  inject: [{ from: "grader/hidden.test.js", to: "test/hidden.test.js" }], ...extra,
});
const task = (extra: Record<string, unknown> = {}) => ({
  id: "laptop", task: "Rank the offers.", workspace: "fixtures/laptop", scorers: [scorer()], ...extra,
});
const taskSet = (extra: Record<string, unknown> = {}) => ({ version: 1, name: "purchasing", tasks: [task()], ...extra });

/** Writes `content` as the task-set file of `dir` and loads it. */
function load(dir: string, content: unknown): ReturnType<typeof loadTaskSet> {
  writeFileSync(join(dir, "tasks.yaml"), typeof content === "string" ? content : stringify(content));
  return loadTaskSet(join(dir, "tasks.yaml"));
}
function loaded(dir: string, content: unknown): TaskSet {
  const result = load(dir, content);
  if ("errors" in result) throw new Error(result.errors.join("\n"));
  return result.taskSet;
}
function errorsOf(dir: string, content: unknown): string[] {
  const result = load(dir, content);
  if ("taskSet" in result) throw new Error("the task set loaded");
  return result.errors;
}

const canLink = process.platform !== "win32";
const canMakeFifo = (() => {
  if (process.platform === "win32") return false;
  const dir = mkdtempSync(join(tmpdir(), "harness-taskset-"));
  try {
    return spawnSync("mkfifo", [join(dir, "pipe")]).status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe("loadTaskSet", () => {
  it("reads a task set: the task text, the fixture, the scorers with their defaults, and the file's hash", () => {
    const dir = project();
    const set = loaded(dir, {
      version: 1, name: "purchasing", workflow: "wf.harness.yaml", trials: 3,
      tasks: [
        {
          id: "laptop", taskFile: "tasks/laptop.md", workspace: "fixtures/laptop", split: "heldout", smoke: true, weight: 2,
          scorers: [
            scorer({ timeoutSecs: 120 }),
            { name: "names-the-winner", weight: 3, output: { contains: ["SUP-A"], notContains: ["SUP-C"], matches: ["SUP-[AB]"], node: "Decision Maker" } },
            { name: "wrote-the-report", file: { path: "report.md", contains: ["## Ranking"] } },
          ],
        },
        { id: "phone", task: "Pick a phone.", scorers: [{ name: "answer", output: { contains: ["x"] } }] },
      ],
    });

    expect(set).toMatchObject({ name: "purchasing", trials: 3, path: join(dir, "tasks.yaml"), dir, workflow: join(dir, "wf.harness.yaml") });
    expect(set.hash).toMatch(/^[0-9a-f]{64}$/);
    const [laptop, phone] = set.tasks;
    expect(laptop).toMatchObject({
      id: "laptop", split: "heldout", smoke: true, weight: 2, task: "Rank the three offers for 40 laptops.\n",
      workspace: join(dir, "fixtures", "laptop"),
    });
    expect(laptop.scorers).toEqual([
      {
        kind: "command", name: "tests", weight: 1, command: "npm test --silent", restore: ["test", "package.json"],
        inject: [{ from: join(dir, "grader", "hidden.test.js"), to: "test/hidden.test.js" }], timeoutSecs: 120,
      },
      {
        kind: "output", name: "names-the-winner", weight: 3, contains: ["SUP-A"], notContains: ["SUP-C"], matches: ["SUP-[AB]"],
        node: "Decision Maker",
      },
      { kind: "file", name: "wrote-the-report", weight: 1, path: "report.md", contains: ["## Ranking"], matches: [] },
    ]);
    // The defaults: the evolve split, not a smoke task, weight 1, a 300 s limit, an empty workspace.
    expect(phone).toMatchObject({ id: "phone", split: "evolve", smoke: false, weight: 1, workspace: undefined });
  });

  it("gives a command scorer 300 seconds by default, and trims its command", () => {
    const set = loaded(project(), taskSet({ tasks: [task({ scorers: [scorer({ command: "  npm test --silent\n" })] })] }));
    expect(set.tasks[0].scorers[0]).toMatchObject({ command: "npm test --silent", timeoutSecs: 300 });
  });

  it("takes a workflow anywhere, relative to the task set's file", () => {
    const dir = project();
    expect(loaded(dir, taskSet({ workflow: "../elsewhere/wf.harness.yaml" })).workflow).toBe(resolve(dir, "../elsewhere/wf.harness.yaml"));
    expect(loaded(dir, taskSet()).workflow).toBeUndefined();
  });

  describe("the schema is strict: an unknown key is an error, at every level", () => {
    it.each([
      ["the task set", () => ({ ...taskSet(), colour: "red" }), /\(the file\): Unrecognized key: "colour"/],
      ["a task", () => taskSet({ tasks: [task({ colour: "red" })] }), /tasks\[0\]: Unrecognized key: "colour"/],
      ["a scorer", () => taskSet({ tasks: [task({ scorers: [scorer({ colour: "red" })] })] }), /tasks\[0\]\.scorers\[0\]: Unrecognized key: "colour"/],
      ["an output check", () => taskSet({ tasks: [task({ scorers: [{ name: "o", output: { contains: ["x"], colour: "red" } }] })] }),
        /tasks\[0\]\.scorers\[0\]\.output: Unrecognized key: "colour"/],
      ["a file check", () => taskSet({ tasks: [task({ scorers: [{ name: "f", file: { path: "a", colour: "red" } }] })] }),
        /tasks\[0\]\.scorers\[0\]\.file: Unrecognized key: "colour"/],
      ["an inject", () => taskSet({ tasks: [task({ scorers: [scorer({ inject: [{ from: "grader/hidden.test.js", to: "x", colour: "red" }] })] })] }),
        /tasks\[0\]\.scorers\[0\]\.inject\[0\]: Unrecognized key: "colour"/],
    ])("in %s", (_where, content, message) => {
      expect(errorsOf(project(), content()).join("\n")).toMatch(message);
    });

    it("also for a key that is misspelled (workspace as work_space)", () => {
      const bad = { id: "a", task: "t", work_space: "fixtures/laptop", scorers: [scorer()] };
      expect(errorsOf(project(), taskSet({ tasks: [bad] })).join("\n")).toMatch(/Unrecognized key: "work_space"/);
    });
  });

  describe("the rest of the schema", () => {
    it.each([
      ["a missing version", () => { const { version: _v, ...rest } = taskSet(); return rest; }, /version/],
      ["another version", () => taskSet({ version: 2 }), /version/],
      ["no tasks", () => taskSet({ tasks: [] }), /tasks/],
      ["a task with no scorers", () => taskSet({ tasks: [task({ scorers: [] })] }), /tasks\[0\]\.scorers/],
      ["a bad id", () => taskSet({ tasks: [task({ id: "my task" })] }), /tasks\[0\]\.id: .*letters, digits/],
      ["an id with a path in it", () => taskSet({ tasks: [task({ id: "../x" })] }), /tasks\[0\]\.id/],
      ["a split that is not evolve or heldout", () => taskSet({ tasks: [task({ split: "smoke" })] }), /tasks\[0\]\.split/],
      ["a weight of 0", () => taskSet({ tasks: [task({ weight: 0 })] }), /tasks\[0\]\.weight/],
      ["a negative scorer weight", () => taskSet({ tasks: [task({ scorers: [scorer({ weight: -1 })] })] }), /scorers\[0\]\.weight/],
      ["0 trials", () => taskSet({ trials: 0 }), /trials/],
      ["a timeout over an hour", () => taskSet({ tasks: [task({ scorers: [scorer({ timeoutSecs: 3601 })] })] }), /timeoutSecs/],
      ["a timeout of 0", () => taskSet({ tasks: [task({ scorers: [scorer({ timeoutSecs: 0 })] })] }), /timeoutSecs/],
      ["both task and taskFile", () => taskSet({ tasks: [task({ taskFile: "tasks/laptop.md" })] }), /exactly one of task and taskFile/],
      ["neither task nor taskFile", () => taskSet({ tasks: [{ id: "a", scorers: [scorer()] }] }), /exactly one of task and taskFile/],
      ["a scorer with no kind", () => taskSet({ tasks: [task({ scorers: [{ name: "x" }] })] }), /exactly one of command, output and file/],
      ["a scorer with two kinds", () => taskSet({ tasks: [task({ scorers: [scorer({ file: { path: "a" } })] })] }), /exactly one of command, output and file/],
      ["restore on an output scorer", () => taskSet({ tasks: [task({ scorers: [{ name: "o", output: { contains: ["x"] }, restore: ["a"] }] })] }), /restore is for a command scorer/],
      ["inject on a file scorer", () => taskSet({ tasks: [task({ scorers: [{ name: "f", file: { path: "a" }, inject: [] }] })] }), /inject is for a command scorer/],
      ["a timeout on an output scorer", () => taskSet({ tasks: [task({ scorers: [{ name: "o", output: { contains: ["x"] }, timeoutSecs: 5 }] })] }), /timeoutSecs is for a command scorer/],
      ["an output scorer that checks nothing", () => taskSet({ tasks: [task({ scorers: [{ name: "o", output: { node: "A" } }] })] }), /at least one of contains, notContains and matches/],
      ["an empty string to look for", () => taskSet({ tasks: [task({ scorers: [{ name: "o", output: { contains: [""] } }] })] }), /contains/],
    ])("rejects %s", (_what, content, message) => {
      expect(errorsOf(project(), content()).join("\n")).toMatch(message);
    });

    it("rejects a file that is not YAML, or empty, naming the file", () => {
      const dir = project();
      expect(errorsOf(dir, "tasks: [unclosed").join("\n")).toContain("cannot read");
      expect(errorsOf(dir, "").join("\n")).toContain("(the file)");
      expect(loadTaskSet(join(dir, "missing.yaml"))).toMatchObject({ errors: [expect.stringContaining("cannot read")] });
    });

    it("rejects duplicate keys in the YAML itself", () => {
      expect(errorsOf(project(), "version: 1\nversion: 1\nname: x\ntasks: []\n").join("\n")).toContain("cannot read");
    });

    it("rejects the same task id twice, and the same scorer name twice in a task", () => {
      expect(errorsOf(project(), taskSet({ tasks: [task(), task()] })).join("\n")).toContain("task id laptop is used twice");
      const twice = task({ scorers: [scorer(), scorer({ command: "npm run lint" })] });
      expect(errorsOf(project(), taskSet({ tasks: [twice] })).join("\n")).toContain("task laptop: scorer name tests is used twice");
    });

    it("rejects an empty task, inline or in a file", () => {
      const dir = project({ "tasks/empty.md": "  \n" });
      expect(errorsOf(dir, taskSet({ tasks: [task({ task: "  " })] })).join("\n")).toContain("task laptop: the task text is empty");
      expect(errorsOf(dir, taskSet({ tasks: [{ id: "a", taskFile: "tasks/empty.md", scorers: [scorer()] }] })).join("\n"))
        .toContain("the task text is empty");
    });

    it("rejects a regular expression that does not compile, naming the scorer", () => {
      const bad = task({ scorers: [{ name: "pattern", output: { matches: ["SUP-(A"] } }] });
      expect(errorsOf(project(), taskSet({ tasks: [bad] })).join("\n")).toMatch(/task laptop, scorer pattern: matches \/SUP-\(A\/ is not a regular expression/);
      const badFile = task({ scorers: [{ name: "pattern", file: { path: "r.md", matches: ["[a-"] } }] });
      expect(errorsOf(project(), taskSet({ tasks: [badFile] })).join("\n")).toMatch(/is not a regular expression/);
    });

    it("reports everything that is wrong at once, not just the first", () => {
      const errors = errorsOf(project(), taskSet({
        tasks: [task({ workspace: "../outside" }), task({ id: "b", taskFile: "tasks/none.md", task: undefined })],
      }));
      expect(errors.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("a command is one line of plain text, so that what the user approves is what runs", () => {
    it.each([
      ["empty", " "],
      ["two lines", "npm ci\nnpm test"],
      ["a carriage return", "npm test\rrm -rf x"],
      ["a tab", "npm\ttest"],
      ["a right-to-left override", "npm test \u202e"],
      ["a zero-width space", "npm\u200b test"],
      ["very long", `echo ${"a".repeat(2001)}`],
    ])("rejects a command that is %s", (_what, command) => {
      const content = taskSet({ tasks: [task({ scorers: [scorer({ command })] })] });
      expect(errorsOf(project(), content).join("\n")).toMatch(/task laptop, scorer tests: the command (is empty|must be one line|is too long)/);
    });
  });

  describe("paths", () => {
    it.each([
      ["a workspace above the task set's folder", { workspace: "../outside" }, /workspace \.\.\/outside leaves the task set's folder/],
      ["a workspace that goes up and back down", { workspace: "fixtures/../../outside" }, /leaves the task set's folder/],
      ["an absolute workspace", { workspace: "/etc" }, /workspace \/etc is not relative/],
      ["a Windows drive path", { workspace: "C:\\fixtures" }, /is not relative/],
      ["a UNC path", { workspace: "\\\\server\\share" }, /is not relative/],
      ["the task set's own folder as the workspace", { workspace: "." }, /workspace \. is the task set's folder itself/],
      ["a workspace that does not exist", { workspace: "fixtures/none" }, /workspace: fixtures\/none does not exist/],
      ["a workspace that is a file", { workspace: "fixtures/laptop/package.json" }, /workspace: fixtures\/laptop\/package\.json is not a folder/],
      ["a task file above the folder", { taskFile: "../x.md", task: undefined }, /taskFile \.\.\/x\.md leaves the task set's folder/],
      ["a task file that does not exist", { taskFile: "tasks/none.md", task: undefined }, /taskFile: tasks\/none\.md does not exist/],
      ["a task file that is a folder", { taskFile: "tasks", task: undefined }, /taskFile: tasks is not a file/],
    ])("rejects %s", (_what, extra, message) => {
      expect(errorsOf(project(), taskSet({ tasks: [task(extra)] })).join("\n")).toMatch(message);
    });

    it.each([
      ["restore", (path: string) => scorer({ restore: [path], inject: [] }), /restore/],
      ["inject.to", (path: string) => scorer({ restore: [], inject: [{ from: "grader/hidden.test.js", to: path }] }), /inject\.to/],
    ])("keeps %s inside the trial's folder: no absolute path, no .. that leaves it, not the folder itself", (_what, make, label) => {
      for (const [path, message] of [
        ["../outside", /leaves the trial's folder/], ["test/../../outside", /leaves the trial's folder/], ["/etc/passwd", /is not relative/],
        ["C:\\Users", /is not relative/], [".", /is the trial's folder itself/], ["test/..", /is the trial's folder itself/], ["", /is empty/],
      ] as const) {
        const errors = errorsOf(project(), taskSet({ tasks: [task({ scorers: [make(path)] })] })).join("\n");
        expect(errors, path).toMatch(label);
        expect(errors, path).toMatch(message);
      }
    });

    it("lets restore and inject.to go up and come back down inside the folder", () => {
      const content = taskSet({ tasks: [task({ scorers: [scorer({ restore: ["test/../package.json"], inject: [{ from: "grader/hidden.test.js", to: "test/./h.js" }] })] })] });
      expect(() => loaded(project(), content)).not.toThrow();
    });

    it("keeps file.path inside the trial's folder too", () => {
      const bad = task({ scorers: [{ name: "f", file: { path: "../report.md" } }] });
      expect(errorsOf(project(), taskSet({ tasks: [bad] })).join("\n")).toMatch(/scorer f: file\.path \.\.\/report\.md leaves the trial's folder/);
    });

    it("keeps inject.from inside the task set's folder, and requires it to exist", () => {
      const from = (path: string) => taskSet({ tasks: [task({ scorers: [scorer({ inject: [{ from: path, to: "x" }] })] })] });
      expect(errorsOf(project(), from("../hidden.test.js")).join("\n")).toMatch(/inject\.from \.\.\/hidden\.test\.js leaves the task set's folder/);
      expect(errorsOf(project(), from("/etc/hostname")).join("\n")).toMatch(/inject\.from \/etc\/hostname is not relative/);
      expect(errorsOf(project(), from("grader/none.js")).join("\n")).toMatch(/inject\.from: grader\/none\.js does not exist/);
    });

    it("refuses an inject.from inside the task's own workspace: the agents would see it", () => {
      const dir = project({ "fixtures/laptop/hidden.test.js": "// not hidden\n" });
      const content = taskSet({ tasks: [task({ scorers: [scorer({ inject: [{ from: "fixtures/laptop/hidden.test.js", to: "x" }] })] })] });
      expect(errorsOf(dir, content).join("\n")).toMatch(/inject\.from fixtures\/laptop\/hidden\.test\.js is inside the task's workspace/);
    });

    it("takes an inject.from that is a folder", () => {
      const dir = project({ "grader/hidden/a.js": "// a\n", "grader/hidden/b/c.js": "// c\n" });
      const content = taskSet({ tasks: [task({ scorers: [scorer({ inject: [{ from: "grader/hidden", to: "test/hidden" }] })] })] });
      expect(loaded(dir, content).tasks[0].scorers[0]).toMatchObject({ inject: [{ from: join(dir, "grader", "hidden"), to: "test/hidden" }] });
    });
  });

  describe.skipIf(!canLink)("links, which are refused", () => {
    it("refuses a link anywhere in a fixture, naming it", () => {
      const dir = project();
      symlinkSync("../package.json", join(dir, "fixtures", "laptop", "test", "link.json"));
      expect(errorsOf(dir, taskSet()).join("\n")).toMatch(/task laptop: workspace: fixtures\/laptop\/test\/link\.json is a link \(a task set may not contain links\)/);
    });

    it("refuses a link even when it leads to something inside the fixture, and a dangling one", () => {
      const dir = project();
      symlinkSync("package.json", join(dir, "fixtures", "laptop", "inside"));
      expect(errorsOf(dir, taskSet()).join("\n")).toContain("fixtures/laptop/inside is a link");
      const other = project();
      symlinkSync("nowhere", join(other, "fixtures", "laptop", "dangling"));
      expect(errorsOf(other, taskSet()).join("\n")).toContain("fixtures/laptop/dangling is a link");
    });

    it("refuses a workspace that is itself a link, and one reached through a link", () => {
      const dir = project();
      symlinkSync("laptop", join(dir, "fixtures", "linked"));
      expect(errorsOf(dir, taskSet({ tasks: [task({ workspace: "fixtures/linked" })] })).join("\n")).toContain("fixtures/linked is a link");
      symlinkSync("fixtures", join(dir, "via"));
      expect(errorsOf(dir, taskSet({ tasks: [task({ workspace: "via/laptop" })] })).join("\n")).toContain("via is a link");
    });

    it("refuses a link that leads out of the task set's folder", () => {
      const dir = project();
      const outside = mkdtempSync(join(tmpdir(), "harness-taskset-outside-"));
      scratch.push(outside);
      writeFileSync(join(outside, "secret.txt"), "secret\n");
      symlinkSync(outside, join(dir, "fixtures", "laptop", "escape"));
      expect(errorsOf(dir, taskSet()).join("\n")).toContain("fixtures/laptop/escape is a link");
    });

    it("refuses a task file and an injected file that are links", () => {
      const dir = project();
      symlinkSync("laptop.md", join(dir, "tasks", "alias.md"));
      expect(errorsOf(dir, taskSet({ tasks: [{ id: "a", taskFile: "tasks/alias.md", scorers: [scorer()] }] })).join("\n"))
        .toMatch(/taskFile: tasks\/alias\.md is a link/);
      symlinkSync("hidden.test.js", join(dir, "grader", "alias.js"));
      const content = taskSet({ tasks: [task({ scorers: [scorer({ inject: [{ from: "grader/alias.js", to: "x" }] })] })] });
      expect(errorsOf(dir, content).join("\n")).toMatch(/inject\.from: grader\/alias\.js is a link/);
    });

    it("refuses a link inside an injected folder", () => {
      const dir = project({ "grader/hidden/a.js": "// a\n" });
      symlinkSync("a.js", join(dir, "grader", "hidden", "b.js"));
      const content = taskSet({ tasks: [task({ scorers: [scorer({ inject: [{ from: "grader/hidden", to: "x" }] })] })] });
      expect(errorsOf(dir, content).join("\n")).toContain("grader/hidden/b.js is a link");
    });

    it("lets the task set's own folder be reached through a link: only what is inside it counts", () => {
      const dir = project();
      const via = mkdtempSync(join(tmpdir(), "harness-taskset-via-"));
      scratch.push(via);
      symlinkSync(dir, join(via, "link"));
      writeFileSync(join(dir, "tasks.yaml"), stringify(taskSet()));
      expect(loadTaskSet(join(via, "link", "tasks.yaml"))).toHaveProperty("taskSet");
    });
  });

  it.skipIf(!canMakeFifo)("refuses a named pipe in a fixture: a copy of it would block", () => {
    const dir = project();
    expect(spawnSync("mkfifo", [join(dir, "fixtures", "laptop", "pipe")]).status).toBe(0);
    expect(errorsOf(dir, taskSet()).join("\n")).toContain("fixtures/laptop/pipe is not a regular file or folder");
  });
});

describe("isInsideDir", () => {
  it("is true for the folder and what is in it, false for what is outside or beside it", () => {
    const root = resolve("/work/set");
    expect(isInsideDir(root, root)).toBe(true);
    expect(isInsideDir(root, join(root, "a", "b"))).toBe(true);
    expect(isInsideDir(root, resolve(root, ".."))).toBe(false);
    expect(isInsideDir(root, resolve(root, "../other"))).toBe(false);
    expect(isInsideDir(root, resolve("/work/set-two"))).toBe(false); // a longer name is not inside
    expect(isInsideDir(root, resolve("/elsewhere"))).toBe(false);
  });

  it("counts a folder whose name starts with two dots as inside", () => {
    const root = resolve("/work/set");
    expect(isInsideDir(root, join(root, "..data", "x"))).toBe(true);
  });
});

describe("relativePathProblem", () => {
  it.each([
    ["test/a.js", undefined], ["a", undefined], ["a/../b", undefined], ["./a", undefined], ["..data/x", undefined],
    ["", "is empty"], ["  ", "is empty"], [".", "is its folder itself"], ["a/..", "is its folder itself"],
    ["..", "leaves its folder"], ["../a", "leaves its folder"], ["a/../../b", "leaves its folder"],
    ["/a", "is not relative"], ["C:\\a", "is not relative"], ["c:a", "is not relative"], ["\\\\host\\share", "is not relative"],
  ])("%j: %s", (path, problem) => {
    expect(relativePathProblem(path)).toBe(problem);
  });

  it("names the folder it is asked about", () => {
    expect(relativePathProblem("../a", "the trial's folder")).toBe("leaves the trial's folder");
    expect(relativePathProblem(".", "the task set's folder")).toBe("is the task set's folder itself");
  });
});

function agentNode(id: string, name: string): AgentNode {
  return {
    id, type: "agent", position: { x: 0, y: 0 },
    data: {
      name, role: AgentRole.Worker, model: "m", temperature: 0.7, maxTokens: 1024, maxSteps: 3, timeoutSeconds: 300,
      promptSource: { type: "inline", content: "" }, tools: [], memoryRead: [], memoryWrite: [], tokens: { used: 0, budget: 0 }, status: "idle",
    },
  };
}
const graphOf = (...names: string[]): WorkflowGraph => ({
  nodes: names.map((name, i) => agentNode(`agent-${i}`, name)), edges: [],
  meta: { name: "W", version: "1.0.0", description: "", projectRoot: "", createdAt: "", updatedAt: "" },
  executionSettings: { maxParallel: 2, timeoutSeconds: 300, retryOnFailure: false, maxRetries: 0 },
});

function taskDef(id: string, over: Partial<TaskDef> = {}): TaskDef {
  return {
    id, split: "evolve", smoke: false, weight: 1, task: "t", scorers: [{ kind: "output", name: "o", weight: 1, contains: ["x"], notContains: [], matches: [] }],
    ...over,
  };
}

describe("selectTasks", () => {
  const tasks = [
    taskDef("a"), taskDef("b", { split: "heldout" }), taskDef("c", { smoke: true }), taskDef("d", { split: "heldout", smoke: true }),
  ];
  const ids = (selected: ReturnType<typeof selectTasks>) => ("tasks" in selected ? selected.tasks.map((t) => t.id) : selected.error);

  it("runs the evolve split by default, the heldout split on request, in the task set's order", () => {
    expect(ids(selectTasks(tasks, "evolve", []))).toEqual(["a", "c"]);
    expect(ids(selectTasks(tasks, "heldout", []))).toEqual(["b", "d"]);
  });

  it("runs the smoke tasks of both splits for smoke, and every task for all", () => {
    expect(ids(selectTasks(tasks, "smoke", []))).toEqual(["c", "d"]);
    expect(ids(selectTasks(tasks, "all", []))).toEqual(["a", "b", "c", "d"]);
  });

  it("narrows the split to the tasks --only names", () => {
    expect(ids(selectTasks(tasks, "evolve", ["c"]))).toEqual(["c"]);
    expect(ids(selectTasks(tasks, "all", ["d", "a"]))).toEqual(["a", "d"]); // the task set's order
  });

  it("says when --only names no task, or one outside the split, and what to do", () => {
    expect(ids(selectTasks(tasks, "evolve", ["zzz"]))).toBe("--only zzz: the task set has no such task (its tasks: a, b, c, d)");
    expect(ids(selectTasks(tasks, "evolve", ["b"]))).toBe("--only b: that task is not in the split evolve; use --split heldout (or --split all)");
    expect(ids(selectTasks(tasks, "smoke", ["a"]))).toMatch(/not in the split smoke/);
  });

  it("says when the split has no task", () => {
    expect(ids(selectTasks([taskDef("a")], "heldout", []))).toBe("no task is in the split heldout");
  });
});

describe("nodeProblems", () => {
  const withNode = (node: string) => [taskDef("a", {
    scorers: [{ kind: "output", name: "o", weight: 1, contains: ["x"], notContains: [], matches: [], node }],
  })];

  it("accepts a node that names exactly one agent of the workflow, and a scorer with no node", () => {
    expect(nodeProblems(withNode("Decision Maker"), graphOf("Researcher", "Decision Maker"))).toEqual([]);
    expect(nodeProblems([taskDef("a")], graphOf("Researcher"))).toEqual([]);
  });

  it("says when it names no agent", () => {
    expect(nodeProblems(withNode("Judge"), graphOf("Researcher"))).toEqual(['task a, scorer o: node "Judge" is not an agent of the workflow']);
  });

  it("says when it names two", () => {
    expect(nodeProblems(withNode("Worker"), graphOf("Worker", "Worker"))).toEqual(
      ['task a, scorer o: node "Worker" names 2 agents of the workflow; it must name one']);
  });
});

describe("unapprovedScorerCommands", () => {
  const command = (name: string, text: string) => ({
    kind: "command" as const, name, weight: 1, command: text, restore: [], inject: [], timeoutSecs: 300,
  });
  const tasks = [
    taskDef("laptop", { scorers: [command("tests", "npm test --silent"), command("lint", "npm run lint")] }),
    taskDef("phone", { scorers: [command("tests", "npm test --silent")] }),
  ];

  it("lists each command that was not approved once, with the scorers that run it", () => {
    expect(unapprovedScorerCommands(tasks, new Set())).toEqual([
      { command: "npm test --silent", scorers: ["laptop/tests", "phone/tests"] },
      { command: "npm run lint", scorers: ["laptop/lint"] },
    ]);
  });

  it("approves a command only by its exact text", () => {
    const allowed = new Set(["npm test --silent", "npm run lint "]);
    expect(unapprovedScorerCommands(tasks, allowed)).toEqual([{ command: "npm run lint", scorers: ["laptop/lint"] }]);
    for (const near of ["npm test", "npm test --silent && id", "npm  test --silent", "NPM test --silent", "npm test --silent;"]) {
      expect(unapprovedScorerCommands([tasks[1]], new Set([near])), near).toHaveLength(1);
    }
  });

  it("has nothing to say when every scorer command was approved, or when no scorer runs a command", () => {
    expect(unapprovedScorerCommands(tasks, new Set(["npm test --silent", "npm run lint"]))).toEqual([]);
    expect(unapprovedScorerCommands([taskDef("a")], new Set())).toEqual([]);
  });
});
