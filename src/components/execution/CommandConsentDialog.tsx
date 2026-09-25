/**
 * CommandConsentDialog — asks the user to approve each shell command an agent
 * wants to run (the `bash` tool). Deny has the focus and Escape denies, so only
 * a deliberate click on Allow runs a command. The whole command is shown above
 * the buttons (no inner scroll box a long line could hide its end in).
 */
import { useEffect } from "react";
import { useCommandConsentStore } from "@/store/commandConsentStore";

const MONO = '"JetBrains Mono", monospace';

export function CommandConsentDialog() {
  const queue = useCommandConsentStore((s) => s.queue);
  const answer = useCommandConsentStore((s) => s.answer);
  const current = queue[0];

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") answer(current.id, "deny"); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, answer]);

  if (!current) return null;

  const button = (primary: boolean) => ({
    padding: "7px 16px", borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: "inherit",
    cursor: "pointer",
    border: primary ? "1px solid var(--accent)" : "1px solid var(--border-md)",
    background: primary ? "var(--accent)" : "var(--surface-3)",
    color: primary ? "#1a1207" : "var(--text)",
  });

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "80px 0 40px", zIndex: 400,
      overflowY: "auto",
    }}>
      <div
        role="alertdialog" aria-modal="true" aria-labelledby="command-consent-title"
        style={{
          width: 560, maxWidth: "96vw", background: "var(--surface-2)", border: "1px solid var(--border-md)",
          borderRadius: 12, boxShadow: "0 24px 80px rgba(0,0,0,0.7)", overflow: "hidden",
        }}
      >
        <div style={{ padding: "13px 18px", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
          <div id="command-consent-title" style={{ fontSize: 14, fontWeight: 700 }}>Run this command?</div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>
            {current.agentName} wants to run a shell command
            {queue.length > 1 && ` · ${queue.length - 1} more waiting`}
          </div>
        </div>

        <div style={{ padding: "14px 18px" }}>
          <pre style={{
            margin: 0, padding: "10px 12px", borderRadius: 6, background: "var(--surface-3)",
            border: "1px solid var(--border)", fontFamily: MONO, fontSize: 12,
            whiteSpace: "pre-wrap", wordBreak: "break-all",
          }}>{current.command}</pre>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 10, lineHeight: 1.5 }}>
            Runs in <span style={{ fontFamily: MONO }}>{current.workspacePath}</span> with your permissions
            (cmd.exe on Windows). It is not sandboxed: allow only commands you understand.
          </div>
        </div>

        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--border)", background: "var(--surface)" }}>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10, lineHeight: 1.5 }}>
            <strong>Allow for this run</strong> runs this exact command again without asking, even if the agent
            changes what it runs (for example package.json scripts).
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button autoFocus onClick={() => answer(current.id, "deny")} style={button(false)}>Deny</button>
            <button onClick={() => answer(current.id, "allow-run")} style={button(false)}>Allow for this run</button>
            <button onClick={() => answer(current.id, "allow")} style={button(true)}>Allow once</button>
          </div>
        </div>
      </div>
    </div>
  );
}
