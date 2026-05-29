/**
 * ErrorToast — brief dismissible error notification.
 * Positioned at top-center; auto-dismisses after 5 seconds.
 * Replaces alert() calls from useWorkflowExecution.
 */
import { useEffect } from "react";

interface ErrorToastProps {
  message: string;
  onDismiss: () => void;
}

export function ErrorToast({ message, onDismiss }: ErrorToastProps) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [message, onDismiss]);

  return (
    <div style={{
      position: "fixed", top: 60, left: "50%", transform: "translateX(-50%)",
      zIndex: 9999, maxWidth: 520, width: "calc(100% - 32px)",
      background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.5)",
      borderRadius: 8, padding: "10px 14px",
      display: "flex", alignItems: "flex-start", gap: 10,
      boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
      fontFamily: "inherit",
    }}>
      <span style={{ fontSize: 14, color: "#f87171", flexShrink: 0, marginTop: 1 }}>✕</span>
      <span style={{ flex: 1, fontSize: 12, color: "var(--text)", lineHeight: 1.5 }}>
        {message}
      </span>
      <button
        onClick={onDismiss}
        style={{
          border: "none", background: "transparent", color: "var(--hint)",
          cursor: "pointer", padding: "0 2px", fontSize: 12, flexShrink: 0,
        }}
      >✕</button>
    </div>
  );
}
