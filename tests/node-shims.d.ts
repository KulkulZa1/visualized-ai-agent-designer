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
    on(event: "error" | "close", listener: () => void): void;
    kill(): boolean;
  }

  export function spawn(
    command: string,
    args?: string[],
    options?: { stdio?: Array<"pipe" | "inherit" | "ignore"> },
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
  }

  export function spawnSync(
    command: string,
    args?: string[],
    options?: SpawnSyncOptions,
  ): SpawnSyncReturns;
}

declare module "node:fs" {
  export function chmodSync(path: string, mode: number): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function mkdtempSync(prefix: string): string;
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function symlinkSync(target: string, path: string, type?: string): void;
  export function writeFileSync(path: string, data: string, encoding?: string): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export const delimiter: string;
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
  execPath: string;
  env: Record<string, string | undefined>;
  platform: string;
  stdout: { write(text: string): boolean };
  stderr: { write(text: string): boolean };
  on(event: "SIGINT", listener: () => void): void;
  off(event: "SIGINT", listener: () => void): void;
  exit(code?: number): never;
};
