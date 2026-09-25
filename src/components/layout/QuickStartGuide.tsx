/**
 * QuickStartGuide — in-app help modal with five tabs.
 *
 * Tabs:
 *   Start Here    — beginner walkthrough (4 steps)
 *   Concepts      — what each panel and node type does
 *   Providers     — how to configure AI providers / API keys
 *   Shortcuts     — keyboard shortcut reference
 *   Troubleshoot  — common problems with suggested fixes
 *
 * Triggered by the ? button in TopBar (Ctrl+/).
 */
import { useState } from "react";
const MONO = '"JetBrains Mono", ui-monospace, monospace';

// ── shared primitives ─────────────────────────────────────────────────────────

function H2({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 10 }}>
      {children}
    </div>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6, margin: "0 0 10px" }}>
      {children}
    </p>
  );
}

function Step({ n, title, body, extra }: { n: number; title: string; body: string; extra?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
      <div style={{
        width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
        background: "var(--accent-soft)", border: "1px solid rgba(229,161,66,0.4)",
        display: "grid", placeItems: "center",
        fontSize: 12, fontWeight: 700, color: "var(--accent)",
      }}>{n}</div>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 3 }}>{title}</div>
        <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>{body}</div>
        {extra}
      </div>
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd style={{
      display: "inline-block", padding: "1px 7px", borderRadius: 4,
      border: "1px solid rgba(255,255,255,0.15)",
      background: "var(--surface-3)", color: "var(--text)",
      fontFamily: MONO, fontSize: 11, lineHeight: 1.7,
    }}>{children}</kbd>
  );
}

function KbdRow({ keys, desc }: { keys: string; desc: string }) {
  const parts = keys.split("+");
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "4px 8px", borderRadius: 5, background: "var(--surface-3)",
      marginBottom: 3,
    }}>
      <div style={{ minWidth: 170, display: "flex", alignItems: "center", gap: 3 }}>
        {parts.map((p, i) => (
          <span key={i}>
            <Kbd>{p}</Kbd>
            {i < parts.length - 1 && <span style={{ color: "var(--hint)", margin: "0 2px", fontSize: 10 }}>+</span>}
          </span>
        ))}
      </div>
      <span style={{ fontSize: 12, color: "var(--text)" }}>{desc}</span>
    </div>
  );
}

function Concept({ glyph, name, color, desc }: { glyph: string; name: string; color: string; desc: string }) {
  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "flex-start" }}>
      <div style={{
        width: 26, height: 26, borderRadius: 6, flexShrink: 0,
        background: `${color}18`, border: `1px solid ${color}44`,
        display: "grid", placeItems: "center",
        fontSize: 13, color,
      }}>{glyph}</div>
      <div>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{name}</span>
        <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 6 }}>{desc}</span>
      </div>
    </div>
  );
}

function Alert({ type, children }: { type: "warn" | "info" | "danger"; children: React.ReactNode }) {
  const colors = {
    warn:   { bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.3)", icon: "⚠", text: "#f59e0b" },
    info:   { bg: "rgba(99,102,241,0.08)", border: "rgba(99,102,241,0.3)", icon: "ℹ", text: "#818cf8" },
    danger: { bg: "rgba(239,68,68,0.08)",  border: "rgba(239,68,68,0.3)",  icon: "✕", text: "#f87171" },
  }[type];
  return (
    <div style={{
      background: colors.bg, border: `1px solid ${colors.border}`,
      borderRadius: 6, padding: "8px 12px",
      display: "flex", gap: 8, marginBottom: 10, fontSize: 11, color: "var(--muted)", lineHeight: 1.5,
    }}>
      <span style={{ color: colors.text, flexShrink: 0 }}>{colors.icon}</span>
      <span>{children}</span>
    </div>
  );
}

// ── tab content ───────────────────────────────────────────────────────────────

function TabStartHere() {
  return (
    <div>
      <H2>Welcome to Harness Studio</H2>
      <P>
        Harness Studio is a local-first desktop app for building, visualising, and running
        multi-agent AI workflows. Each node on the canvas is an AI agent or a control node
        (gateway, memory, hook). Edges show how data and context flow between them.
      </P>

      <Step n={1} title="Open a workspace folder"
        body="A workspace is any folder on your computer. Your workflow files (.harness.yaml) will be saved there. Press Ctrl+Shift+O or click the folder icon in the left sidebar."
      />
      <Step n={2} title="Load an example workflow"
        body="Press Ctrl+E to open the Example Picker. Choose any example and click Load. The canvas will populate with agents and connections. This is the fastest way to see how a workflow looks."
        extra={<div style={{ marginTop: 4 }}><Kbd>Ctrl+E</Kbd></div>}
      />
      <Step n={3} title="Configure your AI provider"
        body="Click ⚙ Settings in the top-right corner. Add an API key for Anthropic or OpenAI, or point the app to your local Ollama server. Ollama works without any API key."
      />
      <Step n={4} title="Run the workflow"
        body="Press the Run button. A dialog will ask for a workflow topic/input. Fill it in and click Start. Independent forward branches can run concurrently up to maxParallel; downstream agents wait for required inputs."
      />

      <Alert type="info">
        No API key? Select <strong>Ollama (local)</strong> as your provider. If you have
        Ollama running at localhost:11434 with any model installed, you can run workflows
        immediately at no cost.
      </Alert>

      <Alert type="warn">
        API keys entered in Settings are stored in browser localStorage only. They are
        never written to workflow files or sent anywhere other than the selected provider.
        See the storage note under each key field in ⚙ Settings.
      </Alert>
    </div>
  );
}

function TabConcepts() {
  return (
    <div>
      <H2>Workflow concepts</H2>
      <P>
        A workflow is a directed graph of nodes (agents) and edges (data channels).
        Nodes run when their forward-edge dependencies are satisfied. Independent
        branches can run concurrently up to maxParallel, while downstream agents wait
        for required upstream outputs.
      </P>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
          Node types
        </div>
        <Concept glyph="◆" color="#e5a142" name="Orchestrator" desc="Plans the overall workflow and delegates tasks to workers." />
        <Concept glyph="◇" color="#7c9eff" name="Gateway" desc="Routes execution to different paths based on a condition or classifier output." />
        <Concept glyph="●" color="#5fbf7f" name="Worker" desc="Executes a specific task (coding, research, writing, etc.)." />
        <Concept glyph="◐" color="#e07575" name="Critic" desc="Reviews previous output and provides feedback or a pass/revise verdict." />
        <Concept glyph="▣" color="#b88bd9" name="Memory" desc="Stores key/value pairs that other agents can read across the run." />
        <Concept glyph="✕" color="#d97757" name="Hook" desc="Runs its pre-execution hook script when the run reaches it. Hooks marked 'require consent' are not run automatically; the run stops there." />
        <Concept glyph="⊕" color="#5fbf7f" name="Aggregator" desc="Collects outputs from multiple upstream agents and combines them." />
        <Concept glyph="⬡" color="#7c9eff" name="Tool Caller" desc="Calls workspace file tools (read, list, grep, write) as part of a chain. Shell commands (bash) run only after you approve them." />
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
          Edge types
        </div>
        {[
          { color: "#7c9eff", label: "Dataflow —", desc: "Passes text output from source to target." },
          { color: "#b88bd9", label: "Memory ···", desc: "Stores content in a memory node's key store." },
          { color: "#e07575", label: "Feedback ⟲", desc: "Sends critic output back to a worker for revision." },
          { color: "#6b7280", label: "Control - -", desc: "Trigger only, no data passed (hook signals, loop counters)." },
        ].map(({ color, label, desc }) => (
          <div key={label} style={{ display: "flex", gap: 10, marginBottom: 6, fontSize: 11, alignItems: "center" }}>
            <span style={{ fontFamily: MONO, color, minWidth: 110 }}>{label}</span>
            <span style={{ color: "var(--muted)" }}>{desc}</span>
          </div>
        ))}
      </div>

      <div>
        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
          UI panels
        </div>
        {[
          { name: "Canvas (center)", desc: "Main editing area. Drag nodes, draw edges, auto-layout with Ctrl+L." },
          { name: "Sidebar (left)", desc: "File tree for your workspace, plus a node list with filter chips." },
          { name: "Config Panel (right)", desc: "6-tab inspector when a node is selected: Role / Prompt / Tools / Hooks / Memory / Context." },
          { name: "Audit Strip (bottom)", desc: "Real-time event log for the current session. Filter by agent or event kind." },
          { name: "Status Bar (very bottom)", desc: "Active agent indicator, provider mode, and quick status." },
        ].map(({ name, desc }) => (
          <div key={name} style={{ marginBottom: 6, fontSize: 11 }}>
            <span style={{ color: "var(--text)", fontWeight: 600 }}>{name}</span>
            <span style={{ color: "var(--muted)", marginLeft: 6 }}>{desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TabProviders() {
  return (
    <div>
      <H2>Setting up AI providers</H2>
      <P>
        Harness Studio supports multiple AI providers. Open ⚙ Settings to configure them.
        A fixed provider mode (e.g. Ollama, Anthropic, or Custom) is used for every agent.
        In Auto mode the provider is chosen per node from its model name (gpt-*/o* → OpenAI,
        claude-* → Anthropic, anything else → Ollama), falling back to Ollama when that
        provider has no key.
      </P>

      {[
        {
          name: "Ollama (local) — recommended for beginners",
          color: "#6366f1",
          steps: [
            "Download and install Ollama from ollama.com",
            "Run: ollama pull qwen2.5-coder:7b  (or any model)",
            "In Settings, set Provider → Ollama (local)",
            "Base URL defaults to http://localhost:11434",
            "No API key needed. Click ▶ Test to verify.",
          ],
          note: null,
          warn: null,
        },
        {
          name: "Ollama Cloud",
          color: "#0ea5e9",
          steps: [
            "Get a key at ollama.com/settings",
            "Click the ☁ gemma4:31b-cloud preset button in Settings",
            "Paste your key in Auth Token → Save",
            "Click ▶ Test → should show 'will stream on-demand'",
          ],
          note: "Prompts are sent to ollama.com servers. Not local-only.",
          warn: null,
        },
        {
          name: "Anthropic (Claude)",
          color: "#d97706",
          steps: [
            "Get an API key from console.anthropic.com",
            "In Settings, paste key in Anthropic API Key → Save",
            "Set Provider → Anthropic",
            "Default model: claude-sonnet-4.6",
          ],
          note: "Prompts are sent to Anthropic servers.",
          warn: "Key stored in browser localStorage only. Never written to workflow files.",
        },
        {
          name: "OpenAI (GPT)",
          color: "#10b981",
          steps: [
            "Get an API key from platform.openai.com",
            "In Settings, paste key in OpenAI API Key → Save",
            "Set Provider → OpenAI",
            "Default model: gpt-4o-mini",
          ],
          note: "Prompts are sent to OpenAI servers.",
          warn: "Key stored in browser localStorage only.",
        },
      ].map(({ name, color, steps, note, warn }) => (
        <div key={name} style={{
          marginBottom: 14, padding: "10px 12px",
          background: "var(--surface-3)", borderRadius: 7,
          border: `1px solid ${color}33`,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color, marginBottom: 8 }}>{name}</div>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {steps.map((s, i) => (
              <li key={i} style={{ fontSize: 11, color: "var(--muted)", marginBottom: 3, lineHeight: 1.5 }}>{s}</li>
            ))}
          </ol>
          {note && (
            <div style={{ marginTop: 7, fontSize: 10, color: "#818cf8", display: "flex", gap: 5 }}>
              <span>ℹ</span><span>{note}</span>
            </div>
          )}
          {warn && (
            <div style={{ marginTop: 5, fontSize: 10, color: "#f59e0b", display: "flex", gap: 5 }}>
              <span>⚠</span><span>{warn}</span>
            </div>
          )}
        </div>
      ))}

      <Alert type="info">
        Each node's model is set in the config panel's <strong>Role</strong> tab. The optional
        per-node fallback model there is saved with the workflow but is not applied during
        runs yet.
      </Alert>
    </div>
  );
}

function TabShortcuts() {
  const sections: { title: string; rows: { keys: string; desc: string }[] }[] = [
    {
      title: "Navigation",
      rows: [
        { keys: "Ctrl+E",         desc: "Open Example Picker" },
        { keys: "Ctrl+Shift+E",   desc: "Load Active Project harness instantly" },
        { keys: "Ctrl+Shift+O",   desc: "Open workspace folder" },
        { keys: "Ctrl+K",         desc: "Command Palette" },
        { keys: "Ctrl+G",         desc: "Generate CLAUDE.md / agents / hooks" },
        { keys: "Ctrl+L",         desc: "Auto-layout canvas (Dagre LR)" },
        { keys: "Ctrl+.",         desc: "Validate workflow" },
        { keys: "Ctrl+S",         desc: "Save workflow to workspace" },
        { keys: "Ctrl+/",         desc: "This help guide" },
        { keys: "Escape",         desc: "Close any modal or panel" },
      ],
    },
    {
      title: "Canvas",
      rows: [
        { keys: "Ctrl+Z",         desc: "Undo" },
        { keys: "Ctrl+Y",         desc: "Redo" },
        { keys: "Ctrl+Shift+Z",   desc: "Redo" },
        { keys: "Ctrl+D",         desc: "Duplicate selected node" },
        { keys: "Delete",         desc: "Remove selected node" },
      ],
    },
    {
      title: "Execution",
      rows: [
        { keys: "Run button",     desc: "Start workflow (opens preflight dialog)" },
        { keys: "Ctrl+I",         desc: "Toggle agent activity panel (selected node)" },
      ],
    },
    {
      title: "Panels",
      rows: [
        { keys: "Ctrl+Shift+P",   desc: "Permission matrix" },
        { keys: "Ctrl+Shift+F",   desc: "Search execution snapshots" },
      ],
    },
  ];

  return (
    <div>
      <H2>Keyboard shortcuts</H2>
      {sections.map((sec) => (
        <div key={sec.title} style={{ marginBottom: 16 }}>
          <div style={{
            fontSize: 10, fontWeight: 700, color: "var(--muted)",
            textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6,
          }}>
            {sec.title}
          </div>
          {sec.rows.map((row) => (
            <KbdRow key={row.keys} keys={row.keys} desc={row.desc}/>
          ))}
        </div>
      ))}
    </div>
  );
}

function TabTroubleshoot() {
  const problems: { q: string; a: string; type: "warn" | "info" | "danger" }[] = [
    {
      q: "No API key — workflows fail immediately",
      a: "Open ⚙ Settings → add an Anthropic or OpenAI key. Or switch Provider to Ollama (local) — no key needed if Ollama is running locally with a model installed.",
      type: "warn",
    },
    {
      q: "Ollama not reachable (localhost:11434)",
      a: "Make sure Ollama is running: open a terminal and run `ollama serve`. Then in Settings, click ▶ Test. If you see 'Ollama is reachable', you're good.",
      type: "warn",
    },
    {
      q: "Ollama model not found",
      a: "The health check will tell you which model to pull. Run: `ollama pull qwen2.5-coder:7b` (or whatever model you set in Settings).",
      type: "info",
    },
    {
      q: "OpenAI quota exceeded / billing error",
      a: "Check your usage at platform.openai.com/usage. If you've exhausted your free tier, add a payment method. The app falls back to a local Ollama server (never Ollama Cloud or a remote gateway) if one is running with your Ollama model.",
      type: "warn",
    },
    {
      q: "Anthropic insufficient credits",
      a: "Add credits at console.anthropic.com → Plans & Billing. The app falls back to a local Ollama server if one is running with your Ollama model.",
      type: "warn",
    },
    {
      q: "Canvas is empty after loading",
      a: "Open a workspace first (Ctrl+Shift+O), then load a workflow (Ctrl+E). If a workspace is already open, the file tree on the left shows .harness.yaml files — click any to load it.",
      type: "info",
    },
    {
      q: "Workflow validation errors",
      a: "Press Ctrl+. to validate. A badge shows error count with the first few messages. Click a node, open the Role tab, and check that all required fields (name, role, model) are filled in.",
      type: "info",
    },
    {
      q: "Settings changes don't persist between launches",
      a: "API keys and provider settings are stored in browser localStorage. They persist as long as you don't clear browser data. Keys can also come from OS environment variables (OPENAI_API_KEY, ANTHROPIC_API_KEY, OLLAMA_API_KEY) set before launching the app; .env files are not read.",
      type: "info",
    },
    {
      q: "Hook execution blocked or shows 'consent required'",
      a: "This is intentional: hooks run arbitrary scripts. Only the Hooks tab asks for consent, when you click Run hook there. In a workflow run, a hook node marked 'require consent' is not run automatically — the node fails and the run stops. Run it from the Hooks tab instead, or turn off 'require consent' after reviewing the script. Hooks attached to agent nodes never run during workflow runs.",
      type: "warn",
    },
    {
      q: "MCP server not connecting to Claude Code / Cursor",
      a: "Run `npm run mcp` to start the server (stdio transport). In your MCP client config, point to `node mcp/server.mjs` from the project root. The server exposes 8 read/test tools: run_tests, run_cargo_tests, validate_workflow, project_status, list_workflows, list_providers (credential names only), list_artifacts (empty until runs persist artifacts), and get_recent_logs (audit entries, best-effort secret redaction). It has no write tools or workflow execution.",
      type: "info",
    },
  ];

  return (
    <div>
      <H2>Common problems</H2>
      {problems.map(({ q, a, type }) => (
        <div key={q} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 5 }}>
            {q}
          </div>
          <Alert type={type}>{a}</Alert>
        </div>
      ))}

      <div style={{
        marginTop: 8, padding: "10px 12px",
        background: "var(--surface-3)", borderRadius: 6,
        fontSize: 11, color: "var(--muted)",
      }}>
        <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>Still stuck?</div>
        <div>Check <code style={{ fontFamily: MONO }}>docs/TROUBLESHOOTING.md</code> in the project folder for more detail, or open an issue on GitHub.</div>
      </div>
    </div>
  );
}

// ── main modal ────────────────────────────────────────────────────────────────

type TabId = "start" | "concepts" | "providers" | "shortcuts" | "troubleshoot";

const TABS: { id: TabId; label: string }[] = [
  { id: "start",       label: "Start Here" },
  { id: "concepts",    label: "Concepts" },
  { id: "providers",   label: "Providers" },
  { id: "shortcuts",   label: "Shortcuts" },
  { id: "troubleshoot",label: "Troubleshoot" },
];

interface QuickStartGuideProps {
  onClose: () => void;
  initialTab?: TabId;
}

export function QuickStartGuide({ onClose, initialTab = "start" }: QuickStartGuideProps) {
  const [tab, setTab] = useState<TabId>(initialTab);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 200,
        background: "rgba(0,0,0,0.6)", display: "flex",
        alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 600, maxHeight: "85vh",
          background: "var(--surface-2)",
          border: "1px solid var(--border-md)", borderRadius: 12,
          boxShadow: "0 32px 80px rgba(0,0,0,0.7)",
          display: "flex", flexDirection: "column",
          fontFamily: "inherit", overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface-3)", flexShrink: 0,
        }}>
          <div style={{
            width: 22, height: 22, borderRadius: 5,
            background: "var(--accent-soft)", border: "1px solid var(--accent)",
            display: "grid", placeItems: "center",
            fontSize: 11, fontWeight: 800, color: "var(--accent)", marginRight: 10,
          }}>H</div>
          <span style={{
            fontWeight: 700, fontSize: 13, color: "var(--text)",
          }}>
            Harness Studio — Help & Quick Start
          </span>
          <div style={{ flex: 1 }}/>
          <button
            onClick={onClose}
            style={{
              border: "none", background: "transparent", color: "var(--hint)",
              cursor: "pointer", padding: "2px 6px", fontSize: 14, lineHeight: 1,
            }}
          >✕</button>
        </div>

        {/* Tab bar */}
        <div style={{
          display: "flex", gap: 2, padding: "8px 12px 0",
          background: "var(--surface-3)", borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}>
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "5px 12px", border: "none", borderRadius: "5px 5px 0 0",
              cursor: "pointer", fontSize: 12, fontFamily: "inherit",
              background: tab === t.id ? "var(--surface-2)" : "transparent",
              color: tab === t.id ? "var(--accent)" : "var(--muted)",
              fontWeight: tab === t.id ? 600 : 400,
              borderBottom: tab === t.id ? "2px solid var(--accent)" : "2px solid transparent",
              transition: "all 80ms",
            }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{
          padding: "18px 20px", overflowY: "auto", flex: 1,
        }}>
          {tab === "start"        && <TabStartHere/>}
          {tab === "concepts"     && <TabConcepts/>}
          {tab === "providers"    && <TabProviders/>}
          {tab === "shortcuts"    && <TabShortcuts/>}
          {tab === "troubleshoot" && <TabTroubleshoot/>}
        </div>

        {/* Footer */}
        <div style={{
          padding: "8px 16px", borderTop: "1px solid var(--border)",
          background: "var(--surface-3)", flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          fontSize: 10, color: "var(--hint)",
        }}>
          <span>Harness Studio v0.1.0 · Local-first AI workflow builder</span>
          <span>
            <kbd style={{ fontFamily: MONO, fontSize: 10, background: "var(--surface-2)",
              padding: "1px 5px", borderRadius: 3, border: "1px solid var(--border)" }}>Ctrl+/</kbd>
            {" "} to toggle
          </span>
        </div>
      </div>
    </div>
  );
}
