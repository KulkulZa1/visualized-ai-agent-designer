// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { WorkflowGraph } from "@/engine/workflowGraph";
import { AgentRole } from "@/types/agent";
import type { AgentNode } from "@/types/workflow";
import {
  isInsideDir, linkProblem, loadTaskSet, nodeProblems, pathParts, relativePathProblem, selectTasks, unapprovedScorerCommands, type TaskDef, type TaskSet,
} from "@/cli/taskSet";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A folder holding `files` (path → text), made fresh, as its real path (a path through a link is not what these tests are about, unless they make the link). */
function project(files: Record<string, string> = {}): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "harness-taskset-")));
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
      ["an output check with an empty contains list", () => taskSet({ tasks: [task({ scorers: [{ name: "o", output: { contains: [] } }] })] }), /scorers\[0\]\.output\.contains/],
      ["an output check with an empty notContains list", () => taskSet({ tasks: [task({ scorers: [{ name: "o", output: { notContains: [] } }] })] }), /scorers\[0\]\.output\.notContains/],
      ["an output check whose lists are all empty", () => taskSet({ tasks: [task({ scorers: [{ name: "o", output: { contains: [], notContains: [], matches: [] } }] })] }), /output\.contains/],
      ["a file check with an empty matches list", () => taskSet({ tasks: [task({ scorers: [{ name: "f", file: { path: "a", matches: [] } }] })] }), /scorers\[0\]\.file\.matches/],
      ["more trials than the most", () => taskSet({ trials: 1001 }), /trials/],
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

    it("takes the most trials, and not one more", () => {
      expect(loaded(project(), taskSet({ trials: 1000 })).trials).toBe(1000);
    });

    it.each(["__proto__", "constructor", "prototype"])("rejects %s as a task id: it is an object's own property, and would vanish from the report", (id) => {
      expect(errorsOf(project(), taskSet({ tasks: [task({ id })] })).join("\n")).toMatch(/tasks\[0\]\.id: this cannot be a task id: it is the name of an object's own property/);
    });

    it.each(["con", "CON", "prn", "aux", "nul", "Nul", "com1", "COM9", "lpt1", "LPT9", "con.txt"])("rejects %s as a task id: Windows keeps it for a device", (id) => {
      const errors = errorsOf(project(), taskSet({ tasks: [task({ id })] })).join("\n");
      expect(errors).toMatch(/this cannot be a task id: Windows keeps it for a device/);
    });

    it.each(["console", "com10", "com0", "lpt", "auxiliary", "null", "con-t1", "protoype", "a-con"])("takes %s as a task id: it is not a device or property name", (id) => {
      expect(() => loaded(project(), taskSet({ tasks: [task({ id })] }))).not.toThrow();
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

    it("lets restore, inject.to and file.path go up and come back down inside the folder, and keeps them written out: no . or .. is left to be read two ways", () => {
      const content = taskSet({ tasks: [task({ scorers: [
        scorer({ restore: ["test/../package.json", "./test"], inject: [{ from: "grader/hidden.test.js", to: "test/./h.js" }] }),
        { name: "f", file: { path: "docs/../report.md" } },
      ] })] });

      const [command, file] = loaded(project(), content).tasks[0].scorers;

      expect(command).toMatchObject({ restore: ["package.json", "test"], inject: [{ to: "test/h.js" }] });
      expect(file).toMatchObject({ path: "report.md" });
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

  describe.skipIf(!canLink)("links in a fixture", () => {
    /** The fixture's folder, in a new project. */
    const fixture = (dir: string, ...path: string[]) => join(dir, "fixtures", "laptop", ...path);
    const problems = (dir: string) => errorsOf(dir, taskSet()).join("\n");

    it("allows a relative link that leads to a place in the fixture, and keeps it as it is: an npm install's node_modules/.bin is one", () => {
      const dir = project({ "fixtures/laptop/node_modules/pkg/bin/x": "#!/bin/sh\n", "fixtures/laptop/sub/f.txt": "f\n" });
      mkdirSync(fixture(dir, "node_modules", ".bin"));
      symlinkSync("../pkg/bin/x", fixture(dir, "node_modules", ".bin", "x")); // the shape npm gives it
      symlinkSync("../package.json", fixture(dir, "test", "up.json")); // to a file elsewhere in the fixture
      symlinkSync("sub", fixture(dir, "alias")); // to a folder
      symlinkSync("alias/f.txt", fixture(dir, "chain")); // a link to a path through another link
      symlinkSync("..", fixture(dir, "sub", "home")); // to the fixture's own folder

      const set = loaded(dir, taskSet());

      expect(set.tasks[0].workspace).toBe(fixture(dir));
    });

    it("does not enter a link: a link to the folder it is in, or to a folder above it in the fixture, is no loop", () => {
      const dir = project();
      symlinkSync(".", fixture(dir, "self"));
      mkdirSync(fixture(dir, "deep", "er"), { recursive: true });
      symlinkSync("../..", fixture(dir, "deep", "er", "root"));

      expect(() => loaded(dir, taskSet())).not.toThrow();
    });

    it("refuses an absolute link, even to a place in the fixture", () => {
      const dir = project();
      symlinkSync(fixture(dir, "package.json"), fixture(dir, "test", "abs.json"));

      expect(problems(dir)).toMatch(/task laptop: workspace: fixtures\/laptop\/test\/abs\.json is a link with an absolute target .*a link in the fixture must be relative/);
    });

    it("refuses a link that leads out of the fixture, whether its target says so or not", () => {
      const dir = project();
      symlinkSync("../../grader/hidden.test.js", fixture(dir, "out")); // climbs out
      expect(problems(dir)).toMatch(/fixtures\/laptop\/out is a link whose target .*climbs out of the fixture/);

      const other = project({ "fixtures/laptop/a/keep.txt": "x\n" });
      symlinkSync("../../..", fixture(other, "a", "up")); // not a place in the fixture, and its text climbs from a/ by three
      expect(problems(other)).toMatch(/fixtures\/laptop\/a\/up is a link whose target .*climbs out/);
    });

    it("refuses a link that climbs out of the fixture and comes back in by its name: in a copy it would lead somewhere else", () => {
      const dir = project();
      symlinkSync("../laptop/package.json", fixture(dir, "back")); // lands in the fixture, but through the folder above it

      expect(problems(dir)).toMatch(/fixtures\/laptop\/back is a link whose target .*climbs out of the fixture/);
    });

    it("reads a link's target as the kernel does, not as text: a .. after a link goes up from the link's target", () => {
      const dir = project();
      mkdirSync(fixture(dir, "a"));
      symlinkSync("..", fixture(dir, "a", "up")); // a/up is the fixture's own folder: fine
      // As text, a/up/.. is just a: inside. The kernel goes up from a/up, which is the fixture, so it ends above it.
      symlinkSync("a/up/..", fixture(dir, "b"));

      expect(problems(dir)).toMatch(/fixtures\/laptop\/b is a link whose target .*climbs out of the fixture/);
    });

    it("refuses a link whose walk goes above the fixture through another link, though neither its text nor where it ends says so: it would come back in by the fixture's own name", () => {
      const dir = project();
      mkdirSync(fixture(dir, "x"));
      symlinkSync("..", fixture(dir, "x", "a")); // x/a is the fixture's own folder: fine
      // As text, from the fixture's folder: x, a, .., laptop, package.json: it never goes above. Walked: x/a is the fixture,
      // .. is fixtures/, laptop is the fixture again, so it ends at the fixture's package.json: inside. In a copy, at another
      // place, that name is not there (or is another folder's): the link would not lead to the copy's own file.
      symlinkSync("x/a/../laptop/package.json", fixture(dir, "back"));

      expect(problems(dir)).toMatch(/fixtures\/laptop\/back is a link whose target .*climbs out of the fixture: a step of it goes above/);
    });

    it("refuses a dangling link, a link through a file, and links that loop", () => {
      const dir = project();
      symlinkSync("nowhere", fixture(dir, "dangling"));
      expect(problems(dir)).toMatch(/fixtures\/laptop\/dangling is a link to nothing/);

      const throughFile = project();
      symlinkSync("package.json/x", fixture(throughFile, "notdir")); // a file is not a folder
      expect(problems(throughFile)).toMatch(/fixtures\/laptop\/notdir is a link to nothing/);

      const loop = project();
      symlinkSync("two", fixture(loop, "one"));
      symlinkSync("one", fixture(loop, "two"));
      expect(problems(loop)).toMatch(/is a link to nothing .*links loop/);
    });

    it("asks the kernel where a link ends, as well as walking it: a trailing slash after a file is a link to nothing, which the walk alone lets by", () => {
      const dir = project();
      symlinkSync("package.json/", fixture(dir, "l")); // the kernel says ENOTDIR: a file is not a folder

      expect(problems(dir)).toMatch(/fixtures\/laptop\/l is a link to nothing/);
    });

    it("refuses a workspace that is itself a link, and one reached through a link", () => {
      const dir = project();
      symlinkSync("laptop", join(dir, "fixtures", "linked"));
      expect(errorsOf(dir, taskSet({ tasks: [task({ workspace: "fixtures/linked" })] })).join("\n"))
        .toContain("fixtures/linked is a link (a path in a task set may not go through a link)");
      symlinkSync("fixtures", join(dir, "via"));
      expect(errorsOf(dir, taskSet({ tasks: [task({ workspace: "via/laptop" })] })).join("\n")).toContain("via is a link (a path in a task set may not go through a link)");
    });

    it("refuses a task file and a grader file that are links, and a link in a grader folder: these may not contain links at all", () => {
      const dir = project();
      symlinkSync("laptop.md", join(dir, "tasks", "alias.md"));
      expect(errorsOf(dir, taskSet({ tasks: [{ id: "a", taskFile: "tasks/alias.md", scorers: [scorer()] }] })).join("\n"))
        .toMatch(/taskFile: tasks\/alias\.md is a link \(a path in a task set may not go through a link\)/);
      symlinkSync("hidden.test.js", join(dir, "grader", "alias.js"));
      const content = taskSet({ tasks: [task({ scorers: [scorer({ inject: [{ from: "grader/alias.js", to: "x" }] })] })] });
      expect(errorsOf(dir, content).join("\n")).toMatch(/inject\.from: grader\/alias\.js is a link/);

      const folder = project({ "grader/hidden/a.js": "// a\n" });
      symlinkSync("a.js", join(folder, "grader", "hidden", "b.js")); // even a harmless one
      const inFolder = taskSet({ tasks: [task({ scorers: [scorer({ inject: [{ from: "grader/hidden", to: "x" }] })] })] });
      expect(errorsOf(folder, inFolder).join("\n")).toContain("grader/hidden/b.js is a link (grader files and task files may not contain links)");
    });

    it("lets the task set's own folder be reached through a link, and gives the fixture's real path", () => {
      const dir = project();
      const via = realpathSync.native(mkdtempSync(join(tmpdir(), "harness-taskset-via-")));
      scratch.push(via);
      symlinkSync(dir, join(via, "link"));
      writeFileSync(join(dir, "tasks.yaml"), stringify(taskSet()));

      const result = loadTaskSet(join(via, "link", "tasks.yaml"));

      expect(result).toHaveProperty("taskSet");
      expect((result as { taskSet: TaskSet }).taskSet.tasks[0].workspace).toBe(fixture(dir)); // where the kernel says it is
    });
  });

  it.skipIf(!canMakeFifo)("refuses a named pipe in a fixture: a copy of it would block", () => {
    const dir = project();
    expect(spawnSync("mkfifo", [join(dir, "fixtures", "laptop", "pipe")]).status).toBe(0);
    expect(errorsOf(dir, taskSet()).join("\n")).toContain("fixtures/laptop/pipe is not a regular file or folder");
  });
});

describe.skipIf(!canLink)("linkProblem", () => {
  /** A fixture with a folder `sub`, a file `sub/f.txt`; returns its real path. */
  function fixtureRoot(): string {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "harness-link-")));
    scratch.push(dir);
    mkdirSync(join(dir, "fixture", "sub"), { recursive: true });
    writeFileSync(join(dir, "fixture", "sub", "f.txt"), "f\n");
    return join(dir, "fixture");
  }

  it("has nothing to say about a relative link that stays in the fixture, however it gets there", () => {
    const root = fixtureRoot();
    symlinkSync("sub/f.txt", join(root, "a"));
    symlinkSync("../sub", join(root, "sub", "up"));
    symlinkSync("sub/up/f.txt", join(root, "b")); // through another link
    symlinkSync("sub/up/../sub/f.txt", join(root, "c")); // .. after a link goes up from where the link leads: sub/up is sub, so this is sub/../sub/f.txt

    for (const name of ["a", "b", "c"]) expect(linkProblem(join(root, name), root), name).toBeUndefined();
    expect(linkProblem(join(root, "sub", "up"), root)).toBeUndefined();
  });

  it("walks a step at a time: it says what stopped the walk", () => {
    const root = fixtureRoot();
    symlinkSync(join(root, "sub"), join(root, "abs"));
    symlinkSync("abs/f.txt", join(root, "via-abs"));
    symlinkSync("..", join(root, "sub", "up"));
    symlinkSync("sub/up/..", join(root, "above"));
    symlinkSync("sub/f.txt/more", join(root, "through-file"));

    expect(linkProblem(join(root, "abs"), root)).toMatch(/^is a link with an absolute target/);
    expect(linkProblem(join(root, "via-abs"), root)).toMatch(/^is a link whose target \("abs\/f\.txt"\) goes through a link with an absolute target/);
    expect(linkProblem(join(root, "above"), root)).toMatch(/^is a link whose target \("sub\/up\/\.\."\) climbs out of the fixture/);
    expect(linkProblem(join(root, "through-file"), root)).toMatch(/^is a link to nothing/);
  });

  it("asks the kernel too: a trailing slash after a file passes the walk and is a link to nothing", () => {
    const root = fixtureRoot();
    symlinkSync("sub/f.txt/", join(root, "slash"));
    symlinkSync("sub/", join(root, "folder-slash")); // a trailing slash after a folder is fine

    expect(linkProblem(join(root, "slash"), root)).toMatch(/^is a link to nothing/);
    expect(linkProblem(join(root, "folder-slash"), root)).toBeUndefined();
  });

  it("calls the folder what it is told to, for the links a restore puts in a trial", () => {
    const root = fixtureRoot();
    symlinkSync("../../out", join(root, "sub", "up"));
    symlinkSync(join(root, "sub"), join(root, "abs"));

    expect(linkProblem(join(root, "sub", "up"), root, "the trial's folder")).toMatch(/^is a link whose target \("\.\.\/\.\.\/out"\) climbs out of the trial's folder: a step of it goes above it$/);
    expect(linkProblem(join(root, "abs"), root, "the trial's folder")).toMatch(/: a link in the trial's folder must be relative$/);
  });

  it("gives up on links that loop, and on a link that cannot be read", () => {
    const root = fixtureRoot();
    symlinkSync("two", join(root, "one"));
    symlinkSync("one", join(root, "two"));

    expect(linkProblem(join(root, "one"), root)).toMatch(/^is a link to nothing/);
    expect(linkProblem(join(root, "sub", "f.txt"), root)).toMatch(/^is a link that cannot be read/); // not a link
  });
});

describe("pathParts", () => {
  it("gives the names of a path written out, without the empty steps and the dots, and keeps ..", () => {
    expect(pathParts("a/b/c")).toEqual(["a", "b", "c"]);
    expect(pathParts("./a//b/./c/")).toEqual(["a", "b", "c"]);
    expect(pathParts("a/../b")).toEqual(["a", "..", "b"]);
    expect(pathParts(".")).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("reads a backslash as part of a name where the platform's own separator is a slash, as the kernel does", () => {
    expect(pathParts("a\\b/c")).toEqual(["a\\b", "c"]);
    expect(pathParts("..\\x")).toEqual(["..\\x"]); // one name: no .. in it
  });

  it.skipIf(process.platform !== "win32")("reads a backslash as a separator on Windows", () => {
    expect(pathParts("a\\b/c")).toEqual(["a", "b", "c"]);
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

describe("the shipped example task set", () => {
  it("examples/evals/research-synthesis.tasks.yaml loads, with an evolve, a smoke and a heldout task", () => {
    const loaded = loadTaskSet(resolve("examples/evals/research-synthesis.tasks.yaml"));
    if ("errors" in loaded) throw new Error(loaded.errors.join("\n"));
    expect(loaded.taskSet.tasks.map((t) => [t.id, t.split, t.smoke])).toEqual([
      ["four-day-week", "evolve", true], ["office-return", "heldout", false],
    ]);
  });
});
