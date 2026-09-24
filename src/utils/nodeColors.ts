/**
 * Atelier design system — role metadata.
 * Colors match the design tokens in .design/Components/workflows.jsx exactly.
 */
import { AgentRole } from "@/types/agent";

export interface RoleMeta {
  label:   string;
  glyph:   string;   // geometric symbol shown in chips
  tint:    string;   // border + icon color
  bgAlpha: string;   // node background (tint + alpha)
  icon:    string;   // icon name (maps to Icon component in nodes)
}

export const ROLE_META: Record<AgentRole, RoleMeta> = {
  [AgentRole.Orchestrator]: { label:"Orchestrator", glyph:"◆", tint:"#e5a142", bgAlpha:"#e5a14212", icon:"cpu"     },
  [AgentRole.Gateway]:      { label:"Gateway",      glyph:"◇", tint:"#7c9eff", bgAlpha:"#7c9eff12", icon:"branch"  },
  [AgentRole.Worker]:       { label:"Worker",       glyph:"●", tint:"#5fbf7f", bgAlpha:"#5fbf7f12", icon:"zap"     },
  [AgentRole.Critic]:       { label:"Critic",       glyph:"◐", tint:"#e07575", bgAlpha:"#e0757512", icon:"eye"     },
  [AgentRole.Memory]:       { label:"Memory",       glyph:"▣", tint:"#b88bd9", bgAlpha:"#b88bd912", icon:"db"      },
  [AgentRole.Hook]:         { label:"Hook",         glyph:"✕", tint:"#d97757", bgAlpha:"#d9775712", icon:"shield"  },
  [AgentRole.Aggregator]:   { label:"Aggregator",   glyph:"⊕", tint:"#5fbfb5", bgAlpha:"#5fbfb512", icon:"send"   },
  [AgentRole.ToolCaller]:   { label:"Tool",         glyph:"⬡", tint:"#9aa4b2", bgAlpha:"#9aa4b212", icon:"cog"    },
};

/** Role tints for minimap (same as RoleMeta.tint, extracted for easy lookup). */
export const MINIMAP_COLORS: Record<AgentRole, string> = Object.fromEntries(
  Object.entries(ROLE_META).map(([k, v]) => [k, v.tint])
) as Record<AgentRole, string>;

/** Status dot colors matching the design system. */
export const STATUS_COLORS = {
  idle:    { dot: "#6b7280", label: "idle"    },
  running: { dot: "#5fbf7f", label: "running" },
  waiting: { dot: "#e5a142", label: "waiting" },
  done:    { dot: "#7c9eff", label: "done"    },
  error:   { dot: "#e07575", label: "error"   },
  stopped: { dot: "#9097a3", label: "stopped" },
} as const;
