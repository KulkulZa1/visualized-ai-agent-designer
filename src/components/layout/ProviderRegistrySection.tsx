import { useState } from "react";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { DEFAULT_PROVIDER_CATALOG } from "@/services/model-providers/providerCatalog";

const MONO = '"JetBrains Mono", monospace';

function Badge({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "green" }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "2px 6px", borderRadius: 3,
      background: tone === "green" ? "rgba(95,191,127,0.12)" : "var(--surface-3)",
      color: tone === "green" ? "var(--green)" : "var(--muted)",
      fontSize: 10, fontFamily: MONO,
    }}>
      {children}
    </span>
  );
}

/** Collapsible read-only provider registry listing. Drop into any settings panel. */
export function ProviderRegistrySection() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "12px 18px 4px" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 6, width: "100%",
          background: "transparent", border: "none", padding: 0,
          cursor: "pointer", fontFamily: "inherit",
        }}
      >
        <NodeIcon name={open ? "chev-d" : "chev"} size={10} color="var(--muted)"/>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
          Provider Registry
        </span>
        <span style={{ fontSize: 11, color: "var(--hint)", marginLeft: 4 }}>
          ({DEFAULT_PROVIDER_CATALOG.length} providers)
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 10, display: "grid", gap: 6, marginBottom: 12 }}>
          {DEFAULT_PROVIDER_CATALOG.map((p) => (
            <div key={p.id} style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "6px 10px", borderRadius: 5,
              background: "var(--surface-3)", border: "1px solid var(--border)",
              fontSize: 11,
            }}>
              <div style={{
                width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                background: p.enabled ? "var(--green)" : "var(--hint)",
              }}/>
              <span style={{ flex: 1, fontWeight: 500, color: "var(--text)", minWidth: 0,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.name}
              </span>
              <Badge>{p.type}</Badge>
              <Badge tone={p.isLocal ? "green" : "default"}>
                {p.isLocal ? "local" : "cloud"}
              </Badge>
              <Badge tone={p.enabled ? "green" : "default"}>
                {p.enabled ? "on" : "off"}
              </Badge>
              <Badge>{p.healthStatus}</Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
