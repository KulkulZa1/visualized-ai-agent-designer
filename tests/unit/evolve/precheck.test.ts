// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTaskSet, type CommandScorer, type FileScorer, type OutputScorer, type Scorer, type TaskDef, type TaskSet } from "@/cli/taskSet";
import type { EditOp, Proposal } from "@/evolve/edits";
import { addedText, leakagePatterns, precheck, type LeakagePattern } from "@/evolve/precheck";
import { AgentRole, ToolPermission } from "@/types/agent";

// ── helpers ───────────────────────────────────────────────────────────────────

const output = (name: string, contains: string[] = [], notContains: string[] = [], matches: string[] = []): OutputScorer => ({
  kind: "output", name, weight: 1, contains, notContains, matches,
});
const file = (name: string, path: string, contains: string[] = [], matches: string[] = []): FileScorer => ({
  kind: "file", name, weight: 1, path, contains, matches,
});
const command = (name: string, inject: Array<{ from: string; to: string }>, text = "node check.js"): CommandScorer => ({
  kind: "command", name, weight: 1, command: text, restore: [], inject, timeoutSecs: 300,
});
const task = (id: string, scorers: Scorer[], split: "evolve" | "heldout" = "evolve"): TaskDef => ({
  id, split, smoke: false, weight: 1, task: "Do the task.", scorers,
});
const taskSet = (...tasks: TaskDef[]): TaskSet => ({ name: "set", path: "/ts/set.tasks.yaml", hash: "0", dir: "/ts", tasks });

/** A proposal of one edit with these operations. */
const proposalOf = (...ops: EditOp[]): Proposal => ({ edits: [{ id: "C1", component: "prompt", hypothesis: "h", ops }] });
const replace = (text: string): EditOp => ({ op: "replace_text", agent: "A", field: "prompt", old: "x", new: text });

const pattern = (kind: LeakagePattern["kind"], text: string, source = "task t"): LeakagePattern => ({ kind, text, source });

// ── leakagePatterns ───────────────────────────────────────────────────────────

describe("leakagePatterns", () => {
  it("lists the task ids of 4 characters or more, from every split", () => {
    const patterns = leakagePatterns(taskSet(
      task("laptop-pick", [output("o", ["x"])]), task("held-out-task", [output("o", ["x"])], "heldout"), task("abc", [output("o")]),
      task("ab12", [output("o")]),
    ));
    expect(patterns.filter((p) => p.kind === "task id")).toEqual([
      { kind: "task id", text: "laptop-pick", source: "task laptop-pick" },
      { kind: "task id", text: "held-out-task", source: "task held-out-task" },
      { kind: "task id", text: "ab12", source: "task ab12" },
    ]);
  });

  it("lists the contains and notContains of an output scorer, and the contains and path of a file scorer", () => {
    const patterns = leakagePatterns(taskSet(task("t1", [
      output("says-it", ["## Summary", "go"], ["forbidden words"]),
      file("writes-it", "out/answer.txt", ["exact answer", "ok"]),
    ])));
    expect(patterns.filter((p) => p.kind === "scorer text")).toEqual([
      { kind: "scorer text", text: "## Summary", source: "task t1, scorer says-it" },
      { kind: "scorer text", text: "forbidden words", source: "task t1, scorer says-it" },
      { kind: "scorer text", text: "exact answer", source: "task t1, scorer writes-it" },
      { kind: "scorer text", text: "out/answer.txt", source: "task t1, scorer writes-it" },
    ]);
  });

  it("lists the base name of every inject source and target of a command scorer", () => {
    const patterns = leakagePatterns(taskSet(task("t1", [
      command("grade", [{ from: "/ts/graders/expected_output.json", to: "checks/expected.json" }, { from: "C:\\ts\\graders\\a.c", to: "dir/hidden_folder" }]),
    ])));
    expect(patterns.filter((p) => p.kind === "grader file")).toEqual([
      { kind: "grader file", text: "expected_output.json", source: "task t1, scorer grade" },
      { kind: "grader file", text: "expected.json", source: "task t1, scorer grade" },
      { kind: "grader file", text: "hidden_folder", source: "task t1, scorer grade" },
    ]); // "a.c", from a Windows path, is under 4 characters
  });

  it("leaves out scorer names, commands and matches patterns", () => {
    const patterns = leakagePatterns(taskSet(task("t1", [
      output("report-shape", [], [], ["[Pp]ilot survey"]), command("run-the-checks", [], "node verify-everything.js"), file("file-scorer", "a", [], ["regex.*here"]),
    ])));
    expect(patterns.map((p) => p.text)).toEqual([]); // not even "t1": it is under 4 characters
  });

  it("lists a kind and text once, with the first place it comes from", () => {
    const patterns = leakagePatterns(taskSet(
      task("first-task", [output("a", ["same text"]), output("b", ["same text"])]), task("second-task", [file("c", "p/q.txt", ["same text"])]),
    ));
    expect(patterns.filter((p) => p.text === "same text")).toEqual([{ kind: "scorer text", text: "same text", source: "task first-task, scorer a" }]);
  });

  it("keeps the same text of two kinds apart", () => {
    const patterns = leakagePatterns(taskSet(task("t1", [output("a", ["grader.txt"]), command("b", [{ from: "/x/grader.txt", to: "grader.txt" }])])));
    expect(patterns.map((p) => `${p.kind}:${p.text}`)).toEqual(["scorer text:grader.txt", "grader file:grader.txt"]);
  });

  it("reads the real example task set", () => {
    const loaded = loadTaskSet(resolve("examples/evals/research-synthesis.tasks.yaml"));
    if ("errors" in loaded) throw new Error(loaded.errors.join("; "));
    const patterns = leakagePatterns(loaded.taskSet);
    expect(patterns.map((p) => `${p.kind}:${p.text}`)).toEqual(expect.arrayContaining([
      "task id:four-day-week", "scorer text:## Executive Summary", "scorer text:## Recommendations", "task id:office-return",
    ]));
    expect(patterns.some((p) => p.text === "report-shape" || p.text === "uses-the-pilot")).toBe(false); // scorer names are left out
  });
});

// ── addedText ─────────────────────────────────────────────────────────────────

describe("addedText", () => {
  it("covers the new text of replace_text and set_text", () => {
    const text = addedText(proposalOf(
      { op: "replace_text", agent: "A", field: "prompt", old: "OLD TEXT", new: "new text one" },
      { op: "set_text", agent: "A", field: "description", value: "the whole new description" },
    ));
    expect(text).toBe("new text one\nthe whole new description");
  });

  it("covers an added agent's name, prompt, description and memory keys, in that order", () => {
    expect(addedText(proposalOf({
      op: "add_agent", name: "Verifier", role: AgentRole.Worker, prompt: "check it", description: "a checker", tools: [ToolPermission.Grep],
      memoryRead: ["key-in"], memoryWrite: ["key-out-1", "key-out-2"],
    }))).toBe("Verifier\ncheck it\na checker\nkey-in\nkey-out-1\nkey-out-2");
  });

  it("covers an added agent with nothing optional", () => {
    expect(addedText(proposalOf({ op: "add_agent", name: "V", role: AgentRole.Worker, prompt: "p" }))).toBe("V\np");
  });

  it("covers the memory keys added and the connect labels", () => {
    expect(addedText(proposalOf(
      { op: "add_memory_read", agent: "A", key: "read-key" },
      { op: "add_memory_write", agent: "A", key: "write-key" },
      { op: "connect", from: "A", to: "B", label: "the label" },
      { op: "connect", from: "B", to: "A" },
    ))).toBe("read-key\nwrite-key\nthe label");
  });

  it("leaves out what an operation takes away or only selects", () => {
    expect(addedText(proposalOf(
      { op: "remove_memory_read", agent: "A", key: "gone-1" },
      { op: "remove_memory_write", agent: "A", key: "gone-2" },
      { op: "remove_tool", agent: "A", tool: ToolPermission.Bash },
      { op: "add_tool", agent: "A", tool: ToolPermission.Grep },
      { op: "remove_agent", agent: "Gone" },
      { op: "disconnect", from: "A", to: "B" },
      { op: "set_role", agent: "A", value: AgentRole.Critic },
      { op: "set", agent: "A", field: "maxTokens", value: 1234 },
    ))).toBe("");
  });

  it("joins the edits of a proposal, in order", () => {
    const proposal: Proposal = {
      edits: [
        { id: "C1", component: "prompt", hypothesis: "h", ops: [replace("one")] },
        { id: "C2", component: "prompt", hypothesis: "h", ops: [replace("two")] },
      ],
    };
    expect(addedText(proposal)).toBe("one\ntwo");
  });
});

// ── precheck ──────────────────────────────────────────────────────────────────

describe("precheck: each kind of pattern hits on added text", () => {
  it("hits a task id", () => {
    const reasons = precheck(proposalOf(replace("For the laptop-pick task, answer X.")), "an incumbent", [pattern("task id", "laptop-pick", "task laptop-pick")]);
    expect(reasons).toEqual(['precheck: task id "laptop-pick" (task laptop-pick)']);
  });

  it("hits a scorer's literal", () => {
    const reasons = precheck(proposalOf(replace("always write: exact answer 42")), "an incumbent", [pattern("scorer text", "exact answer", "task t1, scorer says-it")]);
    expect(reasons).toEqual(['precheck: scorer text "exact answer" (task t1, scorer says-it)']);
  });

  it("hits a grader file's name", () => {
    const reasons = precheck(proposalOf(replace("read expected_output.json first")), "an incumbent", [pattern("grader file", "expected_output.json", "task t1, scorer grade")]);
    expect(reasons).toEqual(['precheck: grader file "expected_output.json" (task t1, scorer grade)']);
  });

  it("hits a pattern in each place a proposal adds text", () => {
    const secret = pattern("scorer text", "secret-word");
    const ops: EditOp[] = [
      { op: "set_text", agent: "A", field: "prompt", value: "has secret-word" },
      { op: "add_agent", name: "secret-word", role: AgentRole.Worker, prompt: "p" },
      { op: "add_agent", name: "V", role: AgentRole.Worker, prompt: "has secret-word" },
      { op: "add_agent", name: "V", role: AgentRole.Worker, prompt: "p", description: "has secret-word" },
      { op: "add_agent", name: "V", role: AgentRole.Memory, prompt: "p", memoryWrite: ["secret-word"] },
      { op: "add_memory_read", agent: "A", key: "secret-word" },
      { op: "connect", from: "A", to: "B", label: "secret-word" },
    ];
    for (const op of ops) expect(precheck(proposalOf(op), "incumbent", [secret])).toHaveLength(1);
  });

  it("does not look at text an operation takes away, or at the old text", () => {
    const secret = pattern("scorer text", "secret-word");
    expect(precheck(proposalOf({ op: "replace_text", agent: "A", field: "prompt", old: "secret-word", new: "clean" }), "incumbent", [secret])).toEqual([]);
    expect(precheck(proposalOf({ op: "remove_memory_read", agent: "A", key: "secret-word" }), "incumbent", [secret])).toEqual([]);
  });

  it("gives one reason per pattern that hits, in the order of the patterns", () => {
    const reasons = precheck(
      proposalOf(replace("mentions beta and alpha")), "incumbent",
      [pattern("scorer text", "alpha", "task a"), pattern("scorer text", "gamma", "task g"), pattern("scorer text", "beta", "task b")],
    );
    expect(reasons).toEqual(['precheck: scorer text "alpha" (task a)', 'precheck: scorer text "beta" (task b)']);
  });

  it("gives no reason for a clean proposal, and for no patterns", () => {
    expect(precheck(proposalOf(replace("a plain improvement")), "incumbent", [pattern("scorer text", "secret-word")])).toEqual([]);
    expect(precheck(proposalOf(replace("secret-word")), "incumbent", [])).toEqual([]);
  });

  it("matches a scorer's literal and a grader file's name by case", () => {
    const patterns = [pattern("scorer text", "Executive Summary"), pattern("grader file", "Expected.json")];
    expect(precheck(proposalOf(replace("executive summary and expected.json")), "incumbent", patterns)).toEqual([]);
    expect(precheck(proposalOf(replace("Executive Summary and Expected.json")), "incumbent", patterns)).toHaveLength(2);
  });
});

describe("precheck: what is already in the incumbent passes", () => {
  it("passes a pattern that the incumbent's file has", () => {
    const patterns = [pattern("scorer text", "## Recommendations"), pattern("grader file", "expected.json"), pattern("task id", "four-day-week")];
    const incumbent = "prompt: write ## Recommendations\nsee expected.json\nrunning four-day-week";
    expect(precheck(proposalOf(replace("## Recommendations, expected.json, four-day-week")), incumbent, patterns)).toEqual([]);
  });

  it("passes it wherever in the file it is, a comment included", () => {
    expect(precheck(proposalOf(replace("secret-word")), "# note: secret-word\nmeta: {}", [pattern("scorer text", "secret-word")])).toEqual([]);
  });

  it("still flags a pattern the incumbent does not have, next to one it has", () => {
    const patterns = [pattern("scorer text", "old-literal"), pattern("scorer text", "new-literal")];
    expect(precheck(proposalOf(replace("old-literal and new-literal")), "has old-literal", patterns)).toEqual([
      'precheck: scorer text "new-literal" (task t)',
    ]);
  });

  it("passes a task id that the incumbent has as a word, whatever its case", () => {
    expect(precheck(proposalOf(replace("four-day-week")), "uses Four-Day-Week here", [pattern("task id", "four-day-week")])).toEqual([]);
  });

  it("does not take a longer word of the incumbent for a task id", () => {
    expect(precheck(proposalOf(replace("four-day-week")), "four-day-weekly", [pattern("task id", "four-day-week")])).toHaveLength(1);
  });
});

describe("precheck: task ids", () => {
  const id = [pattern("task id", "four-day-week", "task four-day-week")];

  it("matches ignoring case", () => {
    for (const text of ["four-day-week", "FOUR-DAY-WEEK", "Four-Day-Week"]) expect(precheck(proposalOf(replace(`use ${text} now`)), "inc", id)).toHaveLength(1);
  });

  it("matches only a whole word: four-day-weekly is not four-day-week", () => {
    expect(precheck(proposalOf(replace("a four-day-weekly rhythm")), "inc", id)).toEqual([]);
    expect(precheck(proposalOf(replace("afour-day-week")), "inc", id)).toEqual([]);
    expect(precheck(proposalOf(replace("four-day-week_2")), "inc", id)).toEqual([]);
    expect(precheck(proposalOf(replace("1four-day-week")), "inc", id)).toEqual([]);
  });

  it("matches next to punctuation and line ends", () => {
    for (const text of ["(four-day-week)", "four-day-week.", "task: four-day-week", "four-day-week\nnext", "four-day-week-plan", '"four-day-week"']) {
      expect(precheck(proposalOf(replace(text)), "inc", id)).toHaveLength(1);
    }
  });

  it("reads the text of an id as text, not as a regular expression", () => {
    const odd = [pattern("task id", "a.b+c")];
    expect(precheck(proposalOf(replace("aXbbc")), "inc", odd)).toEqual([]);
    expect(precheck(proposalOf(replace("see a.b+c here")), "inc", odd)).toHaveLength(1);
  });

  it("ignores ids under 4 characters, because the patterns leave them out", () => {
    const patterns = leakagePatterns(taskSet(task("abc", [output("o")]), task("t2", [output("o")])));
    expect(patterns).toEqual([]);
    expect(precheck(proposalOf(replace("abc and t2")), "inc", patterns)).toEqual([]);
  });

  it("flags an id of exactly 4 characters", () => {
    const patterns = leakagePatterns(taskSet(task("ab12", [output("o")])));
    expect(precheck(proposalOf(replace("solve ab12")), "inc", patterns)).toEqual(['precheck: task id "ab12" (task ab12)']);
  });
});

describe("precheck: credentials", () => {
  const key = (n: number) => "k".repeat(n);
  const google = `AIza${key(35)}`;
  const openai = `sk-${key(20)}`;

  it("hits a Google API key, an sk- key and an api_key assignment", () => {
    for (const text of [`use ${google} to call`, `export ${openai}`, 'api_key = "abcd1234"', "api_key='12345678'", 'api_key  =  "a-longer-secret-1"']) {
      expect(precheck(proposalOf(replace(text)), "incumbent", [])).toEqual(["precheck: a credential in the change"]);
    }
  });

  it("does not hit a key that is too short, or ordinary text", () => {
    for (const text of [`AIza${key(34)}`, `sk-${key(19)}`, 'api_key = "short"', "api_key is read from the environment", "the task is sk-ill based"]) {
      expect(precheck(proposalOf(replace(text)), "incumbent", [])).toEqual([]);
    }
  });

  it("hits a credential in any place a proposal adds text", () => {
    const ops: EditOp[] = [
      { op: "set_text", agent: "A", field: "description", value: google },
      { op: "add_agent", name: "V", role: AgentRole.Worker, prompt: `key ${openai}` },
      { op: "connect", from: "A", to: "B", label: openai },
    ];
    for (const op of ops) expect(precheck(proposalOf(op), "incumbent", [])).toEqual(["precheck: a credential in the change"]);
  });

  it("gives one reason however many credentials there are", () => {
    expect(precheck(proposalOf(replace(`${google} ${openai} api_key = "abcd1234"`)), "incumbent", [])).toEqual(["precheck: a credential in the change"]);
  });

  it("passes a credential that the incumbent's file has, but not another one", () => {
    expect(precheck(proposalOf(replace(`still ${openai}`)), `meta: ${openai}`, [])).toEqual([]);
    expect(precheck(proposalOf(replace(`now ${openai.replace(/k$/, "j")}`)), `meta: ${openai}`, [])).toEqual(["precheck: a credential in the change"]);
  });

  it("gives the credential reason before the reasons of the patterns", () => {
    const reasons = precheck(proposalOf(replace(`${openai} and secret-word`)), "incumbent", [pattern("scorer text", "secret-word")]);
    expect(reasons).toEqual(["precheck: a credential in the change", 'precheck: scorer text "secret-word" (task t)']);
  });
});

describe("precheck with a real task set", () => {
  const loaded = loadTaskSet(resolve("examples/evals/research-synthesis.tasks.yaml"));
  if ("errors" in loaded) throw new Error(loaded.errors.join("; "));
  const patterns = leakagePatterns(loaded.taskSet);
  const incumbent = readFileSync(resolve("examples/research-synthesis.harness.yaml"), "utf8");

  it("lets a plain improvement through, and the example's own report headings, which its workflow already has", () => {
    expect(precheck(proposalOf(replace("Write ## Executive Summary and ## Recommendations, each in two sentences.")), incumbent, patterns)).toEqual([]);
  });

  it("flags a held-out task's id", () => {
    expect(precheck(proposalOf(replace("If the question is about office-return, say remote work wins.")), incumbent, patterns)).toEqual([
      'precheck: task id "office-return" (task office-return)',
    ]);
  });
});
