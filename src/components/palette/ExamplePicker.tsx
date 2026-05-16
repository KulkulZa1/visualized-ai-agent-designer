/**
 * ExamplePicker — modal that lists the 3 built-in example workflows
 * and lets the user load one into the canvas with a single click.
 * Triggered by the "Examples" button in TopBar or Ctrl+E.
 */
import { useState } from "react";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { useExamples, type ExampleMeta } from "@/hooks/useExamples";

interface ExamplePickerProps {
  onClose: () => void;
}

const MONO = '"JetBrains Mono", ui-monospace, monospace';

const PATTERN_ICONS: Record<string, string> = {
  "Fan-out / Fan-in":           "send",
  "Sequential pipeline":        "chev",
  "Reflection loop":            "history",
  "Recursive self-improvement": "cpu",
  "Production project harness": "lock",
};

const PATTERN_COLORS: Record<string, string> = {
  "Fan-out / Fan-in":           "var(--blue)",
  "Sequential pipeline":        "var(--green)",
  "Reflection loop":            "var(--accent)",
  "Recursive self-improvement": "var(--purple)",
  "Production project harness": "var(--orange)",
};

export function ExamplePicker({ onClose }: ExamplePickerProps) {
  const { examples, loadExample } = useExamples();
  const [loading, setLoading] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; ok: boolean; error?: string } | null>(null);

  function handleLoad(example: ExampleMeta) {
    setLoading(example.id);
    setResult(null);
    // Small timeout so the loading state renders before the parse blocks the thread
    setTimeout(() => {
      const res = loadExample(example);
      setLoading(null);
      setResult({ id: example.id, ...res });
      if (res.ok) {
        setTimeout(onClose, 600); // auto-close after success animation
      }
    }, 50);
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(3px)", display: "flex", alignItems: "flex-start",
        justifyContent: "center", paddingTop: 80, zIndex: 200, fontFamily: "inherit",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 620, background: "var(--surface-2)",
          border: "1px solid var(--border-md)", borderRadius: 12,
          boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
          overflow: "hidden", animation: "slide-up 160ms ease",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", padding: "14px 18px",
          borderBottom: "1px solid var(--border)",
        }}>
          <NodeIcon name="folder" size={16} color="var(--accent)" style={{ marginRight: 10 }}/>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Example workflows</div>
            <div style={{ fontSize: 11, color: "var(--hint)", marginTop: 1 }}>
              Load a ready-made workflow into the canvas. Your current canvas will be replaced.
            </div>
          </div>
          <button onClick={onClose} style={{
            width: 26, height: 26, border: "none", borderRadius: 4,
            background: "transparent", color: "var(--hint)", cursor: "pointer",
            display: "grid", placeItems: "center",
          }}>
            <NodeIcon name="x" size={14}/>
          </button>
        </div>

        {/* Example cards */}
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          {examples.map((ex) => {
            const isLoading = loading === ex.id;
            const isSuccess = result?.id === ex.id && result.ok;
            const isError   = result?.id === ex.id && !result.ok;
            const patternColor = PATTERN_COLORS[ex.pattern] ?? "var(--muted)";
            const patternIcon  = PATTERN_ICONS[ex.pattern] ?? "circle";

            return (
              <div key={ex.id} style={{
                display: "flex", gap: 14, padding: "14px 16px",
                background: "var(--surface-3)", borderRadius: 8,
                border: `1px solid ${isSuccess ? "rgba(95,191,127,0.4)" : isError ? "rgba(224,117,117,0.4)" : "var(--border)"}`,
                transition: "border-color 200ms",
              }}>
                {/* Pattern icon */}
                <div style={{
                  width: 40, height: 40, borderRadius: 8, flexShrink: 0,
                  background: `${patternColor}18`,
                  display: "grid", placeItems: "center",
                }}>
                  <NodeIcon name={patternIcon} size={18} color={patternColor}/>
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{ex.name}</span>
                    <span style={{
                      fontSize: 10, padding: "1px 7px", borderRadius: 99,
                      background: `${patternColor}18`, color: patternColor,
                      fontWeight: 600,
                    }}>{ex.pattern}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5, marginBottom: 8 }}>
                    {ex.description}
                  </div>
                  <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--hint)", fontFamily: MONO }}>
                    <span>{ex.nodeCount} nodes</span>
                    <span>{ex.edgeCount} edges</span>
                    <span style={{ color: "var(--hint)", fontSize: 10 }}>
                      examples/{ex.id}.harness.yaml
                    </span>
                  </div>
                  {isError && result?.error && (
                    <div style={{ marginTop: 6, fontSize: 11, color: "var(--red)",
                      background: "rgba(224,117,117,0.06)", padding: "4px 8px",
                      borderRadius: 4, fontFamily: MONO }}>
                      ✕ {result.error}
                    </div>
                  )}
                </div>

                {/* Load button */}
                <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
                  <button onClick={() => handleLoad(ex)} disabled={isLoading || isSuccess} style={{
                    padding: "7px 16px", border: "none", borderRadius: 6, cursor: isLoading || isSuccess ? "default" : "pointer",
                    background: isSuccess ? "var(--green)" : isLoading ? "var(--surface-2)" : "var(--accent)",
                    color: isSuccess ? "#0e0f13" : isLoading ? "var(--muted)" : "#1a1207",
                    fontSize: 12, fontWeight: 600, fontFamily: "inherit",
                    display: "flex", alignItems: "center", gap: 6,
                    transition: "background 200ms, color 200ms",
                  }}>
                    {isSuccess ? (
                      <><NodeIcon name="check" size={13} color="#0e0f13"/> Loaded</>
                    ) : isLoading ? (
                      <>Parsing…</>
                    ) : (
                      <><NodeIcon name="play" size={12}/> Load</>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{
          padding: "10px 18px", borderTop: "1px solid var(--border)",
          fontSize: 11, color: "var(--hint)", display: "flex", alignItems: "center", gap: 8,
        }}>
          <NodeIcon name="file" size={12}/>
          Full YAML files are in the <span style={{ fontFamily: MONO, color: "var(--muted)" }}>examples/</span> folder.
          Click any <span style={{ fontFamily: MONO, color: "var(--accent)" }}>.harness.yaml</span> file
          in the sidebar tree to load it too.
        </div>
      </div>
    </div>
  );
}
