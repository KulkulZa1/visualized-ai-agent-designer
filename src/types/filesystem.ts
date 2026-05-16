export interface FileTreeEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileTreeEntry[];
}

export interface WorkspaceConfig {
  root: string;
  recentWorkspaces: string[];
}

export interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}
