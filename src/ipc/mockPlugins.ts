// Stub exports for Tauri plugin packages during testing
export const open = () => Promise.resolve(null);
export const readTextFile = () => Promise.resolve("");
export const writeTextFile = () => Promise.resolve();
export const readDir = () => Promise.resolve([]);
