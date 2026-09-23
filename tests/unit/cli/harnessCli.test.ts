import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const cliPath = join(root, "cli", "harness.mjs");

function runHarness(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      KILO_API_KEY: "",
    },
  });
}

describe("harness CLI v0 subprocess", () => {
  it("prints read-only project status", () => {
    const result = runHarness(["project", "status"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Harness Studio");
    expect(result.stdout).toContain("Read-only CLI v0");
    expect(result.stdout).toContain("AGENT.md");
  });

  it("lists providers without printing key-like secret values", () => {
    const result = runHarness(["provider", "list", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
    const providers = JSON.parse(result.stdout) as Array<{
      id: string;
      type: string;
      classification: string;
      capabilities: Record<string, boolean>;
      credentialRef?: string;
    }>;
    expect(providers.some((provider) => provider.id === "openai")).toBe(true);
    expect(providers.some((provider) => provider.classification === "local")).toBe(true);
    expect(providers.every((provider) => provider.capabilities)).toBe(true);
    expect(providers.find((provider) => provider.id === "openai")?.credentialRef).toBe(
      "env:OPENAI_API_KEY",
    );
  });

  it("validates the purchasing decision demo", () => {
    const result = runHarness([
      "workflow",
      "validate",
      "examples/purchasing-decision.harness.yaml",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VALID");
    expect(result.stdout).toContain("Purchasing Decision Assistant");
    expect(result.stdout).toContain("Agents");
    expect(result.stdout).toContain("Connections");
  });

  it("fails cleanly when the workflow file is missing", () => {
    const result = runHarness(["workflow", "validate", "missing-file-does-not-exist.harness.yaml"]);

    expect(result.status).not.toBe(0);
    const error = JSON.parse(result.stderr) as { error: { message: string } };
    expect(error.error.message).toContain("File not found");
  });

  it("fails cleanly for invalid workflow YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-"));
    const file = join(dir, "invalid.harness.yaml");
    writeFileSync(file, "meta:\n  name: Broken\nagents: []\n", "utf8");

    const result = runHarness(["workflow", "validate", file, "--json"]);

    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { valid: boolean; issues: unknown[] };
    expect(parsed.valid).toBe(false);
    expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it("does not treat a leading --workspace value as the command", () => {
    const workspace = mkdtempSync(join(tmpdir(), "harness-cli-ws-"));

    const result = runHarness(["--workspace", workspace, "project", "status", "--json"]);

    expect(result.status).toBe(0);
    const status = JSON.parse(result.stdout) as { workspace: string };
    expect(status.workspace).toBe(resolve(workspace));
  });

  it("validates the file, not the --workspace value, when the flag precedes the path", () => {
    const workspace = mkdtempSync(join(tmpdir(), "harness-cli-ws-"));
    const file = join(root, "examples", "purchasing-decision.harness.yaml");

    const result = runHarness(["workflow", "validate", "--workspace", workspace, file]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VALID");
    expect(result.stdout).toContain("Purchasing Decision Assistant");
  });
});
