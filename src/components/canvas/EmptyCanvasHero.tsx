/**
 * EmptyCanvasHero — shown as an overlay when the workflow has 0 nodes.
 *
 * Two states:
 *   1. No workspace set  → "Get Started" guide explaining what to do first
 *   2. Workspace set     → "Load or create a workflow" quick actions
 */
import { useWorkspaceStore } from "@/store/workspaceStore";

function dispatch(ctrl: boolean, shift: boolean, key: string) {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key, ctrlKey: ctrl, metaKey: ctrl, shiftKey: shift, bubbles: true })
  );
}

const Chip = ({
  label, hint, desc, onClick, accent = false,
}: { label: string; hint: string; desc?: string; onClick: () => void; accent?: boolean }) => (
  <button
    onClick={onClick}
    style={{
      display: "flex", flexDirection: "column", alignItems: "center", gap: 5,
      padding: "14px 20px", borderRadius: 10, cursor: "pointer",
      background: accent ? "var(--accent-soft)" : "var(--surface-2)",
      border: accent ? "1px solid rgba(229,161,66,0.4)" : "1px solid var(--border)",
      color: "var(--text)", fontFamily: "inherit",
      transition: "border-color 0.12s, background 0.12s",
      minWidth: 130,
    }}
    onMouseEnter={(e) => {
      const el = e.currentTarget as HTMLButtonElement;
      el.style.borderColor = "rgba(229,161,66,0.7)";
      el.style.background  = "var(--accent-soft)";
    }}
    onMouseLeave={(e) => {
      const el = e.currentTarget as HTMLButtonElement;
      el.style.borderColor = accent ? "rgba(229,161,66,0.4)" : "var(--border)";
      el.style.background  = accent ? "var(--accent-soft)" : "var(--surface-2)";
    }}
  >
    <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
    <span style={{ fontSize: 9, color: "var(--hint)", fontFamily: "var(--font-mono)" }}>{hint}</span>
    {desc && <span style={{ fontSize: 10, color: "var(--muted)", textAlign: "center", maxWidth: 120, lineHeight: 1.4 }}>{desc}</span>}
  </button>
);

const Step = ({ n, title, body }: { n: number; title: string; body: string }) => (
  <div style={{ display: "flex", gap: 12, alignItems: "flex-start", textAlign: "left" }}>
    <div style={{
      width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
      background: "var(--accent-soft)", border: "1px solid rgba(229,161,66,0.4)",
      display: "grid", placeItems: "center",
      fontSize: 11, fontWeight: 700, color: "var(--accent)",
    }}>{n}</div>
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>{body}</div>
    </div>
  </div>
);

export function EmptyCanvasHero() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 5,
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      pointerEvents: "none",
    }}>
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center", gap: 20,
        padding: "36px 44px", borderRadius: 16,
        background: "rgba(21,23,28,0.94)", backdropFilter: "blur(8px)",
        border: "1px solid var(--border)",
        pointerEvents: "auto",
        maxWidth: 480,
      }}>
        {/* Logo glyph */}
        <div style={{
          width: 44, height: 44, borderRadius: 11,
          background: "var(--accent-soft)", border: "1px solid var(--accent)",
          display: "grid", placeItems: "center",
          fontSize: 20, color: "var(--accent)", fontWeight: 800,
        }}>H</div>

        {workspacePath ? (
          /* ── Workspace is set, but no workflow nodes ───────────────── */
          <>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text)", marginBottom: 5 }}>
                No workflow loaded
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", maxWidth: 320, lineHeight: 1.6 }}>
                Load a saved harness from the file tree on the left,
                start from an example, or generate a new workflow with AI.
              </div>
              <div style={{
                marginTop: 8, fontSize: 10, color: "var(--hint)",
                fontFamily: "var(--font-mono)",
                background: "var(--surface-3)", display: "inline-block",
                padding: "3px 8px", borderRadius: 4,
                border: "1px solid var(--border)",
              }}>
                📁 {workspacePath.split(/[\\/]/).at(-1)}
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
              <Chip accent label="Load Example" hint="Ctrl+E"
                desc="Browse built-in workflows"
                onClick={() => dispatch(true, false, "e")}/>
              <Chip label="Generate" hint="Ctrl+G"
                desc="AI-assisted builder"
                onClick={() => dispatch(true, false, "g")}/>
              <Chip label="Help" hint="Ctrl+/"
                onClick={() => dispatch(true, false, "/")}/>
            </div>

            <p style={{ fontSize: 11, color: "var(--hint)", margin: 0, textAlign: "center" }}>
              Tip: press{" "}
              <kbd style={{ fontFamily: "var(--font-mono)", fontSize: 10,
                background: "var(--surface-3)", padding: "1px 5px", borderRadius: 4,
                border: "1px solid var(--border)" }}>Ctrl+Shift+E</kbd>{" "}
              to instantly load the Harness Studio project harness.
            </p>
          </>
        ) : (
          /* ── No workspace set — first-launch guide ─────────────────── */
          <>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text)", marginBottom: 5 }}>
                Welcome to Harness Studio
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", maxWidth: 340, lineHeight: 1.6 }}>
                Build, visualise, and run multi-agent AI workflows.
                Follow the steps below to get started.
              </div>
            </div>

            {/* Step-by-step guide */}
            <div style={{
              display: "flex", flexDirection: "column", gap: 14,
              alignSelf: "stretch",
              padding: "14px 16px",
              background: "var(--surface-2)", borderRadius: 8,
              border: "1px solid var(--border)",
            }}>
              <Step n={1} title="Open a workspace folder"
                body="A workspace is any local folder. Your workflow files (.harness.yaml) are saved there. Click the folder icon in the left sidebar or press Ctrl+Shift+O."/>
              <Step n={2} title="Load a workflow"
                body='Use "Load Example" (Ctrl+E) to explore built-in demos, or "Generate" (Ctrl+G) to describe a workflow in plain text.'/>
              <Step n={3} title="Configure your AI provider"
                body="Open ⚙ Settings (top-right) to add an Anthropic or OpenAI key, or point Harness to a local Ollama server — no key required for local."/>
              <Step n={4} title="Run the workflow"
                body="Press ▶ Run. Each agent executes in order; outputs chain automatically to downstream agents and memory nodes."/>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
              <Chip accent label="Open Workspace" hint="Ctrl+Shift+O"
                desc="Choose a local folder"
                onClick={() => dispatch(true, true, "o")}/>
              <Chip label="Load Example" hint="Ctrl+E"
                desc="No workspace needed"
                onClick={() => dispatch(true, false, "e")}/>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
