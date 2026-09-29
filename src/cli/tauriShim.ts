/**
 * @tauri-apps/api/core in the harness run bundle (vite.cli.config.ts). Node has
 * no Tauri IPC: the engine's commands go to harness-core, and providerAdapter
 * cannot create a stream channel, so replies do not stream.
 */
export class Channel {
  constructor() {
    throw new Error("harness run has no Tauri IPC: replies do not stream");
  }
}
