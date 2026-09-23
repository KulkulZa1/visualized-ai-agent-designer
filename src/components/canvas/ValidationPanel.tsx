/**
 * ValidationPanel — modal showing workflow validation results with fix suggestions.
 * Opens when the user clicks "Validate" and there are errors or warnings.
 */
import type { ValidationResult } from "@/types/workflow";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { useWorkflowStore } from "@/store/workflowStore";
import { useUIStore } from "@/store/uiStore";

// ── Per-error fix suggestions ─────────────────────────────────────────────────

const FIX_SUGGESTIONS: Record<string, { icon: string; fix: string }> = {
  disconnected: {
    icon: "⬡",
    fix: "Draw an edge from this node to another node. Every node except singletons needs at least one connection.",
  },
  cycle: {
    icon: "↺",
    fix: "Find the looping edge and change its type to 'feedback' (dashed red). Feedback edges are excluded from cycle detection.",
  },
  missing_prompt: {
    icon: "✎",
    fix: "Select the node → open the Prompt tab → add a system prompt. Memory and Hook nodes are exempt.",
  },
  no_model: {
    icon: "◈",
    fix: "Select the node → open the Role tab → choose a model (e.g. claude-haiku-4.5 or gpt-4o-mini).",
  },
  high_token_budget: {
    icon: "◎",
    fix: "Open the Role tab and lower the token budget to match the expected output size. 4096–16384 is typical.",
  },
  many_tools: {
    icon: "⊞",
    fix: "Open the Tools tab and remove tools the agent doesn't need. Principle of least privilege.",
  },
  no_hooks_on_bash: {
    icon: "⚠",
    fix: "Remove the bash permission: agent-issued shell commands are disabled at runtime.",
  },
};

const DEFAULT_FIX = { icon: "?", fix: "Check the node configuration in the right-hand panel." };

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  result: ValidationResult;
  onClose: () => void;
}

export function ValidationPanel({ result, onClose }: Props) {
  const selectNode = useUIStore((s) => s.selectNode);
  const nodes = useWorkflowStore((s) => s.nodes);

  const { errors, warnings } = result;
  const total = errors.length + warnings.length;

  function jumpTo(nodeId: string | undefined) {
    if (!nodeId) return;
    selectNode(nodeId);
    onClose();
  }

  function nodeName(nodeId: string | undefined): string {
    if (!nodeId) return "";
    return nodes.find((n) => n.id === nodeId)?.data.name ?? nodeId;
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(3px)", display: "flex", alignItems: "flex-start",
        justifyContent: "center", paddingTop: 80, zIndex: 250,
        fontFamily: "inherit",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 540, maxWidth: "96vw",
          background: "var(--surface-2)", border: "1px solid var(--border-md)",
          borderRadius: 12, boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "13px 18px", borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
        }}>
          {errors.length > 0 ? (
            <span style={{ fontSize: 16, color: "var(--red)" }}>✕</span>
          ) : (
            <span style={{ fontSize: 16, color: "var(--accent)" }}>⚠</span>
          )}
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>
              Workflow Validation
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>
              {errors.length > 0
                ? `${errors.length} error${errors.length !== 1 ? "s" : ""} must be fixed before running`
                : `${warnings.length} warning${warnings.length !== 1 ? "s" : ""} — workflow can run but review recommended`}
            </div>
          </div>
          <div style={{ flex: 1 }}/>
          <button onClick={onClose} style={{
            width: 26, height: 26, border: "none", borderRadius: 4,
            background: "transparent", color: "var(--hint)", cursor: "pointer",
            display: "grid", placeItems: "center",
          }}>
            <NodeIcon name="x" size={13}/>
          </button>
        </div>

        {/* Body */}
        <div style={{ maxHeight: "60vh", overflowY: "auto", padding: "12px 0" }}>

          {/* Valid state */}
          {total === 0 && (
            <div style={{
              padding: "24px", textAlign: "center",
              fontSize: 13, color: "var(--green)",
            }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>✓</div>
              Workflow is valid — all checks passed.
            </div>
          )}

          {/* Errors */}
          {errors.map((err, i) => {
            const suggestion = FIX_SUGGESTIONS[err.kind] ?? DEFAULT_FIX;
            return (
              <div key={i} style={{
                margin: "0 14px 10px", padding: "12px 14px", borderRadius: 8,
                background: "rgba(224,117,117,0.07)",
                border: "1px solid rgba(224,117,117,0.25)",
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 6 }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>{suggestion.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--red)", marginBottom: 3 }}>
                      {err.message}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.5 }}>
                      <span style={{ fontWeight: 600, color: "var(--muted)" }}>Fix: </span>
                      {suggestion.fix}
                    </div>
                  </div>
                </div>
                {err.nodeId && (
                  <button
                    onClick={() => jumpTo(err.nodeId)}
                    style={{
                      fontSize: 10, padding: "3px 9px", borderRadius: 4,
                      border: "1px solid rgba(224,117,117,0.4)",
                      background: "rgba(224,117,117,0.1)", color: "var(--red)",
                      cursor: "pointer", fontFamily: "inherit",
                    }}
                  >
                    → Jump to: {nodeName(err.nodeId)}
                  </button>
                )}
              </div>
            );
          })}

          {/* Warnings */}
          {warnings.map((warn, i) => {
            const suggestion = FIX_SUGGESTIONS[warn.kind] ?? DEFAULT_FIX;
            return (
              <div key={i} style={{
                margin: "0 14px 10px", padding: "12px 14px", borderRadius: 8,
                background: "rgba(229,161,66,0.07)",
                border: "1px solid rgba(229,161,66,0.25)",
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 6 }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>{suggestion.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)", marginBottom: 3 }}>
                      {warn.message}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.5 }}>
                      <span style={{ fontWeight: 600, color: "var(--muted)" }}>Suggestion: </span>
                      {suggestion.fix}
                    </div>
                  </div>
                </div>
                {warn.nodeId && (
                  <button
                    onClick={() => jumpTo(warn.nodeId)}
                    style={{
                      fontSize: 10, padding: "3px 9px", borderRadius: 4,
                      border: "1px solid rgba(229,161,66,0.4)",
                      background: "rgba(229,161,66,0.1)", color: "var(--accent)",
                      cursor: "pointer", fontFamily: "inherit",
                    }}
                  >
                    → Jump to: {nodeName(warn.nodeId)}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{
          padding: "12px 18px", borderTop: "1px solid var(--border)",
          display: "flex", justifyContent: "flex-end",
          background: "var(--surface)",
        }}>
          <button onClick={onClose} style={{
            padding: "7px 18px", border: "none", borderRadius: 5,
            background: "var(--surface-3)", color: "var(--text)",
            cursor: "pointer", fontSize: 13, fontFamily: "inherit",
          }}>Close</button>
        </div>
      </div>
    </div>
  );
}
