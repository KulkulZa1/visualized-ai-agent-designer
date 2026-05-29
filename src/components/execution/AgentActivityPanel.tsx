/**
 * AgentActivityPanel — live view of a selected agent's execution state.
 *
 * Shows: upstream inputs → live output → downstream connections
 * Plus: status, model, elapsed time, token budget, prompt preview.
 *
 * Appears at the bottom of the canvas center column when a node is selected
 * and a workflow run has started (even if the selected node is still idle).
 */
import { useState, useCallback } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useExecutionStore } from "@/store/executionStore";
import { useNodeExecutionData } from "@/hooks/useNodeExecutionData";
import { ROLE_META } from "@/utils/nodeColors";

// ── helpers ──────────────────────────────────────────────────────────────────

function elapsed(startedAt?: number, finishedAt?: number): string {
  if (!startedAt) return "—";
  const ms = (finishedAt ?? Date.now()) - startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function statusColor(status: string): string {
  return status === "running" ? "var(--accent)"
    : status === "done"    ? "var(--green)"
    : status === "error"   ? "var(--red)"
    : status === "waiting" ? "var(--blue)"
    : "var(--hint)";
}

function statusDot(status: string): React.ReactNode {
  const color = statusColor(status);
  const pulse = status === "running";
  return (
    <span style={{
      display: "inline-block", width: 7, height: 7, borderRadius: "50%",
      background: color, flexShrink: 0,
      boxShadow: pulse ? `0 0 6px ${color}` : "none",
      animation: pulse ? "pulse 1.2s ease-in-out infinite" : "none",
    }}/>
  );
}

function edgeKindColor(kind: string | undefined): string {
  return kind === "memory" ? "var(--purple)"
    : kind === "feedback" ? "var(--red)"
    : kind === "control"  ? "var(--hint)"
    : "var(--blue)";
}

function copyText(text: string) {
  navigator.clipboard.writeText(text).catch(() => {/* ignore */});
}

// ── sub-components ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 9, fontWeight: 700, letterSpacing: "0.08em",
      textTransform: "uppercase", color: "var(--muted)",
      marginBottom: 6, paddingBottom: 3,
      borderBottom: "1px solid var(--border)",
    }}>{children}</div>
  );
}

function ConnectionPill({
  label, kind, nodeName, arrow,
}: { label?: string; kind?: string; nodeName: string; arrow: "←" | "→" }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 5,
      padding: "3px 7px", borderRadius: 4, marginBottom: 4,
      background: "var(--surface-3)", border: "1px solid var(--border)",
      fontSize: 11,
    }}>
      <span style={{ color: edgeKindColor(kind), fontWeight: 700, fontSize: 12 }}>{arrow}</span>
      <span style={{ color: "var(--text)", maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {nodeName}
      </span>
      {label && (
        <span style={{ color: "var(--hint)", fontSize: 10, fontFamily: "var(--font-mono)" }}>
          {label}
        </span>
      )}
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export function AgentActivityPanel({
  nodeId, onClose,
}: { nodeId: string; onClose: () => void }) {
  const [showPrompt, setShowPrompt]   = useState(false);
  const [outputFull, setOutputFull]   = useState(false);
  const [copied, setCopied]           = useState(false);

  const nodes      = useWorkflowStore((s) => s.nodes);
  const edges      = useWorkflowStore((s) => s.edges);
  const currentRun = useExecutionStore((s) => s.currentRun);
  const agentRun   = useNodeExecutionData(nodeId);

  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  const data     = node.data;
  const roleMeta = ROLE_META[data.role as keyof typeof ROLE_META] ?? { glyph: "●", tint: "var(--muted)" };

  // Connections
  type EdgeData = { label?: string; edgeKind?: string };

  const upstream = edges
    .filter((e) => e.target === nodeId)
    .map((e) => ({
      id: e.id, source: e.source, target: e.target,
      label: (e.data as EdgeData | undefined)?.label,
      kind: (e.data as EdgeData | undefined)?.edgeKind,
      sourceName: nodes.find((n) => n.id === e.source)?.data.name ?? e.source,
    }));

  const downstream = edges
    .filter((e) => e.source === nodeId)
    .map((e) => ({
      id: e.id, source: e.source, target: e.target,
      label: (e.data as EdgeData | undefined)?.label,
      kind: (e.data as EdgeData | undefined)?.edgeKind,
      targetName: nodes.find((n) => n.id === e.target)?.data.name ?? e.target,
    }));

  // Peer statuses for the "future work" section
  const downstreamStatuses = downstream.map((e) => {
    const peerRun = currentRun?.agents[e.target];
    return {
      name: e.targetName,
      label: e.label,
      kind: e.kind,
      status: peerRun?.status ?? "idle",
    };
  });

  const status  = agentRun?.status ?? "idle";
  const output  = agentRun?.output ?? "";
  const hasRun  = status !== "idle" && status !== "waiting";
  const tokens  = agentRun?.tokenEstimate ?? 0;
  const budget  = data.tokens?.budget ?? 0;
  const tokenPct = budget > 0 ? Math.min(100, Math.round((tokens / budget) * 100)) : 0;

  const promptContent = data.promptSource.type === "inline"
    ? data.promptSource.content
    : `[From file: ${data.promptSource.type === "file" ? data.promptSource.path : "unknown"}]`;

  const handleCopy = useCallback(() => {
    copyText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [output]);

  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column",
      background: "var(--surface)", overflow: "hidden",
    }}>
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "5px 12px", borderBottom: "1px solid var(--border)",
        background: "var(--surface-2)", flexShrink: 0,
      }}>
        <span style={{ color: roleMeta.tint, fontSize: 14, fontWeight: 700 }}>{roleMeta.glyph}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{data.name}</span>
        <span style={{ fontSize: 10, color: "var(--muted)", padding: "1px 6px",
          borderRadius: 3, background: "var(--surface-3)", fontFamily: "var(--font-mono)" }}>
          {data.role}
        </span>

        {/* Status */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {statusDot(status)}
          <span style={{ fontSize: 11, color: statusColor(status), fontWeight: 600 }}>
            {status}
          </span>
        </div>

        {agentRun?.startedAt && (
          <span style={{ fontSize: 11, color: "var(--hint)", fontFamily: "var(--font-mono)" }}>
            ⏱ {elapsed(agentRun.startedAt, agentRun.finishedAt)}
          </span>
        )}

        {agentRun?.modelUsed && (
          <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
            {agentRun.modelUsed}
            {agentRun.providerUsed ? ` · ${agentRun.providerUsed}` : ""}
          </span>
        )}

        <div style={{ flex: 1 }}/>

        {/* Token budget bar */}
        {budget > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 10, color: "var(--hint)" }}>
              {tokens > 0 ? `~${tokens.toLocaleString()}` : "0"}
              {" / "}{budget.toLocaleString()} tokens
            </span>
            <div style={{ width: 60, height: 4, borderRadius: 2, background: "var(--surface-3)", overflow: "hidden" }}>
              <div style={{
                height: "100%", width: `${tokenPct}%`,
                background: tokenPct > 80 ? "var(--red)" : tokenPct > 50 ? "var(--accent)" : "var(--green)",
                transition: "width 0.4s ease",
              }}/>
            </div>
          </div>
        )}

        {/* Prompt toggle */}
        <button
          onClick={() => setShowPrompt(v => !v)}
          title="Toggle prompt preview"
          style={{
            padding: "2px 8px", borderRadius: 3, fontSize: 10,
            border: `1px solid ${showPrompt ? "var(--accent)" : "var(--border)"}`,
            background: showPrompt ? "var(--accent-soft)" : "var(--surface-3)",
            color: showPrompt ? "var(--accent)" : "var(--muted)",
            cursor: "pointer", fontFamily: "inherit",
          }}
        >prompt</button>

        {/* Close */}
        <button onClick={onClose} style={{
          width: 22, height: 22, border: "none", borderRadius: 3,
          background: "transparent", color: "var(--hint)", cursor: "pointer",
          display: "grid", placeItems: "center", fontSize: 14,
        }}>✕</button>
      </div>

      {/* ── Prompt bar (collapsible) ─────────────────────────────────────── */}
      {showPrompt && (
        <div style={{
          padding: "6px 12px", borderBottom: "1px solid var(--border)",
          background: "var(--bg)", flexShrink: 0, maxHeight: 80, overflow: "auto",
        }}>
          <pre style={{
            margin: 0, fontSize: 10, color: "var(--muted)",
            fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>{promptContent}</pre>
        </div>
      )}

      {/* ── Three-column body ────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* LEFT: Upstream connections ─────────────────────────────────── */}
        <div style={{
          width: 180, flexShrink: 0, padding: "8px 10px",
          borderRight: "1px solid var(--border)", overflow: "auto",
        }}>
          <SectionLabel>Receives from</SectionLabel>
          {upstream.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--hint)" }}>entry point</div>
          ) : (
            upstream.map((e) => {
              const peerRun = currentRun?.agents[e.source];
              return (
                <div key={e.id}>
                  <ConnectionPill
                    arrow="←"
                    nodeName={e.sourceName}
                    label={e.label}
                    kind={e.kind}
                  />
                  {peerRun?.output && (
                    <div style={{
                      fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)",
                      padding: "2px 6px", marginBottom: 4, borderRadius: 3,
                      background: "var(--bg)",
                      overflow: "hidden", textOverflow: "ellipsis",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}>
                      {peerRun.output.slice(0, 120)}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* CENTER: Output ──────────────────────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

          {/* Label bar */}
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "5px 10px 3px", flexShrink: 0,
            borderBottom: "1px solid var(--border)",
          }}>
            {/* Dynamic label based on status */}
            {status === "running" && (
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--accent)",
                display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ animation: "pulse 1s infinite" }}>●</span> Live Output
              </span>
            )}
            {status === "done" && (
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--green)" }}>
                ✓ Final Output
              </span>
            )}
            {status === "error" && (
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--red)" }}>
                ✕ Error
              </span>
            )}
            {status === "skipped" && (
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--hint)" }}>
                ↷ Skipped by gateway
              </span>
            )}
            {!hasRun && status === "idle" && (
              <span style={{ fontSize: 10, color: "var(--hint)" }}>
                Output
              </span>
            )}
            {status === "waiting" && (
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--blue)" }}>
                ⏳ Waiting for upstream…
              </span>
            )}

            {/* Actions */}
            {output && (
              <>
                <button onClick={handleCopy} style={{
                  padding: "2px 8px", borderRadius: 3, fontSize: 10, marginLeft: "auto",
                  border: "1px solid var(--border)", background: copied ? "rgba(95,191,127,0.1)" : "var(--surface-3)",
                  color: copied ? "var(--green)" : "var(--muted)",
                  cursor: "pointer", fontFamily: "inherit",
                }}>{copied ? "✓ Copied" : "Copy"}</button>
                <button onClick={() => setOutputFull(v => !v)} style={{
                  padding: "2px 8px", borderRadius: 3, fontSize: 10,
                  border: "1px solid var(--border)", background: "var(--surface-3)",
                  color: "var(--muted)", cursor: "pointer", fontFamily: "inherit",
                }}>{outputFull ? "↕ Collapse" : "↕ Expand"}</button>
              </>
            )}
            {!output && hasRun && (
              <span style={{ marginLeft: "auto" }}/>
            )}
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflow: "auto", padding: "6px 10px 8px" }}>
            {/* Empty states */}
            {!hasRun && status === "idle" && (
              <div style={{ height: "100%", display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 6,
                color: "var(--hint)", fontSize: 12 }}>
                <span style={{ fontSize: 24 }}>○</span>
                <span>Run the workflow to see output here</span>
              </div>
            )}

            {/* Error */}
            {agentRun?.error && (
              <pre style={{
                margin: 0, padding: "10px 12px", borderRadius: 6,
                background: "rgba(224,117,117,0.07)", border: "1px solid rgba(224,117,117,0.25)",
                color: "var(--red)", fontFamily: "var(--font-mono)", fontSize: 11,
                whiteSpace: "pre-wrap", wordBreak: "break-word",
              }}>{agentRun.error}</pre>
            )}

            {/* Output — shown during streaming AND after completion */}
            {output && (
              <pre style={{
                margin: 0, padding: "10px 12px", borderRadius: 6,
                background: status === "done"
                  ? "rgba(95,191,127,0.04)"
                  : status === "running"
                  ? "rgba(229,161,66,0.04)"
                  : "var(--bg)",
                border: status === "done"
                  ? "1px solid rgba(95,191,127,0.2)"
                  : status === "running"
                  ? "1px solid rgba(229,161,66,0.2)"
                  : "1px solid var(--border)",
                color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11,
                whiteSpace: "pre-wrap", wordBreak: "break-word",
                maxHeight: outputFull ? "none" : 220, overflow: "auto",
                transition: "border-color 0.3s, background 0.3s",
              }}>{output}</pre>
            )}

            {/* Streaming placeholder when running but no output yet */}
            {!output && status === "running" && (
              <div style={{ padding: "8px 4px", color: "var(--accent)", fontSize: 11,
                display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ animation: "pulse 1s infinite" }}>●</span>
                Generating…
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: Downstream + future work ─────────────────────────────── */}
        <div style={{
          width: 190, flexShrink: 0, padding: "8px 10px",
          borderLeft: "1px solid var(--border)", overflow: "auto",
        }}>
          <SectionLabel>Sends to</SectionLabel>
          {downstreamStatuses.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--hint)" }}>terminal node</div>
          ) : (
            downstreamStatuses.map((d, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <ConnectionPill
                  arrow="→"
                  nodeName={d.name}
                  label={d.label}
                  kind={d.kind}
                />
                <div style={{
                  display: "flex", alignItems: "center", gap: 4,
                  paddingLeft: 6, fontSize: 10,
                }}>
                  {statusDot(d.status)}
                  <span style={{ color: statusColor(d.status) }}>{d.status}</span>
                </div>
              </div>
            ))
          )}

          {/* Run info */}
          {currentRun && (
            <>
              <SectionLabel>Run</SectionLabel>
              <div style={{ fontSize: 10, color: "var(--hint)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                {currentRun.id}
              </div>
              <div style={{ fontSize: 10, color: statusColor(currentRun.status), marginTop: 3 }}>
                {currentRun.status}
              </div>
            </>
          )}

          {/* Allowed tools */}
          {data.tools.length > 0 && (
            <>
              <SectionLabel>Tools</SectionLabel>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                {data.tools.map((t) => (
                  <span key={t} style={{
                    fontSize: 9, padding: "1px 5px", borderRadius: 3,
                    background: "var(--surface-3)", color: "var(--muted)",
                    fontFamily: "var(--font-mono)", border: "1px solid var(--border)",
                  }}>{t}</span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
