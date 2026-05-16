import { useState } from "react";
import { useWorkflowStore } from "@/store/workflowStore";

interface WorkflowMetaEditorProps {
  onClose: () => void;
}

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box",
  padding: "5px 8px", borderRadius: 4, fontSize: 12,
  border: "1px solid var(--border-md)", background: "var(--surface-3)",
  color: "var(--text)", fontFamily: "inherit", outline: "none",
};

const labelStyle: React.CSSProperties = {
  fontSize: 11, color: "var(--hint)", marginBottom: 3, display: "block",
};

export function WorkflowMetaEditor({ onClose }: WorkflowMetaEditorProps) {
  const meta    = useWorkflowStore((s) => s.meta);
  const updMeta = useWorkflowStore((s) => s.updateMeta);
  const [draft, setDraft] = useState({ ...meta });

  function save() {
    updMeta({
      name:        draft.name,
      description: draft.description,
      version:     draft.version,
      projectRoot: draft.projectRoot,
      updatedAt:   new Date().toISOString(),
    });
    onClose();
  }

  function field(key: keyof typeof draft, label: string, placeholder = "") {
    return (
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{label}</label>
        <input
          style={inputStyle}
          value={draft[key]}
          placeholder={placeholder}
          onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") onClose(); }}
        />
      </div>
    );
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 300,
      background: "rgba(0,0,0,0.55)", display: "grid", placeItems: "center",
    }} onClick={onClose}>
      <div style={{
        background: "var(--surface-2)", border: "1px solid var(--border-md)",
        borderRadius: 8, padding: "20px 22px", width: 380,
        fontFamily: "inherit",
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 16 }}>
          Workflow Metadata
        </div>
        {field("name", "Name", "Untitled Workflow")}
        {field("version", "Version", "1.0.0")}
        {field("description", "Description", "Optional description")}
        {field("projectRoot", "Project Root", "/path/to/project")}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <button onClick={onClose} style={{
            padding: "6px 14px", border: "1px solid var(--border-md)", borderRadius: 5,
            background: "transparent", color: "var(--text)", cursor: "pointer",
            fontSize: 12, fontFamily: "inherit",
          }}>Cancel</button>
          <button onClick={save} style={{
            padding: "6px 14px", border: "none", borderRadius: 5,
            background: "var(--accent)", color: "#1a1207", cursor: "pointer",
            fontSize: 12, fontWeight: 600, fontFamily: "inherit",
          }}>Save</button>
        </div>
      </div>
    </div>
  );
}
