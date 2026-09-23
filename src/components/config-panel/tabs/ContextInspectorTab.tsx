import { useState, useEffect } from "react";
import type { Edge } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useNodeExecutionData } from "@/hooks/useNodeExecutionData";
import { MOCK_ARTIFACTS } from "@/services/artifact-manager/mockArtifacts";
import { buildContextSnapshot } from "@/services/context-builder/contextSnapshot";
import {
  listSnapshotsForNode,
  updateSnapshot,
  type PersistedSnapshot,
} from "@/services/context-builder/snapshotService";
import type { Artifact } from "@/types/inspection";
import { Sec, SmallBtn } from "../shared";

const mono = "var(--font-mono)";
const MAX_HISTORY = 5;

function TextBlock({ children, expanded = false }: { children: React.ReactNode; expanded?: boolean }) {
  return (
    <pre style={{
      margin: 0, padding: "8px 10px", borderRadius: 4,
      background: "var(--bg)", border: "1px solid var(--border)",
      color: "var(--text)", fontFamily: mono, fontSize: 11,
      lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
      maxHeight: expanded ? "none" : 240, overflow: "auto",
    }}>
      {children}
    </pre>
  );
}

function Badge({
  children, tone = "default",
}: { children: React.ReactNode; tone?: "default" | "accent" | "green" }) {
  const color =
    tone === "accent" ? "var(--accent)" :
    tone === "green" ? "var(--green)" : "var(--muted)";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", padding: "2px 6px",
      borderRadius: 3,
      background: tone === "accent" ? "var(--accent-soft)" : "var(--surface-3)",
      color, fontSize: 10, fontFamily: mono,
    }}>
      {children}
    </span>
  );
}

function SnapshotHistoryRow({
  snap,
  workspacePath,
  onDelete,
}: {
  snap: PersistedSnapshot;
  workspacePath: string | null;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const time = snap.createdAt.slice(11, 19); // HH:MM:SS
  const preview = snap.finalContext.slice(0, 30);

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    updateSnapshot(snap.id, { snapshotStatus: "cancelled" }, workspacePath)
      .then(() => onDelete(snap.id))
      .catch(console.error);
  }

  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: "100%", textAlign: "left", display: "flex",
          alignItems: "center", gap: 6, padding: "4px 6px",
          border: "1px solid var(--border)", borderRadius: 4,
          background: "var(--surface-3)", cursor: "pointer",
          fontFamily: "inherit", color: "var(--text)",
        }}
      >
        <Badge
          tone={
            snap.snapshotStatus === "completed" ? "green" :
            snap.snapshotStatus === "failed" ? "accent" : "default"
          }
        >
          {snap.snapshotStatus}
        </Badge>
        <span style={{ fontSize: 10, color: "var(--hint)", fontFamily: mono }}>{time}</span>
        <span style={{ fontSize: 10, color: "var(--muted)", flex: 1,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {preview}…
        </span>
        <span style={{ fontSize: 10, color: "var(--hint)" }}>{expanded ? "▲" : "▼"}</span>
        <span
          onClick={handleDelete}
          title="Delete snapshot"
          style={{
            fontSize: 11, color: "var(--hint)", padding: "0 2px",
            cursor: "pointer", lineHeight: 1,
          }}
        >✕</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 4, display: "grid", gap: 4 }}>
          <TextBlock>{snap.finalContext}</TextBlock>
          <TextBlock>{snap.promptLayers.system}</TextBlock>
        </div>
      )}
    </div>
  );
}

function LiveRunRow({ nodeId }: { nodeId: string }) {
  const agentRun = useNodeExecutionData(nodeId);
  if (!agentRun || agentRun.status === "idle" || agentRun.status === "waiting") return null;

  const elapsedMs = agentRun.startedAt
    ? (agentRun.finishedAt ?? Date.now()) - agentRun.startedAt
    : null;
  const elapsed = elapsedMs == null ? null
    : elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}s`;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "5px 8px", borderRadius: 4, marginBottom: 6,
      background: "var(--surface-3)", border: "1px solid var(--border)",
    }}>
      <span style={{ fontSize: 9, color: "var(--accent)" }}>●</span>
      <span style={{ fontSize: 10, color: "var(--hint)" }}>Current run</span>
      <Badge tone={agentRun.status === "done" ? "green" : "accent"}>
        {agentRun.status}
      </Badge>
      <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: mono }}>
        {agentRun.modelUsed ?? "—"}
      </span>
      <span style={{ fontSize: 10, color: "var(--hint)" }}>
        {agentRun.tokenEstimate ?? 0} tokens
      </span>
      {elapsed && (
        <span style={{ fontSize: 10, color: "var(--hint)", marginLeft: "auto" }}>{elapsed}</span>
      )}
    </div>
  );
}

function SnapshotHistory({
  nodeId, workspacePath,
}: { nodeId: string; workspacePath: string | null }) {
  const [history, setHistory] = useState<PersistedSnapshot[]>([]);

  async function loadHistory() {
    try {
      const snaps = await listSnapshotsForNode(nodeId, workspacePath);
      setHistory(snaps.filter((s) => s.snapshotStatus !== "cancelled").slice(0, MAX_HISTORY));
    } catch (err) {
      console.error(err);
    }
  }

  async function handleExportJson() {
    try {
      const snaps = await listSnapshotsForNode(nodeId, workspacePath);
      const exportable = snaps.filter((s) => s.snapshotStatus !== "cancelled");
      const json = JSON.stringify(exportable, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `snapshots-${nodeId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
    }
  }

  useEffect(() => {
    let alive = true;
    listSnapshotsForNode(nodeId, workspacePath)
      .then((snaps) => {
        if (alive) setHistory(snaps.filter((s) => s.snapshotStatus !== "cancelled").slice(0, MAX_HISTORY));
      })
      .catch(console.error);
    return () => { alive = false; };
  }, [nodeId, workspacePath]);

  function handleDelete(id: string) {
    setHistory((prev) => prev.filter((s) => s.id !== id));
  }

  return (
    <Sec title="Snapshot History">
      <LiveRunRow nodeId={nodeId} />
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <SmallBtn onClick={loadHistory}>↻</SmallBtn>
        <SmallBtn onClick={handleExportJson}>Export JSON</SmallBtn>
      </div>
      {history.length === 0 ? (
        <span style={{ fontSize: 11, color: "var(--hint)" }}>
          No persisted snapshots yet.
        </span>
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          {history.map((snap) => (
            <SnapshotHistoryRow
              key={snap.id}
              snap={snap}
              workspacePath={workspacePath}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </Sec>
  );
}

function ArtifactViewer({ artifacts }: { artifacts: Artifact[] }) {
  const [selectedId, setSelectedId] = useState(artifacts[0]?.id ?? "");
  const [raw, setRaw] = useState(false);
  const selected = artifacts.find((a) => a.id === selectedId) ?? artifacts[0];

  if (!selected) {
    return <div style={{ fontSize: 11, color: "var(--hint)" }}>No artifacts linked to this node.</div>;
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "grid", gap: 6 }}>
        {artifacts.map((artifact) => (
          <button
            key={artifact.id}
            onClick={() => setSelectedId(artifact.id)}
            style={{
              textAlign: "left", border: `1px solid ${
                artifact.id === selected.id ? "rgba(229,161,66,0.4)" : "var(--border)"
              }`, borderRadius: 5,
              background: artifact.id === selected.id ? "var(--accent-dim)" : "var(--surface-3)",
              color: "var(--text)", padding: "7px 8px", cursor: "pointer", fontFamily: "inherit",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, flex: 1 }}>{artifact.title}</span>
              <Badge tone="accent">{artifact.type}</Badge>
            </div>
            <div style={{ marginTop: 3, display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Badge>v{artifact.version}</Badge>
              <Badge>{artifact.status}</Badge>
              <Badge>{artifact.previewMode}</Badge>
            </div>
          </button>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase",
          letterSpacing: "0.06em" }}>Preview</span>
        <div style={{ flex: 1 }} />
        <SmallBtn onClick={() => setRaw(!raw)}>{raw ? "Preview" : "Raw"}</SmallBtn>
      </div>
      <TextBlock>{raw ? JSON.stringify(selected, null, 2) : selected.content}</TextBlock>
    </div>
  );
}

export function ContextInspectorTab({ nodeId }: { nodeId: string }) {
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges as Edge[]);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const node = nodes.find((candidate) => candidate.id === nodeId);
  const agentRun = useNodeExecutionData(nodeId);
  const [outputExpanded, setOutputExpanded] = useState(false);

  if (!node) return null;

  const snapshot = buildContextSnapshot({ node, nodes, edges, agentRun, artifacts: MOCK_ARTIFACTS });

  return (
    <div>
      {/* Snapshot history — shown before the mock banner */}
      <SnapshotHistory nodeId={nodeId} workspacePath={workspacePath} />

      {/* Mock banner */}
      <div style={{
        marginBottom: 6, padding: "8px 10px", borderRadius: 5,
        border: "1px solid rgba(229,161,66,0.2)", background: "var(--accent-dim)",
        color: "var(--accent)", fontSize: 11, fontWeight: 600,
      }}>
        Mock context inspection surface - live trace persistence is planned.
      </div>

      <Sec title="Prompt">
        <div style={{ display: "grid", gap: 8 }}>
          <Badge tone="accent">{snapshot.providerId}</Badge>
          <TextBlock>{snapshot.prompt.staticPrompt || "(no static prompt)"}</TextBlock>
          <TextBlock>{snapshot.prompt.systemPrompt}</TextBlock>
        </div>
      </Sec>

      <Sec title="Final Context">
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Badge>{snapshot.finalContext.previewLabel}</Badge>
            <Badge tone="green">{snapshot.finalContext.tokenEstimate ?? 0} est. tokens</Badge>
          </div>
          <TextBlock>{snapshot.finalContext.content}</TextBlock>
        </div>
      </Sec>

      <Sec title="Inputs">
        <div style={{ display: "grid", gap: 8 }}>
          <TextBlock>
            {snapshot.inputs.upstreamOutputs.length
              ? snapshot.inputs.upstreamOutputs
                  .map((item) => `${item.nodeName} (${item.nodeId})\n${item.output}`)
                  .join("\n\n")
              : "No upstream node outputs."}
          </TextBlock>
          <TextBlock>{snapshot.inputs.userInput}</TextBlock>
        </div>
      </Sec>

      <Sec title="Tools">
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {snapshot.tools.allowedTools.length
            ? snapshot.tools.allowedTools.map((tool) => <Badge key={tool}>{tool}</Badge>)
            : <Badge>none</Badge>}
        </div>
      </Sec>

      <Sec title="Files">
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {snapshot.files.selectedFiles.length
            ? snapshot.files.selectedFiles.map((file) => <Badge key={file}>{file}</Badge>)
            : <Badge>none</Badge>}
        </div>
      </Sec>

      <Sec
        title="Output Stream"
        action={
          <SmallBtn onClick={() => setOutputExpanded((v) => !v)}>
            {outputExpanded ? "↕ Collapse" : "↕ Expand"}
          </SmallBtn>
        }
      >
        <TextBlock expanded={outputExpanded}>{snapshot.outputStream.content}</TextBlock>
      </Sec>

      <Sec title="Artifacts">
        <ArtifactViewer artifacts={snapshot.artifacts} />
      </Sec>

      <Sec title="Debug Info">
        <TextBlock>{JSON.stringify(snapshot.debugInfo, null, 2)}</TextBlock>
      </Sec>
    </div>
  );
}
