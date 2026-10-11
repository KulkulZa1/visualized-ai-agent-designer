# `harness evolve`, part 2: machine edits and the precheck — Plan

Spec: `docs/superpowers/specs/2026-10-11-harness-evolve-design.md`, §2, §3 and
§4.1. Part 1 (`src/evolve/`: config, schedule, measure, calibrate, components,
history, selection, attribution) is done. Part 2 adds three pure modules and their
tests. There is no CLI or child process yet.

## `src/evolve/jsonText.ts`

**`jsonObjectsIn(text): unknown[]`** returns every JSON object found in a model's
output, in order of appearance.
- The contents of fenced blocks (```` ```json ```` or plain ```` ``` ````) count,
  and so do top-level `{…}` spans in the remaining text.
- **The scan** is string-aware: braces inside JSON strings and escaped quotes do not
  count.
- A span that does not parse is skipped.

Part 3 uses it for both the proposal and the critic's verdict.

## `src/evolve/edits.ts`

### The proposal schema (zod, strict everywhere)

**Edit metadata.**
- `component` is any non-empty string. It is re-tagged anyway, so a wrong word
  costs no repair round.
- `ops` has at least one operation.
- The optional strings and `predicted_affected` are kept when present.

```ts
Proposal     = { summary?: string; edits: ProposedEdit[] }            // at least one edit
ProposedEdit = { id: string; component: string; hypothesis: string; ops: EditOp[];
                 targets_mode?, retroactive_check?, why_not_lower_lever?,
                 trigger_condition?, regression_risk?: string;
                 predicted_affected?: string[] }
```

**`EditOp`** is a discriminated union on `op`, each case a `z.strictObject`:

| `op` | Fields |
|---|---|
| `replace_text` | `agent`, `field: "prompt" \| "description"`, `old` (non-empty), `new` |
| `set_text` | `agent`, `field: "prompt" \| "description"`, `value` |
| `set` | `agent`, and `field`/`value`: `maxTokens` int 0..200000, `maxSteps` int 1..1000, `timeoutSeconds` int 1..86400, `thinkDepth` `none\|low\|medium\|high` (a union per field) |
| `set_role` | `agent`, `value`: an `AgentRole` except `hook` |
| `add_tool` | `agent`, `tool` ∈ `ADDABLE_TOOLS` = `read_file, fs.read, list_files, grep, fs.write, fs.append, subagent_dispatch` |
| `remove_tool` | `agent`, `tool`: any `ToolPermission` |
| `add_memory_read`, `remove_memory_read`, `add_memory_write`, `remove_memory_write` | `agent`, `key` (non-empty) |
| `add_agent` | `name` (1..64), `role` (not `hook`), `prompt`, and optionally `description`, `tools` (ADDABLE_TOOLS), `memoryRead`, `memoryWrite`, `maxTokens`, `maxSteps`, `timeoutSeconds`, `thinkDepth` with the bounds above |
| `remove_agent` | `agent` |
| `connect` | `from`, `to`, and optionally `kind: dataflow\|memory\|feedback\|control` and `label` |
| `disconnect` | `from`, `to` |

`agent`, `from` and `to` are non-empty strings: agent names.

**`parseProposal(text)`** returns `{ proposal } | { error: string }`.
- **The proposal** is the last object from `jsonObjectsIn` that has an `edits`
  array.
- **No such object:** `"no JSON object with an \"edits\" array in the output"`.
- **Schema errors** become one line each, `edits[0].ops[1]: <message>`. They name
  unknown keys, and there are at most 20 lines.
- **Duplicate edit ids** are also an error.

### Classifying

- **`opComponent(op)`:**
  - `replace_text` and `set_text` → `prompt`;
  - `set` → `config`;
  - `set_role`, `connect` and `disconnect` → `control_flow`;
  - memory reads → `context_mgmt`;
  - memory writes → `memory`;
  - tools → `client_tool`;
  - agents → `subagent`.
- **`editComponent(edit)`** is `mostStructural(ops.map(opComponent))`, from
  `components.ts`.
- **`classify(proposal)`** returns the edits, each with `component` (classified),
  `declared` (the proposer's word) and `retagged: boolean`.

### Applying

**`applyProposal(incumbentText, proposal, ctx: { protectedAgents: Map<string, string> })`**
returns `{ text, edits } | { errors: string[] }`.
- `protectedAgents` maps an agent name to a reason, for example
  `scorer names-the-winner of task laptop names it (node:)`.
- **The incumbent.** Parse it with `yaml`'s `parseDocument`, so comments and layout
  are kept, and check `doc.toJS()` with the app's `workflowDefSchema`. An invalid
  incumbent, or agent names that are not unique, is an error.
- **Order.** Apply edits in order. For each edit, work on `doc.clone()` and apply
  its operations in order.
  - **A failing operation** records `edit C1, op 2 (replace_text): <reason>`.
    That edit's changes are dropped, and the next edit is tried on the state before
    it.
  - So the result lists the first error of every failing edit. Any error makes the
    whole result `{ errors }`.
- **Agent names.** Agents are found by `name`, and the index is
  `agents[i].name === name`.

**Each operation:**
- **`replace_text` and `set_text`.**
  - **`field: prompt`:**
    - The text is at `agents[i].promptSource.content`. When `promptSource.type` is
      `file`, the error says the agent reads its prompt from that file, and only
      inline prompts can be edited.
    - `old` must occur exactly once. Otherwise the error says it was not found, or
      that it occurs N times and needs more context.
  - **`field: description`:** the text is `agents[i].description`, or `""` when it
    is missing.
  - **Writing the text:** set the scalar's value, keeping its style. A new
    multi-line value is a block literal scalar.
- **`set` and `set_role`:** set the field.
- **Tools and memory keys.** Add to or remove from the sequence, keeping a flow
  sequence flow. Adding one that is there, or removing one that is not, is an
  error.
- **`add_agent`.**
  - **The name** must be new.
  - **The agent is appended with:**
    - `model`: the most common model among the agents, ties going to the first
      agent's;
    - `temperature`: the first agent's;
    - `maxTokens` 2048, `maxSteps` 5 and `timeoutSeconds` 300, unless given;
    - `promptSource: {type: inline, content: prompt}`;
    - `tools`, `memoryRead` and `memoryWrite`, `[]` unless given;
    - `tokens: {used: 0, budget: 0}`, `status: idle`;
    - `description` and `thinkDepth` only when given.
  - **Its position** is `nodePositions["agent-<n>"] = {x: max x + 260, y: 120}`, or
    `{x: 0, y: 120}` when there are no positions.
- **`remove_agent`.**
  - **It is an error** when the agent is the only one, or when it is in
    `protectedAgents` (the error gives the reason).
  - **It removes:** the agent; every connection whose `sourceAgentId` or
    `targetAgentId` is `agent-<i>`; and `nodePositions["agent-<i>"]`.
  - **Later ids shift down:** `agent-<j>` for every `j > i` becomes `agent-<j−1>`,
    in connections and in `nodePositions` keys.
- **`connect`.**
  - **Both agents must exist,** and they must be different.
  - **No duplicate:** an edge with the same source, target and kind must not
    exist. A missing `edgeKind` reads as `dataflow`.
  - **It appends** `{id, sourceAgentId, targetAgentId, edgeKind, label?}`, with an
    id `evolve-<a>-<b>` (and `-2`, `-3`, … when taken).
- **`disconnect`.** It removes every connection from → to, and there must be at
  least one.

**No-ops are errors:**
- a value equal to the current one;
- `new` equal to `old`;
- a `set_text` with the same text;
- `set_role` to the role the agent has.

**After every edit applies:**
1. **Serialize** with `doc.toString({ lineWidth: 0 })`.
2. **Load the text again** as `harness eval` does:
   - `parse`, then `workflowDefSchema`, then `defToGraph`;
   - every connection must name an `agent-<i>` that exists;
   - `validateWorkflow(nodes, edges)`: its errors (a disconnected agent, a cycle)
     are errors;
   - every name in `protectedAgents` must still name exactly one agent.
3. **Return** `{ text, edits: classify(proposal) }`.

### Checks for the loop

- **`checkBudget(proposal, b_t)`:** `"<n> edits exceed the budget b_t = <b>"`, or
  undefined.
- **`checkReservedSlot(classifiedEdits, untried)`:** undefined when `untried` is
  empty or some edit's classified component is in it. Otherwise RRSI's text: this
  variant holds a reserved exploration slot, at least one edit must be on a
  never-exercised component from `[…]` (judged by its operations), and none is.

### Rendering

**`renderChange(incumbentText, classifiedEdits)`** returns the text the critic and
the history read. Per edit:
- **A header line:** `C1 [client_tool] (declared prompt) — <hypothesis>`. The
  `(declared …)` part appears only when the edit was re-tagged.
- **One line or block per operation.** These name the agent and what changed:
  - `Critic · prompt: replace`, followed by `- ` and `+ ` lines;
  - `Pro Analyst · tools: + grep`;
  - `Final Check · maxTokens: 2000 → 3000`;
  - `+ agent "Verifier" (worker), tools [read_file]`, and its prompt indented;
  - `− agent "Findings Log"`;
  - `edge: + Pro Analyst → Final Check (dataflow)`;
  - `Critic · memoryRead: + analysis-pros`.
- **For `set_text`:** the `lineDiff` of the old and new text.

**`lineDiff(a, b, context = 3)`** gives unified hunks (`@@ -l,s +l,s @@`, then ` `,
`-` and `+` lines).
- It uses an LCS over lines, with a dynamic-programming table.
- **When `lines(a) × lines(b) > 4 000 000`,** it returns
  `"(too large to diff: <n> and <m> lines)"`.
- **Equal texts** give `""`.

`diffFile(incumbentText, candidateText)` wraps it with the `--- incumbent` and
`+++ candidate` headers.

## `src/evolve/precheck.ts`

**`leakagePatterns(taskSet: TaskSet)`** lists patterns from every task, in every
split. Each is `{kind, text, source}`:
- **`task id`:**
  - the task ids of 4 or more characters;
  - matched as a whole word, ignoring case;
  - the source is `task <id>`.
- **`scorer text`:**
  - `output` scorers' `contains` and `notContains`;
  - `file` scorers' `contains` and `path`;
  - each of 4 or more characters, as a case-sensitive substring;
  - the source is `task <id>, scorer <name>`.
- **`grader file`:**
  - the base name of each `inject` `from` and `to`, of 4 or more characters, as a
    case-sensitive substring;
  - the source is `task <id>, scorer <name>`.

Duplicates by kind and text are kept once.

**`addedText(proposal)`** joins, with newlines, every string the proposal adds:
- `replace_text.new` and `set_text.value`;
- an `add_agent`'s name, prompt, description and memory keys;
- memory keys added;
- `connect` labels.

**`precheck(proposal, incumbentText, patterns)`** returns `string[]`, one reason per
hit:
- **A credential:** RRSI's
  `AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{20,}|api_key\s*=\s*["'][^"']{8,}`. It hits
  when the pattern is in the added text and not in the incumbent. The reason is
  `precheck: a credential in the change`.
- **Every other pattern** hits when it is in the added text and not anywhere in
  `incumbentText`. The reason is `precheck: <kind> "<text>" (<source>)`.
- **Whole words** use a regex with `(?<![A-Za-z0-9_])` and `(?![A-Za-z0-9_])`
  around the escaped text, with the `i` flag.

## Tests (vitest)

**`tests/unit/evolve/jsonText.test.ts`:**
- fenced and bare objects;
- prose around them;
- several objects, in order;
- braces and escaped quotes inside strings;
- broken spans skipped.

**`tests/unit/evolve/edits.test.ts`.** Use a small inline YAML workflow, with
comments and a flow `tools: [read_file]` sequence, plus
`examples/research-synthesis.harness.yaml`.
- **`parseProposal`:**
  - the last object with `edits` wins;
  - an unknown key in an op (`agnet`) is an error naming the path;
  - a required field is missing;
  - duplicate ids;
  - no edits or no ops;
  - a forbidden tool (`bash`) and the `hook` role are rejected by the schema.
- **Every operation applied:**
  - the comments survive;
  - the value changes;
  - the text loads again with `workflowDefSchema`.
- **`remove_agent` in the middle:**
  - its edges are gone;
  - the later ids and `nodePositions` keys shift;
  - an edge between two later agents still joins the same two names.
- **`add_agent`:** then a `connect` to it in the same edit works; the model is the
  most common one; the position is added.
- **Errors:**
  - an unknown agent;
  - `old` missing or repeated;
  - each no-op;
  - a file prompt;
  - a duplicate edge and a self edge;
  - `disconnect` with no edge;
  - removing a protected agent, or the only one;
  - a duplicate `add_agent` name;
  - an agent added with no edge (disconnected);
  - an incumbent with duplicate names.
- **Two edits, one failing:** the result is the error list, and it includes only
  the failing edit's first error.
- **Classification:** `add_agent` plus `connect` gives `subagent`; `add_tool` plus
  `replace_text` gives `client_tool`; `retagged` is set.
- **`checkBudget` and `checkReservedSlot`.**
- **`renderChange`:** it holds the expected lines.
- **`lineDiff`:**
  - equal texts give `""`;
  - one change gives a hunk with context;
  - the too-large guard.

**`tests/unit/evolve/precheck.test.ts`:**
- each kind hits on added text;
- the same text already in the incumbent passes;
- ids under 4 characters are ignored;
- an id matches ignoring case, and only as a whole word (`four-day-weekly` does not
  match `four-day-week`);
- a credential hits;
- `addedText` covers each source.

## Checks

- `npx tsc --noEmit`: clean.
- `npx vitest run tests/unit/evolve`: all pass.
- `npx vitest run`: the whole suite passes.
