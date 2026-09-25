/**
 * WorkflowInputDialog — preflight dialog shown before every workflow run.
 *
 * Lets the user:
 * 1. Write an initial prompt for entry-point agents.
 * 2. Attach context files (workspace-relative paths).
 * 3. Apply one-click prompt enhancements.
 * 4. Override think depth, provider mode, and continue-on-error for this run.
 */
import { useState, useRef, useCallback } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useExecutionStore } from "@/store/executionStore";
import { entryAgentIds } from "@/services/execution/entryNodes";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { ROLE_META } from "@/utils/nodeColors";
import type { WorkflowRunConfig } from "@/types/workflowRunConfig";
import type { LlmProvider } from "@/utils/providerConfig";
import type { AgentRole } from "@/types/agent";

// ── Prompt enhancements ──────────────────────────────────────────────────────

const ENHANCEMENTS: { label: string; title: string; append: string }[] = [
  {
    label: "Step by step",
    title: "Chain-of-thought: reason through the problem before answering",
    append: "\n\nThink step by step and explain your reasoning before giving the final answer.",
  },
  {
    label: "Be specific",
    title: "Add precision — avoid vague or generic outputs",
    append: "\n\nBe specific and precise. Avoid generic statements — use concrete details, numbers, or names.",
  },
  {
    label: "With examples",
    title: "Illustrate key points with concrete examples",
    append: "\n\nProvide concrete examples to illustrate each key point.",
  },
  {
    label: "JSON output",
    title: "Return a structured JSON object as the final answer",
    append: "\n\nFormat your final answer as valid JSON. Include a brief explanation before the JSON block.",
  },
  {
    label: "Be concise",
    title: "Trim output to essentials — avoid padding",
    append: "\n\nBe concise. Limit the response to essential information only — no padding, no repetition.",
  },
  {
    label: "Critical review",
    title: "Challenge assumptions before concluding",
    append: "\n\nCritically evaluate all options and assumptions before reaching a conclusion. Note risks and trade-offs.",
  },
  {
    label: "Executive summary",
    title: "Lead with a 2–3 sentence TL;DR",
    append: "\n\nBegin with a 2–3 sentence executive summary, then expand with details.",
  },
  {
    label: "Cite sources",
    title: "Reference source data or upstream context in your answer",
    append: "\n\nCite or quote the relevant source data that informs each claim.",
  },
];

// ── helpers ──────────────────────────────────────────────────────────────────

const MONO = '"JetBrains Mono", monospace';

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: "0.06em",
      textTransform: "uppercase", marginBottom: 7, marginTop: 16 }}>
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{children}</div>;
}

type Chip = {
  active?: boolean; onClick: () => void;
  title?: string; children: React.ReactNode;
};

function Chip({ active, onClick, title, children }: Chip) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: "4px 10px", borderRadius: 99, fontSize: 11, fontFamily: "inherit",
        cursor: "pointer",
        border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
        background: active ? "var(--accent-soft)" : "var(--surface-3)",
        color: active ? "var(--accent)" : "var(--text)",
        fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </button>
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

interface Props {
  onStart: (config: WorkflowRunConfig) => void;
  onCancel: () => void;
}

export function WorkflowInputDialog({ onStart, onCancel }: Props) {
  const meta     = useWorkflowStore((s) => s.meta);
  const nodes    = useWorkflowStore((s) => s.nodes);
  const edges    = useWorkflowStore((s) => s.edges);
  const executionSettings = useWorkflowStore((s) => s.executionSettings);
  const llmProvider = useExecutionStore((s) => s.llmProvider);
  const continueOnError = useExecutionStore((s) => s.continueOnError);
  const setContinueOnError = useExecutionStore((s) => s.setContinueOnError);

  // Entry agents receive the prompt (same rule as the run loop)
  const entryIds    = entryAgentIds(nodes, edges);
  const entryNodes  = nodes.filter((n) => entryIds.has(n.id));
  const executionModeLabel =
    executionSettings.maxParallel <= 1
      ? "sequential (maxParallel 1)"
      : `bounded parallel up to ${executionSettings.maxParallel}`;

  const [userInput,        setUserInput]        = useState("");
  const [filePaths,        setFilePaths]        = useState<string[]>([]);
  const [fileInput,        setFileInput]        = useState("");
  const [activeEnhancements, setActiveEnhancements] = useState<Set<number>>(new Set());
  const [thinkDepth,       setThinkDepth]       = useState<WorkflowRunConfig["thinkDepthOverride"]>(null);
  const [providerOverride, setProviderOverride] = useState<LlmProvider | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Enhancements are applied silently at send time — they never appear in the textarea.
  const toggleEnhancement = useCallback((idx: number) => {
    setActiveEnhancements((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  function addFilePath() {
    const p = fileInput.trim();
    if (!p || filePaths.includes(p)) { setFileInput(""); return; }
    setFilePaths((prev) => [...prev, p]);
    setFileInput("");
  }

  function removeFilePath(p: string) {
    setFilePaths((prev) => prev.filter((x) => x !== p));
  }

  function handleStart() {
    // Build the final prompt: user text + any active enhancements appended silently
    let finalInput = userInput.trim();
    for (const idx of activeEnhancements) {
      finalInput += ENHANCEMENTS[idx].append;
    }
    onStart({
      userInput: finalInput,
      contextFilePaths: filePaths,
      thinkDepthOverride: thinkDepth,
      providerOverride,
    });
  }

  const providerModes: { value: LlmProvider | null; label: string }[] = [
    { value: null,           label: "Use Settings" },
    { value: "openai",       label: "OpenAI" },
    { value: "anthropic",    label: "Anthropic" },
    { value: "ollama",       label: "Ollama" },
    { value: "ollama-cloud", label: "Ollama Cloud" },
  ];

  const thinkOptions: { value: WorkflowRunConfig["thinkDepthOverride"]; label: string; title: string }[] = [
    { value: null,     label: "Node default", title: "Each node uses its own think-depth setting" },
    { value: "none",   label: "None",   title: "No extended reasoning (fastest, cheapest)" },
    { value: "low",    label: "Low",    title: "Brief reasoning pass" },
    { value: "medium", label: "Medium", title: "Balanced reasoning" },
    { value: "high",   label: "High",   title: "Deep reasoning (slowest, most expensive)" },
  ];

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)",
        backdropFilter: "blur(4px)", display: "flex",
        alignItems: "flex-start", justifyContent: "center",
        paddingTop: 60, zIndex: 300, fontFamily: "inherit", overflowY: "auto",
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560, maxWidth: "96vw",
          background: "var(--surface-2)", border: "1px solid var(--border-md)",
          borderRadius: 12, boxShadow: "0 24px 80px rgba(0,0,0,0.7)",
          overflow: "hidden", marginBottom: 40,
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "13px 18px", borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: 6, background: "var(--accent)",
            display: "grid", placeItems: "center", color: "#1a1207",
            fontSize: 13, fontWeight: 800, flexShrink: 0,
          }}>▶</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Run Workflow</div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>{meta.name}</div>
          </div>
          <div style={{ flex: 1 }}/>
          <button onClick={onCancel} style={{
            width: 26, height: 26, border: "none", borderRadius: 4,
            background: "transparent", color: "var(--hint)", cursor: "pointer",
            display: "grid", placeItems: "center",
          }}>
            <NodeIcon name="x" size={13}/>
          </button>
        </div>

        <div style={{ padding: "4px 18px 18px", maxHeight: "72vh", overflowY: "auto" }}>

          {/* Entry-point node callout */}
          {entryNodes.length > 0 && (
            <div style={{
              marginTop: 14, padding: "8px 12px", borderRadius: 6,
              background: "var(--accent-soft)", border: "1px solid rgba(229,161,66,0.25)",
              display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center",
            }}>
              <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600 }}>
                Your prompt goes to:
              </span>
              {entryNodes.map((n) => {
                const meta = ROLE_META[n.data.role as AgentRole];
                return (
                  <span key={n.id} style={{
                    fontSize: 11, padding: "2px 8px", borderRadius: 99,
                    background: "var(--surface-3)", color: "var(--text)",
                    border: "1px solid var(--border)",
                  }}>
                    <span style={{ color: meta?.tint }}>{meta?.glyph ?? "●"} </span>
                    {n.data.name}
                  </span>
                );
              })}
            </div>
          )}

          {/* ── Initial prompt ─────────────────────────────────────────── */}
          <Label>Initial Prompt</Label>
          <textarea
            ref={textareaRef}
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            placeholder={
              entryNodes.length > 0
                ? `What should ${entryNodes[0].data.name} do? Describe the task, constraints, or data…`
                : "Describe the task for this workflow…"
            }
            rows={5}
            style={{
              width: "100%", boxSizing: "border-box",
              padding: "9px 11px", borderRadius: 7, fontSize: 13,
              border: "1px solid var(--border-md)",
              background: "var(--surface-3)", color: "var(--text)",
              fontFamily: "inherit", lineHeight: 1.55,
              resize: "vertical", outline: "none",
            }}
          />

          {/* ── Prompt enhancement chips ─────────────────────────────── */}
          <Label>Enhance Prompt</Label>
          <Row>
            {ENHANCEMENTS.map((enh, i) => (
              <Chip
                key={i}
                active={activeEnhancements.has(i)}
                title={enh.title}
                onClick={() => toggleEnhancement(i)}
              >
                {enh.label}
              </Chip>
            ))}
          </Row>
          {activeEnhancements.size > 0 && (
            <div style={{
              marginTop: 8, fontSize: 10, color: "var(--hint)", fontStyle: "italic",
            }}>
              {activeEnhancements.size} enhancement{activeEnhancements.size !== 1 ? "s" : ""} will be appended silently when you start — not shown in the prompt above.
            </div>
          )}

          {/* ── Context files ─────────────────────────────────────────── */}
          <Label>Context Files <span style={{ fontWeight: 400, textTransform: "none", fontSize: 10 }}>(optional — read and prepended for entry nodes)</span></Label>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input
              type="text"
              value={fileInput}
              onChange={(e) => setFileInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addFilePath(); } }}
              placeholder=".harness/inputs/requirements.yaml"
              style={{
                flex: 1, padding: "6px 10px", borderRadius: 5, fontSize: 12,
                border: "1px solid var(--border-md)",
                background: "var(--surface-3)", color: "var(--text)", fontFamily: MONO,
              }}
            />
            <button
              onClick={addFilePath}
              style={{
                padding: "6px 14px", border: "1px solid var(--border-md)", borderRadius: 5,
                background: "var(--surface-3)", color: "var(--text)",
                cursor: "pointer", fontSize: 12, fontFamily: "inherit",
              }}
            >+ Add</button>
          </div>

          {filePaths.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {filePaths.map((p) => (
                <div key={p} style={{
                  display: "flex", alignItems: "center", gap: 7,
                  padding: "5px 9px", borderRadius: 5,
                  background: "var(--surface-3)", border: "1px solid var(--border)",
                }}>
                  <NodeIcon name="file" size={11} color="var(--muted)"/>
                  <span style={{
                    flex: 1, fontSize: 11, fontFamily: MONO, color: "var(--text)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{p}</span>
                  <button
                    onClick={() => removeFilePath(p)}
                    style={{
                      width: 18, height: 18, border: "none", borderRadius: 3,
                      background: "transparent", color: "var(--hint)",
                      cursor: "pointer", display: "grid", placeItems: "center", fontSize: 12,
                    }}
                  >✕</button>
                </div>
              ))}
            </div>
          )}

          {filePaths.length === 0 && (
            <div style={{ fontSize: 11, color: "var(--hint)", fontStyle: "italic" }}>
              No context files — the agents will use only their configured prompts and upstream outputs.
            </div>
          )}

          {/* ── Think depth ─────────────────────────────────────────────── */}
          <Label>Think Depth <span style={{ fontWeight: 400, textTransform: "none", fontSize: 10 }}>(applies to o-series / GPT-5.5 nodes)</span></Label>
          <Row>
            {thinkOptions.map(({ value, label, title }) => (
              <Chip
                key={String(value)}
                active={thinkDepth === value}
                title={title}
                onClick={() => setThinkDepth(value)}
              >
                {label}
              </Chip>
            ))}
          </Row>

          {/* ── Provider override ───────────────────────────────────────── */}
          <Label>Provider Override</Label>
          <Row>
            {providerModes.map(({ value, label }) => (
              <Chip
                key={String(value)}
                active={providerOverride === value}
                onClick={() => setProviderOverride(value)}
              >
                {value === null ? `${label} (${llmProvider})` : label}
              </Chip>
            ))}
          </Row>

          {/* ── Continue on error ──────────────────────────────────────── */}
          <div style={{ marginTop: 16 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={continueOnError}
                onChange={(e) => setContinueOnError(e.target.checked)}
                style={{ accentColor: "var(--accent)", width: 14, height: 14 }}
              />
              <span style={{ fontSize: 12 }}>Continue on agent error</span>
              <span style={{ fontSize: 11, color: "var(--hint)" }}>
                — skip failing agents, finish the rest
              </span>
            </label>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "12px 18px", borderTop: "1px solid var(--border)",
          background: "var(--surface)",
        }}>
          <span style={{ flex: 1, fontSize: 10, color: "var(--hint)" }}>
            {nodes.length} agent{nodes.length !== 1 ? "s" : ""} · {executionModeLabel} · live streaming for native tool calls
          </span>
          <button onClick={onCancel} style={{
            padding: "7px 16px", border: "1px solid var(--border-md)", borderRadius: 5,
            background: "transparent", color: "var(--text)",
            cursor: "pointer", fontSize: 13, fontFamily: "inherit",
          }}>Cancel</button>
          <button onClick={handleStart} style={{
            padding: "7px 20px", border: "none", borderRadius: 5,
            background: "var(--accent)", color: "#1a1207",
            cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <span style={{ fontSize: 12 }}>▶</span> Start Workflow
          </button>
        </div>
      </div>
    </div>
  );
}
