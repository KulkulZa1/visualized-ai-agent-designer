import type { AgentRun, AgentStatus } from "@/types/execution";
import { useExecutionStore } from "@/store/executionStore";

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle:    "var(--muted)",
  waiting: "var(--hint)",
  running: "rgba(229,161,66,0.8)",
  done:    "rgba(95,191,127,0.7)",
  error:   "rgba(224,117,117,0.7)",
  skipped: "var(--hint)",
};

function TimelineBar({
  agent, runStart, totalMs,
}: { agent: AgentRun; runStart: number; totalMs: number }) {
  if (!agent.startedAt) return null;
  const start = agent.startedAt;
  const end   = agent.finishedAt ?? Date.now();
  const left  = Math.max(0, ((start - runStart) / totalMs) * 100);
  const width = Math.max(2, ((end - start) / totalMs) * 100);

  return (
    <div style={{ position: "relative", height: 14, margin: "2px 0" }}>
      <div style={{
        position: "absolute", left: 0, fontSize: 9,
        color: "var(--hint)", whiteSpace: "nowrap", lineHeight: "14px",
        maxWidth: "35%", overflow: "hidden", textOverflow: "ellipsis",
        zIndex: 1,
      }}>
        {agent.agentName.slice(0, 18)}
      </div>
      <div style={{
        position: "absolute",
        left: `calc(35% + ${left * 0.65}%)`,
        width: `${width * 0.65}%`,
        height: 10, top: 2, borderRadius: 2,
        background: STATUS_COLOR[agent.status],
        opacity: 0.85,
      }}/>
    </div>
  );
}

export function ExecutionTimeline() {
  const currentRun = useExecutionStore((s) => s.currentRun);
  if (!currentRun) return null;

  const agents = Object.values(currentRun.agents);
  const hasFinished = agents.some((a) => a.finishedAt);
  if (agents.length <= 1 || !hasFinished) return null;

  const runStart = currentRun.startedAt;
  const totalMs = Math.max(1, (currentRun.finishedAt ?? Date.now()) - runStart);

  return (
    <div style={{
      borderTop: "1px solid var(--border)", padding: "8px 14px",
      flexShrink: 0,
    }}>
      <div style={{ fontSize: 10, color: "var(--hint)", marginBottom: 4 }}>Timeline</div>
      {agents.map((agent) => (
        <TimelineBar
          key={agent.agentId}
          agent={agent}
          runStart={runStart}
          totalMs={totalMs}
        />
      ))}
    </div>
  );
}
