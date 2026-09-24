import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOOK_TEMPLATES } from "@/utils/generators/hookTemplates";

function template(id: string) {
  const found = HOOK_TEMPLATES.find((t) => t.id === id);
  if (!found) throw new Error(`missing hook template: ${id}`);
  return found;
}

function available(command: string): boolean {
  return spawnSync(command, ["--version"], { encoding: "utf8" }).status === 0;
}

// Hooks run as `python <file>` / `bash <file>` (see execute_hook), so write them to disk.
let workDir = "";
beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "hook-templates-"));
});
afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function writeHook(id: string): string {
  const { filename, content } = template(id);
  const path = join(workDir, filename);
  writeFileSync(path, content, "utf8");
  return path;
}

describe("url_allowlist template", () => {
  const source = template("url_allowlist").content;

  it("parses the host with urlparse().hostname and allows only http(s)", () => {
    expect(source).not.toContain("lstrip(");
    expect(source).toContain(".hostname");
    expect(source).toContain('("http", "https")');
  });

  describe.skipIf(!available("python"))("when run with python", () => {
    let hook = "";
    beforeAll(() => {
      hook = writeHook("url_allowlist");
    });

    const verdict = (url: string, env: Record<string, string> = {}) => {
      const args = url ? ["-B", hook, url] : ["-B", hook];
      const result = spawnSync("python", args, { encoding: "utf8", env: { ...process.env, ...env } });
      return result.status === 0 ? "APPROVED" : "BLOCKED";
    };

    it.each([
      "https://wgithub.com/payload",
      "https://wwwpython.org/x",
      "file://github.com/etc/passwd",
      "ftp://github.com/x",
      "https://evil.com/",
      "https://github.com.evil.com/",
      "https://github.com@evil.com/",
      // urlparse reads the host as github.com; WHATWG fetchers stop at the backslash (evil.com).
      "https://evil.com\\@github.com/",
    ])("blocks %s", (url) => {
      expect(verdict(url)).toBe("BLOCKED");
    });

    it.each([
      "https://github.com:443/ok",
      "https://github.com/anthropics",
      "https://www.github.com/x",
      "https://api.github.com/repos",
      "http://python.org/",
      "HTTPS://GitHub.COM/x",
    ])("approves %s", (url) => {
      expect(verdict(url)).toBe("APPROVED");
    });

    it("reads the URL from HOOK_INPUT when no argument is given", () => {
      expect(verdict("", { HOOK_INPUT: "https://github.com:443/ok" })).toBe("APPROVED");
      expect(verdict("", { HOOK_INPUT: "https://wgithub.com/payload" })).toBe("BLOCKED");
    });
  });
});

describe("destructive_guard template", () => {
  const source = template("destructive_guard").content;

  it("does not pipe the input into grep (fails open on SIGPIPE under pipefail)", () => {
    expect(source).not.toContain('echo "$INPUT" | grep');
  });

  it("does not block on the bare word 'format'", () => {
    expect(source).not.toContain('"format"');
  });

  describe.skipIf(!available("bash"))("when run with bash", () => {
    let hook = "";
    beforeAll(() => {
      hook = writeHook("destructive_guard");
    });

    const run = (input: string, env: Record<string, string> = {}) =>
      spawnSync("bash", [hook], {
        encoding: "utf8",
        env: { ...process.env, ALLOW_DESTRUCTIVE: "0", HOOK_INPUT: input, ...env },
      });

    it("blocks a destructive command followed by a large amount of text", () => {
      const lines = Array.from({ length: 40_000 }, (_, i) => `line ${i}`);
      const result = run(["rm -rf /", ...lines].join("\n"));
      expect(result.status).toBe(1);
    }, 30_000);

    it.each([
      // bypasses of the old substring list
      "rm -fr /",
      "rm -r -f ~/project",
      "rm --recursive --force /",
      "rm -f -r /",
      "rm --force --recursive /",
      "rm -r ~/project -f",
      "sudo /bin/rm -Rfv /",
      "find / -delete",
      "git clean -fdx",
      "Remove-Item -Recurse -Force C:/",
      "Remove-Item C:/ -Recurse -Force",
      "del /s /q C:/",
      "rd /s /q C:\\",
      // already blocked before
      "rm -rf /",
      "rmdir /s /q C:\\build",
      "DROP TABLE users;",
      "TRUNCATE TABLE logs",
      "DELETE FROM users",
      "mkfs.ext4 /dev/sda1",
      "format c:",
      "Format-Volume -DriveLetter C",
    ])("blocks %s", (input) => {
      const result = run(input);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("BLOCKED: destructive operation detected");
    });

    it.each([
      "Update the platform-specific formatter",
      "npm run format",
      "ls -la",
      "rm -f build.log",
      "docker run --rm -it ubuntu",
      'git commit -m "clean up the formatter"',
      "del C:/src/old.txt",
      "Remove-Item C:/my-repo/x",
    ])("allows %s", (input) => {
      const result = run(input);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("SAFE: no destructive patterns detected.");
      // grep exits 2 on a malformed pattern, which `if grep` would read as "no match".
      expect(result.stderr).toBe("");
    });

    it("reads the command from the first argument when HOOK_INPUT is empty", () => {
      const result = spawnSync("bash", [hook, "rm -r -f ~/project"], {
        encoding: "utf8",
        env: { ...process.env, ALLOW_DESTRUCTIVE: "0", HOOK_INPUT: "" },
      });
      expect(result.status).toBe(1);
    });

    it("lets ALLOW_DESTRUCTIVE=1 override a block", () => {
      expect(run("rm -rf /", { ALLOW_DESTRUCTIVE: "1" }).status).toBe(0);
    });
  });
});
