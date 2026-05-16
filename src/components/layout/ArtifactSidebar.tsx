import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getPersistedArtifactPaths } from "@/services/artifact-manager/artifactService";

function extBadge(path: string): string {
  const ext = path.split(".").at(-1) ?? "";
  return ext.toUpperCase() || "FILE";
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

interface Props {
  workspacePath: string | null;
}

export function ArtifactSidebar({ workspacePath }: Props) {
  const [open, setOpen] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setPaths(getPersistedArtifactPaths());
  }, [open]);

  async function handleClick(p: string) {
    if (!workspacePath) return;
    if (preview?.path === p) { setPreview(null); return; }
    try {
      const content = await invoke<string>("read_workspace_file", {
        workspacePath,
        relativePath: p,
      });
      setPreview({ path: p, content });
    } catch {
      setPreview({ path: p, content: "(could not load file)" });
    }
  }

  return (
    <div style={{ borderTop: "1px solid var(--border)", flexShrink: 0 }}>
      {/* Header */}
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "6px 12px", cursor: "pointer", userSelect: "none",
        }}
      >
        <span style={{ fontSize: 9, fontWeight: 600, color: "var(--hint)",
          textTransform: "uppercase", letterSpacing: "0.06em", flex: 1 }}>
          Artifacts ({paths.length})
        </span>
        <span style={{ fontSize: 10, color: "var(--hint)" }}>{open ? "▲" : "▼"}</span>
      </div>

      {/* Body */}
      {open && (
        <div style={{ padding: "0 0 6px" }}>
          {paths.length === 0 ? (
            <div style={{ padding: "4px 12px", fontSize: 11, color: "var(--hint)" }}>
              No artifacts yet.
            </div>
          ) : (
            paths.map((p) => (
              <div key={p}>
                <div
                  onClick={() => handleClick(p)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "3px 12px", cursor: "pointer",
                    background: preview?.path === p ? "var(--accent-soft)" : "transparent",
                  }}
                >
                  <span style={{ fontSize: 11, color: "var(--muted)", flex: 1,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {fileName(p)}
                  </span>
                  <span style={{ fontSize: 9, padding: "1px 4px", borderRadius: 3,
                    background: "var(--surface-3)", color: "var(--accent)" }}>
                    {extBadge(p)}
                  </span>
                </div>
                {preview?.path === p && (
                  <pre style={{
                    margin: "2px 10px 4px", padding: "6px 8px", borderRadius: 4,
                    background: "var(--bg)", border: "1px solid var(--border)",
                    color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 10,
                    lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word",
                    maxHeight: 120, overflow: "auto",
                  }}>
                    {preview.content}
                  </pre>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
