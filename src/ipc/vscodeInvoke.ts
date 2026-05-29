/**
 * vscodeInvoke.ts — frontend shim for running inside a VS Code WebviewPanel.
 *
 * When the Harness Studio React app runs inside a VS Code webview (not Tauri),
 * `@tauri-apps/api/core`'s `invoke()` is not available. Instead, the extension
 * host injects `window.__HARNESS_INVOKE__` via the bridge script in webviewPanel.ts.
 *
 * Usage: import this at the top of the invoke chain (tauriCommands.ts) and
 * check `isVsCode()` before calling Tauri's `invoke()`.
 *
 * The bridge is injected by the extension BEFORE any React script loads,
 * so `window.__HARNESS_INVOKE__` is always defined by the time components mount.
 */

declare global {
  interface Window {
    __HARNESS_VSCODE__: boolean;
    __HARNESS_INVOKE__: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  }
}

/** Returns true when running inside a VS Code WebviewPanel. */
export function isVsCode(): boolean {
  return typeof window !== "undefined" && window.__HARNESS_VSCODE__ === true;
}

/**
 * VS Code-compatible invoke function.
 * Routes calls to the extension host via window.__HARNESS_INVOKE__.
 */
export function vsCodeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!window.__HARNESS_INVOKE__) {
    return Promise.reject(new Error("[Harness] VS Code invoke bridge not available."));
  }
  return window.__HARNESS_INVOKE__<T>(command, args);
}
