/** A Ctrl shortcut's label for the user's platform: "⌘K" on macOS, "Ctrl+K" on
 *  Windows and Linux. The app's handlers accept either key. */
export function modShortcut(key: string, platform: string = navigator.platform): string {
  return platform.startsWith("Mac") ? `⌘${key}` : `Ctrl+${key}`;
}
