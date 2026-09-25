// @vitest-environment node
import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CORE_STOPPED, startCore } from "@/cli/coreClient";

const fakeCore = resolve(__dirname, "../../fixtures/fake-core.mjs");
const core = () => startCore(process.execPath, [fakeCore]);

describe("startCore", () => {
  it("answers each call with its own reply, in whatever order they finish", async () => {
    const c = core();
    const [slow, echo] = await Promise.all([c.invoke("slow"), c.invoke("echo", { x: 1 })]);
    expect([slow, echo]).toEqual(["slow", { x: 1 }]);
    await c.close();
    expect(c.stopped()).toBe(true);
  });

  it("rejects with the command's error message, as Tauri's invoke does", async () => {
    const c = core();
    await expect(c.invoke("fail")).rejects.toBe("boom");
    await c.close();
  });

  it("rejects pending and later calls once harness-core stops", async () => {
    const c = core();
    const pending = c.invoke("slow");
    void c.invoke("die").catch(() => {});
    await expect(pending).rejects.toBe(CORE_STOPPED);
    expect(c.stopped()).toBe(true);
    await expect(c.invoke("echo")).rejects.toBe(CORE_STOPPED);
  });

  it("reports a core that cannot start as stopped", async () => {
    const c = startCore(join(tmpdir(), "no-such-harness-core"));
    await expect(c.invoke("echo")).rejects.toBe(CORE_STOPPED);
    expect(c.stopped()).toBe(true);
  });
});
