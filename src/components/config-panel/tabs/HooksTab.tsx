import { useEffect, useState } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useAuditStore } from "@/store/auditStore";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { Sec } from "../shared";
import type { HookConfig } from "@/types/agent";
import type { HookResult } from "@/types/filesystem";
import { executeHook, writeAuditEntry } from "@/ipc/tauriCommands";
import { makeAuditEntry } from "@/utils/logger";

function formatEnv(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseEnv(text: string): Record<string, string> | undefined {
  const env = Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf("=");
        return idx === -1
          ? [line, ""]
          : [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
      })
      .filter(([key]) => key)
  );
  return Object.keys(env).length ? env : undefined;
}

function HookRow({
  label,
  hook,
  onUpdate,
  onRun,
  running,
  result,
}: {
  label: string;
  hook: HookConfig | undefined;
  onUpdate: (value: HookConfig | undefined) => void;
  onRun: () => void;
  running: boolean;
  result: HookResult | { error: string } | undefined;
}) {
  const [envText, setEnvText] = useState(formatEnv(hook?.env));

  useEffect(() => {
    setEnvText(formatEnv(hook?.env));
  }, [hook?.path, hook?.env]);

  return (
    <div style={{ background: "var(--bg)", border: "1px solid var(--border)",
      borderRadius: 5, padding: 10, marginBottom: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase",
        color: "var(--hint)", marginBottom: 6 }}>{label}</div>
      <input
        value={hook?.path ?? ""}
        onChange={(event) => {
          const path = event.target.value;
          onUpdate(path ? { path, requireConsent: hook?.requireConsent ?? true, env: hook?.env } : undefined);
        }}
        placeholder=".harness/hooks/my-hook.sh"
        style={{ width: "100%", background: "transparent", border: "none", borderBottom: "1px solid var(--border)",
          color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", outline: "none",
          padding: "3px 0", marginBottom: 8 }}/>

      {hook?.path && (
        <>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11,
            color: "var(--text)", cursor: "pointer" }}>
            <span style={{ width: 28, height: 16, borderRadius: 99,
              background: hook.requireConsent ? "var(--accent)" : "var(--surface-3)",
              position: "relative", flexShrink: 0 }}>
              <span style={{ position: "absolute",
                right: hook.requireConsent ? 2 : undefined,
                left: hook.requireConsent ? undefined : 2,
                top: 2, width: 12, height: 12, borderRadius: "50%",
                background: hook.requireConsent ? "#1a1207" : "var(--muted)" }}/>
            </span>
            <input type="checkbox" checked={hook.requireConsent}
              onChange={(event) => onUpdate({ ...hook, requireConsent: event.target.checked })}
              style={{ display: "none" }}/>
            Require user consent before execution
          </label>

          <textarea
            value={envText}
            onChange={(event) => setEnvText(event.target.value)}
            onBlur={() => onUpdate({ ...hook, env: parseEnv(envText) })}
            placeholder="Optional env: KEY=value"
            rows={3}
            style={{ width: "100%", marginTop: 8, resize: "vertical",
              background: "var(--surface)", border: "1px solid var(--border)",
              borderRadius: 4, color: "var(--text)", fontSize: 11,
              fontFamily: "var(--font-mono)", outline: "none", padding: 7 }}/>

          <button onClick={onRun} disabled={running} style={{
            marginTop: 8, height: 26, padding: "0 10px", border: "none", borderRadius: 5,
            background: running ? "var(--surface-3)" : "var(--orange)",
            color: running ? "var(--muted)" : "#1a1207", fontSize: 11,
            fontWeight: 700, cursor: running ? "default" : "pointer", fontFamily: "inherit",
            display: "inline-flex", alignItems: "center", gap: 6,
          }}>
            <NodeIcon name="play" size={11} />
            {running ? "Running..." : "Run hook"}
          </button>

          <div style={{ marginTop: 6, display: "flex", gap: 12, fontSize: 10, color: "var(--hint)" }}>
            <span>30s timeout</span>
            <span>logged to .harness/audit.log.jsonl</span>
          </div>
        </>
      )}

      {result && (
        <pre style={{ margin: "8px 0 0", maxHeight: 96, overflow: "auto",
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 4, padding: 7, color: "error" in result ? "var(--red)" : "var(--text)",
          fontSize: 10, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap" }}>
          {"error" in result
            ? result.error
            : `exit ${result.exitCode} in ${result.durationMs}ms\n${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`}
        </pre>
      )}
    </div>
  );
}

export function HooksTab({ nodeId }: { nodeId: string }) {
  const node = useWorkflowStore((state) => state.nodes.find((item) => item.id === nodeId));
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const workspacePath = useWorkspaceStore((state) => state.workspacePath);
  const addAuditEntry = useAuditStore((state) => state.addEntry);
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, HookResult | { error: string }>>({});

  if (!node) return null;

  const recordAudit = async (
    success: boolean,
    label: string,
    hook: HookConfig,
    details: string
  ) => {
    const entry = makeAuditEntry("hook_executed", success, {
      path: hook.path,
      agentId: nodeId,
      details: `${label}: ${details}`,
    });
    addAuditEntry(entry);
    if (workspacePath) {
      await writeAuditEntry(workspacePath, entry).catch(console.error);
    }
  };

  const runHook = async (key: string, label: string, hook: HookConfig | undefined) => {
    if (!hook) return;
    if (!workspacePath) {
      setResults((current) => ({ ...current, [key]: { error: "Open a workspace before running hooks." } }));
      return;
    }
    if (hook.requireConsent && !window.confirm(`Run ${label}?\n\n${hook.path}`)) {
      await recordAudit(false, label, hook, "cancelled by user");
      setResults((current) => ({ ...current, [key]: { error: "Cancelled by user." } }));
      return;
    }

    setRunning(key);
    try {
      const result = await executeHook(workspacePath, hook.path, nodeId, hook.env ?? {}, true);
      setResults((current) => ({ ...current, [key]: result }));
      await recordAudit(
        result.exitCode === 0,
        label,
        hook,
        `exit ${result.exitCode} in ${result.durationMs}ms`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResults((current) => ({ ...current, [key]: { error: message } }));
      await recordAudit(false, label, hook, message);
    } finally {
      setRunning(null);
    }
  };

  return (
    <div>
      <div style={{ marginBottom: 12, padding: "8px 10px",
        background: "rgba(217,119,87,0.07)", border: "1px solid rgba(217,119,87,0.2)",
        borderRadius: 5, fontSize: 11, color: "var(--orange)",
        display: "flex", gap: 8, alignItems: "flex-start" }}>
        <NodeIcon name="shield" size={13} style={{ marginTop: 1, flexShrink: 0 }}/>
        Hooks execute code on your machine. Consent gates, environment variables, output, and audit logging are handled here.
      </div>

      <Sec title="Pre-execution hook">
        <HookRow
          label="runs before this node starts"
          hook={node.data.preHook}
          onUpdate={(value) => updateNodeData(nodeId, { preHook: value })}
          onRun={() => runHook("pre", "pre-execution hook", node.data.preHook)}
          running={running === "pre"}
          result={results.pre}/>
      </Sec>

      <Sec title="Post-execution hook">
        <HookRow
          label="runs after this node completes"
          hook={node.data.postHook}
          onUpdate={(value) => updateNodeData(nodeId, { postHook: value })}
          onRun={() => runHook("post", "post-execution hook", node.data.postHook)}
          running={running === "post"}
          result={results.post}/>
      </Sec>

      <Sec title="Audit log">
        <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)",
          background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, padding: 8 }}>
          .harness/audit.log.jsonl
        </div>
      </Sec>
    </div>
  );
}
