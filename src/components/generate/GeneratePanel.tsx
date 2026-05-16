/**
 * GeneratePanel — modal showing all code/config generators.
 * Triggered from TopBar > "Generate" button or ⌘K.
 */
import { useState } from "react";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { useGenerator, type GenerateTarget } from "@/hooks/useGenerator";
import { HOOK_TEMPLATES } from "@/utils/generators";
import type { HookTemplate } from "@/utils/generators";

interface GeneratePanelProps {
  onClose: () => void;
}

interface GenItem {
  id: GenerateTarget;
  label: string;
  desc: string;
  icon: string;
  ext: string;
  color: string;
  hookTemplate?: HookTemplate;
}

const GEN_ITEMS: GenItem[] = [
  {
    id: "claude_md",
    label: "CLAUDE.md",
    desc: "Project-level instruction file for Claude Code — all agents, tools, and security notes.",
    icon: "file",
    ext: ".md",
    color: "var(--accent)",
  },
  {
    id: "agents_md",
    label: "AGENTS.md",
    desc: "Agent definition file — topology overview, per-agent specs, memory access, hooks.",
    icon: "file",
    ext: ".md",
    color: "var(--green)",
  },
  {
    id: "langgraph",
    label: "LangGraph Python",
    desc: "Runnable StateGraph with node functions, edges, checkpointing, and tool bindings.",
    icon: "zap",
    ext: ".py",
    color: "var(--blue)",
  },
  {
    id: "crewai",
    label: "CrewAI Python",
    desc: "CrewAI Crew with Agents, Tasks, and process type inferred from workflow topology.",
    icon: "send",
    ext: ".py",
    color: "var(--purple)",
  },
];

const MONO = '"JetBrains Mono", ui-monospace, monospace';

export function GeneratePanel({ onClose }: GeneratePanelProps) {
  const { generate, hasWorkspace } = useGenerator();
  const [preview, setPreview] = useState<{ content: string; path: string; label: string } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [written, setWritten] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"generators" | "hooks">("generators");

  async function handleGenerate(item: GenItem, hookTemplate?: HookTemplate) {
    setLoading(item.id);
    setWritten(null);
    try {
      const result = await generate(item.id, { hookTemplate });
      setPreview({ content: result.content, path: result.path, label: item.label });
      if (hasWorkspace) setWritten(result.path);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      backdropFilter: "blur(3px)", display: "flex", alignItems: "flex-start",
      justifyContent: "center", paddingTop: 60, zIndex: 200, fontFamily: "inherit",
    }} onClick={onClose}>
      <div style={{
        width: preview ? 900 : 560,
        background: "var(--surface-2)", border: "1px solid var(--border-md)",
        borderRadius: 12, boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
        overflow: "hidden", display: "flex", flexDirection: "column",
        maxHeight: "80vh", animation: "slide-up 160ms ease",
      }} onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", padding: "14px 18px",
          borderBottom: "1px solid var(--border)" }}>
          <NodeIcon name="grid" size={16} color="var(--accent)" style={{ marginRight: 10 }}/>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Generate</span>
          <div style={{ flex: 1 }}/>
          <button onClick={onClose} style={{ width: 26, height: 26, border: "none", borderRadius: 4,
            background: "transparent", color: "var(--hint)", cursor: "pointer",
            display: "grid", placeItems: "center" }}>
            <NodeIcon name="x" size={14}/>
          </button>
        </div>

        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {/* Left: generator list */}
          <div style={{ width: preview ? 280 : "100%", flexShrink: 0,
            display: "flex", flexDirection: "column", overflow: "hidden" }}>

            {/* Tabs */}
            <div style={{ display: "flex", borderBottom: "1px solid var(--border)", padding: "0 12px" }}>
              {(["generators","hooks"] as const).map((t) => (
                <button key={t} onClick={() => setActiveTab(t)} style={{
                  padding: "9px 10px", border: "none", background: "transparent",
                  cursor: "pointer", fontSize: 11, textTransform: "uppercase",
                  letterSpacing: "0.04em", fontFamily: "inherit",
                  color: activeTab === t ? "var(--text)" : "var(--muted)",
                  borderBottom: activeTab === t ? "2px solid var(--accent)" : "2px solid transparent",
                  marginBottom: -1,
                }}>{t === "generators" ? "Config & Code" : "Hook Templates"}</button>
              ))}
            </div>

            <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
              {!hasWorkspace && (
                <div style={{ padding: "8px 12px", background: "rgba(229,161,66,0.08)",
                  border: "1px solid rgba(229,161,66,0.2)", borderRadius: 6,
                  fontSize: 11, color: "var(--accent)", marginBottom: 10,
                  display: "flex", gap: 7, alignItems: "center" }}>
                  <NodeIcon name="alert" size={13}/>
                  No workspace open — preview only, files won't be saved.
                </div>
              )}

              {activeTab === "generators" && GEN_ITEMS.map((item) => (
                <div key={item.id} style={{
                  display: "flex", alignItems: "flex-start", gap: 10,
                  padding: "10px 12px", borderRadius: 7, marginBottom: 6,
                  border: "1px solid var(--border)", background: "var(--surface-3)",
                  cursor: "pointer", transition: "border-color 120ms",
                }}
                onMouseEnter={(e) => (e.currentTarget as HTMLDivElement).style.borderColor = item.color}
                onMouseLeave={(e) => (e.currentTarget as HTMLDivElement).style.borderColor = "var(--border)"}
                onClick={() => handleGenerate(item)}>
                  <NodeIcon name={item.icon} size={15} color={item.color} style={{ marginTop: 2, flexShrink: 0 }}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3 }}>
                      {item.label}
                      <span style={{ fontSize: 10, color: "var(--hint)", fontFamily: MONO, marginLeft: 6 }}>{item.ext}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.4 }}>{item.desc}</div>
                  </div>
                  {loading === item.id
                    ? <span style={{ fontSize: 10, color: "var(--muted)" }}>…</span>
                    : <NodeIcon name="chev" size={12} color="var(--hint)"/>
                  }
                </div>
              ))}

              {activeTab === "hooks" && HOOK_TEMPLATES.map((tmpl) => (
                <div key={tmpl.id} style={{
                  padding: "10px 12px", borderRadius: 7, marginBottom: 6,
                  border: "1px solid var(--border)", background: "var(--surface-3)",
                  cursor: "pointer", transition: "border-color 120ms",
                }}
                onMouseEnter={(e) => (e.currentTarget as HTMLDivElement).style.borderColor = "var(--orange)"}
                onMouseLeave={(e) => (e.currentTarget as HTMLDivElement).style.borderColor = "var(--border)"}
                onClick={() => handleGenerate({ id: "hook_template", label: tmpl.name, desc: tmpl.description, icon: "shield", ext: `.${tmpl.language}`, color: "var(--orange)" }, tmpl)}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    <NodeIcon name="shield" size={13} color="var(--orange)"/>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{tmpl.name}</span>
                    <span style={{ fontSize: 10, color: "var(--hint)", fontFamily: MONO, marginLeft: 4 }}>.{tmpl.language}</span>
                    <div style={{ flex: 1 }}/>
                    <span style={{ fontSize: 10, color: "var(--hint)", fontFamily: MONO }}>{tmpl.filename}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.4 }}>{tmpl.description}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: preview pane */}
          {preview && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden",
              borderLeft: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", padding: "8px 14px",
                borderBottom: "1px solid var(--border)", gap: 8 }}>
                <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: MONO, flex: 1,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {preview.path}
                </span>
                {written && (
                  <span style={{ fontSize: 10, color: "var(--green)", display: "flex", alignItems: "center", gap: 4 }}>
                    <NodeIcon name="check" size={11}/>
                    Written
                  </span>
                )}
                <button onClick={() => navigator.clipboard?.writeText(preview.content)} style={{
                  padding: "3px 8px", border: "none", borderRadius: 4,
                  background: "var(--surface-3)", color: "var(--muted)",
                  fontSize: 10, cursor: "pointer", fontFamily: "inherit",
                }}>Copy</button>
              </div>
              <div style={{ flex: 1, overflow: "auto", padding: "12px 14px",
                fontFamily: MONO, fontSize: 11, lineHeight: 1.6,
                color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {preview.content}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
