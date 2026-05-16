/**
 * ⌘K Command Palette — keyboard-driven access to all actions.
 * Triggered by Ctrl/Cmd+K from anywhere in the app.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { NodeIcon } from "@/components/nodes/NodeIcon";
import { useWorkflowStore, makeDefaultAgentNode, nextNodeId } from "@/store/workflowStore";
import { AgentRole } from "@/types/agent";
import { ROLE_META } from "@/utils/nodeColors";

interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  shortcut?: string;
  group: string;
  color?: string;
  run: () => void;
}

interface CommandPaletteProps {
  onClose: () => void;
  onOpenGenerate: () => void;
  onOpenPermissions: () => void;
}

const MONO = '"JetBrains Mono", ui-monospace, monospace';

export function CommandPalette({ onClose, onOpenGenerate, onOpenPermissions }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const addNode   = useWorkflowStore((s) => s.addNode);
  const nodeCount = useWorkflowStore((s) => s.nodes.length);
  const meta      = useWorkflowStore((s) => s.meta);

  const actions: PaletteAction[] = [
    // Workflow actions
    { id:"save",     label:"Save workflow",     hint:meta.name,  icon:"save",    shortcut:"⌘S", group:"Workflow",   run: () => { onClose(); /* handled by useKeyboardShortcuts */ } },
    { id:"generate", label:"Generate…",         hint:"CLAUDE.md, LangGraph, CrewAI", icon:"grid", shortcut:"⌘G", group:"Workflow", run: () => { onClose(); onOpenGenerate(); } },
    { id:"permissions", label:"Permission matrix", hint:"node x tool grants", icon:"shield", shortcut:"Ctrl+Shift+P", group:"Workflow", run: () => { onClose(); onOpenPermissions(); } },
    { id:"validate", label:"Validate graph",    icon:"check",   shortcut:"⌘.", group:"Workflow",  run: () => { onClose(); } },
    { id:"layout",   label:"Auto-layout",       icon:"grid",    shortcut:"⌘L", group:"Workflow",  run: () => { onClose(); } },

    // Add nodes
    ...Object.values(AgentRole).map((role) => {
      const m = ROLE_META[role];
      return {
        id: `add_${role}`,
        label: `Add ${m.label} node`,
        hint: m.glyph,
        icon: m.icon,
        group: "Add node",
        color: m.tint,
        run: () => {
          const col = nodeCount % 4;
          const row = Math.floor(nodeCount / 4);
          addNode(makeDefaultAgentNode(nextNodeId(), role, { x: 100 + col * 300, y: 100 + row * 240 }));
          onClose();
        },
      };
    }),

    // Navigation
    { id:"docs",     label:"Open AGENTS.md",    icon:"file",   group:"Navigate",  run: () => { onClose(); } },
    { id:"claude",   label:"Open CLAUDE.md",    icon:"file",   group:"Navigate",  run: () => { onClose(); } },
    { id:"audit",    label:"View audit log",    icon:"history",group:"Navigate",  run: () => { onClose(); } },
  ];

  const filtered = query.trim()
    ? actions.filter((a) =>
        a.label.toLowerCase().includes(query.toLowerCase()) ||
        a.group.toLowerCase().includes(query.toLowerCase()) ||
        (a.hint ?? "").toLowerCase().includes(query.toLowerCase())
      )
    : actions;

  // Group the filtered results
  const groups: Record<string, PaletteAction[]> = {};
  filtered.forEach((a) => {
    if (!groups[a.group]) groups[a.group] = [];
    groups[a.group].push(a);
  });

  const flatItems = filtered;

  useEffect(() => { setCursor(0); }, [query]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, flatItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      flatItems[cursor]?.run();
    } else if (e.key === "Escape") {
      onClose();
    }
  }, [cursor, flatItems, onClose]);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
      backdropFilter: "blur(2px)", display: "flex", alignItems: "flex-start",
      justifyContent: "center", paddingTop: 80, zIndex: 300, fontFamily: "inherit",
    }} onClick={onClose}>
      <div style={{
        width: 580, background: "var(--surface-2)",
        border: "1px solid var(--border-md)", borderRadius: 12,
        boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
        overflow: "hidden", animation: "slide-up 140ms ease",
      }} onClick={(e) => e.stopPropagation()}>

        {/* Search input */}
        <div style={{ display: "flex", alignItems: "center", padding: "14px 18px",
          borderBottom: "1px solid var(--border)", gap: 10 }}>
          <NodeIcon name="search" size={16} color="var(--hint)"/>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Search commands…"
            style={{ flex: 1, background: "transparent", border: "none",
              color: "var(--text)", fontSize: 15, outline: "none", fontFamily: "inherit" }}/>
          <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4,
            background: "var(--surface-3)", color: "var(--hint)", fontFamily: MONO }}>esc</span>
        </div>

        {/* Results */}
        <div style={{ maxHeight: 400, overflow: "auto", padding: "4px 0" }}>
          {flatItems.length === 0 && (
            <div style={{ padding: "16px 18px", fontSize: 12, color: "var(--hint)", textAlign: "center" }}>
              No commands matching "{query}"
            </div>
          )}

          {Object.entries(groups).map(([group, items]) => (
            <div key={group}>
              <div style={{ padding: "8px 18px 4px", fontSize: 10, color: "var(--hint)",
                textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>
                {group}
              </div>
              {items.map((item) => {
                const globalIdx = flatItems.indexOf(item);
                const isSel = globalIdx === cursor;
                return (
                  <div key={item.id} onClick={item.run}
                    style={{
                      display: "flex", alignItems: "center", gap: 12, padding: "8px 18px",
                      cursor: "pointer", userSelect: "none",
                      background: isSel ? "var(--accent-soft)" : "transparent",
                      borderLeft: isSel ? "2px solid var(--accent)" : "2px solid transparent",
                    }}
                    onMouseEnter={() => setCursor(globalIdx)}>
                    <span style={{ width: 18, color: isSel ? (item.color ?? "var(--accent)") : "var(--muted)",
                      display: "flex", justifyContent: "center" }}>
                      <NodeIcon name={item.icon} size={14} color={isSel ? (item.color ?? "var(--accent)") : "var(--muted)"}/>
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 13, color: isSel ? "var(--text)" : "var(--text)" }}>{item.label}</span>
                      {item.hint && (
                        <span style={{ fontSize: 11, color: "var(--hint)", marginLeft: 8, fontFamily: MONO }}>
                          {item.hint}
                        </span>
                      )}
                    </div>
                    {item.shortcut && (
                      <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4,
                        background: "var(--surface-3)", color: "var(--hint)", fontFamily: MONO,
                        flexShrink: 0 }}>{item.shortcut}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div style={{ padding: "6px 18px", borderTop: "1px solid var(--border)",
          display: "flex", gap: 16, fontSize: 10, color: "var(--hint)" }}>
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
