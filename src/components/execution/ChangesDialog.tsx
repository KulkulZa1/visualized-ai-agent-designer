/**
 * ChangesDialog — the files this run's agents changed with fs.write, fs.append
 * or edit_file, as a side-by-side diff, with revert per file or for all.
 * Changes made by shell commands are not tracked.
 */
import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useExecutionStore } from "@/store/executionStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useAuditStore } from "@/store/auditStore";
import { writeAuditEntry } from "@/ipc/tauriCommands";
import { lineCounts } from "@/services/execution/changeLog";
import { revertChange } from "@/services/execution/revertChanges";
import type { FileChange } from "@/types/execution";
import { NodeIcon } from "@/components/nodes/NodeIcon";

const DiffEditor = React.lazy(() =>
  import("@/components/editor/monacoLocal").then((m) => ({ default: m.DiffEditor })),
);

const MONO = '"JetBrains Mono", monospace';
const NO_CHANGES: FileChange[] = [];
const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json",
  md: "markdown", rs: "rust", py: "python", css: "css", html: "html", yaml: "yaml", yml: "yaml",
};
const languageOf = (path: string) => LANGUAGES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";

const smallButton: React.CSSProperties = {
  padding: "2px 8px", border: "1px solid var(--border-md)", borderRadius: 4, background: "var(--surface-3)",
  color: "var(--text)", cursor: "pointer", fontSize: 11, fontFamily: "inherit",
};

export function ChangesDialog({ onClose }: { onClose: () => void }) {
  const changes = useExecutionStore((s) => s.currentRun?.changes) ?? NO_CHANGES;
  const forgetFileChange = useExecutionStore((s) => s.forgetFileChange);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const shown = changes.find((c) => c.path === selected) ?? changes[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function revert(targets: FileChange[]) {
    if (!workspacePath) { setMessage("Open the workspace to revert changes."); return; }
    const reverted: string[] = [];
    try {
      for (const change of targets) {
        let outcome = await revertChange(change, workspacePath, invoke);
        if (outcome === "changed-since" &&
            window.confirm(`${change.path} changed after the agent's last edit. Revert it anyway?`)) {
          outcome = await revertChange(change, workspacePath, invoke, true);
        }
        if (outcome !== "reverted") continue;
        forgetFileChange(change.path);
        reverted.push(change.path);
        const entry = {
          id: `revert-${change.path}-${Date.now()}`, timestamp: new Date().toISOString(),
          action: "file_write" as const, path: change.path, success: true,
          details: `↶ Reverted ${change.path} to its content before the run`,
        };
        useAuditStore.getState().addEntry(entry);
        writeAuditEntry(workspacePath, entry).catch(console.error);
      }
      setMessage(reverted.length ? `Reverted ${reverted.join(", ")}.` : "Nothing was reverted.");
    } catch (e) {
      setMessage(`Revert failed: ${String(e)}`);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300,
    }}>
      <div role="dialog" aria-modal="true" aria-labelledby="changes-title" style={{
        width: 1100, maxWidth: "96vw", height: "80vh", display: "flex", flexDirection: "column",
        background: "var(--surface-2)", border: "1px solid var(--border-md)", borderRadius: 12,
        boxShadow: "0 24px 80px rgba(0,0,0,0.7)", overflow: "hidden",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px",
          borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
          <NodeIcon name="file" size={14} color="var(--accent)" />
          <div id="changes-title" style={{ fontSize: 14, fontWeight: 700, flex: 1 }}>
            Changes · {changes.length} file{changes.length === 1 ? "" : "s"}
          </div>
          {changes.length > 0 && <button onClick={() => revert(changes)} style={smallButton}>Revert all</button>}
          <button onClick={onClose} aria-label="Close" style={{ ...smallButton, border: "none", background: "transparent" }}>
            <NodeIcon name="x" size={13} />
          </button>
        </div>

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div style={{ width: 280, borderRight: "1px solid var(--border)", overflowY: "auto" }}>
            {changes.map((c) => {
              const { added, removed } = lineCounts(c.before, c.after);
              return (
                <div key={c.path} onClick={() => setSelected(c.path)} style={{
                  padding: "8px 12px", cursor: "pointer", borderBottom: "1px solid var(--border)",
                  background: c === shown ? "var(--accent-soft)" : "transparent",
                }}>
                  <div style={{ fontFamily: MONO, fontSize: 11, wordBreak: "break-all" }}>{c.path}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 10, color: "var(--muted)" }}>
                    <span style={{ color: c.before === null ? "var(--green)" : "var(--accent)" }}>
                      {c.before === null ? "new" : "modified"}
                    </span>
                    <span style={{ fontFamily: MONO }}>{`+${added} −${removed}`}</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.agents.join(", ")}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); void revert([c]); }} style={smallButton}>Revert</button>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {shown && (
              <React.Suspense fallback={<div style={{ padding: 16, fontSize: 12, color: "var(--hint)" }}>Loading diff…</div>}>
                <DiffEditor
                  height="100%"
                  language={languageOf(shown.path)}
                  original={shown.before ?? ""}
                  modified={shown.after}
                  options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12 }}
                />
              </React.Suspense>
            )}
          </div>
        </div>

        <div style={{ padding: "8px 16px", borderTop: "1px solid var(--border)", fontSize: 11,
          color: "var(--muted)", background: "var(--surface)" }}>
          {message || "Only changes made with fs.write, fs.append and edit_file are listed; changes made by shell commands are not tracked."}
        </div>
      </div>
    </div>
  );
}
