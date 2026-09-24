import { useState } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { AgentRole } from "@/types/agent";
import type { AgentNodeData } from "@/types/agent";
import { ROLE_META } from "@/utils/nodeColors";
import { ModelPicker } from "@/components/config-panel/ModelPicker";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { isReasoningModel } from "@/services/model-providers/providerAdapter";
import { Sec, Fld, Input, Select } from "../shared";

const MONO = '"JetBrains Mono", ui-monospace, monospace';

// ── Bulk apply actions ────────────────────────────────────────────────────────

function BulkApplyActions({ model, role }: { model: string; role: AgentRole }) {
  const bulkSetModel = useWorkflowStore((s) => s.bulkSetModel);
  const nodes        = useWorkflowStore((s) => s.nodes);
  const [flash, setFlash] = useState<string | null>(null);

  if (!model) return null;

  const roleNodes = nodes.filter((n) => n.data.role === role);
  const allCount  = nodes.filter((n) => n.data.model !== model).length;

  const apply = (roleFilter?: AgentRole) => {
    const count = bulkSetModel(model, roleFilter);
    const roleName = roleFilter ? ROLE_META[roleFilter].label : null;
    setFlash(
      count === 0
        ? "Already applied to all matching nodes"
        : roleName
        ? `Applied to ${count} ${roleName} node${count !== 1 ? "s" : ""}`
        : `Applied to all ${count} node${count !== 1 ? "s" : ""}`
    );
    setTimeout(() => setFlash(null), 2200);
  };

  return (
    <div style={{ marginTop: 2 }}>
      {flash ? (
        <div style={{
          fontSize: 11, color: "var(--green)",
          display: "flex", alignItems: "center", gap: 5,
          padding: "5px 8px", borderRadius: 5,
          background: "rgba(16,185,129,0.07)", border: "1px solid rgba(16,185,129,0.2)",
        }}>
          <NodeIcon name="check" size={11} color="var(--green)"/>
          {flash}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          <button
            onClick={() => apply()}
            disabled={allCount === 0}
            title={`Set ${model} on every node in the workflow`}
            style={applyBtnStyle(allCount > 0)}>
            <NodeIcon name="grid" size={10}/>
            Apply to all nodes
          </button>
          {roleNodes.length > 1 && (
            <button
              onClick={() => apply(role)}
              title={`Set ${model} on all ${ROLE_META[role].label} nodes`}
              style={applyBtnStyle(true)}>
              <NodeIcon name="history" size={10}/>
              Apply to {ROLE_META[role].label} nodes ({roleNodes.length})
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function applyBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: "3px 9px", border: "none", borderRadius: 4,
    cursor: active ? "pointer" : "not-allowed",
    background: active ? "var(--surface-3)" : "var(--surface-2)",
    color: active ? "var(--muted)" : "var(--hint)",
    fontSize: 11, fontFamily: "inherit",
    display: "inline-flex", alignItems: "center", gap: 4,
    opacity: active ? 1 : 0.5,
    transition: "all 80ms",
  };
}

// ── Model presets bar ─────────────────────────────────────────────────────────

type PresetName = "Full Ollama" | "Full Claude" | "Claude Mix" | "Ollama Cloud";

const MODEL_PRESETS: Record<PresetName, { label: string; hint: string; assign: (role: AgentRole) => string }> = {
  "Full Ollama": {
    label: "🖥 Ollama",
    hint: "All nodes → qwen2.5-coder:7b (free, local)",
    assign: () => "qwen2.5-coder:7b",
  },
  "Ollama Cloud": {
    label: "☁ Cloud",
    hint: "All nodes → gemma4:31b-cloud (Ollama Cloud)",
    assign: () => "gemma4:31b-cloud",
  },
  "Full Claude": {
    label: "◆ Claude",
    hint: "All nodes → claude-sonnet-4.6",
    assign: () => "claude-sonnet-4.6",
  },
  "Claude Mix": {
    label: "◆ Mix",
    hint: "Orchestrators/Critics → claude-opus-4.6, Workers → claude-haiku-4.5",
    assign: (role) =>
      role === AgentRole.Orchestrator || role === AgentRole.Critic
        ? "claude-opus-4.6"
        : role === AgentRole.Worker || role === AgentRole.ToolCaller
        ? "claude-haiku-4.5"
        : "claude-sonnet-4.6",
  },
};

function ModelPresetsBar() {
  const nodes        = useWorkflowStore((s) => s.nodes);
  const bulkSetModel = useWorkflowStore((s) => s.bulkSetModel);
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const [flash, setFlash] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<string | null>(null);

  if (nodes.length === 0) return null;

  const applyPreset = (name: PresetName) => {
    const preset = MODEL_PRESETS[name];
    // For uniform presets (all same model), use bulkSetModel
    if (name === "Full Ollama" || name === "Ollama Cloud" || name === "Full Claude") {
      const model = preset.assign(AgentRole.Worker);
      bulkSetModel(model);
      setFlash(`${name} applied (${nodes.length} nodes → ${model})`);
    } else {
      // Role-differentiated: update each node individually
      nodes.forEach((n) => {
        const model = preset.assign(n.data.role);
        if (model && n.data.role !== AgentRole.Hook && n.data.role !== AgentRole.Memory) {
          updateNodeData(n.id, { model });
        }
      });
      setFlash(`${name} applied`);
    }
    setTimeout(() => setFlash(null), 2200);
  };

  return (
    <div style={{
      background: "var(--bg)", border: "1px solid var(--border)",
      borderRadius: 6, padding: "8px 10px",
    }}>
      <div style={{ fontSize: 10, color: "var(--hint)", marginBottom: 6, letterSpacing: "0.06em" }}>
        WORKFLOW PRESETS
      </div>
      {flash ? (
        <div style={{
          fontSize: 11, color: "var(--green)",
          display: "flex", alignItems: "center", gap: 5,
        }}>
          <NodeIcon name="check" size={11} color="var(--green)"/>
          {flash}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {(Object.keys(MODEL_PRESETS) as PresetName[]).map((name) => (
              <button
                key={name}
                onClick={() => applyPreset(name)}
                onMouseEnter={() => setTooltip(MODEL_PRESETS[name].hint)}
                onMouseLeave={() => setTooltip(null)}
                style={{
                  padding: "4px 10px", border: "none", borderRadius: 99,
                  cursor: "pointer", fontSize: 11, fontFamily: "inherit",
                  background: "var(--surface-3)", color: "var(--text)",
                  transition: "background 80ms",
                }}>
                {MODEL_PRESETS[name].label}
              </button>
            ))}
          </div>
          {tooltip && (
            <div style={{ fontSize: 10, color: "var(--hint)", marginTop: 5 }}>
              {tooltip}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Fallback model section ────────────────────────────────────────────────────

const FALLBACK_TRIGGERS = [
  { value: "rate_limit", label: "Rate limit" },
  { value: "error",      label: "Any error" },
  { value: "timeout",    label: "Timeout" },
  { value: "any",        label: "Any issue" },
] as const;

function FallbackModelSection({ nodeId, data }: { nodeId: string; data: AgentNodeData }) {
  const upd = useWorkflowStore((s) => s.updateNodeData);
  const hasFallback = !!data.fallback?.model;

  const enable = () =>
    upd(nodeId, { fallback: { model: "gpt-4o-mini", trigger: "rate_limit" } });

  const disable = () =>
    upd(nodeId, { fallback: undefined });

  return (
    <Fld label="Fallback model">
      <div style={{
        background: "var(--bg)", border: "1px solid var(--border)",
        borderRadius: 6, padding: 10,
      }}>
        {/* Toggle row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: hasFallback ? 10 : 0 }}>
          <div style={{ fontSize: 11, color: "var(--hint)", display: "flex", alignItems: "center", gap: 5 }}>
            <NodeIcon name="history" size={11} color="var(--blue)"/>
            Auto-switch when primary fails (not yet applied during runs)
          </div>
          <button
            onClick={hasFallback ? disable : enable}
            style={{
              padding: "2px 9px", border: "none", borderRadius: 99,
              cursor: "pointer", fontSize: 10, fontFamily: "inherit",
              background: hasFallback ? "rgba(16,185,129,0.12)" : "var(--surface-3)",
              color: hasFallback ? "var(--green)" : "var(--muted)",
              outline: hasFallback ? "1px solid rgba(16,185,129,0.3)" : "none",
            }}>
            {hasFallback ? "● Enabled" : "○ Off"}
          </button>
        </div>

        {/* Trigger selector + model picker when enabled */}
        {hasFallback && (
          <>
            {/* Trigger row */}
            <div style={{
              display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
              fontSize: 11, color: "var(--muted)",
            }}>
              <span>Trigger on</span>
              <select
                value={data.fallback?.trigger ?? "rate_limit"}
                onChange={(e) =>
                  upd(nodeId, {
                    fallback: data.fallback
                      ? { ...data.fallback, trigger: e.target.value as typeof FALLBACK_TRIGGERS[number]["value"] }
                      : undefined,
                  })
                }
                style={{
                  background: "var(--surface-3)", border: "none",
                  borderRadius: 4, padding: "3px 7px", color: "var(--text)",
                  fontSize: 11, fontFamily: "inherit", outline: "none", cursor: "pointer",
                }}>
                {FALLBACK_TRIGGERS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            {/* Same ModelPicker, compact mode */}
            <ModelPicker
              compact
              value={data.fallback?.model ?? ""}
              onChange={(v) =>
                upd(nodeId, {
                  fallback: { model: v, trigger: data.fallback?.trigger ?? "rate_limit" },
                })
              }
            />

            {/* Flow indicator */}
            {data.fallback?.model && (
              <div style={{
                marginTop: 8, fontSize: 10, color: "var(--blue)",
                fontFamily: MONO, display: "flex", alignItems: "center", gap: 4,
              }}>
                <NodeIcon name="chev" size={10} color="var(--blue)"/>
                {data.model || "primary"} → {data.fallback.model}
                <span style={{ color: "var(--hint)" }}>on {data.fallback.trigger}</span>
              </div>
            )}
          </>
        )}
      </div>
    </Fld>
  );
}

// ── ThinkDepth selector ───────────────────────────────────────────────────────

type ThinkDepth = "none" | "low" | "medium" | "high";
const THINK_DEPTHS: ThinkDepth[] = ["none", "low", "medium", "high"];

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

// ── RoleTab ───────────────────────────────────────────────────────────────────

export function RoleTab({ nodeId }: { nodeId: string }) {
  const node = useWorkflowStore((s) => s.nodes.find((n) => n.id === nodeId));
  const upd  = useWorkflowStore((s) => s.updateNodeData);
  // Needed so Zustand doesn't re-render on irrelevant node count changes
  const nodeCount = useWorkflowStore((s) => s.nodes.length);
  if (!node) return null;
  const d = node.data;
  const canHaveModel = d.role !== AgentRole.Hook && d.role !== AgentRole.Memory;

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
              fontSize: 12, fontFamily: "inherit", outline: "none", resize: "none",
              boxSizing: "border-box" }}/>
        </Fld>
        <Fld label="Comment (annotation)">
          <textarea
            value={d.comment ?? ""}
            rows={2}
            placeholder="Optional note or annotation for this node…"
            onChange={(e) => upd(nodeId, { comment: e.target.value })}
            style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
              borderRadius: 4, padding: "6px 8px", color: "var(--text)",
              fontSize: 12, fontFamily: "inherit", outline: "none", resize: "none",
              boxSizing: "border-box" }}
          />
        </Fld>
      </Sec>

      {canHaveModel && (
        <Sec title="Model">
          <Fld label="Primary model">
            <ModelPicker
              value={d.model}
              onChange={(v) => upd(nodeId, { model: v })}
            />
          </Fld>

          {/* Bulk apply — only useful when there are other nodes */}
          {nodeCount > 1 && (
            <BulkApplyActions model={d.model} role={d.role}/>
          )}

          <ThinkDepthSelector nodeId={nodeId} data={d}/>

          <FallbackModelSection nodeId={nodeId} data={d}/>

          {/* Workflow presets — affects all nodes */}
          <Fld label="Workflow model presets">
            <ModelPresetsBar/>
          </Fld>
        </Sec>
      )}

      {!canHaveModel && (
        <Sec title="Model">
          <div style={{ fontSize: 11, color: "var(--hint)", padding: "6px 0" }}>
            {d.role === AgentRole.Hook
              ? "Hook nodes execute scripts — no LLM model required."
              : "Memory nodes store key/value pairs — no LLM model required."}
          </div>
        </Sec>
      )}

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
          <div style={{ fontSize: 10, color: "var(--hint)", marginTop: 3 }}>
            Saved and exported, but not yet sent to providers during runs.
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
            Shown as a badge on the canvas node. Not sent to the model at runtime — put routing rules in the gateway's prompt.
          </div>
        </Sec>
      )}
    </div>
  );
}
