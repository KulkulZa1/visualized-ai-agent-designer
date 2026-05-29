/**
 * GuidePanel — floating rule-based help assistant.
 *
 * A small floating button sits at the bottom-right. Clicking it opens
 * a slide-out panel with quick questions and rule-based answers.
 *
 * NO LIVE AI CALL. NO NETWORK. Pure pre-written knowledge.
 *
 * Future: this same UI shell can be wired to a real local model (Ollama)
 * when the user explicitly opts in via Settings.
 */
import { useState, useMemo } from "react";
import { useExecutionStore } from "@/store/executionStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";

const MONO = '"JetBrains Mono", ui-monospace, monospace';

interface GuideQA {
  q: string;
  /** Lowercase keywords that trigger this answer when typed in the input box. */
  triggers: string[];
  /** Markdown-light answer text. Plain string segments + bold sections. */
  answer: { kind: "text" | "bold" | "code"; text: string }[];
  /** Optional context tags — "empty-canvas", "no-key", "first-run", etc. */
  context?: string[];
}

const QA_LIBRARY: GuideQA[] = [
  {
    q: "How do I start from zero?",
    triggers: ["start", "begin", "first", "zero", "new"],
    context: ["empty-canvas"],
    answer: [
      { kind: "text", text: "Three steps to your first workflow:" },
      { kind: "text", text: "1. Open a workspace folder (sidebar folder icon or " },
      { kind: "code", text: "Ctrl+Shift+O" },
      { kind: "text", text: ")." },
      { kind: "text", text: "2. Press " },
      { kind: "code", text: "Ctrl+E" },
      { kind: "text", text: " to load an example, or " },
      { kind: "code", text: "Ctrl+Shift+W" },
      { kind: "text", text: " to create from a goal." },
      { kind: "text", text: "3. Configure a provider in ⚙ Settings (Anthropic key, OpenAI key, or Ollama local). Then click ▶ Run." },
    ],
  },
  {
    q: "Which model should I use?",
    triggers: ["model", "which", "best", "recommend", "pick", "choose"],
    answer: [
      { kind: "bold", text: "If you have no API key: " },
      { kind: "text", text: "Install Ollama and pull " },
      { kind: "code", text: "qwen2.5-coder:7b" },
      { kind: "text", text: " — free, local, private." },
      { kind: "bold", text: "If you have Anthropic key: " },
      { kind: "text", text: "Use claude-sonnet-4.6 for most agents, claude-opus-4.6 for orchestrators/critics." },
      { kind: "bold", text: "If you have OpenAI key: " },
      { kind: "text", text: "Use gpt-4o-mini for cheap workers, gpt-5.5-xhigh for reasoning agents." },
      { kind: "text", text: "Tip: in Role tab → Model section, click 'Apply to all nodes' to bulk-assign a model." },
    ],
  },
  {
    q: "How do I get an API key?",
    triggers: ["api", "key", "credential", "auth", "token"],
    context: ["no-key"],
    answer: [
      { kind: "bold", text: "Anthropic Claude: " },
      { kind: "text", text: "Sign up at console.anthropic.com → Settings → API Keys → Create Key. Paste in ⚙ Settings → Anthropic." },
      { kind: "bold", text: "OpenAI: " },
      { kind: "text", text: "Sign up at platform.openai.com → API keys → Create. Paste in ⚙ Settings → OpenAI." },
      { kind: "bold", text: "Ollama Cloud: " },
      { kind: "text", text: "ollama.com/settings → Generate API Key. Paste in ⚙ Settings → Ollama Cloud auth token." },
      { kind: "bold", text: "Ollama Local (free, no key): " },
      { kind: "text", text: "Download from ollama.com → install → run " },
      { kind: "code", text: "ollama pull qwen2.5-coder:7b" },
      { kind: "text", text: "." },
      { kind: "bold", text: "Storage note: " },
      { kind: "text", text: "Keys are stored in browser localStorage only (development shortcut). They never leave your machine except to the chosen provider." },
    ],
  },
  {
    q: "Why did my workflow fail?",
    triggers: ["fail", "error", "broken", "stop", "crash", "wrong"],
    answer: [
      { kind: "text", text: "Check these in order:" },
      { kind: "bold", text: "1. Audit Strip (bottom of screen) " },
      { kind: "text", text: "— shows real error message from the provider." },
      { kind: "bold", text: "2. Run Panel " },
      { kind: "text", text: "— shows per-agent status; click any node with red border." },
      { kind: "bold", text: "3. Settings → ▶ Test " },
      { kind: "text", text: "— verifies your provider is reachable." },
      { kind: "text", text: "Common failures: missing API key, Ollama not running, billing limit reached, invalid YAML." },
      { kind: "text", text: "See docs/TROUBLESHOOTING.md for the full table." },
    ],
  },
  {
    q: "What is a context snapshot?",
    triggers: ["context", "snapshot", "trace"],
    answer: [
      { kind: "text", text: "A " },
      { kind: "bold", text: "context snapshot " },
      { kind: "text", text: "is what an agent saw at the moment it ran: the system prompt, upstream agent outputs, memory keys read, tool calls made, and the final output." },
      { kind: "text", text: "Click any executed node → Config Panel → " },
      { kind: "bold", text: "Context " },
      { kind: "text", text: "tab to see it." },
      { kind: "text", text: "Currently snapshots are stored in memory per run. File-backed persistence is planned." },
    ],
  },
  {
    q: "What is an artifact?",
    triggers: ["artifact", "output", "file", "generated"],
    answer: [
      { kind: "text", text: "An " },
      { kind: "bold", text: "artifact " },
      { kind: "text", text: "is a file generated by an agent (e.g. a draft.md, scores.json, code.diff). The artifact viewer panel shows what each agent produced." },
      { kind: "text", text: "Status today: artifacts are shown as " },
      { kind: "bold", text: "mock data " },
      { kind: "text", text: "during execution. Real per-run file persistence is a planned next step." },
    ],
  },
  {
    q: "How do I use Ollama?",
    triggers: ["ollama", "local", "free"],
    answer: [
      { kind: "text", text: "Step 1: Install from " },
      { kind: "code", text: "ollama.com" },
      { kind: "text", text: "." },
      { kind: "text", text: "Step 2: Pull a model (terminal):" },
      { kind: "code", text: "ollama pull qwen2.5-coder:7b" },
      { kind: "text", text: "Step 3: Make sure it's running (Ollama runs as a background service after install)." },
      { kind: "text", text: "Step 4: In ⚙ Settings → Provider → Auto or Ollama. Base URL stays " },
      { kind: "code", text: "http://localhost:11434" },
      { kind: "text", text: "." },
      { kind: "text", text: "Step 5: Click ▶ Test in Settings. Should show 'Ollama is reachable'." },
    ],
  },
  {
    q: "What does MCP do?",
    triggers: ["mcp", "model context", "protocol", "claude code"],
    answer: [
      { kind: "text", text: "MCP (Model Context Protocol) lets AI coding assistants like Claude Code or Cursor inspect this project without opening the desktop app." },
      { kind: "text", text: "Start the server:" },
      { kind: "code", text: "npm run mcp" },
      { kind: "text", text: "Currently exposes " },
      { kind: "bold", text: "5 read-only tools: " },
      { kind: "text", text: "run_tests, run_cargo_tests, validate_workflow, project_status, list_workflows." },
      { kind: "text", text: "See docs/MCP_USAGE.md for the full guide." },
    ],
  },
  {
    q: "Are agents really independent?",
    triggers: ["independent", "parallel", "concurrent", "real"],
    answer: [
      { kind: "bold", text: "Yes, contextually — each agent has its own ID, prompt, model, tools, memory keys, output, and context snapshot." },
      { kind: "bold", text: "No, temporally — " },
      { kind: "text", text: "execution today is " },
      { kind: "bold", text: "sequential " },
      { kind: "text", text: "(topological order). Even if your workflow has parallel branches, they run one node at a time. True concurrent execution is on the roadmap." },
      { kind: "text", text: "Click any node → Context tab to see the exact context that node received — they are different per agent." },
    ],
  },
  {
    q: "Is streaming real or simulated?",
    triggers: ["stream", "streaming", "live", "real time"],
    answer: [
      { kind: "bold", text: "Currently simulated. " },
      { kind: "text", text: "The provider call returns the full text upfront; the UI then displays it in chunks via setTimeout for visual effect." },
      { kind: "text", text: "Real SSE/streaming from providers is on the roadmap for Phase 6." },
    ],
  },
  {
    q: "What does each panel do?",
    triggers: ["panel", "ui", "layout", "where"],
    answer: [
      { kind: "bold", text: "Top bar: " },
      { kind: "text", text: "breadcrumb, stats, save, run." },
      { kind: "bold", text: "Left sidebar: " },
      { kind: "text", text: "file tree + node list with filters." },
      { kind: "bold", text: "Center canvas: " },
      { kind: "text", text: "the workflow graph. Drag to pan, scroll to zoom, " },
      { kind: "code", text: "Ctrl+L" },
      { kind: "text", text: " to auto-layout." },
      { kind: "bold", text: "Right panel: " },
      { kind: "text", text: "5-tab inspector for the selected node (Role/Prompt/Tools/Hooks/Memory + Context after run)." },
      { kind: "bold", text: "Bottom strip: " },
      { kind: "text", text: "audit log with per-agent and per-kind filters." },
    ],
  },
];

const QUICK_QUESTIONS = QA_LIBRARY.map((qa) => qa.q);

// ── Component ────────────────────────────────────────────────────────────────

interface GuidePanelProps {
  open: boolean;
  onToggle: () => void;
}

export function GuidePanel({ open, onToggle }: GuidePanelProps) {
  const [search, setSearch] = useState("");
  const [activeQA, setActiveQA] = useState<GuideQA | null>(null);

  // Context-aware suggestions
  const nodes         = useWorkflowStore((s) => s.nodes);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const apiKey        = useExecutionStore((s) => s.apiKey);
  const openaiKey     = useExecutionStore((s) => s.openaiApiKey);
  const llmProvider   = useExecutionStore((s) => s.llmProvider);

  const contextTag: string | null = useMemo(() => {
    if (!workspacePath) return "first-run";
    if (nodes.length === 0) return "empty-canvas";
    if (llmProvider !== "ollama" && llmProvider !== "auto" && !apiKey && !openaiKey) return "no-key";
    return null;
  }, [workspacePath, nodes.length, llmProvider, apiKey, openaiKey]);

  const matchedQAs: GuideQA[] = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) {
      // Show context-relevant ones first if a tag matches, else first 5
      if (contextTag) {
        const relevant = QA_LIBRARY.filter((qa) => qa.context?.includes(contextTag));
        return [...relevant, ...QA_LIBRARY.filter((qa) => !relevant.includes(qa))].slice(0, 7);
      }
      return QA_LIBRARY.slice(0, 7);
    }
    return QA_LIBRARY.filter((qa) =>
      qa.q.toLowerCase().includes(term) ||
      qa.triggers.some((t) => term.includes(t) || t.includes(term))
    );
  }, [search, contextTag]);

  // ── Floating button (always rendered) ────────────────────────────────────
  return (
    <>
      <button
        onClick={onToggle}
        title="Help Guide — ask me anything"
        style={{
          position: "fixed", bottom: 38, right: 18, zIndex: 150,
          width: 38, height: 38, borderRadius: "50%",
          background: open ? "var(--accent)" : "var(--surface-2)",
          color: open ? "#1a1207" : "var(--accent)",
          border: open ? "1px solid var(--accent)" : "1px solid var(--accent-soft)",
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          cursor: "pointer", fontSize: 18, fontWeight: 700,
          display: "grid", placeItems: "center",
          transition: "all 100ms",
        }}
      >
        {open ? "✕" : "?"}
      </button>

      {/* Slide-out panel */}
      {open && (
        <div style={{
          position: "fixed", bottom: 86, right: 18, zIndex: 150,
          width: 360, maxHeight: "70vh",
          background: "var(--surface-2)",
          border: "1px solid var(--border-md)", borderRadius: 12,
          boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
          display: "flex", flexDirection: "column", overflow: "hidden",
          fontFamily: "inherit",
        }}>
          {/* Header */}
          <div style={{
            padding: "10px 14px", borderBottom: "1px solid var(--border)",
            background: "var(--surface-3)", display: "flex", alignItems: "center", gap: 8,
          }}>
            <div style={{
              width: 22, height: 22, borderRadius: "50%",
              background: "var(--accent-soft)", border: "1px solid var(--accent)",
              display: "grid", placeItems: "center",
              fontSize: 11, color: "var(--accent)", fontWeight: 700,
            }}>?</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>Guide Assistant</div>
              <div style={{ fontSize: 9, color: "var(--hint)" }}>Rule-based · no AI call</div>
            </div>
          </div>

          {/* Body */}
          {activeQA ? (
            <div style={{ padding: "12px 14px", overflowY: "auto", flex: 1 }}>
              <button
                onClick={() => setActiveQA(null)}
                style={{
                  border: "none", background: "var(--surface-3)", color: "var(--muted)",
                  cursor: "pointer", padding: "3px 8px", borderRadius: 4,
                  fontSize: 10, fontFamily: "inherit", marginBottom: 10,
                }}
              >← All questions</button>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
                {activeQA.q}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
                {activeQA.answer.map((seg, i) => {
                  if (seg.kind === "bold")
                    return <strong key={i} style={{ color: "var(--text)" }}>{seg.text}</strong>;
                  if (seg.kind === "code")
                    return <code key={i} style={{
                      fontFamily: MONO, fontSize: 10, background: "var(--surface-3)",
                      padding: "1px 5px", borderRadius: 3, color: "var(--accent)",
                    }}>{seg.text}</code>;
                  return <span key={i}>{seg.text} </span>;
                })}
              </div>
            </div>
          ) : (
            <>
              {/* Search */}
              <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search: 'api key', 'ollama', 'failed', etc."
                  style={{
                    width: "100%", padding: "5px 10px",
                    background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: 5, color: "var(--text)",
                    fontSize: 12, fontFamily: "inherit", outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              {/* Context hint */}
              {contextTag && !search && (
                <div style={{
                  padding: "8px 14px",
                  background: "var(--accent-soft)", borderBottom: "1px solid rgba(229,161,66,0.2)",
                  fontSize: 10, color: "var(--accent)",
                }}>
                  {contextTag === "first-run"   && "👋 Looks like you haven't opened a workspace yet."}
                  {contextTag === "empty-canvas" && "📋 Canvas is empty. Load an example or create from a goal."}
                  {contextTag === "no-key"       && "🔑 No API key configured for the selected provider."}
                </div>
              )}

              {/* QA list */}
              <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
                {matchedQAs.length === 0 ? (
                  <div style={{ padding: "16px 14px", fontSize: 11, color: "var(--hint)", textAlign: "center" }}>
                    No matching question. Try: "api key", "ollama", "failed", "model".
                  </div>
                ) : (
                  matchedQAs.map((qa) => (
                    <button
                      key={qa.q}
                      onClick={() => setActiveQA(qa)}
                      style={{
                        display: "block", width: "100%", textAlign: "left",
                        padding: "7px 14px", border: "none", background: "transparent",
                        color: "var(--text)", cursor: "pointer", fontFamily: "inherit",
                        fontSize: 11, borderBottom: "1px solid var(--border)",
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = "var(--surface-3)"}
                      onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                    >
                      {qa.q}
                    </button>
                  ))
                )}
              </div>
            </>
          )}

          {/* Footer */}
          <div style={{
            padding: "6px 14px", borderTop: "1px solid var(--border)",
            background: "var(--surface-3)",
            fontSize: 9, color: "var(--hint)", lineHeight: 1.4,
          }}>
            {QUICK_QUESTIONS.length} pre-written answers. For more, see docs/QUICK_START.md and docs/TROUBLESHOOTING.md.
          </div>
        </div>
      )}
    </>
  );
}
