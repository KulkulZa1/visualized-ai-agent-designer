/**
 * harness-core as a child process. `invoke` sends one request line and resolves
 * with the matching reply (protocol: src-tauri/src/commands/core_server.rs). A
 * command's error rejects with its message, as Tauri's invoke does.
 */
import { spawn } from "node:child_process";
import type { InvokeFn } from "@/services/model-providers/providerAdapter";

export const CORE_STOPPED = "harness-core stopped";

export interface CoreClient {
  invoke: InvokeFn;
  /** True once harness-core has exited, or could not start. */
  stopped: () => boolean;
  /** Ends its input, so it answers what is still running and exits; kills it
   *  if it still runs after `graceMs`. */
  close: (graceMs?: number) => Promise<void>;
}

type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void };

export function startCore(command: string, args: string[] = []): CoreClient {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let stopped = false;
  let markExited = () => {};
  const exited = new Promise<void>((resolve) => { markExited = resolve; });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const call of pending.values()) call.reject(CORE_STOPPED);
    pending.clear();
    markExited();
  };
  child.on("error", stop); // it could not start
  child.on("close", stop); // it exited, and its output has been read
  child.stdin.on("error", () => {}); // it exited; stop() rejects what was pending

  const settle = (line: string) => {
    let reply: { id?: unknown; ok?: unknown; err?: unknown };
    try {
      reply = JSON.parse(line);
    } catch {
      return; // not a reply
    }
    const call = typeof reply.id === "number" ? pending.get(reply.id) : undefined;
    if (!call) return;
    pending.delete(reply.id as number);
    if (reply.err !== undefined) call.reject(String(reply.err));
    else call.resolve(reply.ok);
  };
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      settle(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
    }
  });

  const invoke = <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (stopped) return Promise.reject(CORE_STOPPED);
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
    });
  };

  return {
    invoke,
    stopped: () => stopped,
    close: async (graceMs = 5000) => {
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), graceMs); });
      if (await Promise.race([exited.then(() => false), late])) child.kill();
      clearTimeout(timer);
    },
  };
}
