import { useExecutionStore } from "@/store/executionStore";
import { useUIStore } from "@/store/uiStore";
import type { AgentStatus } from "@/types/execution";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { ExecutionTimeline } from "./ExecutionTimeline";

interface RunPanelProps {
  onClose: () => void;
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle:    "var(--muted)",
  waiting: "var(--hint)",
  running: "var(--accent)",
  done:    "var(--green)",
  error:   "var(--red)",
  skipped: "var(--hint)",
  stopped: "var(--hint)",
};

const STATUS_ICON: Record<AgentStatus, string> = {
  idle:    "circle",
  waiting: "history",
  running: "play",
  done:    "check",
  error:   "x",
  skipped: "chev",
  stopped: "stop",
};

function elapsed(start?: number, end?: number): string {
  if (!start) return "";
  const ms = (end ?? Date.now()) - start;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function RunPanel({ onClose }: RunPanelProps) {
  const currentRun = useExecutionStore((s) => s.currentRun);
  const cancelRun  = useExecutionStore((s) => s.cancelRun);
  const apiKey     = useExecutionStore((s) => s.apiKey);
  const openaiApiKey = useExecutionStore((s) => s.openaiApiKey);
  const llmProvider = useExecutionStore((s) => s.llmProvider);
  const ollamaModel = useExecutionStore((s) => s.ollamaModel);
  const ollamaBaseUrl = useExecutionStore((s) => s.ollamaBaseUrl);
  const setApiKey  = useExecutionStore((s) => s.setApiKey);
  const setOpenaiApiKey = useExecutionStore((s) => s.setOpenaiApiKey);
  const selectNode = useUIStore((s) => s.selectNode);

  const agents = currentRun ? Object.values(currentRun.agents) : [];
  const runningAgent = agents.find((a) => a.status === "running");
  const missingHostedKey =
    (llmProvider === "anthropic" && !apiKey) ||
    (llmProvider === "openai" && !openaiApiKey);

  return (
    <div style={{
      position: "fixed", right: 0, bottom: 26, top: 40,
      width: 300, background: "var(--surface-2)",
      borderLeft: "1px solid var(--border-md)",
      display: "flex", flexDirection: "column",
      zIndex: 100, fontFamily: "inherit", fontSize: 12,
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 14px", borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}>
        <NodeIcon name="play" size={13} color="var(--accent)"/>
        <span style={{ fontWeight: 600, flex: 1 }}>
          {currentRun?.workflowName ?? "Run"}
        </span>
        {currentRun && (
          <span style={{ color: "var(--muted)", fontSize: 11 }}>
            {elapsed(currentRun.startedAt, currentRun.finishedAt)}
          </span>
        )}
        <button onClick={onClose} style={{
          border: "none", background: "transparent", color: "var(--hint)",
          cursor: "pointer", padding: 2, display: "grid", placeItems: "center",
        }}>
          <NodeIcon name="x" size={13}/>
        </button>
      </div>

      {/* Provider warning */}
      {missingHostedKey && (
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ color: "var(--red)", marginBottom: 6, fontWeight: 500 }}>
            No {llmProvider === "openai" ? "OpenAI" : "Anthropic"} API key set
          </div>
          <input
            type="password"
            placeholder={llmProvider === "openai" ? "sk-..." : "sk-ant-..."}
            style={{
              width: "100%", boxSizing: "border-box",
              padding: "5px 8px", borderRadius: 5, fontSize: 11,
              border: "1px solid var(--border-md)", background: "var(--surface-3)",
              color: "var(--text)", fontFamily: "monospace",
            }}
            onChange={(e) => {
              if (llmProvider === "openai") setOpenaiApiKey(e.target.value);
              else setApiKey(e.target.value);
            }}
          />
        </div>
      )}
      {(llmProvider === "ollama" || llmProvider === "ollama-cloud") && (
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0, color: "var(--hint)", fontSize: 11 }}>
          Running via {llmProvider === "ollama-cloud" ? "Ollama Cloud" : "local Ollama"}: <span style={{ color: "var(--text)", fontFamily: "monospace" }}>{ollamaModel}</span>
          <br />
          <span style={{ fontFamily: "monospace" }}>{ollamaBaseUrl}</span>
        </div>
      )}

      {/* Status */}
      {currentRun && (
        <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <span style={{
            padding: "2px 8px", borderRadius: 99, fontSize: 10, fontWeight: 700,
            background: currentRun.status === "running" ? "var(--accent-soft)" :
                        currentRun.status === "done"    ? "rgba(95,191,127,0.15)" :
                        currentRun.status === "error"   ? "rgba(224,117,117,0.15)" :
                        "var(--surface-3)",
            color: currentRun.status === "running" ? "var(--accent)" :
                   currentRun.status === "done"    ? "var(--green)" :
                   currentRun.status === "error"   ? "var(--red)" :
                   "var(--muted)",
          }}>
            {currentRun.status.toUpperCase()}
          </span>
        </div>
      )}

      {/* Agent list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        {agents.length === 0 && (
          <div style={{ padding: "20px 14px", color: "var(--hint)", textAlign: "center" }}>
            No agents have run yet.
          </div>
        )}
        {agents.map((agent) => (
          <div key={agent.agentId} onClick={() => selectNode(agent.agentId)} style={{
            display: "flex", alignItems: "flex-start", gap: 8,
            padding: "6px 14px", cursor: "pointer",
            background: agent.status === "running" ? "var(--accent-soft)" : "transparent",
          }}>
            <NodeIcon
              name={STATUS_ICON[agent.status]}
              size={12}
              color={STATUS_COLOR[agent.status]}
              style={{ marginTop: 1, flexShrink: 0 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, color: STATUS_COLOR[agent.status] }}>
                {agent.agentName}
              </div>
              {agent.status === "running" && (
                <div style={{ color: "var(--muted)", fontSize: 10 }}>
                  {elapsed(agent.startedAt)} elapsed…
                </div>
              )}
              {agent.status === "done" && agent.modelUsed && (
                <div style={{ color: "var(--hint)", fontSize: 10, fontFamily: "var(--font-mono)", marginTop: 1 }}>
                  {agent.modelUsed} via {agent.providerUsed}
                </div>
              )}
              {agent.tokenEstimate != null && (
                <div style={{ color: "var(--hint)", fontSize: 10, marginTop: 1 }}>
                  ~{agent.tokenEstimate.toLocaleString()} est. tokens
                </div>
              )}
              {agent.error && (
                <div style={{
                  fontSize: 10, color: "var(--red)", marginTop: 2,
                  wordBreak: "break-word",
                }}>
                  {agent.error.slice(0, 120)}
                </div>
              )}
            </div>
            <span style={{ color: "var(--hint)", fontSize: 10, flexShrink: 0 }}>
              {elapsed(agent.startedAt, agent.finishedAt)}
            </span>
          </div>
        ))}
      </div>

      {/* Running agent output */}
      {runningAgent?.output && (
        <div style={{
          borderTop: "1px solid var(--border)", padding: "8px 14px",
          background: "var(--surface-3)", flexShrink: 0, maxHeight: 200, overflowY: "auto",
        }}>
          <div style={{ fontSize: 10, color: "var(--hint)", marginBottom: 4,
            display: "flex", alignItems: "center", gap: 8 }}>
            <span>Latest output</span>
            <button
              onClick={() => navigator.clipboard.writeText(runningAgent.output ?? "")}
              style={{
                padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 3,
                background: "transparent", color: "var(--hint)", cursor: "pointer",
                fontSize: 10, fontFamily: "inherit",
              }}
            >
              Copy
            </button>
          </div>
          <pre style={{
            margin: 0, fontSize: 10, color: "var(--text)",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
            fontFamily: '"JetBrains Mono", monospace',
          }}>
            {runningAgent.output.split("\n").slice(-10).join("\n")}
          </pre>
        </div>
      )}

      {/* Execution timeline */}
      {(currentRun?.status === "done" || agents.some((a) => a.finishedAt)) && (
        <ExecutionTimeline />
      )}

      {/* Cancel button */}
      {currentRun?.status === "running" && (
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          <button onClick={cancelRun} style={{
            width: "100%", padding: "6px 0", border: "1px solid var(--red)",
            borderRadius: 5, background: "transparent", color: "var(--red)",
            cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit",
          }}>
            Cancel run
          </button>
        </div>
      )}
    </div>
  );
}
