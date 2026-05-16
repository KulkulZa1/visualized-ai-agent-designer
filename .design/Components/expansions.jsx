// expansions.jsx — Five additional UI surfaces that extend Atelier + Observatory.
// Uses the same Atelier/Observatory tokens already defined globally.

// ─────────────────────────────────────────────────────────────────────────
// 1) COMMAND PALETTE  (⌘K)
// ─────────────────────────────────────────────────────────────────────────
function CommandPalette() {
  const T = window.ATELIER;
  const [q, setQ] = React.useState('open ');
  const groups = [
    { label: 'Workflow', items: [
      { icon: '▶', name: 'Run workflow', shortcut: '⌘R', hint: 'parallel-research.harness.yaml' },
      { icon: '✓', name: 'Validate graph', shortcut: '⌘.', hint: '8 nodes · 12 edges' },
      { icon: '⤓', name: 'Save & commit', shortcut: '⌘S' },
      { icon: '⎌', name: 'Replay last trajectory', shortcut: '⌘⇧R', hint: '2026-05-11_14-22' },
    ]},
    { label: 'Navigate', items: [
      { icon: '⟶', name: 'Open: Web Searcher',  shortcut: '↵', hint: 'worker · w1' },
      { icon: '⟶', name: 'Open: Coordinator',   hint: 'orchestrator · in' },
      { icon: '⟶', name: 'Open: url_allowlist hook', hint: '.harness/hooks/url_allowlist.py' },
    ]},
    { label: 'Inspect', items: [
      { icon: '◐', name: 'Diff prompt vs v3',   hint: 'web-searcher.md' },
      { icon: '📊', name: 'Token report',       hint: 'last 24h · 4 runs' },
      { icon: '⚡', name: 'Cost projection',    hint: 'this graph · $0.74 avg' },
    ]},
  ];
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)',
      backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'flex-start',
      justifyContent: 'center', paddingTop: 80, fontFamily: '"Inter", system-ui, sans-serif' }}>
      <div style={{ width: 580, background: T.surface2,
        border: `1px solid ${T.borderStrong}`, borderRadius: 12,
        boxShadow: '0 24px 80px rgba(0,0,0,0.5)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 18px',
          borderBottom: `1px solid ${T.border}`, gap: 10 }}>
          <Icon name="search" size={16} style={{ color: T.textHint }}/>
          <input value={q} onChange={e => setQ(e.target.value)} autoFocus
            style={{ flex: 1, background: 'transparent', border: 'none', color: T.text,
              fontSize: 15, outline: 'none', fontFamily: 'inherit' }}/>
          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4,
            background: T.surface3, color: T.textHint, fontFamily: '"JetBrains Mono", monospace' }}>esc</span>
        </div>
        <div style={{ maxHeight: 380, overflow: 'auto', padding: '4px 0' }}>
          {groups.map(g => (
            <div key={g.label}>
              <div style={{ padding: '8px 18px 4px', fontSize: 10, color: T.textHint,
                textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>
                {g.label}
              </div>
              {g.items.map((it, i) => {
                const sel = g.label === 'Navigate' && i === 0;
                return (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '8px 18px', cursor: 'pointer',
                    background: sel ? T.accentSoft : 'transparent',
                    borderLeft: sel ? `2px solid ${T.accent}` : '2px solid transparent',
                  }}>
                    <span style={{ width: 18, color: sel ? T.accent : T.textMuted,
                      fontSize: 14, textAlign: 'center' }}>{it.icon}</span>
                    <span style={{ fontSize: 13, color: T.text, fontWeight: 500 }}>{it.name}</span>
                    {it.hint && <span style={{ fontSize: 11, color: T.textHint,
                      fontFamily: '"JetBrains Mono", monospace' }}>{it.hint}</span>}
                    <div style={{ flex: 1 }}/>
                    {it.shortcut && (
                      <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4,
                        background: T.surface3, color: T.textMuted,
                        fontFamily: '"JetBrains Mono", monospace' }}>{it.shortcut}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div style={{ padding: '8px 14px', borderTop: `1px solid ${T.border}`,
          background: T.surface, display: 'flex', alignItems: 'center', gap: 14,
          fontSize: 10, color: T.textHint, fontFamily: '"JetBrains Mono", monospace' }}>
          <span><b style={{ color: T.textMuted }}>↑↓</b> nav</span>
          <span><b style={{ color: T.textMuted }}>↵</b> open</span>
          <span><b style={{ color: T.textMuted }}>⌘↵</b> open in new tab</span>
          <div style={{ flex: 1 }}/>
          <span>22 results</span>
        </div>
      </div>
    </div>
  );
}

// Mini-app frame: a stylized Atelier backdrop behind the palette
function PaletteScreen() {
  const T = window.ATELIER;
  return (
    <div style={{ width: '100%', height: '100%', background: T.bg,
      color: T.text, fontFamily: '"Inter", system-ui, sans-serif',
      position: 'relative', overflow: 'hidden' }}>
      {/* faint canvas grid */}
      <div style={{ position: 'absolute', inset: 0,
        background: `radial-gradient(circle at 1px 1px, rgba(255,255,255,0.04) 1px, transparent 1px)`,
        backgroundSize: '20px 20px' }}/>
      {/* faint chrome hint */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 40,
        background: T.surface, borderBottom: `1px solid ${T.border}`,
        display: 'flex', alignItems: 'center', padding: '0 12px', gap: 8 }}>
        <div style={{ width: 14, height: 14, borderRadius: 4, background: T.accent }}/>
        <span style={{ fontSize: 12, color: T.textMuted }}>harness-studio</span>
        <span style={{ color: T.textHint }}>/</span>
        <span style={{ fontSize: 12 }}>research-agent</span>
      </div>
      <CommandPalette/>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 2) RUN PREFLIGHT DIALOG
// ─────────────────────────────────────────────────────────────────────────
function RunPreflight() {
  const T = window.ATELIER;
  const wf = window.WORKFLOWS.fanout;
  const totalBudget = wf.nodes.reduce((s, n) => s + n.tokens.budget, 0);
  const m = window.MODELS;
  // rough est: half of budget hit, weighted in/out 70/30
  const est = wf.nodes.reduce((s, n) => {
    if (!n.model) return s;
    const mm = m[n.model];
    const tok = n.tokens.budget * 0.5;
    return s + (tok * 0.7 * mm.costIn + tok * 0.3 * mm.costOut) / 1_000_000;
  }, 0);

  const hooks = [
    { name: 'pre_run_consent', who: 'Coordinator', detail: 'will request user approval before workflow starts' },
    { name: 'url_allowlist',   who: 'Web Searcher', detail: '4 domains allowed · arxiv.org, github.com, anthropic.com, +1' },
    { name: 'path_scope',      who: 'Code Searcher', detail: 'limited to ./src and ./.harness' },
  ];

  return (
    <div style={{ width: '100%', height: '100%', background: 'rgba(14,15,19,0.85)',
      backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontFamily: '"Inter", system-ui, sans-serif',
      color: T.text, padding: 20, boxSizing: 'border-box' }}>
      <div style={{ width: '100%', maxWidth: 620, background: T.surface,
        border: `1px solid ${T.borderStrong}`, borderRadius: 14,
        boxShadow: '0 24px 80px rgba(0,0,0,0.6)', overflow: 'hidden',
        display: 'flex', flexDirection: 'column', maxHeight: '100%' }}>
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 11, color: T.accent, textTransform: 'uppercase',
            letterSpacing: '0.1em', fontWeight: 600 }}>Run preflight</div>
          <div style={{ fontSize: 17, fontWeight: 600, marginTop: 4 }}>
            parallel-research.harness.yaml
          </div>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>
            Confirm cost, consent, and dry-run preview before launch.
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          {/* Cost block */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 18 }}>
            <Stat label="Est. tokens"  value={`${(totalBudget/1000)|0}k`}  hint="capped"/>
            <Stat label="Est. cost"    value={`$${est.toFixed(2)}`}        hint="±30%" tint={T.accent}/>
            <Stat label="Est. wall"    value="~14s"                        hint="3 parallel"/>
          </div>

          {/* Inputs */}
          <Block label="Inputs">
            <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6,
              padding: 10, fontFamily: '"JetBrains Mono", monospace', fontSize: 11.5 }}>
              <div><span style={{ color: T.textHint }}>query</span>{' '}
                <span>"impact of context rot on long-horizon agents"</span></div>
              <div><span style={{ color: T.textHint }}>since</span>{' '}
                <span>2024-01-01</span></div>
              <div><span style={{ color: T.textHint }}>max_depth</span>{' '}
                <span>3</span></div>
            </div>
          </Block>

          {/* Consent ledger */}
          <Block label="Hooks that will fire">
            {hooks.map((h, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '10px 12px', background: T.bg, border: `1px solid ${T.border}`,
                borderLeft: `3px solid #d97757`, borderRadius: 6, marginBottom: 6 }}>
                <Icon name="shield" size={14} style={{ color: '#d97757', marginTop: 2 }}/>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, fontFamily: '"JetBrains Mono", monospace' }}>
                    {h.name}
                    <span style={{ color: T.textHint, fontWeight: 400, marginLeft: 8 }}>
                      on {h.who}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{h.detail}</div>
                </div>
                <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3,
                  background: 'rgba(95,191,127,0.15)', color: '#5fbf7f',
                  fontFamily: '"JetBrains Mono", monospace' }}>allowed</span>
              </div>
            ))}
          </Block>

          {/* Dry-run */}
          <Block label="Dry-run preview (graph reachability)">
            <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6,
              padding: 10, fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
              color: T.textMuted, lineHeight: 1.6 }}>
              <div><span style={{ color: '#5fbf7f' }}>✓</span> 8 nodes reachable</div>
              <div><span style={{ color: '#5fbf7f' }}>✓</span> No cycles outside the critic loop (depth ≤ 2)</div>
              <div><span style={{ color: '#5fbf7f' }}>✓</span> All required env vars present (3/3)</div>
              <div><span style={{ color: '#e5a142' }}>!</span> <span style={{ color: T.text }}>web_fetch</span> may exceed worker token budget on long pages — offload enabled</div>
            </div>
          </Block>

          {/* Permissions matrix */}
          <Block label="Permissions">
            <div style={{ display: 'grid', gridTemplateColumns: 'auto auto auto auto auto',
              fontSize: 11, fontFamily: '"JetBrains Mono", monospace',
              borderTop: `1px solid ${T.border}`, borderLeft: `1px solid ${T.border}` }}>
              {['Node', 'fs.read', 'fs.write', 'web', 'shell'].map(h => (
                <div key={h} style={{ padding: '6px 10px',
                  borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`,
                  color: T.textHint, background: T.surface, fontWeight: 600 }}>{h}</div>
              ))}
              {[
                ['Coordinator',   '·', '·', '·', '·'],
                ['Web Searcher',  '·', '·', '✓', '·'],
                ['Code Searcher', '✓', '·', '·', '·'],
                ['Synthesizer',   '✓', '✓', '·', '·'],
              ].flatMap((row, ri) => row.map((cell, ci) => (
                <div key={`${ri}-${ci}`} style={{ padding: '6px 10px',
                  borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`,
                  color: cell === '✓' ? '#5fbf7f' : cell === '·' ? T.textHint : T.text,
                  textAlign: ci === 0 ? 'left' : 'center',
                  fontWeight: ci === 0 ? 500 : 400 }}>{cell}</div>
              )))}
            </div>
          </Block>
        </div>

        <div style={{ padding: '14px 20px', borderTop: `1px solid ${T.border}`,
          display: 'flex', alignItems: 'center', gap: 10, background: T.surface2 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 11, color: T.textMuted, cursor: 'pointer' }}>
            <span style={{ width: 14, height: 14, borderRadius: 3, background: T.accent,
              display: 'grid', placeItems: 'center', color: '#1a1207' }}>
              <Icon name="check" size={10}/>
            </span>
            Auto-record trajectory
          </label>
          <div style={{ flex: 1 }}/>
          <button style={btn(T, false)}>Cancel</button>
          <button style={btn(T, true)}>
            <Icon name="play" size={11}/> Launch
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, hint, tint }) {
  const T = window.ATELIER;
  return (
    <div style={{ padding: '12px 14px', background: T.bg,
      border: `1px solid ${T.border}`, borderRadius: 8 }}>
      <div style={{ fontSize: 10, color: T.textHint, textTransform: 'uppercase',
        letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: tint || T.text,
        fontFamily: '"JetBrains Mono", monospace', marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 10, color: T.textHint, marginTop: 2 }}>{hint}</div>
    </div>
  );
}

function Block({ label, children }) {
  const T = window.ATELIER;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, color: T.textMuted, textTransform: 'uppercase',
        letterSpacing: '0.08em', fontWeight: 600, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

function btn(T, primary) {
  return {
    height: 30, padding: '0 14px', border: 'none', borderRadius: 6,
    background: primary ? T.accent : T.surface3,
    color: primary ? '#1a1207' : T.text, cursor: 'pointer',
    fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
    display: 'inline-flex', alignItems: 'center', gap: 6,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 3) TRAJECTORY REPLAY DEEP-DIVE  (Observatory-style, full screen)
// ─────────────────────────────────────────────────────────────────────────
function TrajectoryReplay() {
  const T = window.OBS;
  const [step, setStep] = React.useState(6);
  const steps = window.AUDIT_ENTRIES;
  const cur = steps[step];

  return (
    <div style={{ width: '100%', height: '100%', background: T.bg, color: T.text,
      fontFamily: '"Inter", system-ui, sans-serif', display: 'grid',
      gridTemplateRows: '48px 1fr 80px', gridTemplateColumns: '320px 1fr 380px',
      gridTemplateAreas: `"top top top" "left center right" "bottom bottom bottom"`,
      overflow: 'hidden' }}>
      {/* top */}
      <div style={{ gridArea: 'top', background: T.panel,
        borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center',
        padding: '0 18px', gap: 14 }}>
        <button style={{ width: 24, height: 24, borderRadius: 6, border: `1px solid ${T.border}`,
          background: T.panel3, color: T.text, cursor: 'pointer', fontSize: 11 }}>←</button>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Trajectory replay</div>
          <div style={{ fontSize: 10, color: T.muted, fontFamily: '"JetBrains Mono", monospace' }}>
            .harness/trajectories/2026-05-11_14-22.jsonl
          </div>
        </div>
        <div style={{ flex: 1 }}/>
        <span style={{ fontSize: 11, color: T.muted }}>step</span>
        <span style={{ fontSize: 13, color: T.text, fontFamily: '"JetBrains Mono", monospace',
          fontWeight: 600 }}>{step + 1} / {steps.length}</span>
        <div style={{ width: 1, height: 16, background: T.border }}/>
        <span style={{ fontSize: 11, color: T.green }}>● completed · $0.74 · 8.2s</span>
      </div>

      {/* left: step list */}
      <div style={{ gridArea: 'left', background: T.panel,
        borderRight: `1px solid ${T.border}`, overflow: 'auto' }}>
        <div style={{ padding: '12px 14px 6px', fontSize: 10, color: T.muted,
          textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>
          Steps · {steps.length}
        </div>
        {steps.map((e, i) => {
          const sel = i === step;
          const KIND_COLOR = { run: T.accent, tool: T.green, fanout: T.purple,
            consent: T.amber, done: T.accent, warn: T.amber, error: T.red,
            edge: T.muted, tokens: T.dim };
          return (
            <div key={i} onClick={() => setStep(i)} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '8px 14px',
              background: sel ? 'rgba(77,212,255,0.08)' : 'transparent',
              borderLeft: sel ? `2px solid ${T.accent}` : '2px solid transparent',
              cursor: 'pointer' }}>
              <span style={{ fontSize: 10, color: T.dim, minWidth: 14,
                fontFamily: '"JetBrains Mono", monospace', paddingTop: 2 }}>{i+1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 9, color: KIND_COLOR[e.kind] || T.muted,
                    textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600,
                    fontFamily: '"JetBrains Mono", monospace' }}>{e.kind}</span>
                  <span style={{ fontSize: 9, color: T.dim,
                    fontFamily: '"JetBrains Mono", monospace' }}>{e.t.slice(0,8)}</span>
                </div>
                <div style={{ fontSize: 11, color: sel ? T.text : T.muted,
                  marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap' }}>{e.node}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* center: step detail */}
      <div style={{ gridArea: 'center', background: T.bg, padding: 24, overflow: 'auto' }}>
        <div style={{ fontSize: 10, color: T.muted, textTransform: 'uppercase',
          letterSpacing: '0.08em', marginBottom: 6 }}>Step {step + 1} · {cur.t}</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: T.text }}>{cur.node}</div>
        <div style={{ fontSize: 13, color: T.muted, marginTop: 4,
          fontFamily: '"JetBrains Mono", monospace' }}>{cur.msg}</div>

        {/* input/output panels */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 18 }}>
          <Codeblock title="Input">
{`tool: web_search
args:
  query: "context rot LLM long horizon"
  limit: 8
trace_id: tr_4f2a91
parent_step: 4`}
          </Codeblock>
          <Codeblock title="Output (truncated)">
{`results: [
  {title: "Lost in the Middle…", url: "arxiv.org/2307.03172"},
  {title: "Context Rot in Long…", url: "arxiv.org/2409.…"},
  {title: "Long-horizon agents…", url: "anthropic.com/r…"},
  …5 more
]
tokens_used: 412
elapsed_ms: 1726`}
          </Codeblock>
        </div>

        {/* delta */}
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 10, color: T.muted, textTransform: 'uppercase',
            letterSpacing: '0.08em', marginBottom: 6, fontWeight: 600 }}>Δ context</div>
          <div style={{ padding: 14, background: T.panel, border: `1px solid ${T.border}`,
            borderRadius: 8, display: 'flex', alignItems: 'center', gap: 18 }}>
            <DeltaStat label="tokens" before={11988} after={12400} unit=""/>
            <DeltaStat label="messages" before={6} after={8} unit=""/>
            <DeltaStat label="tool calls" before={2} after={3} unit=""/>
            <DeltaStat label="cost" before={0.0628} after={0.0712} unit="$" prec={4}/>
          </div>
        </div>
      </div>

      {/* right: state diff */}
      <div style={{ gridArea: 'right', background: T.panel,
        borderLeft: `1px solid ${T.border}`, overflow: 'auto', padding: 18 }}>
        <div style={{ fontSize: 10, color: T.muted, textTransform: 'uppercase',
          letterSpacing: '0.08em', marginBottom: 8, fontWeight: 600 }}>State at step {step + 1}</div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>Active nodes</div>
          {['Web Searcher', 'Code Searcher', 'Docs Searcher'].map((n, i) => (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', background: T.bg, border: `1px solid ${T.border}`,
              borderRadius: 6, marginBottom: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: T.green,
                boxShadow: `0 0 6px ${T.green}` }}/>
              <span style={{ fontSize: 12 }}>{n}</span>
              <div style={{ flex: 1 }}/>
              <span style={{ fontSize: 10, color: T.muted, fontFamily: '"JetBrains Mono", monospace' }}>
                {[12400, 8900, 3100][i].toLocaleString()} tok
              </span>
            </div>
          ))}
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>Scratchpad writes</div>
          <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
            color: T.muted, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6,
            padding: 10, lineHeight: 1.5 }}>
            <div><span style={{ color: T.green }}>+</span> {'{kind: "search_hit", url: "arxiv.org/2307.03172"}'}</div>
            <div><span style={{ color: T.green }}>+</span> {'{kind: "search_hit", url: "arxiv.org/2409.…"}'}</div>
            <div><span style={{ color: T.green }}>+</span> {'{kind: "search_hit", url: "anthropic.com/r…"}'}</div>
          </div>
        </div>

        <button style={{ width: '100%', padding: '8px 0', background: T.accent,
          color: T.bg, border: 'none', borderRadius: 6, cursor: 'pointer',
          fontFamily: 'inherit', fontSize: 12, fontWeight: 600 }}>
          Open in Atelier ↗
        </button>
        <button style={{ width: '100%', padding: '8px 0', background: 'transparent',
          color: T.muted, border: `1px solid ${T.border}`, borderRadius: 6, cursor: 'pointer',
          fontFamily: 'inherit', fontSize: 12, marginTop: 6 }}>
          Branch from here…
        </button>
      </div>

      {/* bottom: scrubber */}
      <div style={{ gridArea: 'bottom', background: T.panel,
        borderTop: `1px solid ${T.border}`, padding: '12px 18px',
        display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={() => setStep(s => Math.max(0, s-1))}
          style={{ width: 28, height: 28, borderRadius: 6, border: `1px solid ${T.border}`,
            background: T.panel3, color: T.text, cursor: 'pointer' }}>◀</button>
        <button style={{ width: 28, height: 28, borderRadius: 6, border: 'none',
          background: T.accent, color: T.bg, cursor: 'pointer', fontWeight: 700 }}>▶</button>
        <button onClick={() => setStep(s => Math.min(steps.length-1, s+1))}
          style={{ width: 28, height: 28, borderRadius: 6, border: `1px solid ${T.border}`,
            background: T.panel3, color: T.text, cursor: 'pointer' }}>▶</button>
        <div style={{ flex: 1, position: 'relative', height: 28,
          background: T.bg, borderRadius: 6, border: `1px solid ${T.border}` }}>
          {steps.map((e, i) => (
            <div key={i} onClick={() => setStep(i)} style={{
              position: 'absolute', top: 4, height: 20, left: `${(i / (steps.length-1)) * 96 + 2}%`,
              width: 4, background: i === step ? T.accent : T.muted,
              cursor: 'pointer', borderRadius: 1 }}/>
          ))}
        </div>
        <span style={{ fontSize: 11, color: T.muted, fontFamily: '"JetBrains Mono", monospace' }}>
          {cur.t}
        </span>
      </div>
    </div>
  );
}

function Codeblock({ title, children }) {
  const T = window.OBS;
  return (
    <div>
      <div style={{ fontSize: 10, color: T.muted, textTransform: 'uppercase',
        letterSpacing: '0.08em', marginBottom: 6, fontWeight: 600 }}>{title}</div>
      <pre style={{ margin: 0, padding: 12, background: T.panel,
        border: `1px solid ${T.border}`, borderRadius: 8,
        fontFamily: '"JetBrains Mono", monospace', fontSize: 11, lineHeight: 1.55,
        color: T.text, whiteSpace: 'pre-wrap' }}>{children}</pre>
    </div>
  );
}

function DeltaStat({ label, before, after, unit, prec = 0 }) {
  const T = window.OBS;
  const d = after - before;
  const sign = d > 0 ? '+' : '';
  const fmt = (n) => unit + (prec ? n.toFixed(prec) : n.toLocaleString());
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 10, color: T.muted, textTransform: 'uppercase',
        letterSpacing: '0.06em', marginBottom: 3 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 600,
          fontFamily: '"JetBrains Mono", monospace' }}>{fmt(after)}</span>
        <span style={{ fontSize: 10, color: d > 0 ? T.amber : T.green,
          fontFamily: '"JetBrains Mono", monospace' }}>
          {sign}{prec ? d.toFixed(prec) : d.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 4) EVAL HARNESS DASHBOARD
// ─────────────────────────────────────────────────────────────────────────
function EvalHarness() {
  const T = window.ATELIER;
  const cases = [
    { id: 'EV-001', name: 'simple-query',         desc: 'Single concept research' },
    { id: 'EV-002', name: 'ambiguous-multi-hop',  desc: 'Two related but distinct concepts' },
    { id: 'EV-003', name: 'no-results',           desc: 'Query with zero plausible web hits' },
    { id: 'EV-004', name: 'long-form-paper',      desc: '>100k token paper fetch' },
    { id: 'EV-005', name: 'contradicting-sources',desc: 'Sources that disagree on a fact' },
    { id: 'EV-006', name: 'budget-overflow',      desc: 'Forces compaction at 80%' },
    { id: 'EV-007', name: 'hostile-content',      desc: 'Prompt-injected page content' },
    { id: 'EV-008', name: 'tool-failure',         desc: 'web_search returns 503' },
  ];
  const versions = ['v4 (HEAD)', 'v3', 'v2', 'v1'];
  const results = [
    [ 'pass', 'pass', 'pass', 'pass' ],
    [ 'pass', 'pass', 'fail', 'fail' ],
    [ 'pass', 'pass', 'pass', 'pass' ],
    [ 'pass', 'flaky','fail', 'fail' ],
    [ 'pass', 'fail', 'fail', 'fail' ],   // <-- the win
    [ 'pass', 'pass', 'fail', 'fail' ],
    [ 'pass', 'pass', 'pass', 'fail' ],
    [ 'pass', 'pass', 'pass', 'pass' ],
  ];
  const cellColor = { pass: '#5fbf7f', fail: '#e07575', flaky: '#e5a142' };

  return (
    <div style={{ width: '100%', height: '100%', background: T.bg, color: T.text,
      fontFamily: '"Inter", system-ui, sans-serif', display: 'flex',
      flexDirection: 'column', overflow: 'hidden' }}>
      {/* top */}
      <div style={{ height: 56, background: T.surface,
        borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center',
        padding: '0 20px', gap: 16 }}>
        <div style={{ width: 14, height: 14, borderRadius: 4, background: T.accent }}/>
        <span style={{ fontSize: 12, color: T.textMuted }}>harness-studio</span>
        <span style={{ color: T.textHint }}>/</span>
        <span style={{ fontSize: 13, fontWeight: 500 }}>Evals</span>
        <span style={{ color: T.textHint }}>/</span>
        <span style={{ fontSize: 13 }}>parallel-research</span>
        <div style={{ flex: 1 }}/>
        <span style={{ fontSize: 11, color: T.textMuted }}>last run</span>
        <span style={{ fontSize: 12, fontFamily: '"JetBrains Mono", monospace' }}>2026-05-11 14:38</span>
        <button style={btn(T, true)}>
          <Icon name="play" size={11}/> Run all
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', flex: 1, overflow: 'hidden' }}>
        {/* matrix */}
        <div style={{ overflow: 'auto', padding: 20 }}>
          {/* KPI strip */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 18 }}>
            <Stat label="Pass rate (HEAD)" value="100%" hint="8/8" tint="#5fbf7f"/>
            <Stat label="Δ vs v3"          value="+12.5%" hint="1 case fixed" tint={T.accent}/>
            <Stat label="Avg cost / case"  value="$0.71"  hint="−$0.04 vs v3"/>
            <Stat label="Avg wall"         value="8.4s"   hint="+0.3s vs v3"/>
          </div>

          {/* matrix */}
          <div style={{ background: T.surface, border: `1px solid ${T.border}`,
            borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'grid',
              gridTemplateColumns: `300px repeat(${versions.length}, 1fr) 60px`,
              background: T.surface2, borderBottom: `1px solid ${T.border}` }}>
              <div style={{ padding: '10px 14px', fontSize: 11, color: T.textMuted,
                textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Case</div>
              {versions.map(v => (
                <div key={v} style={{ padding: '10px 14px', fontSize: 11, color: T.textMuted,
                  textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600,
                  textAlign: 'center', fontFamily: '"JetBrains Mono", monospace' }}>{v}</div>
              ))}
              <div style={{ padding: '10px 8px', fontSize: 11, color: T.textMuted,
                fontWeight: 600, textAlign: 'right' }}>cost</div>
            </div>
            {cases.map((c, ri) => (
              <div key={c.id} style={{ display: 'grid',
                gridTemplateColumns: `300px repeat(${versions.length}, 1fr) 60px`,
                borderBottom: ri === cases.length - 1 ? 'none' : `1px solid ${T.border}` }}>
                <div style={{ padding: '12px 14px' }}>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>
                    <span style={{ color: T.textHint, fontFamily: '"JetBrains Mono", monospace',
                      marginRight: 8 }}>{c.id}</span>
                    {c.name}
                  </div>
                  <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{c.desc}</div>
                </div>
                {results[ri].map((r, ci) => (
                  <div key={ci} style={{ padding: '12px 14px', display: 'flex',
                    alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ width: 18, height: 18, borderRadius: 4,
                      background: `${cellColor[r]}22`, color: cellColor[r],
                      display: 'grid', placeItems: 'center', fontSize: 10,
                      fontFamily: '"JetBrains Mono", monospace', fontWeight: 700 }}>
                      {r === 'pass' ? '✓' : r === 'fail' ? '✕' : '~'}
                    </span>
                  </div>
                ))}
                <div style={{ padding: '12px 8px', fontSize: 11, color: T.textMuted,
                  textAlign: 'right', fontFamily: '"JetBrains Mono", monospace',
                  alignSelf: 'center' }}>
                  ${(0.42 + ri * 0.08).toFixed(2)}
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 12, fontSize: 11, color: T.textHint, display: 'flex', gap: 14 }}>
            <span><span style={{ color: '#5fbf7f' }}>✓</span> pass</span>
            <span><span style={{ color: '#e07575' }}>✕</span> fail</span>
            <span><span style={{ color: '#e5a142' }}>~</span> flaky (non-deterministic)</span>
          </div>
        </div>

        {/* right: case detail */}
        <div style={{ background: T.surface, borderLeft: `1px solid ${T.border}`,
          overflow: 'auto', padding: 18 }}>
          <div style={{ fontSize: 10, color: T.textMuted, textTransform: 'uppercase',
            letterSpacing: '0.08em', fontWeight: 600, marginBottom: 6 }}>
            Selected case
          </div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>EV-005 · contradicting-sources</div>
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>
            Two arxiv papers disagree on whether context rot is linear or sigmoid past 50k tokens.
          </div>

          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 10, color: T.textMuted, textTransform: 'uppercase',
              letterSpacing: '0.08em', fontWeight: 600, marginBottom: 8 }}>Expected</div>
            <div style={{ background: T.bg, border: `1px solid ${T.border}`,
              borderRadius: 6, padding: 10, fontSize: 11.5,
              fontFamily: '"JetBrains Mono", monospace', lineHeight: 1.5 }}>
              <div><span style={{ color: T.textHint }}>output_must_contain</span>: "disagree"</div>
              <div><span style={{ color: T.textHint }}>citations</span>: ≥ 2 distinct urls</div>
              <div><span style={{ color: T.textHint }}>resolution</span>: "explicit_contradiction"</div>
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 10, color: T.textMuted, textTransform: 'uppercase',
              letterSpacing: '0.08em', fontWeight: 600, marginBottom: 8 }}>v3 → v4 fix</div>
            <div style={{ background: T.bg, border: `1px solid ${T.border}`,
              borderRadius: 6, padding: 10, fontSize: 11,
              fontFamily: '"JetBrains Mono", monospace', lineHeight: 1.6 }}>
              <div style={{ color: '#e07575' }}>− no speculation past your sources</div>
              <div style={{ color: '#5fbf7f' }}>+ no speculation past your sources.</div>
              <div style={{ color: '#5fbf7f' }}>+ If sources disagree, surface the disagreement</div>
              <div style={{ color: '#5fbf7f' }}>+ rather than picking a winner.</div>
            </div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 8 }}>
              Edited by <b>matt</b> · 2026-05-11 11:08 · <span style={{ color: T.accent }}>linked prediction</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 5) PREDICTION LEDGER
// ─────────────────────────────────────────────────────────────────────────
function PredictionLedger() {
  const T = window.ATELIER;
  const preds = [
    {
      id: 'PRED-014', date: '2026-05-11 11:08', node: 'Web Searcher', author: 'matt',
      hypothesis: 'Adding "surface disagreement" instruction will fix EV-005 without regressing EV-001 / EV-002.',
      verifyBy: 'Next eval round',
      status: 'verified',
      outcome: 'EV-005 went from FAIL → PASS. No regressions. Token usage +3%.',
    },
    {
      id: 'PRED-013', date: '2026-05-10 19:44', node: 'Coordinator', author: 'matt',
      hypothesis: 'Decomposing into ≤3 sub-questions (was unbounded) will reduce avg cost ~30%.',
      verifyBy: 'After 5 production runs',
      status: 'verified',
      outcome: 'Avg cost $1.04 → $0.71 (−32%). Quality unchanged on EV-001..EV-004.',
    },
    {
      id: 'PRED-012', date: '2026-05-09 16:22', node: 'Verifier', author: 'matt',
      hypothesis: 'Adding "Max 2 revision loops" cap will prevent the runaway cost incident from 05-07.',
      verifyBy: 'Production over 1 week',
      status: 'verified',
      outcome: 'Zero runaway runs in 47 production invocations. p99 wall time −18%.',
    },
    {
      id: 'PRED-015', date: '2026-05-12 09:30', node: 'Synthesizer', author: 'matt',
      hypothesis: 'Switching from Opus → Sonnet for the Synthesizer will cut cost by ~50% with <5% quality loss.',
      verifyBy: 'Eval round + 10 production samples',
      status: 'pending',
      outcome: null,
    },
    {
      id: 'PRED-011', date: '2026-05-08 14:14', node: 'Router', author: 'matt',
      hypothesis: 'Routing low-confidence queries to all 3 workers will boost recall on multi-hop.',
      verifyBy: 'EV-002 + 5 multi-hop samples',
      status: 'falsified',
      outcome: 'Recall unchanged. Cost +47%. Reverted.',
    },
  ];

  const STATUS = {
    verified:  { color: '#5fbf7f', icon: 'check', label: 'verified' },
    falsified: { color: '#e07575', icon: 'x',     label: 'falsified' },
    pending:   { color: '#e5a142', icon: 'circle', label: 'pending' },
  };

  return (
    <div style={{ width: '100%', height: '100%', background: T.bg, color: T.text,
      fontFamily: '"Inter", system-ui, sans-serif', display: 'flex',
      flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ height: 56, background: T.surface,
        borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center',
        padding: '0 20px', gap: 14 }}>
        <div style={{ width: 14, height: 14, borderRadius: 4, background: T.accent }}/>
        <span style={{ fontSize: 12, color: T.textMuted }}>research-agent</span>
        <span style={{ color: T.textHint }}>/</span>
        <span style={{ fontSize: 13, fontWeight: 500 }}>Predictions</span>
        <div style={{ flex: 1 }}/>
        <span style={{ fontSize: 11, color: T.textMuted }}>3 verified · 1 falsified · 1 pending</span>
      </div>

      <div style={{ padding: '20px 24px', borderBottom: `1px solid ${T.border}`,
        background: 'linear-gradient(to bottom, rgba(229,161,66,0.04), transparent)' }}>
        <div style={{ fontSize: 11, color: T.accent, textTransform: 'uppercase',
          letterSpacing: '0.1em', fontWeight: 600 }}>AHE principle</div>
        <div style={{ fontSize: 15, color: T.text, marginTop: 6, maxWidth: 720, lineHeight: 1.5 }}>
          Every edit is a hypothesis. The ledger records what you predicted before merging — and what actually happened after.
          Skip this loop and your harness is built on vibes.
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '8px 24px 24px' }}>
        {preds.map((p, i) => {
          const s = STATUS[p.status];
          return (
            <div key={p.id} style={{
              padding: '16px 18px', background: T.surface,
              border: `1px solid ${T.border}`,
              borderLeft: `3px solid ${s.color}`,
              borderRadius: 8, marginTop: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 99,
                  background: `${s.color}22`, color: s.color,
                  fontFamily: '"JetBrains Mono", monospace', fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                  display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Icon name={s.icon} size={9}/> {s.label}
                </span>
                <span style={{ fontSize: 11, color: T.textHint,
                  fontFamily: '"JetBrains Mono", monospace' }}>{p.id}</span>
                <span style={{ fontSize: 11, color: T.textHint }}>·</span>
                <span style={{ fontSize: 11, color: T.textMuted }}>{p.date}</span>
                <div style={{ flex: 1 }}/>
                <span style={{ fontSize: 11, color: T.textMuted }}>
                  on <b style={{ color: T.text }}>{p.node}</b> · by {p.author}
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: '4px 16px' }}>
                <div style={{ fontSize: 10, color: T.textHint, textTransform: 'uppercase',
                  letterSpacing: '0.06em', paddingTop: 3 }}>Hypothesis</div>
                <div style={{ fontSize: 13, color: T.text, lineHeight: 1.5 }}>{p.hypothesis}</div>

                <div style={{ fontSize: 10, color: T.textHint, textTransform: 'uppercase',
                  letterSpacing: '0.06em', paddingTop: 3 }}>Verify by</div>
                <div style={{ fontSize: 12, color: T.textMuted }}>{p.verifyBy}</div>

                {p.outcome && <>
                  <div style={{ fontSize: 10, color: s.color, textTransform: 'uppercase',
                    letterSpacing: '0.06em', paddingTop: 3, fontWeight: 600 }}>Outcome</div>
                  <div style={{ fontSize: 12, color: T.text, lineHeight: 1.5 }}>{p.outcome}</div>
                </>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

window.PaletteScreen = PaletteScreen;
window.RunPreflight = RunPreflight;
window.TrajectoryReplay = TrajectoryReplay;
window.EvalHarness = EvalHarness;
window.PredictionLedger = PredictionLedger;
