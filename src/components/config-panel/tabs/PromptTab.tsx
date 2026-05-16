import { useWorkflowStore } from "@/store/workflowStore";
import { Sec, SmallBtn } from "../shared";

export function PromptTab({ nodeId }: { nodeId: string }) {
  const node = useWorkflowStore((s) => s.nodes.find((n) => n.id === nodeId));
  const upd  = useWorkflowStore((s) => s.updateNodeData);
  if (!node) return null;
  const { promptSource } = node.data;

  return (
    <div>
      {/* Mode switcher */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {(["inline","file"] as const).map((mode) => (
          <button key={mode} onClick={() => {
            if (mode === "inline") upd(nodeId, { promptSource: { type: "inline", content: promptSource.type === "inline" ? promptSource.content : "" } });
            else upd(nodeId, { promptSource: { type: "file", path: promptSource.type === "file" ? promptSource.path : "" } });
          }} style={{
            flex: 1, padding: "5px 0", borderRadius: 5, border: "none", cursor: "pointer",
            fontSize: 11, fontFamily: "inherit",
            background: promptSource.type === mode ? "var(--accent)" : "var(--surface-3)",
            color: promptSource.type === mode ? "#1a1207" : "var(--muted)",
            fontWeight: promptSource.type === mode ? 600 : 400,
          }}>{mode === "inline" ? "Inline text" : "File reference"}</button>
        ))}
      </div>

      {promptSource.type === "inline" && (
        <Sec title="System prompt" action={
          <span style={{ fontSize: 10, color: "var(--hint)", fontFamily: "var(--font-mono)" }}>
            {promptSource.content.length}ch · ~{Math.ceil(promptSource.content.length / 4)}tok
          </span>
        }>
          <textarea
            value={promptSource.content}
            onChange={(e) => upd(nodeId, { promptSource: { type: "inline", content: e.target.value } })}
            rows={9}
            placeholder="You are a specialized agent responsible for…"
            style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
              borderRadius: 5, padding: 10, color: "var(--text)", fontSize: 11, lineHeight: 1.55,
              fontFamily: "var(--font-mono)", outline: "none", resize: "vertical" }}/>
        </Sec>
      )}

      {promptSource.type === "file" && (
        <Sec title="Prompt file">
          <input value={promptSource.path}
            onChange={(e) => upd(nodeId, { promptSource: { type: "file", path: e.target.value } })}
            placeholder=".harness/prompts/my-agent.md"
            style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
              borderRadius: 4, padding: "6px 8px", color: "var(--text)", fontSize: 12,
              fontFamily: "var(--font-mono)", outline: "none" }}/>
          <div style={{ marginTop: 6, fontSize: 10, color: "var(--hint)" }}>
            Relative to workspace root. File must exist in .harness/prompts/
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <SmallBtn>Open in editor</SmallBtn>
            <SmallBtn>Create file</SmallBtn>
          </div>
        </Sec>
      )}

      <Sec title="Variables">
        <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", lineHeight: 1.7 }}>
          <div>{"{{workspace}}"} → workspace root path</div>
          <div>{"{{date}}"} → YYYY-MM-DD</div>
          <div style={{ color: "var(--hint)" }}>{"{{user_query}}"} → (runtime)</div>
        </div>
      </Sec>
    </div>
  );
}
