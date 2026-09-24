declare module "node:child_process" {
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
  export function resolve(...paths: string[]): string;
}

declare const __dirname: string;
declare const process: {
  execPath: string;
  env: Record<string, string | undefined>;
  platform: string;
};
