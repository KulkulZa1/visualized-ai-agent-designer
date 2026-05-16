import { useState } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { Sec, Fld, Select } from "../shared";

function TagList({ tags, onAdd, onRemove, label }: {
  tags: string[]; onAdd: (t: string) => void; onRemove: (t: string) => void; label: string;
}) {
  const [input, setInput] = useState("");
  const add = () => {
    const t = input.trim();
    if (t && !tags.includes(t)) { onAdd(t); setInput(""); }
  };
  return (
    <Fld label={label}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6, minHeight: 24 }}>
        {tags.map((t) => (
          <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 4,
            background: "rgba(124,158,255,0.12)", color: "var(--blue)",
            fontSize: 10, padding: "2px 7px", borderRadius: 99, fontFamily: "var(--font-mono)" }}>
            {t}
            <button onClick={() => onRemove(t)} style={{ background: "none", border: "none",
              cursor: "pointer", color: "inherit", padding: 0, lineHeight: 1 }}>
              <NodeIcon name="x" size={9} stroke={2.5}/>
            </button>
          </span>
        ))}
        {tags.length === 0 && <span style={{ fontSize: 11, color: "var(--hint)" }}>None</span>}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="memory-key"
          style={{ flex: 1, background: "var(--bg)", border: "1px solid var(--border)",
            borderRadius: 4, padding: "5px 7px", color: "var(--text)", fontSize: 11,
            fontFamily: "var(--font-mono)", outline: "none" }}/>
        <button onClick={add} style={{ padding: "4px 10px", borderRadius: 4, border: "none",
          background: "var(--surface-3)", color: "var(--text)", fontSize: 11, cursor: "pointer",
          fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}>
          <NodeIcon name="plus" size={11}/> Add
        </button>
      </div>
    </Fld>
  );
}

export function MemoryTab({ nodeId }: { nodeId: string }) {
  const node = useWorkflowStore((s) => s.nodes.find((n) => n.id === nodeId));
  const upd  = useWorkflowStore((s) => s.updateNodeData);
  if (!node) return null;
  const d = node.data;
  const pct = d.tokens.budget > 0 ? d.tokens.used / d.tokens.budget : 0;
  const barColor = pct > 0.8 ? "var(--red)" : pct > 0.5 ? "var(--accent)" : "var(--green)";

  return (
    <div>
      <Sec title="Context window">
        <div style={{ background: "var(--bg)", border: "1px solid var(--border)",
          borderRadius: 5, padding: 12 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 8,
            fontFamily: "var(--font-mono)" }}>
            <span style={{ fontSize: 22, fontWeight: 600 }}>
              {(d.tokens.used / 1000).toFixed(1)}
            </span>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              / {(d.tokens.budget / 1000).toFixed(0)}k tokens used
            </span>
          </div>
          <div style={{ height: 6, background: "var(--surface-3)", borderRadius: 3,
            overflow: "hidden", marginBottom: 10 }}>
            <div style={{ height: "100%", width: `${Math.min(100, pct * 100)}%`,
              background: barColor, transition: "width 300ms" }}/>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 10px",
            fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
            <span>system prompt</span>    <span style={{ color: "var(--text)" }}>—</span>
            <span>tool definitions</span> <span style={{ color: "var(--text)" }}>—</span>
            <span>conversation</span>     <span style={{ color: "var(--text)" }}>{(d.tokens.used / 1000).toFixed(1)}k</span>
            <span>free remaining</span>   <span style={{ color: barColor }}>{((d.tokens.budget - d.tokens.used) / 1000).toFixed(1)}k</span>
            <span>compaction at</span>    <span style={{ color: "var(--accent)" }}>80%</span>
          </div>
        </div>
      </Sec>

      <Sec title="Memory keys">
        <TagList label="Can read from" tags={d.memoryRead}
          onAdd={(t) => upd(nodeId, { memoryRead: [...d.memoryRead, t] })}
          onRemove={(t) => upd(nodeId, { memoryRead: d.memoryRead.filter((k) => k !== t) })}/>
        <TagList label="Can write to" tags={d.memoryWrite}
          onAdd={(t) => upd(nodeId, { memoryWrite: [...d.memoryWrite, t] })}
          onRemove={(t) => upd(nodeId, { memoryWrite: d.memoryWrite.filter((k) => k !== t) })}/>
      </Sec>

      <Sec title="Long-term memory">
        <Fld label="Strategy">
          <Select value="append-jsonl" onChange={() => {}}>
            <option value="append-jsonl">Append-only JSONL</option>
            <option value="vector">Vector store</option>
            <option value="summary">Rolling summary</option>
            <option value="none">None</option>
          </Select>
        </Fld>
        <Fld label="Backing path">
          <input defaultValue={`.harness/memory/${nodeId}.jsonl`}
            style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
              borderRadius: 4, padding: "6px 8px", color: "var(--text)", fontSize: 11,
              fontFamily: "var(--font-mono)", outline: "none" }}/>
        </Fld>
      </Sec>
    </div>
  );
}
