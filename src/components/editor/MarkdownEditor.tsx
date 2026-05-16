import MonacoEditor from "@monaco-editor/react";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useUIStore } from "@/store/uiStore";
import { writeWorkspaceFile } from "@/ipc/tauriCommands";
import { useState, useEffect } from "react";
import { readWorkspaceFile } from "@/ipc/tauriCommands";

interface MarkdownEditorProps {
  path: string;
}

export function MarkdownEditor({ path }: MarkdownEditorProps) {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const markEditorDirty = useUIStore((s) => s.markEditorDirty);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspacePath) return;
    setLoading(true);
    readWorkspaceFile(workspacePath, path)
      .then(setContent)
      .catch(() => setContent(""))
      .finally(() => setLoading(false));
  }, [workspacePath, path]);

  async function handleSave(value: string | undefined) {
    if (!workspacePath || value === undefined) return;
    try {
      await writeWorkspaceFile(workspacePath, path, value);
      markEditorDirty(path, false);
    } catch (err) {
      console.error("Failed to save file:", err);
    }
  }

  if (loading) return <div className="p-4 text-xs text-gray-400">Loading…</div>;

  return (
    <MonacoEditor
      height="100%"
      language={path.endsWith(".yaml") || path.endsWith(".yml") ? "yaml" : "markdown"}
      value={content}
      onChange={(v) => {
        setContent(v ?? "");
        markEditorDirty(path, true);
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
        theme: "vs",
      }}
    />
  );
}
