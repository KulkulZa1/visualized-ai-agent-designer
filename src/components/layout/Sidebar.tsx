import { useState } from "react";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { useWorkflowStore } from "@/store/workflowStore";
import { useWorkspaceStore, openWorkspaceFolder, refreshWorkspaceFiles } from "@/store/workspaceStore";
import { filterFileTree } from "@/utils/fileTreeFilter";
import { useUIStore } from "@/store/uiStore";
import { ROLE_META, STATUS_COLORS } from "@/utils/nodeColors";
import type { FileTreeEntry } from "@/types/filesystem";
import { useWorkflow } from "@/hooks/useWorkflow";
import { ArtifactSidebar } from "./ArtifactSidebar";

// ── File tree entry ────────────────────────────────────────────────────────
/** `forceOpen`: a search is on, so every folder shown holds a match and stays open. */
function FileEntry({ entry, depth = 0, forceOpen = false }: {
  entry: FileTreeEntry; depth?: number; forceOpen?: boolean;
}) {
  const [expanded, setOpen] = useState(depth < 1);
  const open = forceOpen || expanded;
  const openFile   = useUIStore((s) => s.openEditorFile);
  const activePath = useUIStore((s) => s.activeEditorPath);
  const { load }   = useWorkflow();

  const isHarness = !entry.isDirectory &&
    (entry.name.endsWith(".harness.yaml") || entry.name.endsWith(".harness.yml"));

  const indent = 8 + depth * 12;
  const isActive = activePath === entry.path;

  if (entry.isDirectory) {
    return (
      <div>
        <div onClick={() => setOpen((v) => !v)} style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: `3px 0 3px ${indent}px`, cursor: "pointer",
          color: "var(--muted)", fontSize: 12, userSelect: "none",
        }}>
          <span style={{ width: 10, display: "inline-flex", opacity: 0.6 }}>
            <NodeIcon name={open ? "chev-d" : "chev"} size={10}/>
          </span>
          <NodeIcon name="folder" size={12} color="var(--accent)" style={{ opacity: 0.75 }}/>
          <span>{entry.name}</span>
        </div>
        {open && entry.children?.map((c) => (
          <FileEntry key={c.path} entry={c} depth={depth + 1} forceOpen={forceOpen}/>
        ))}
      </div>
    );
  }

  const handleFileClick = () => {
    if (isHarness) {
      load(entry.path).catch(console.error);
    } else {
      openFile(entry.path);
    }
  };

  return (
    <div onClick={handleFileClick} style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: `3px 0 3px ${indent + 14}px`,
      color: isActive ? "var(--text)" : "var(--muted)",
      background: isActive ? "var(--accent-soft)" : "transparent",
      borderLeft: isActive ? "2px solid var(--accent)" : "2px solid transparent",
      fontSize: 12, cursor: "pointer",
    }}>
      <NodeIcon name="file" size={11}
        color={isHarness ? "var(--accent)" : undefined}
        style={{ opacity: isHarness ? 0.9 : 0.5 }}/>
      <span style={{ color: isHarness ? "var(--accent)" : undefined }}>{entry.name}</span>
      {isHarness && (
        <span style={{ fontSize: 9, marginLeft: "auto", padding: "1px 5px", borderRadius: 3,
          background: "var(--accent-soft)", color: "var(--accent)" }}>load</span>
      )}
    </div>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────
export function Sidebar() {
  const workspacePath  = useWorkspaceStore((s) => s.workspacePath);
  const fileTree       = useWorkspaceStore((s) => s.fileTree);
  const isLoading      = useWorkspaceStore((s) => s.isLoading);
  const nodes          = useWorkflowStore((s) => s.nodes);
  const selectedNodeId = useUIStore((s) => s.selectedNodeId);
  const selectNode     = useUIStore((s) => s.selectNode);
  const [nodeSearch, setNodeSearch] = useState("");
  const [fileSearch, setFileSearch] = useState("");
  const searchingFiles = fileSearch.trim() !== "";
  const shownTree = filterFileTree(fileTree, fileSearch);

  const filteredNodes = nodeSearch.trim()
    ? nodes.filter((n) => n.data.name.toLowerCase().includes(nodeSearch.toLowerCase()))
    : nodes;

  const workspaceName  = workspacePath?.split(/[\\/]/).at(-1) ?? "no workspace";

  return (
    <div style={{ gridArea: "left" as const, background: "var(--surface)",
      borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column",
      overflow: "hidden" }}>

      {/* Workspace header */}
      <div style={{ padding: "12px 12px 8px", display: "flex", alignItems: "center",
        justifyContent: "space-between", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          onClick={openWorkspaceFolder}>
          <NodeIcon name="folder" size={13} color="var(--accent)"/>
          <span style={{ fontSize: 12, fontWeight: 500 }}>{workspaceName}</span>
        </div>
        {workspacePath && (
          <button onClick={() => { void refreshWorkspaceFiles(); }} title="Refresh files" style={{
            background: "transparent", border: "none", padding: 2, cursor: "pointer",
            color: "var(--hint)", display: "flex",
          }}>
            <NodeIcon name="refresh" size={12}/>
          </button>
        )}
      </div>

      {/* Search */}
      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5,
          background: "var(--bg)", border: "1px solid var(--border)",
          borderRadius: 4, padding: "4px 7px" }}>
          <NodeIcon name="search" size={11} style={{ color: "var(--hint)" }}/>
          <input placeholder="search files" value={fileSearch}
            onChange={(e) => setFileSearch(e.target.value)} style={{
            flex: 1, background: "transparent", border: "none",
            color: "var(--text)", fontSize: 11, outline: "none", fontFamily: "inherit",
          }}/>
        </div>
      </div>

      {/* File tree label */}
      <div style={{ padding: "6px 12px 2px" }}>
        <span style={{ fontSize: 9, fontWeight: 600, color: "var(--hint)",
          textTransform: "uppercase", letterSpacing: "0.06em" }}>Workspace files</span>
      </div>

      {/* File tree */}
      <div style={{ flex: 1, overflow: "auto", padding: "4px 0" }}>
        {isLoading && (
          <div style={{ padding: 10, fontSize: 11, color: "var(--hint)" }}>Loading…</div>
        )}
        {!isLoading && fileTree.length === 0 && (
          <div style={{ padding: 10, fontSize: 11, color: "var(--hint)" }}>
            {workspacePath ? "Empty workspace" : "Open a workspace to browse files"}
          </div>
        )}
        {!isLoading && fileTree.length > 0 && shownTree.length === 0 && (
          <div style={{ padding: 10, fontSize: 11, color: "var(--hint)" }}>No files match</div>
        )}
        {!isLoading && shownTree.map((e) => <FileEntry key={e.path} entry={e} forceOpen={searchingFiles}/>)}
      </div>

      {/* Workflow nodes */}
      <div style={{ borderTop: "1px solid var(--border)", padding: "8px 0", maxHeight: 280, overflow: "auto" }}>
        <div style={{ padding: "0 12px 5px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 9, fontWeight: 600, color: "var(--hint)",
            textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Workflow nodes
          </span>
          {nodeSearch.trim() && (
            <span style={{ fontSize: 9, color: "var(--hint)" }}>
              {filteredNodes.length}/{nodes.length}
            </span>
          )}
        </div>
        <div style={{ padding: "0 8px 4px" }}>
          <input
            value={nodeSearch}
            onChange={(e) => setNodeSearch(e.target.value)}
            placeholder="Filter nodes…"
            style={{
              width: "100%", boxSizing: "border-box",
              padding: "4px 8px", borderRadius: 4, border: "1px solid var(--border)",
              background: "var(--surface-3)", color: "var(--text)",
              fontSize: 11, fontFamily: "inherit", outline: "none",
              marginBottom: 4,
            }}
          />
        </div>
        {nodes.length === 0 && (
          <div style={{ padding: "4px 12px", fontSize: 11, color: "var(--hint)" }}>No nodes yet</div>
        )}
        {filteredNodes.map((n) => {
          const meta   = ROLE_META[n.data.role];
          const status = STATUS_COLORS[n.data.status ?? "idle"];
          const isSel  = selectedNodeId === n.id;
          return (
            <div key={n.id} onClick={() => selectNode(n.id)} style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "4px 12px", cursor: "pointer",
              background: isSel ? "var(--accent-soft)" : "transparent",
              borderLeft: isSel ? "2px solid var(--accent)" : "2px solid transparent",
            }}>
              <span style={{ color: meta.tint, fontSize: 13, width: 14, textAlign: "center",
                flexShrink: 0 }}>{meta.glyph}</span>
              <span style={{ fontSize: 12, color: isSel ? "var(--text)" : "var(--muted)",
                flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {n.data.name}
              </span>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: status.dot,
                flexShrink: 0, boxShadow: n.data.status === "running" ? `0 0 5px ${status.dot}` : "none" }}/>
            </div>
          );
        })}
      </div>

      <ArtifactSidebar workspacePath={workspacePath} />
    </div>
  );
}
