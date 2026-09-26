import { describe, it, expect } from "vitest";
import { modShortcut } from "@/utils/shortcuts";

describe("modShortcut", () => {
  it("names Ctrl on Windows and Linux", () => {
    expect(modShortcut("K", "Win32")).toBe("Ctrl+K");
    expect(modShortcut(".", "Linux x86_64")).toBe("Ctrl+.");
  });

  it("uses ⌘ on macOS", () => {
    expect(modShortcut("K", "MacIntel")).toBe("⌘K");
  });

  it("reads the platform from the browser by default", () => {
    expect(modShortcut("S")).toBe(navigator.platform.startsWith("Mac") ? "⌘S" : "Ctrl+S");
  });
});
