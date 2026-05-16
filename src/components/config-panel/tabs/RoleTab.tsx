import { useEffect } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { AgentRole } from "@/types/agent";
import type { AgentNodeData } from "@/types/agent";
import { ROLE_META } from "@/utils/nodeColors";
import { useModelRegistry } from "@/hooks/useModelRegistry";
import { inferProvider } from "@/utils/modelRegistry";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { Sec, Fld, Input, Select } from "../shared";

const MONO = '"JetBrains Mono", ui-monospace, monospace';

// ── Provider selector ─────────────────────────────────────────────────────────
function ProviderSelector() {
  const {
    providers, selectedProvider, providerDef,
    models, isLoading, loadError, hasLive,
    setProvider, fetchLive, refresh,
  } = useModelRegistry();

  const canFetchLive = !!providerDef?.apiEndpoint;

  return (
    <div style={{ background: "var(--bg)", border: "1px solid var(--border)",
      borderRadius: 6, padding: 10, marginBottom: 10 }}>
      {/* Provider row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: "var(--muted)", minWidth: 60 }}>Provider</span>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1 }}>
          {providers.map((p) => (
            <button key={p.id} onClick={() => setProvider(p.id)} style={{
              padding: "3px 9px", border: "none", borderRadius: 99,
              cursor: "pointer", fontSize: 11, fontFamily: "inherit",
              background: selectedProvider === p.id ? `${p.logoColor}25` : "var(--surface-3)",
              color: selectedProvider === p.id ? p.logoColor : "var(--muted)",
              outline: selectedProvider === p.id ? `1px solid ${p.logoColor}55` : "none",
              fontWeight: selectedProvider === p.id ? 600 : 400,
              transition: "all 100ms",
            }}>{p.label}</button>
          ))}
        </div>
      </div>

      {/* Live API row */}
      {canFetchLive && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
          <span style={{ fontSize: 10, color: "var(--hint)", flex: 1 }}>
            {isLoading ? "Fetching models…" :
             loadError ? `⚠ ${loadError}` :
             hasLive ? `${models.length} models loaded from API` :
             `${models.length} default models · click to load live list`}
          </span>
          <button onClick={isLoading ? undefined : (hasLive ? refresh : fetchLive)}
            disabled={isLoading}
            style={{
              padding: "3px 8px", border: "none", borderRadius: 4, cursor: isLoading ? "default" : "pointer",
              background: "var(--surface-3)", color: isLoading ? "var(--hint)" : "var(--accent)",
              fontSize: 10, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4,
            }}>
            <NodeIcon name="history" size={10} color={isLoading ? "var(--hint)" : "var(--accent)"}/>
            {isLoading ? "Loading…" : hasLive ? "Refresh" : "Load from API"}
          </button>
        </div>
      )}

      {/* Provider info */}
      {providerDef?.requiresKey && (
        <div style={{ marginTop: 6, fontSize: 10, color: "var(--hint)",
          display: "flex", alignItems: "center", gap: 4 }}>
          <NodeIcon name="lock" size={10}/>
          API key required — store in <span style={{ fontFamily: MONO, color: "var(--muted)" }}>.env.local</span>
        </div>
      )}
      {!providerDef?.requiresKey && providerDef?.id === "ollama" && (
        <div style={{ marginTop: 6, fontSize: 10, color: "var(--hint)" }}>
          Needs <span style={{ fontFamily: MONO, color: "var(--muted)" }}>ollama serve</span> running locally.
        </div>
      )}
    </div>
  );
}

// ── Model selector ─────────────────────────────────────────────────────────────
function ModelSelector({ nodeId, currentModel }: { nodeId: string; currentModel: string }) {
  const { models, selectedProvider, setProvider } = useModelRegistry();
  const upd = useWorkflowStore((s) => s.updateNodeData);

  // Auto-detect provider from current model on first render
  useEffect(() => {
    if (currentModel) {
      const inferred = inferProvider(currentModel);
      if (inferred !== selectedProvider) setProvider(inferred);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleModelChange = (value: string) => {
    upd(nodeId, { model: value });
  };

  // Custom entry for "custom" provider
  if (selectedProvider === "custom") {
    return (
      <Input
        value={currentModel}
        onChange={handleModelChange}
        placeholder="Enter any model ID (e.g. my-org/my-model)"
        mono
      />
    );
  }

  const selectedInfo = models.find((m) => m.id === currentModel);

  return (
    <div>
      <Select value={currentModel} onChange={handleModelChange}>
        <option value="">— no model —</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
        {/* Allow keeping the current value even if not in list */}
        {currentModel && !models.find((m) => m.id === currentModel) && (
          <option value={currentModel}>{currentModel} (custom)</option>
        )}
      </Select>

      {/* Model details */}
      {selectedInfo && (
        <div style={{
          marginTop: 6, background: "var(--bg)", border: "1px solid var(--border)",
          borderRadius: 4, padding: "6px 10px", display: "grid",
          gridTemplateColumns: "1fr 1fr", gap: "4px 12px",
          fontSize: 11, color: "var(--muted)", fontFamily: MONO,
        }}>
          <span>context</span>
          <span style={{ color: "var(--text)", textAlign: "right" }}>{selectedInfo.contextK}k tok</span>
          {selectedInfo.costInPerMtok !== undefined && (
            <>
              <span>in / Mtok</span>
              <span style={{ color: "var(--text)", textAlign: "right" }}>
                {selectedInfo.costInPerMtok === 0 ? "free" : `$${selectedInfo.costInPerMtok}`}
              </span>
            </>
          )}
          {selectedInfo.costOutPerMtok !== undefined && (
            <>
              <span>out / Mtok</span>
              <span style={{ color: "var(--text)", textAlign: "right" }}>
                {selectedInfo.costOutPerMtok === 0 ? "free" : `$${selectedInfo.costOutPerMtok}`}
              </span>
            </>
          )}
          {selectedInfo.tags?.length && (
            <>
              <span>tags</span>
              <span style={{ color: "var(--hint)", textAlign: "right" }}>
                {selectedInfo.tags.join(", ")}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── ThinkDepth selector ────────────────────────────────────────────────────────
type ThinkDepth = "none" | "low" | "medium" | "high";
const THINK_DEPTHS: ThinkDepth[] = ["none", "low", "medium", "high"];

function isReasoningModel(model: string): boolean {
  return model.startsWith("gpt-5.5") || model.startsWith("o3") ||
         model.startsWith("o4") || model.startsWith("o1");
}

function ThinkDepthSelector({ nodeId, data }: { nodeId: string; data: AgentNodeData }) {
  const upd = useWorkflowStore((s) => s.updateNodeData);
  if (!isReasoningModel(data.model)) return null;
  const current = data.thinkDepth ?? "none";

  return (
    <Fld label="Thinking depth">
      <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
        {THINK_DEPTHS.map((d) => (
          <button key={d} onClick={() => upd(nodeId, { thinkDepth: d })} style={{
            flex: 1, padding: "4px 0", border: "none", borderRadius: 4,
            cursor: "pointer", fontSize: 11, fontFamily: "inherit",
            background: current === d ? "var(--accent-soft)" : "var(--surface-3)",
            color: current === d ? "var(--accent)" : "var(--muted)",
            outline: current === d ? "1px solid rgba(229,161,66,0.4)" : "none",
            fontWeight: current === d ? 600 : 400,
            transition: "all 100ms",
          }}>{d.charAt(0).toUpperCase() + d.slice(1)}</button>
        ))}
      </div>
      <div style={{ fontSize: 10, color: "var(--hint)" }}>
        Controls <span style={{ fontFamily: MONO }}>reasoning_effort</span> for OpenAI o-series and GPT-5.5
      </div>
    </Fld>
  );
}

// ── RoleTab ────────────────────────────────────────────────────────────────────
export function RoleTab({ nodeId }: { nodeId: string }) {
  const node = useWorkflowStore((s) => s.nodes.find((n) => n.id === nodeId));
  const upd  = useWorkflowStore((s) => s.updateNodeData);
  if (!node) return null;
  const d = node.data;

  return (
    <div>
      <Sec title="Identity">
        <Fld label="Display name">
          <Input value={d.name} onChange={(v) => upd(nodeId, { name: v })}/>
        </Fld>
        <Fld label="Role / kind">
          <Select value={d.role} onChange={(v) => upd(nodeId, { role: v as AgentRole })}>
            {Object.entries(ROLE_META).map(([k, m]) => (
              <option key={k} value={k}>{m.glyph} {m.label}</option>
            ))}
          </Select>
        </Fld>
        <Fld label="Description">
          <textarea value={d.description ?? ""}
            rows={2} placeholder="What does this node do?"
            onChange={(e) => upd(nodeId, { description: e.target.value })}
            style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
              borderRadius: 4, padding: "6px 8px", color: "var(--text)",
              fontSize: 12, fontFamily: "inherit", outline: "none", resize: "none" }}/>
        </Fld>
        <Fld label="Comment (annotation)">
          <textarea
            value={d.comment ?? ""}
            rows={2}
            placeholder="Optional note or annotation for this node…"
            onChange={(e) => upd(nodeId, { comment: e.target.value })}
            style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
              borderRadius: 4, padding: "6px 8px", color: "var(--text)",
              fontSize: 12, fontFamily: "inherit", outline: "none", resize: "none" }}
          />
        </Fld>
      </Sec>

      <Sec title="Model">
        <ProviderSelector />
        <Fld label="Primary model">
          <ModelSelector nodeId={nodeId} currentModel={d.model}/>
        </Fld>

        <ThinkDepthSelector nodeId={nodeId} data={d}/>

        {/* Fallback model */}
        <Fld label="Fallback model">
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)",
            borderRadius: 6, padding: 10 }}>
            <div style={{ fontSize: 11, color: "var(--hint)", marginBottom: 8,
              display: "flex", alignItems: "center", gap: 6 }}>
              <NodeIcon name="history" size={12} color="var(--blue)"/>
              Auto-switch when primary is rate-limited or errors
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6, alignItems: "end" }}>
              <Fld label="Fallback model ID">
                <Input
                  value={d.fallback?.model ?? ""}
                  onChange={(v) => upd(nodeId, {
                    fallback: v ? { model: v, trigger: d.fallback?.trigger ?? "rate_limit" } : undefined,
                  })}
                  placeholder="e.g. gpt-5.5-xhigh"
                  mono
                />
              </Fld>
              <Fld label="Trigger on">
                <select
                  value={d.fallback?.trigger ?? "rate_limit"}
                  disabled={!d.fallback?.model}
                  onChange={(e) => upd(nodeId, {
                    fallback: d.fallback ? { ...d.fallback, trigger: e.target.value as "rate_limit" | "error" | "timeout" | "any" } : undefined,
                  })}
                  style={{ background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: 4, padding: "6px 8px", color: d.fallback?.model ? "var(--text)" : "var(--hint)",
                    fontSize: 12, fontFamily: "inherit", outline: "none" }}
                >
                  <option value="rate_limit">Rate limit</option>
                  <option value="error">Any error</option>
                  <option value="timeout">Timeout</option>
                  <option value="any">Any issue</option>
                </select>
              </Fld>
            </div>
            {d.fallback?.model && (
              <div style={{ marginTop: 6, fontSize: 10, color: "var(--blue)",
                fontFamily: MONO, display: "flex", alignItems: "center", gap: 4 }}>
                <NodeIcon name="chev" size={10} color="var(--blue)"/>
                {d.model || "primary"} → {d.fallback.model} on {d.fallback.trigger}
              </div>
            )}
          </div>
        </Fld>
      </Sec>

      <Sec title="Limits">
        <Fld label={`Token budget · ${d.tokens.budget.toLocaleString()}`}>
          <input type="range" min={0} max={200000} step={1000}
            value={d.tokens.budget}
            onChange={(e) => upd(nodeId, { tokens: { ...d.tokens, budget: +e.target.value } })}
            style={{ width: "100%", accentColor: "var(--accent)" }}/>
          <div style={{ display: "flex", justifyContent: "space-between",
            fontSize: 9, color: "var(--hint)", marginTop: 2 }}>
            <span>0</span>
            <span style={{ fontFamily: MONO }}>{(d.tokens.budget / 1000).toFixed(0)}k</span>
            <span>200k</span>
          </div>
        </Fld>
        <Fld label="Temperature">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="range" min={0} max={2} step={0.05}
              value={d.temperature}
              onChange={(e) => upd(nodeId, { temperature: parseFloat(e.target.value) })}
              style={{ flex: 1, accentColor: "var(--accent)" }}/>
            <span style={{ fontSize: 11, fontFamily: MONO, color: "var(--muted)",
              minWidth: 32, textAlign: "right" }}>{d.temperature.toFixed(2)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between",
            fontSize: 9, color: "var(--hint)", marginTop: 2 }}>
            <span>precise</span><span>balanced</span><span>creative</span>
          </div>
        </Fld>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Fld label="Max steps">
            <Input value={String(d.maxSteps)}
              onChange={(v) => upd(nodeId, { maxSteps: Math.max(1, parseInt(v) || 20) })}/>
          </Fld>
          <Fld label="Timeout (s)">
            <Input value={String(d.timeoutSeconds)}
              onChange={(v) => upd(nodeId, { timeoutSeconds: Math.max(1, parseInt(v) || 300) })}/>
          </Fld>
        </div>
      </Sec>

      {/* Gateway condition */}
      {d.role === AgentRole.Gateway && (
        <Sec title="Routing condition">
          <Input
            value={d.condition ?? ""}
            onChange={(v) => upd(nodeId, { condition: v })}
            placeholder='e.g. "confidence >= 0.6" or "issues > 0 and iter < 3"'
            mono/>
          <div style={{ fontSize: 10, color: "var(--hint)", marginTop: 4 }}>
            Shown as a badge on the canvas node. Evaluated at runtime by the gateway's prompt logic.
          </div>
        </Sec>
      )}
    </div>
  );
}
