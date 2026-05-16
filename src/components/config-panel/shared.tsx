/**
 * Shared primitives for config panel tabs — all dark-themed, Atelier design system.
 */

const inputBase: React.CSSProperties = {
  width: "100%",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "6px 8px",
  color: "var(--text)",
  fontSize: 12,
  fontFamily: "inherit",
  outline: "none",
};

export function Input({ value, onChange, placeholder, mono }: {
  value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean;
}) {
  return (
    <input value={value} onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{ ...inputBase, fontFamily: mono ? "var(--font-mono)" : "inherit" }}/>
  );
}

export function Select({ value, onChange, children }: {
  value: string; onChange: (v: string) => void; children: React.ReactNode;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ ...inputBase, appearance: "none" as const, cursor: "pointer" }}>
      {children}
    </select>
  );
}

export function Sec({ title, children, action }: {
  title: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--muted)",
          letterSpacing: "0.06em", textTransform: "uppercase" }}>{title}</span>
        {action && <><div style={{ flex: 1 }}/>{action}</>}
      </div>
      {children}
    </div>
  );
}

export function Fld({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

export function SmallBtn({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <button onClick={onClick} style={{
      height: 24, padding: "0 10px", border: "none", borderRadius: 4, cursor: "pointer",
      background: "var(--surface-3)", color: "var(--text)", fontSize: 11, fontFamily: "inherit",
    }}>{children}</button>
  );
}
