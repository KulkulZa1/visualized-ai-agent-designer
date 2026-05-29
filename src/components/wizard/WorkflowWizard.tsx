/**
 * WorkflowWizard — Create-from-Goal modal.
 *
 * Flow:
 *   1. User types a goal (e.g. "automate my blog")
 *   2. Wizard matches against the goalTemplates catalog (keyword overlap)
 *   3. Shows top-3 templates with recommended agents/provider/model + setup steps
 *   4. User picks one → templateToWorkflowDef → loaded into canvas
 *
 * Pure rule-based. No AI call. No network.
 */
import { useState, useMemo } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useExecutionStore } from "@/store/executionStore";
import { workflowDefSchema } from "@/schemas/workflowSchema";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import {
  matchGoal, recommendProvider, GOAL_TEMPLATES,
  type GoalTemplate, type ProviderCategory, type MatchResult,
} from "@/services/wizard/goalTemplates";
import { templateToWorkflowDef } from "@/services/wizard/templateToWorkflow";
import { ROLE_META } from "@/utils/nodeColors";

const MONO = '"JetBrains Mono", ui-monospace, monospace';

const PROVIDER_LABELS: Record<ProviderCategory, { label: string; color: string }> = {
  "local":             { label: "Ollama (local)", color: "#6366f1" },
  "ollama-cloud":      { label: "Ollama Cloud",   color: "#0ea5e9" },
  "anthropic":         { label: "Anthropic",      color: "#d97706" },
  "openai":            { label: "OpenAI",         color: "#10b981" },
  "openai-compatible": { label: "Custom Endpoint", color: "#94a3b8" },
};

const DIFFICULTY_BADGE: Record<string, { label: string; color: string }> = {
  beginner:     { label: "Beginner",     color: "#10b981" },
  intermediate: { label: "Intermediate", color: "#f59e0b" },
  advanced:     { label: "Advanced",     color: "#ef4444" },
};

interface WorkflowWizardProps {
  onClose: () => void;
}

export function WorkflowWizard({ onClose }: WorkflowWizardProps) {
  const [goalText, setGoalText] = useState("");
  const [selected, setSelected] = useState<GoalTemplate | null>(null);
  const [appliedError, setAppliedError] = useState<string | null>(null);

  // Provider availability — pulled from execution store
  const apiKey       = useExecutionStore((s) => s.apiKey);
  const openaiKey    = useExecutionStore((s) => s.openaiApiKey);
  const ollamaKey    = useExecutionStore((s) => s.ollamaApiKey);
  const customUrl    = useExecutionStore((s) => s.customApiUrl);
  const ollamaUrl    = useExecutionStore((s) => s.ollamaBaseUrl);
  const llmProvider  = useExecutionStore((s) => s.llmProvider);

  const avail = {
    hasOpenAIKey:      Boolean(openaiKey),
    hasAnthropicKey:   Boolean(apiKey),
    // We don't ping Ollama here — we just check if a URL is set and provider is configured.
    ollamaReady:       Boolean(ollamaUrl) && (llmProvider === "ollama" || llmProvider === "auto"),
    hasOllamaCloudKey: Boolean(ollamaKey),
    hasCustomEndpoint: Boolean(customUrl),
  };

  // Match results
  const matches: MatchResult[] = useMemo(() => {
    if (!goalText.trim()) {
      // Show all templates if no input yet
      return GOAL_TEMPLATES.map((t) => ({ template: t, score: 0, matchedTriggers: [] }));
    }
    return matchGoal(goalText, 5);
  }, [goalText]);

  const loadWorkflow = useWorkflowStore((s) => s.loadWorkflow);

  const handleCreate = (template: GoalTemplate) => {
    const rec = recommendProvider(template, avail);
    const def = templateToWorkflowDef(template, { provider: rec.category });

    // Validate before loading — defensive but the converter should always produce valid output
    const result = workflowDefSchema.safeParse(def);
    if (!result.success) {
      const msg = result.error.issues.slice(0, 3).map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
      setAppliedError(`Validation failed: ${msg}`);
      return;
    }
    loadWorkflow(result.data);
    onClose();
  };

  // ── If a template is selected, show detail view ────────────────────────────
  if (selected) {
    const rec = recommendProvider(selected, avail);
    const provLabel = PROVIDER_LABELS[rec.category];
    const diff = DIFFICULTY_BADGE[selected.difficulty];

    return (
      <div onClick={onClose} style={modalBackdrop}>
        <div onClick={(e) => e.stopPropagation()} style={modalCard}>
          {/* Header */}
          <div style={headerStyle}>
            <button onClick={() => setSelected(null)} style={backBtn}>← Back</button>
            <span style={{ flex: 1, fontWeight: 700, fontSize: 13 }}>{selected.title}</span>
            <span style={{
              fontSize: 10, padding: "2px 8px", borderRadius: 99,
              background: `${diff.color}22`, color: diff.color, fontWeight: 600,
            }}>{diff.label}</span>
            <button onClick={onClose} style={closeBtn}>✕</button>
          </div>

          {/* Body */}
          <div style={bodyStyle}>
            <p style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6, marginTop: 0 }}>
              {selected.description}
            </p>

            {/* Recommended provider card */}
            <div style={{
              marginBottom: 14, padding: "10px 12px",
              background: rec.ready ? "rgba(16,185,129,0.08)" : "rgba(245,158,11,0.08)",
              border: `1px solid ${rec.ready ? "rgba(16,185,129,0.3)" : "rgba(245,158,11,0.3)"}`,
              borderRadius: 8,
            }}>
              <div style={{
                fontSize: 10, fontWeight: 700, color: rec.ready ? "#10b981" : "#f59e0b",
                textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5,
              }}>
                {rec.ready ? "✓ READY TO RUN" : "⚠ SETUP REQUIRED"}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{
                  fontSize: 11, padding: "2px 8px", borderRadius: 99,
                  background: `${provLabel.color}22`, color: provLabel.color, fontWeight: 600,
                }}>{provLabel.label}</span>
                <span style={{ fontSize: 11, color: "var(--text)" }}>{rec.reason}</span>
              </div>
              {!rec.ready && (
                <ol style={{ margin: "6px 0 0 18px", padding: 0 }}>
                  {rec.setupSteps.map((s, i) => (
                    <li key={i} style={{ fontSize: 11, color: "var(--muted)", marginBottom: 3, lineHeight: 1.5 }}>{s}</li>
                  ))}
                </ol>
              )}
            </div>

            {/* Agents */}
            <Section title="Agents in this workflow">
              {selected.recommendedAgents.map((a, i) => {
                const meta = ROLE_META[a.role];
                return (
                  <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "flex-start" }}>
                    <span style={{
                      width: 22, height: 22, borderRadius: 5,
                      background: `${meta.tint}18`, border: `1px solid ${meta.tint}44`,
                      display: "grid", placeItems: "center",
                      fontSize: 11, color: meta.tint, flexShrink: 0,
                    }}>{meta.glyph}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                        {a.name} <span style={{ fontSize: 10, fontWeight: 400, color: "var(--hint)" }}>· {meta.label}</span>
                      </div>
                      <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.4 }}>{a.description}</div>
                      <div style={{ fontSize: 10, color: "var(--hint)", fontFamily: MONO, marginTop: 1 }}>
                        suggested model: {a.modelHint}
                      </div>
                    </div>
                  </div>
                );
              })}
            </Section>

            {/* Setup */}
            <Section title="Setup requirements">
              <ul style={listStyle}>
                {selected.setupRequirements.map((s, i) => <li key={i} style={liStyle}>{s}</li>)}
              </ul>
            </Section>

            {/* Expected artifacts */}
            <Section title="Expected artifacts">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {selected.expectedArtifacts.map((a) => (
                  <span key={a} style={{
                    fontSize: 11, fontFamily: MONO, padding: "2px 7px", borderRadius: 4,
                    background: "var(--surface-3)", color: "var(--muted)",
                  }}>{a}</span>
                ))}
              </div>
            </Section>

            {/* Verification */}
            <Section title="How to verify success">
              <p style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.6, margin: 0 }}>
                {selected.verificationMethod}
              </p>
            </Section>

            {/* Privacy + safety */}
            <Section title="Privacy & safety">
              <div style={{
                fontSize: 11, color: "var(--muted)", lineHeight: 1.6,
                padding: "6px 10px", background: "var(--surface-3)", borderRadius: 5,
              }}>
                {selected.privacyNotes}
              </div>
              {selected.safetyWarnings.length > 0 && (
                <ul style={{ ...listStyle, marginTop: 6 }}>
                  {selected.safetyWarnings.map((w, i) => (
                    <li key={i} style={{ ...liStyle, color: "#f59e0b" }}>⚠ {w}</li>
                  ))}
                </ul>
              )}
            </Section>

            {appliedError && (
              <div style={{
                marginTop: 10, padding: "8px 12px",
                background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)",
                borderRadius: 5, fontSize: 11, color: "#f87171",
              }}>{appliedError}</div>
            )}
          </div>

          {/* Footer */}
          <div style={footerStyle}>
            <button onClick={onClose} style={secondaryBtn}>Cancel</button>
            <button onClick={() => handleCreate(selected)} style={primaryBtn}>
              <NodeIcon name="grid" size={11}/>
              Load this workflow
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── List view (default) ─────────────────────────────────────────────────────
  return (
    <div onClick={onClose} style={modalBackdrop}>
      <div onClick={(e) => e.stopPropagation()} style={modalCard}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={{
            width: 22, height: 22, borderRadius: 5,
            background: "var(--accent-soft)", border: "1px solid var(--accent)",
            display: "grid", placeItems: "center",
            fontSize: 12, color: "var(--accent)",
          }}>★</div>
          <span style={{ fontWeight: 700, fontSize: 13 }}>Create from Goal</span>
          <span style={{ fontSize: 10, color: "var(--hint)", marginLeft: 4 }}>
            Rule-based template recommender
          </span>
          <div style={{ flex: 1 }}/>
          <button onClick={onClose} style={closeBtn}>✕</button>
        </div>

        {/* Goal input */}
        <div style={{ padding: "14px 18px 8px", borderBottom: "1px solid var(--border)" }}>
          <label style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6, display: "block" }}>
            Describe your goal in plain English:
          </label>
          <input
            type="text"
            placeholder='e.g. "automate blog writing" or "improve Harness Studio itself"'
            value={goalText}
            onChange={(e) => setGoalText(e.target.value)}
            autoFocus
            style={{
              width: "100%", padding: "8px 12px",
              background: "var(--bg)", border: "1px solid var(--border)",
              borderRadius: 6, color: "var(--text)",
              fontSize: 13, fontFamily: "inherit", outline: "none",
              boxSizing: "border-box",
            }}
          />
          <div style={{ fontSize: 10, color: "var(--hint)", marginTop: 5 }}>
            We match keywords against {GOAL_TEMPLATES.length} built-in templates. Try:
            {" "}<KeywordChip onClick={() => setGoalText("automate blog writing")}>blog</KeywordChip>
            {" "}<KeywordChip onClick={() => setGoalText("improve Harness Studio itself")}>self-improvement</KeywordChip>
            {" "}<KeywordChip onClick={() => setGoalText("coding task")}>coding</KeywordChip>
            {" "}<KeywordChip onClick={() => setGoalText("rank suppliers")}>purchasing</KeywordChip>
          </div>
        </div>

        {/* Results */}
        <div style={bodyStyle}>
          <div style={{
            fontSize: 10, fontWeight: 700, color: "var(--muted)",
            textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10,
          }}>
            {goalText.trim() ? `${matches.length} matching template${matches.length !== 1 ? "s" : ""}` : "All available templates"}
          </div>

          {matches.map(({ template, score, matchedTriggers }) => {
            const diff = DIFFICULTY_BADGE[template.difficulty];
            const rec  = recommendProvider(template, avail);
            const prov = PROVIDER_LABELS[rec.category];
            return (
              <button
                key={template.id}
                onClick={() => setSelected(template)}
                style={{
                  width: "100%", textAlign: "left", padding: "12px 14px",
                  marginBottom: 8, border: "1px solid var(--border)",
                  background: "var(--surface-3)", borderRadius: 7,
                  cursor: "pointer", fontFamily: "inherit",
                  transition: "border-color 80ms, background 80ms",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--accent)";
                  e.currentTarget.style.background  = "var(--accent-soft)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--border)";
                  e.currentTarget.style.background  = "var(--surface-3)";
                }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{template.title}</span>
                  <span style={{
                    fontSize: 9, padding: "1px 6px", borderRadius: 99,
                    background: `${diff.color}22`, color: diff.color, fontWeight: 600,
                  }}>{diff.label}</span>
                  {score > 0 && (
                    <span style={{ fontSize: 9, color: "var(--hint)" }}>
                      {matchedTriggers.length} keyword{matchedTriggers.length !== 1 ? "s" : ""} matched
                    </span>
                  )}
                  <div style={{ flex: 1 }}/>
                  <span style={{
                    fontSize: 10, padding: "1px 6px", borderRadius: 99,
                    background: `${prov.color}22`, color: prov.color,
                  }}>{prov.label}{rec.ready ? " ✓" : ""}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>
                  {template.description}
                </div>
                <div style={{ fontSize: 10, color: "var(--hint)", marginTop: 4 }}>
                  {template.recommendedAgents.length} agents · {template.recommendedEdges.length} edges
                  {template.localFriendly && " · works with Ollama local"}
                </div>
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          <span style={{ fontSize: 10, color: "var(--hint)", flex: 1 }}>
            Templates are rule-based suggestions. No AI call is made to generate them.
          </span>
          <button onClick={onClose} style={secondaryBtn}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ── Helper components & styles ───────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 10, fontWeight: 700, color: "var(--muted)",
        textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6,
      }}>{title}</div>
      {children}
    </div>
  );
}

function KeywordChip({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      fontSize: 10, padding: "1px 7px", borderRadius: 99, marginRight: 2,
      background: "var(--surface-3)", border: "none", color: "var(--accent)",
      cursor: "pointer", fontFamily: "inherit",
    }}>{children}</button>
  );
}

const modalBackdrop: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 200,
  background: "rgba(0,0,0,0.6)", display: "flex",
  alignItems: "center", justifyContent: "center",
};
const modalCard: React.CSSProperties = {
  width: 640, maxHeight: "85vh",
  background: "var(--surface-2)",
  border: "1px solid var(--border-md)", borderRadius: 12,
  boxShadow: "0 32px 80px rgba(0,0,0,0.7)",
  display: "flex", flexDirection: "column",
  fontFamily: "inherit", overflow: "hidden",
};
const headerStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8,
  padding: "10px 16px", borderBottom: "1px solid var(--border)",
  background: "var(--surface-3)", flexShrink: 0,
};
const bodyStyle: React.CSSProperties = {
  padding: "14px 18px", overflowY: "auto", flex: 1,
};
const footerStyle: React.CSSProperties = {
  display: "flex", gap: 8, padding: "10px 16px",
  borderTop: "1px solid var(--border)", background: "var(--surface-3)",
  flexShrink: 0, alignItems: "center",
};
const closeBtn: React.CSSProperties = {
  border: "none", background: "transparent", color: "var(--hint)",
  cursor: "pointer", padding: "2px 6px", fontSize: 14, lineHeight: 1,
};
const backBtn: React.CSSProperties = {
  border: "none", background: "var(--surface-3)", color: "var(--muted)",
  cursor: "pointer", padding: "3px 8px", borderRadius: 4, fontSize: 11,
};
const primaryBtn: React.CSSProperties = {
  padding: "6px 12px", border: "none", borderRadius: 5,
  background: "var(--accent)", color: "#1a1207",
  fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  display: "inline-flex", alignItems: "center", gap: 5,
};
const secondaryBtn: React.CSSProperties = {
  padding: "6px 12px", border: "none", borderRadius: 5,
  background: "var(--surface-3)", color: "var(--muted)",
  fontSize: 12, cursor: "pointer", fontFamily: "inherit",
};
const listStyle: React.CSSProperties = { margin: 0, paddingLeft: 18 };
const liStyle: React.CSSProperties = { fontSize: 11, color: "var(--muted)", marginBottom: 3, lineHeight: 1.5 };
