import { useNodeExecutionData } from "@/hooks/useNodeExecutionData";
import { useWorkflowStore } from "@/store/workflowStore";

interface AgentOutputPanelProps {
  nodeId: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  idle:    "var(--muted)",
  waiting: "var(--hint)",
  running: "var(--accent)",
  done:    "var(--green)",
  error:   "var(--red)",
  skipped: "var(--hint)",
};

function elapsed(start?: number, end?: number): string {
  if (!start) return "";
  const ms = (end ?? Date.now()) - start;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function AgentOutputPanel({ nodeId }: AgentOutputPanelProps) {
  const agentRun = useNodeExecutionData(nodeId);
  const node = useWorkflowStore((s) => s.nodes.find((n) => n.id === nodeId));

  if (!agentRun) return null;

  const model = node?.data.model ?? "";
  const thinkDepth = node?.data.thinkDepth;
  const statusColor = STATUS_COLOR[agentRun.status] ?? "var(--muted)";
  const duration = elapsed(agentRun.startedAt, agentRun.finishedAt);
  const isRunning = agentRun.status === "running";

  return (
    <div style={{
      borderTop: "1px solid var(--border)",
      background: "var(--bg)",
      flexShrink: 0,
    }}>
      {/* Panel header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 14px", borderBottom: "1px solid var(--border)",
        fontSize: 11,
      }}>
        <span style={{
          width: 7, height: 7, borderRadius: "50%",
          background: statusColor, flexShrink: 0,
          boxShadow: isRunning ? `0 0 6px ${statusColor}` : "none",
          animation: isRunning ? "pulse-running 1.4s infinite" : "none",
        }}/>
        <span style={{ fontWeight: 600, flex: 1, color: "var(--text)" }}>
          {agentRun.agentName}
        </span>
        <span style={{ color: statusColor, fontSize: 10, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {agentRun.status}
        </span>
        {duration && (
          <span style={{ color: "var(--hint)", fontSize: 10, fontFamily: "var(--font-mono)" }}>
            {isRunning ? `${duration} elapsed` : duration}
          </span>
        )}
      </div>

      {/* Meta row: model + thinkDepth */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "5px 14px", fontSize: 10, color: "var(--hint)",
        fontFamily: "var(--font-mono)", flexWrap: "wrap",
      }}>
        {model && (
          <span style={{
            padding: "1px 6px", borderRadius: 3,
            background: "var(--surface-3)", color: "var(--muted)",
          }}>
            {model}
          </span>
        )}
        {thinkDepth && thinkDepth !== "none" && (
          <span style={{
            padding: "1px 6px", borderRadius: 3,
            background: "rgba(229,161,66,0.12)", color: "var(--accent)",
          }}>
            thinking:{thinkDepth}
          </span>
        )}
      </div>

      {/* Error */}
      {agentRun.error && (
        <div style={{
          margin: "0 14px 6px", padding: "6px 8px", borderRadius: 4,
          background: "rgba(224,117,117,0.1)", border: "1px solid rgba(224,117,117,0.25)",
          fontSize: 11, color: "var(--red)", wordBreak: "break-word",
        }}>
          {agentRun.error}
        </div>
      )}

      {/* Output */}
      {agentRun.output && (
        <div style={{ padding: "0 14px 10px" }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "flex-end",
            marginBottom: 4,
          }}>
            <button
              onClick={() => navigator.clipboard.writeText(agentRun.output ?? "")}
              style={{
                padding: "2px 8px", border: "1px solid var(--border)", borderRadius: 3,
                background: "transparent", color: "var(--hint)", cursor: "pointer",
                fontSize: 10, fontFamily: "inherit",
              }}
            >
              Copy
            </button>
          </div>
          <pre style={{
            margin: 0, padding: "8px 10px", borderRadius: 4,
            background: "var(--surface-3)",
            fontSize: 11, lineHeight: 1.5, color: "var(--text)",
            fontFamily: '"JetBrains Mono", monospace',
            whiteSpace: "pre-wrap", wordBreak: "break-word",
            maxHeight: 280, overflowY: "auto",
          }}>
            {agentRun.output}
          </pre>
        </div>
      )}

      {isRunning && !agentRun.output && (
        <div style={{
          padding: "4px 14px 10px", fontSize: 11,
          color: "var(--accent)", fontStyle: "italic",
        }}>
          Running…
        </div>
      )}
    </div>
  );
}
