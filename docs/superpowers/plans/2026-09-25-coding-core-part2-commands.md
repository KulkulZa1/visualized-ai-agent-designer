# Coding Core, Part 2: "Allow for this run" and Kill on Stop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A command the user allowed for the run runs again without a prompt, and Stop kills a running command's process tree right away.

**Architecture:**
- **Store:** `commandConsentStore` keeps per-run grants. `request()` resolves `"granted"` for a granted exact command, and the dialog gains an "Allow for this run" answer.
- **Rust:** `execute_command` registers its shell's process id under an id from the frontend. The new `cancel_command(id)` kills the whole tree.
- **Tool:** `commandTool` gives each command an id and calls `cancel_command` when the run is stopped while the command runs.

**Tech Stack:** TypeScript, Zustand, React, Vitest; Rust (`std::process`, `LazyLock`), Tauri 2.

Spec: `docs/superpowers/specs/2026-09-25-coding-core-design.md` §2.

**Deviation from the spec:**
- The spec also kills a run's commands when the run ends for another reason. `runParallel` never settles while nodes are in flight: it "only settles once in-flight nodes have finished" (`parallelScheduler.ts`). So a run cannot end while one of its commands is running, and Stop is the only case that needs a kill.
- Grants are still cleared when a run ends (`denyRun`, which the run's `finally` already calls).

## File map

| File | Change |
|---|---|
| `src/store/commandConsentStore.ts` | `CommandDecision` gains `"allow-run"`; `CommandApproval` adds `"granted"`; per-run `grants`; `denyRun` clears grants |
| `src/components/execution/CommandConsentDialog.tsx` | Deny / Allow for this run / Allow once, plus a warning |
| `src/services/execution/commandTool.ts` | `runId`; approval wording in the audit; command ids; cancel on Stop |
| `src/hooks/useWorkflowExecution.ts` | Passes `runId` to `runCommandTool` |
| `src-tauri/src/commands/process_commands.rs`, `src-tauri/src/lib.rs` | `command_id`, the registry, `cancel_command`, `kill_tree`, a process group on Unix |

---

### Task 1: Grants in the consent store

**Files:** Modify `src/store/commandConsentStore.ts`. Test: `tests/unit/store/commandConsentStore.test.ts`.

- [ ] **Step 1: Write the failing tests.** In the test file, change the `beforeEach` reset to `useCommandConsentStore.setState({ queue: [], grants: {} });`, then append inside `describe("commandConsentStore")`:

```ts
  it("runs a command allowed for this run again without asking, until the run ends", async () => {
    const first = ask("run-1", "npm test");
    useCommandConsentStore.getState().answer(useCommandConsentStore.getState().queue[0].id, "allow-run");
    await expect(first).resolves.toBe("allow-run");

    await expect(ask("run-1", "npm test")).resolves.toBe("granted");
    const other = ask("run-1", "npm test -- --watch");
    expect(useCommandConsentStore.getState().queue.map((r) => r.command)).toEqual(["npm test -- --watch"]);

    useCommandConsentStore.getState().denyRun("run-1");
    await expect(other).resolves.toBe("deny");
    void ask("run-1", "npm test");
    expect(useCommandConsentStore.getState().queue.map((r) => r.command)).toEqual(["npm test"]);
  });

  it("also runs the same command waiting from another agent once it is allowed for the run", async () => {
    const a = ask("run-1", "npm test");
    const b = ask("run-1", "npm test");
    useCommandConsentStore.getState().answer(useCommandConsentStore.getState().queue[0].id, "allow-run");
    await expect(a).resolves.toBe("allow-run");
    await expect(b).resolves.toBe("granted");
    expect(useCommandConsentStore.getState().queue).toEqual([]);
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/unit/store/commandConsentStore.test.ts`
Expected: FAIL. The second `ask` does not resolve `"granted"`.

- [ ] **Step 3: Implement.** Replace `src/store/commandConsentStore.ts` with:

```ts
import { create } from "zustand";

/**
 * commandConsentStore — shell commands an agent wants to run, waiting for the
 * user's answer (CommandConsentDialog). Every command needs its own approval,
 * unless the user allowed that exact command for the rest of the run.
 */

/** The user's answer in the dialog. */
export type CommandDecision = "allow" | "allow-run" | "deny";
/** What a request resolves with: the answer, or "granted" when the exact command
 *  was allowed for this run earlier (no prompt). */
export type CommandApproval = CommandDecision | "granted";

export interface CommandRequest {
  id: number;
  runId: string;
  agentName: string;
  command: string;
  workspacePath: string;
}

interface CommandConsentState {
  /** Oldest first; the dialog shows the first one. */
  queue: CommandRequest[];
  /** Commands allowed for the rest of a run, by run id. */
  grants: Record<string, string[]>;
  /** Ask the user; resolves with their answer ("deny" if the run ends first). */
  request: (details: Omit<CommandRequest, "id">) => Promise<CommandApproval>;
  answer: (id: number, decision: CommandDecision) => void;
  /** The run was stopped or has ended: deny its pending requests, drop its grants. */
  denyRun: (runId: string) => void;
}

const resolvers = new Map<number, (approval: CommandApproval) => void>();
let nextId = 1;

export const useCommandConsentStore = create<CommandConsentState>()((set, get) => ({
  queue: [],
  grants: {},

  request: (details) => {
    if (get().grants[details.runId]?.includes(details.command)) return Promise.resolve("granted");
    return new Promise<CommandApproval>((resolve) => {
      const id = nextId++;
      resolvers.set(id, resolve);
      set((state) => ({ queue: [...state.queue, { ...details, id }] }));
    });
  },

  answer: (id, decision) => {
    const request = get().queue.find((r) => r.id === id);
    if (!request) return;
    // Allowed for this run: the same command waiting from another agent runs too.
    const settled = decision === "allow-run"
      ? get().queue.filter((r) => r.runId === request.runId && r.command === request.command)
      : [request];
    set((state) => ({
      queue: state.queue.filter((r) => !settled.includes(r)),
      grants: decision === "allow-run"
        ? { ...state.grants, [request.runId]: [...(state.grants[request.runId] ?? []), request.command] }
        : state.grants,
    }));
    for (const r of settled) {
      resolvers.get(r.id)?.(r === request ? decision : "granted");
      resolvers.delete(r.id);
    }
  },

  denyRun: (runId) => {
    for (const r of get().queue) if (r.runId === runId) get().answer(r.id, "deny");
    set((state) => ({
      grants: Object.fromEntries(Object.entries(state.grants).filter(([id]) => id !== runId)),
    }));
  },
}));
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run tests/unit/store/commandConsentStore.test.ts`
Expected: PASS, 5 tests

---

### Task 2: Dialog buttons

**Files:** Modify `src/components/execution/CommandConsentDialog.tsx`. Test: `tests/unit/components/CommandConsentDialog.test.tsx`.

- [ ] **Step 1: Write the failing tests.**
  - In the test file, set the `beforeEach` reset to `{ queue: [], grants: {} }`.
  - In the first `it`, click `"Allow once"` instead of `"Allow"`.
  - Append:

```tsx
  it("allows a command for the rest of the run, with a warning", async () => {
    render(<CommandConsentDialog />);
    let answer!: Promise<string>;
    act(() => { answer = ask("npm test"); });
    expect(screen.getByRole("alertdialog").textContent).toContain("package.json");

    act(() => { fireEvent.click(screen.getByRole("button", { name: "Allow for this run" })); });

    await expect(answer).resolves.toBe("allow-run");
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/unit/components/CommandConsentDialog.test.tsx`
Expected: FAIL. There is no "Allow once" button yet.

- [ ] **Step 3: Implement.** Replace the button row (the `<div>` holding the Deny/Allow buttons) with:

```tsx
        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--border)", background: "var(--surface)" }}>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10, lineHeight: 1.5 }}>
            <strong>Allow for this run</strong> runs this exact command again without asking, even if the agent
            changes what it runs (for example package.json scripts).
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button autoFocus onClick={() => answer(current.id, "deny")} style={button(false)}>Deny</button>
            <button onClick={() => answer(current.id, "allow-run")} style={button(false)}>Allow for this run</button>
            <button onClick={() => answer(current.id, "allow")} style={button(true)}>Allow once</button>
          </div>
        </div>
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run tests/unit/components/CommandConsentDialog.test.tsx`
Expected: PASS, 4 tests

---

### Task 3: Approval wording and command ids in `commandTool`

**Files:** Modify `src/services/execution/commandTool.ts` and `src/hooks/useWorkflowExecution.ts`. Test: `tests/unit/services/execution/commandTool.test.ts`.

- [ ] **Step 1: Write the failing tests.**
  - In the `options()` helper, add `runId: "run-1",`.
  - Change the first test's expectation to:

```ts
    expect(opts.invoke).toHaveBeenCalledWith("execute_command", {
      workspacePath: "/ws", command: "npm test", consentGranted: true, timeoutSecs: 90,
      commandId: expect.stringMatching(/^run-1-cmd-\d+$/),
    });
```

Append:

```ts
  it("says in the audit log how the command was approved", async () => {
    const { opts, audit } = options({ askUser: vi.fn(async () => "granted" as const) });
    await runCommandTool({ command: "npm test" }, opts);
    expect(audit[0].details).toContain("allowed for this run");
  });

  it("kills a running command when the run is stopped", async () => {
    let stopped = false;
    const calls: Array<[string, Record<string, unknown>]> = [];
    const invoke = vi.fn((cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (cmd === "execute_command") { stopped = true; return new Promise(() => {}); }
      return Promise.resolve(true);
    }) as unknown as InvokeFn;
    const { opts, audit } = options({ invoke, isCancelled: () => stopped });

    await expect(runCommandTool({ command: "npm test" }, opts)).rejects.toThrow("Run stopped");

    const started = calls.find(([cmd]) => cmd === "execute_command")![1];
    expect(calls).toContainEqual(["cancel_command", { commandId: started.commandId }]);
    expect(audit.at(-1)).toEqual({ details: expect.stringContaining("stopped"), success: false });
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/unit/services/execution/commandTool.test.ts`
Expected: FAIL. `commandId` is missing, the wording differs, and no `cancel_command` call is made.

- [ ] **Step 3: Implement.** In `commandTool.ts`:
  - Change the import to `import type { CommandApproval } from "@/store/commandConsentStore";`.
  - Add `runId: string;` as the first field of `CommandToolOptions`.
  - Change `askUser` to `askUser: (command: string) => Promise<CommandApproval>;`.
  - Below the constants, add:

```ts
const APPROVED: Record<Exclude<CommandApproval, "deny">, string> = {
  allow: "approved once", "allow-run": "approved for this run", granted: "allowed for this run",
};
let nextCommandId = 0;
```

Replace everything from `const asked = Date.now();` to the end of `runCommandTool`:

```ts
  const asked = Date.now();
  const approval = await opts.askUser(command);
  opts.extendDeadline(Date.now() - asked);
  if (opts.isCancelled()) throw new Error("Run stopped");
  if (approval === "deny") {
    opts.onAudit(`${opts.agentName}: command denied by the user: ${command}`, false);
    return `[error] The user denied this command, so it was not run: ${command}. ` +
      "Do not ask for it again; continue without it or explain what you needed it for.";
  }

  const commandId = `${opts.runId}-cmd-${++nextCommandId}`;
  try {
    const result = await beforeDeadline(
      opts.invoke<HookResult>("execute_command", {
        workspacePath: opts.workspacePath, command, consentGranted: true, commandId,
        timeoutSecs: Math.max(1, Math.ceil((opts.deadline() - Date.now()) / 1000)),
      }),
      () => opts.deadline() + REPORT_GRACE_MS,
      `${command} did not finish within ${opts.agentName}'s time limit`,
      opts.isCancelled,
    );
    opts.onAudit(
      `${opts.agentName} ran: ${command} (${APPROVED[approval]}; exit ${result.exitCode}, ${result.durationMs} ms)`,
      result.exitCode === 0);
    return formatResult(command, result);
  } catch (e) {
    if (opts.isCancelled()) {
      // Stop: end the command now instead of at the time limit.
      opts.invoke("cancel_command", { commandId }).catch(() => {});
      opts.onAudit(`${opts.agentName}: command stopped: ${command}`, false);
      throw e;
    }
    opts.onAudit(`${opts.agentName}: command failed: ${command}: ${String(e)}`, false);
    return `[error] ${command} failed: ${String(e)}`;
  }
}
```

In `useWorkflowExecution.ts`, change the first line of the `runCommandTool` options to `runId, agentName: data.name, workspacePath, invoke,`.

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run tests/unit/services/execution/commandTool.test.ts`
Expected: PASS, 14 tests

---

### Task 4: Rust `cancel_command`

**Files:** Modify `src-tauri/src/commands/process_commands.rs` and `src-tauri/src/lib.rs`.

- [ ] **Step 1: Write the failing tests.**
  - In the `tests` module, change the `run_in` helper to pass `None` as the new last argument.
  - Change the consent test's `execute_command(…, false, 10)` call to `execute_command(…, false, 10, None)`.
  - Append:

```rust
    #[cfg(target_os = "windows")]
    #[test]
    fn cancel_command_kills_a_running_command() {
        let dir = tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let started = Instant::now();
        let runner = thread::spawn(move || {
            execute_command(path, "ping -n 30 127.0.0.1 >nul".to_string(), true, 60,
                Some("cancel-test".to_string()))
        });
        while !RUNNING_COMMANDS.lock().unwrap().contains_key("cancel-test") {
            assert!(started.elapsed() < Duration::from_secs(10), "the command never started");
            thread::sleep(Duration::from_millis(20));
        }

        assert!(cancel_command("cancel-test".to_string()));
        let output = runner.join().unwrap().unwrap();

        assert_ne!(output.exit_code, 0);
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
    }

    #[test]
    fn cancel_command_ignores_unknown_and_finished_commands() {
        assert!(!cancel_command("no-such-command".to_string()));
        let dir = tempdir().unwrap();
        execute_command(dir.path().to_string_lossy().to_string(), "echo done".to_string(), true, 10,
            Some("finished-test".to_string())).unwrap();
        assert!(!cancel_command("finished-test".to_string()));
    }
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib cancel_command`
Expected: FAIL to compile (`cancel_command` and `RUNNING_COMMANDS` missing; `execute_command` takes 4 arguments)

- [ ] **Step 3: Implement.**

Imports: `use std::sync::{Arc, LazyLock, Mutex};`.

Module-level constant and registry, above `execute_command`:

```rust
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Agent commands that are running, by the id the frontend gave them: the
/// shell's process id, for cancel_command.
static RUNNING_COMMANDS: LazyLock<Mutex<HashMap<String, u32>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Takes a command out of RUNNING_COMMANDS when it ends, however it ends.
struct Registration(Option<String>);

impl Drop for Registration {
    fn drop(&mut self) {
        if let (Some(id), Ok(mut running)) = (&self.0, RUNNING_COMMANDS.lock()) {
            running.remove(id);
        }
    }
}
```

`execute_command`:
  - Add a last parameter, `// Lets cancel_command stop it (Stop in the UI).` followed by `command_id: Option<String>,`.
  - Replace `match wait_with_timeout(shell, timeout) {` with:

```rust
    let registration = Registration(command_id);
    match wait_with_timeout(shell, timeout, |pid| {
        if let (Some(id), Ok(mut running)) = (&registration.0, RUNNING_COMMANDS.lock()) {
            running.insert(id.clone(), pid);
        }
    }) {
```

New command and helper after `execute_command`:

```rust
/// Stop a running agent command: kill its whole process tree. False if no
/// command with that id is running.
#[tauri::command]
pub fn cancel_command(command_id: String) -> bool {
    let pid = RUNNING_COMMANDS.lock().ok().and_then(|mut running| running.remove(&command_id));
    if let Some(pid) = pid {
        kill_tree(pid);
    }
    pid.is_some()
}

/// Kill a process and everything it started: killing only the shell leaves its
/// children running.
fn kill_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Agent commands start in their own process group (shell_command).
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}
```

In the Windows `shell_command`, delete the local `const CREATE_NO_WINDOW` line; the module-level one is used now. In the non-Windows `shell_command`, after `shell.args(["-c", command]);`:

```rust
    // Its own process group, so kill_tree can end everything it started.
    std::os::unix::process::CommandExt::process_group(&mut shell, 0);
```

`wait_with_timeout`:
  - New signature: `fn wait_with_timeout(mut command: Command, timeout: Duration, on_spawn: impl FnOnce(u32)) -> std::io::Result<Option<HookResult>>`.
  - After `.spawn()?;`, add `on_spawn(child.id());`.
  - In the timeout branch, replace the `#[cfg(target_os = "windows")] let _ = Command::new("taskkill")…status();` statement with `kill_tree(child.id());`.
  - In `run_command_with_timeout`, call `wait_with_timeout(command, timeout, |_| {})`.

`lib.rs`: import `cancel_command` with `execute_command` (`process_commands::{cancel_command, execute_command, execute_hook}`) and add `cancel_command,` to `generate_handler!` after `execute_command,`.

- [ ] **Step 4: Run them and confirm they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib process_commands`
Expected: PASS (all process command tests, including the 2 new ones)

---

### Task 5: Stop kills the command (hook level)

**Files:** Test: `tests/unit/hooks/useWorkflowExecution.test.ts`. No new code is expected; this checks the wiring.

- [ ] **Step 1: Write the test.**
  - In `describe("shell commands")`, change the `beforeEach` reset to `{ queue: [], grants: {} }`.
  - Append:

```ts
    it("kills a command that is running when Stop is pressed", async () => {
      commandNode();
      mockInvokeHandler("execute_command", () => new Promise(() => {}));
      const cancelled = vi.fn(() => true);
      mockInvokeHandler("cancel_command", cancelled);
      const { result } = renderHook(() => useWorkflowExecution());

      await act(async () => {
        const running = result.current.executeWorkflow(undefined, vi.fn());
        const request = await waitForApprovalPrompt();
        useCommandConsentStore.getState().answer(request.id, "allow");
        await new Promise((resolve) => setTimeout(resolve, 50));
        useExecutionStore.getState().cancelRun();
        await running;
      });

      expect(cancelled).toHaveBeenCalledWith({ commandId: expect.stringMatching(/-cmd-\d+$/) });
      expect(useExecutionStore.getState().currentRun?.agents.A.status).toBe("stopped");
    });
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/unit/hooks/useWorkflowExecution.test.ts`
Expected: PASS (the Task 3 wiring provides it). If it fails, fix the wiring rather than the test.

---

### Task 6: Verify and commit Part 2

- [ ] **Step 1: Full checks.** Run `npx tsc --noEmit`, `npx vitest run`, `cargo test --manifest-path src-tauri/Cargo.toml` and `npm run build`; all must pass.

- [ ] **Step 2: Commit**

```bash
git add src tests src-tauri/src docs/superpowers/plans
git commit -m "Let users allow a command for the whole run, and kill running commands on Stop"
```
