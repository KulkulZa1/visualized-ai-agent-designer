/**
 * commandTool — the `bash` tool of a workflow agent.
 *
 * The user approves each command before it runs (store/commandConsentStore.ts);
 * the time spent waiting for the answer does not count against the node's time.
 * An approved command runs in the open workspace folder (Rust `execute_command`:
 * cmd.exe on Windows, sh elsewhere) without the app's provider keys and without
 * input, until it finishes or the node's remaining time runs out. The agent gets
 * the exit code and the end of the output.
 */

import { beforeDeadline } from "@/services/execution/agentLoop";
import type { InvokeFn } from "@/services/model-providers/providerAdapter";
import type { CommandDecision } from "@/store/commandConsentStore";
import type { HookResult } from "@/types/hookResult";

// Per stream; test runners print their summary at the end, so the end is kept.
const MAX_STDOUT_CHARS = 6000;
const MAX_STDERR_CHARS = 3000;
// Rust stops the command at the node's time limit; allow for its report to arrive.
const REPORT_GRACE_MS = 5000;
// Long enough for real commands, short enough to read in full before approving.
const MAX_COMMAND_CHARS = 2000;

export interface CommandToolOptions {
  agentName: string;
  workspacePath: string | null;
  invoke: InvokeFn;
  /** Ask the user to approve this exact command line. */
  askUser: (command: string) => Promise<CommandDecision>;
  /** The node's deadline (epoch ms). */
  deadline: () => number;
  /** Move the deadline later by the time spent waiting for the user. */
  extendDeadline: (ms: number) => void;
  isCancelled: () => boolean;
  onAudit: (details: string, success: boolean) => void;
}

function tail(text: string, max: number): string {
  return text.length <= max
    ? text
    : `[${text.length - max} earlier characters omitted]\n${text.slice(-max)}`;
}

function formatResult(command: string, r: HookResult): string {
  const parts = [`$ ${command}`, `exit code ${r.exitCode} (${(r.durationMs / 1000).toFixed(1)} s)`];
  if (r.stdout.trim()) parts.push(`stdout:\n${tail(r.stdout.trimEnd(), MAX_STDOUT_CHARS)}`);
  if (r.stderr.trim()) parts.push(`stderr:\n${tail(r.stderr.trimEnd(), MAX_STDERR_CHARS)}`);
  const text = parts.join("\n");
  return r.exitCode === 0 ? text : `[error] ${text}`;
}

export async function runCommandTool(args: Record<string, unknown>, opts: CommandToolOptions): Promise<string> {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) return "[error] bash requires a 'command': the command line to run.";
  if (/[\r\n]/.test(command)) {
    return "[error] bash runs one command line: join the steps with && instead of line breaks.";
  }
  // The user must see exactly what runs: control and invisible format characters
  // (bidi overrides, zero-width spaces) could make the shown text differ.
  if (/[\p{Cc}\p{Cf}]/u.test(command)) {
    return "[error] The command contains control or invisible characters; send plain text.";
  }
  if (command.length > MAX_COMMAND_CHARS) {
    return `[error] The command is too long to review (over ${MAX_COMMAND_CHARS} characters); split it into steps.`;
  }
  if (!opts.workspacePath) return "[error] No workspace open — commands run in the workspace folder.";

  const asked = Date.now();
  const decision = await opts.askUser(command);
  opts.extendDeadline(Date.now() - asked);
  if (opts.isCancelled()) throw new Error("Run stopped");
  if (decision !== "allow") {
    opts.onAudit(`${opts.agentName}: command denied by the user: ${command}`, false);
    return `[error] The user denied this command, so it was not run: ${command}. ` +
      "Do not ask for it again; continue without it or explain what you needed it for.";
  }

  try {
    const result = await beforeDeadline(
      opts.invoke<HookResult>("execute_command", {
        workspacePath: opts.workspacePath, command, consentGranted: true,
        timeoutSecs: Math.max(1, Math.ceil((opts.deadline() - Date.now()) / 1000)),
      }),
      () => opts.deadline() + REPORT_GRACE_MS,
      `${command} did not finish within ${opts.agentName}'s time limit`,
      opts.isCancelled,
    );
    opts.onAudit(`${opts.agentName} ran: ${command} (exit ${result.exitCode}, ${result.durationMs} ms)`,
      result.exitCode === 0);
    return formatResult(command, result);
  } catch (e) {
    if (opts.isCancelled()) throw e;
    opts.onAudit(`${opts.agentName}: command failed: ${command}: ${String(e)}`, false);
    return `[error] ${command} failed: ${String(e)}`;
  }
}
