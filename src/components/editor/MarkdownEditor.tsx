import React from "react";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useUIStore } from "@/store/uiStore";
import { writeWorkspaceFile, readWorkspaceFile } from "@/ipc/tauriCommands";
import { useState, useEffect } from "react";

const MonacoEditor = React.lazy(() =>
  import("./monacoLocal").then((m) => ({ default: m.default }))
);

interface MarkdownEditorProps {
  path: string;
}

export function MarkdownEditor({ path }: MarkdownEditorProps) {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const markEditorSaved = useUIStore((s) => s.markEditorSaved);
  const setEditorBuffer = useUIStore((s) => s.setEditorBuffer);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  // A file that failed to load must never reach the editor: saving its empty
  // buffer would truncate the real file (binary / non-UTF-8 files).
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspacePath) return;
    // Switching back to a tab with unsaved edits restores them, not the disk copy.
    const unsaved = useUIStore.getState().openEditorTabs.find((t) => t.path === path)?.unsaved;
    if (unsaved !== undefined) {
      setContent(unsaved);
      setLoadError(null);
      setLoading(false);
      return;
    }
    // Ignore a slow read for a previous path: its text must not land in this tab.
    let current = true;
    setLoading(true);
    setLoadError(null);
    readWorkspaceFile(workspacePath, path)
      .then((text) => { if (current) setContent(text); })
      .catch((err) => { if (current) setLoadError(String(err)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [workspacePath, path]);

  async function handleSave(value: string | undefined) {
    if (!workspacePath || value === undefined) return;
    try {
      await writeWorkspaceFile(workspacePath, path, value);
      markEditorSaved(path, value);
    } catch (err) {
      console.error("Failed to save file:", err);
    }
  }

  if (loading) return <div className="p-4 text-xs text-gray-400">Loading…</div>;
  if (loadError) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: "var(--red)" }}>
        {path} cannot be opened as text: {loadError}
      </div>
    );
  }

  return (
    <React.Suspense fallback={
      <div style={{ padding: 16, fontSize: 12, color: "var(--hint)" }}>Loading editor…</div>
    }>
      <MonacoEditor
        height="100%"
        theme="vs-dark"
        language={path.endsWith(".yaml") || path.endsWith(".yml") ? "yaml" : "markdown"}
        value={content}
        onChange={(v) => {
          setContent(v ?? "");
          setEditorBuffer(path, v ?? "");
        }}
        onMount={(editor) => {
          editor.addCommand(
            // Ctrl+S
            2048 | 49,
            () => handleSave(editor.getValue())
          );
        }}
        options={{
          fontSize: 13,
          fontFamily: "JetBrains Mono, Fira Code, monospace",
          wordWrap: "on",
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          lineNumbers: "on",
          renderLineHighlight: "line",
        }}
      />
    </React.Suspense>
  );
}
