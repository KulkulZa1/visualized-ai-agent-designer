// In-memory mock of @tauri-apps/api/core for Vitest
const _handlers = new Map<string, (...args: unknown[]) => unknown>();

export function mockInvokeHandler(cmd: string, handler: (...args: unknown[]) => unknown) {
  _handlers.set(cmd, handler);
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const handler = _handlers.get(cmd);
  if (handler) return Promise.resolve(handler(args) as T);
  return Promise.reject(new Error(`No mock handler for command: ${cmd}`));
}
