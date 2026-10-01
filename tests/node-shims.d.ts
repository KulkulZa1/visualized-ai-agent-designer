// Minimal Node typings: this project has no @types/node. Used by the Node-side
// tests and by src/cli (harness run).

declare module "node:child_process" {
  export interface ChildProcess {
    stdin: {
      write(data: string): boolean;
      end(): void;
      on(event: "error", listener: (error: unknown) => void): void;
    };
    stdout: {
      setEncoding(encoding: string): void;
      on(event: "data", listener: (chunk: string) => void): void;
    };
    stderr: {
      setEncoding(encoding: string): void;
      on(event: "data", listener: (chunk: string) => void): void;
    };
    on(event: "error" | "close", listener: () => void): void;
    on(event: "close", listener: (code: number | null) => void): void;
    kill(signal?: string): boolean;
  }

  export function spawn(
    command: string,
    args?: string[],
    options?: { cwd?: string; env?: Record<string, string | undefined>; stdio?: Array<"pipe" | "inherit" | "ignore"> },
  ): ChildProcess;

  export interface SpawnSyncOptions {
    cwd?: string;
    encoding?: string;
    env?: Record<string, string | undefined>;
    input?: string;
    timeout?: number;
  }

  export interface SpawnSyncReturns {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  }

  export function spawnSync(
    command: string,
    args?: string[],
    options?: SpawnSyncOptions,
  ): SpawnSyncReturns;
}

declare module "node:fs" {
  export interface Stats {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
    mode: number;
    size: number;
  }

  export function chmodSync(path: string, mode: number): void;
  export function copyFileSync(from: string, to: string): void;
  export function existsSync(path: string): boolean;
  export function lstatSync(path: string): Stats;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function mkdtempSync(prefix: string): string;
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: string): string;
  export function readlinkSync(path: string): string;
  /** Resolves with the kernel's own realpath(3): a `..` after a link goes up from the link's target. The plain
   *  function reads `..` in a link's target as text, so it can say a path is inside a folder that it is not. */
  export const realpathSync: { (path: string): string; native(path: string): string };
  export function renameSync(from: string, to: string): void;
  export function rmdirSync(path: string): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function statSync(path: string): Stats;
  export function symlinkSync(target: string, path: string, type?: string): void;
  export function writeFileSync(path: string, data: string, encoding?: string): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export const delimiter: string;
  export const sep: string;
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string): { digest(encoding: "hex"): string };
  };
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare const __dirname: string;
declare const process: {
  cwd(): string;
  getuid?(): number;
  execPath: string;
  env: Record<string, string | undefined>;
  platform: string;
  stdout: { write(text: string): boolean };
  stderr: { write(text: string): boolean };
  on(event: "SIGINT", listener: () => void): void;
  off(event: "SIGINT", listener: () => void): void;
  exit(code?: number): never;
};
