interface KeyboardHelpProps {
  onClose: () => void;
}

interface ShortcutRow {
  keys: string;
  desc: string;
}

const SECTIONS: { title: string; rows: ShortcutRow[] }[] = [
  {
    title: "Navigation",
    rows: [
      { keys: "Ctrl+E",       desc: "Open Examples" },
      { keys: "Ctrl+Shift+E", desc: "Load Active Project" },
      { keys: "Ctrl+K",       desc: "Command Palette" },
      { keys: "Ctrl+G",       desc: "Generate Files" },
      { keys: "Ctrl+L",       desc: "Auto-layout canvas" },
      { keys: "Ctrl+.",       desc: "Validate workflow" },
    ],
  },
  {
    title: "Execution",
    rows: [
      { keys: "Run button",   desc: "Start workflow" },
      { keys: "Escape",       desc: "Close any modal" },
    ],
  },
  {
    title: "Panels",
    rows: [
      { keys: "Ctrl+Shift+P", desc: "Permission matrix" },
      { keys: "Ctrl+S",       desc: "Save workflow" },
      { keys: "Ctrl+?",       desc: "This help" },
    ],
  },
];

function Keys({ label }: { label: string }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
    }}>
      {label.split("+").map((part, i, arr) => (
        <span key={i}>
          <kbd style={{
            display: "inline-block", padding: "1px 6px", borderRadius: 4,
            border: "1px solid rgba(255,255,255,0.18)",
            background: "var(--surface-3)", color: "var(--text)",
            fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.6,
          }}>
            {part}
          </kbd>
          {i < arr.length - 1 && (
            <span style={{ color: "var(--hint)", margin: "0 1px", fontSize: 10 }}>+</span>
          )}
        </span>
      ))}
    </span>
  );
}

export function KeyboardHelp({ onClose }: KeyboardHelpProps) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 200,
        background: "rgba(0,0,0,0.55)", display: "flex",
        alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 500, background: "var(--surface-2)",
          border: "1px solid var(--border-md)", borderRadius: 10,
          boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
          fontFamily: "inherit", overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center",
          padding: "12px 16px", borderBottom: "1px solid var(--border)",
          background: "var(--surface-3)",
        }}>
          <span style={{
            fontWeight: 700, fontSize: 13, color: "var(--accent)",
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}>
            Keyboard Shortcuts
          </span>
          <div style={{ flex: 1 }}/>
          <button
            onClick={onClose}
            style={{
              border: "none", background: "transparent", color: "var(--hint)",
              cursor: "pointer", padding: "2px 6px", fontSize: 14, lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "12px 16px 16px", display: "grid", gap: 16 }}>
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <div style={{
                fontSize: 10, fontWeight: 700, color: "var(--muted)",
                textTransform: "uppercase", letterSpacing: "0.08em",
                marginBottom: 8,
              }}>
                {section.title}
              </div>
              <div style={{ display: "grid", gap: 4 }}>
                {section.rows.map((row) => (
                  <div key={row.keys} style={{
                    display: "flex", alignItems: "center", gap: 12,
                    padding: "4px 8px", borderRadius: 5,
                    background: "var(--surface-3)",
                  }}>
                    <div style={{ minWidth: 160 }}>
                      <Keys label={row.keys}/>
                    </div>
                    <span style={{ fontSize: 12, color: "var(--text)" }}>{row.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
