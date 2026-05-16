// observatory.jsx — Variation 3: "Observatory"
// Telemetry-first. The canvas is a live op view with token gauges, trajectory replay timeline.

const OBS = {
  bg: '#0d1116', panel: '#161b22', panel2: '#1e242d', panel3: '#272e39',
  border: '#2d3441', borderH: '#3d4654', text: '#d6dde5', muted: '#8a95a3', dim: '#5c6675',
  accent: '#4dd4ff', purple: '#b388ff', green: '#5ad17a', amber: '#ffb84a',
  red: '#ff6266', pink: '#ff7ab8',
};

const ui = '-apple-system, "Inter", BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const mono2 = '"JetBrains Mono", ui-monospace, Menlo, monospace';

function ObservatoryApp({ workflow }) {
  const [selected, setSelected] = React.useState(workflow.nodes[1]?.id || workflow.nodes[0]?.id);
  const [t, setT] = React.useState(7.4); // timeline scrubber position (s)
  const [playing, setPlaying] = React.useState(false);

  React.useEffect(() => { setSelected(workflow.nodes[1]?.id || workflow.nodes[0]?.id); }, [workflow.id]);

  React.useEffect(() => {
    if (!playing) return;
    const iv = setInterval(() => setT(v => v >= 12 ? 0 : v + 0.1), 80);
    return () => clearInterval(iv);
  }, [playing]);

  const sel = workflow.nodes.find(n => n.id === selected);
  const totalTok = workflow.nodes.reduce((s, n) => s + n.tokens.used, 0);
  const totalCost = totalTok * 0.00002;

  return (
    <div data-screen-label="03 Observatory" style={{
      width: '100%', height: '100%', background: OBS.bg, color: OBS.text,
      fontFamily: ui, fontSize: 13, display: 'grid', overflow: 'hidden',
      gridTemplateRows: '52px 1fr 220px',
      gridTemplateColumns: '1fr 360px',
      gridTemplateAreas: `"top top" "canvas right" "bottom bottom"`,
    }}>
      {/* Top header */}
      <div style={{ gridArea: 'top', background: OBS.panel, borderBottom: `1px solid ${OBS.border}`,
        display: 'flex', alignItems: 'center', padding: '0 18px', gap: 16 }}>
        <div style={{ width: 28, height: 28, borderRadius: 6,
          background: `linear-gradient(135deg, ${OBS.accent}, ${OBS.purple})`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14, color: '#0d1116', fontWeight: 800 }}>O</div>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Observatory</div>
          <div style={{ fontSize: 10, color: OBS.muted, marginTop: -2 }}>
            {workflow.name} · <span style={{ color: OBS.green }}>● live</span>
          </div>
        </div>
        <div style={{ flex: 1 }}/>

        <StatPill label="tokens" value={`${(totalTok/1000).toFixed(1)}k`} tint={OBS.accent}/>
        <StatPill label="cost" value={`$${totalCost.toFixed(2)}`} tint={OBS.amber}/>
        <StatPill label="wall" value="8.4s" tint={OBS.purple}/>
        <StatPill label="errors" value="0" tint={OBS.green}/>

        <button style={{ height: 32, padding: '0 14px', borderRadius: 8, border: 'none',
          background: OBS.accent, color: '#0d1116', cursor: 'pointer',
          fontFamily: ui, fontWeight: 600, fontSize: 13, display: 'flex',
          alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10 }}>▶</span> Replay
        </button>
      </div>

      {/* Canvas */}
      <ObsCanvas workflow={workflow} selected={selected} setSelected={setSelected} t={t}/>

      {/* Right rail: node detail + telemetry */}
      <div style={{ gridArea: 'right', background: OBS.panel,
        borderLeft: `1px solid ${OBS.border}`, display: 'flex', flexDirection: 'column',
        overflow: 'hidden' }}>
        {sel && <ObsDetail node={sel}/>}
      </div>

      {/* Bottom timeline */}
      <ObsTimeline t={t} setT={setT} playing={playing} setPlaying={setPlaying} workflow={workflow}/>
    </div>
  );
}

function StatPill({ label, value, tint }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
      padding: '4px 12px', borderLeft: `1px solid ${OBS.border}` }}>
      <div style={{ fontSize: 9, color: OBS.muted, textTransform: 'uppercase',
        letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: tint, fontFamily: mono2 }}>{value}</div>
    </div>
  );
}

function ObsCanvas({ workflow, selected, setSelected, t }) {
  const xs = workflow.nodes.map(n => n.x);
  const ys = workflow.nodes.map(n => n.y);
  const minX = Math.min(...xs) - 60, minY = Math.min(...ys) - 40;
  const maxX = Math.max(...xs.map((x, i) => x + workflow.nodes[i].w)) + 60;
  const maxY = Math.max(...ys) + 240;

  return (
    <div style={{ gridArea: 'canvas', position: 'relative', overflow: 'auto',
      background: `radial-gradient(circle at 50% 30%, ${OBS.panel} 0, ${OBS.bg} 70%)` }}>
      <div style={{ position: 'relative', width: maxX - minX + 80, height: maxY - minY + 80,
        transform: `translate(${-minX + 40}px, ${-minY + 40}px)` }}>
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}>
          <defs>
            {workflow.edges.map((e, i) => (
              <linearGradient key={i} id={`og${i}`} x1="0" x2="1">
                <stop offset="0" stopColor={OBS.accent} stopOpacity="0.1"/>
                <stop offset="0.5" stopColor={OBS.accent} stopOpacity="0.7"/>
                <stop offset="1" stopColor={OBS.accent} stopOpacity="0.1"/>
              </linearGradient>
            ))}
          </defs>
          {workflow.edges.map((e, i) => {
            const from = workflow.nodes.find(n => n.id === e.from);
            const to = workflow.nodes.find(n => n.id === e.to);
            if (!from || !to) return null;
            const sx = from.x + from.w;
            const sy = from.y + 56;
            const tx = to.x;
            const ty = to.y + 56;
            const isFB = e.kind === 'feedback';
            const isMem = e.kind === 'memory';
            const cx1 = sx + Math.abs(tx - sx) * 0.45;
            const cx2 = tx - Math.abs(tx - sx) * 0.45;
            const path = isFB
              ? `M ${sx} ${sy + 30} C ${sx + 120} ${sy + 200}, ${tx - 120} ${ty + 200}, ${tx} ${ty + 30}`
              : `M ${sx} ${sy} C ${cx1} ${sy}, ${cx2} ${ty}, ${tx} ${ty}`;
            const color = isFB ? OBS.red : isMem ? OBS.purple : OBS.accent;
            const live = !isFB && e.from !== 'cr' && e.from !== 'mem';
            return (
              <g key={i}>
                <path d={path} stroke={color} strokeOpacity={0.25} strokeWidth={2} fill="none"
                  strokeDasharray={isMem ? '5 4' : ''}/>
                {live && (
                  <circle r={3.5} fill={color}>
                    <animateMotion dur={`${2 + (i % 3) * 0.5}s`} repeatCount="indefinite"
                      path={path}/>
                  </circle>
                )}
                <polygon points={`${tx-7},${(isFB ? ty + 30 : ty) - 5} ${tx},${isFB ? ty + 30 : ty} ${tx-7},${(isFB ? ty + 30 : ty) + 5}`}
                  fill={color}/>
              </g>
            );
          })}
        </svg>

        {workflow.nodes.map(n => (
          <ObsNode key={n.id} node={n} selected={selected === n.id}
            onClick={() => setSelected(n.id)} t={t}/>
        ))}
      </div>
    </div>
  );
}

function ObsNode({ node, selected, onClick, t }) {
  const meta = ROLE_META[node.kind];
  const st = STATUS_COLORS[node.status] || STATUS_COLORS.idle;
  const pct = node.tokens.budget ? node.tokens.used / node.tokens.budget : 0;
  const m = node.model ? MODELS[node.model] : null;
  const active = node.status === 'running';

  // Gauge ring
  const R = 18, C = 2 * Math.PI * R;
  const dash = C * Math.min(pct, 1);
  const ringColor = pct > 0.8 ? OBS.red : pct > 0.5 ? OBS.amber : OBS.accent;

  return (
    <div onClick={onClick} style={{
      position: 'absolute', left: node.x, top: node.y, width: node.w,
      background: OBS.panel, borderRadius: 14,
      border: `1px solid ${selected ? OBS.accent : OBS.border}`,
      boxShadow: selected ? `0 0 0 3px ${OBS.accent}22, 0 14px 40px rgba(0,0,0,0.5)`
        : active ? `0 0 0 2px ${OBS.green}30, 0 8px 24px rgba(0,0,0,0.4)`
        : '0 6px 20px rgba(0,0,0,0.35)',
      cursor: 'pointer', overflow: 'hidden',
      transition: 'box-shadow 0.15s, border-color 0.15s',
    }}>
      {/* Header */}
      <div style={{ padding: '12px 14px 8px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ position: 'relative', width: 44, height: 44 }}>
          <svg width={44} height={44} style={{ position: 'absolute', inset: 0,
            transform: 'rotate(-90deg)' }}>
            <circle cx={22} cy={22} r={R} stroke={OBS.panel3} strokeWidth={3} fill="none"/>
            <circle cx={22} cy={22} r={R} stroke={ringColor} strokeWidth={3} fill="none"
              strokeDasharray={`${dash} ${C}`} strokeLinecap="round"
              style={{ transition: 'stroke-dasharray 0.3s' }}/>
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center', fontSize: 18,
            color: meta.tint }}>{meta.glyph}</div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: OBS.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {node.label}
          </div>
          <div style={{ fontSize: 10, color: OBS.muted, marginTop: 1, display: 'flex',
            alignItems: 'center', gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: st.dot,
              boxShadow: active ? `0 0 6px ${st.dot}` : 'none' }}/>
            <span style={{ color: st.dot }}>{st.label}</span>
            {m && <><span style={{ color: OBS.dim }}>·</span><span>{m.short}</span></>}
          </div>
        </div>
      </div>

      {/* Mini metrics row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
        borderTop: `1px solid ${OBS.border}`, background: 'rgba(0,0,0,0.2)' }}>
        <ObsMini label="tok" value={node.tokens.used > 1000 ? `${(node.tokens.used/1000).toFixed(1)}k` : node.tokens.used}/>
        <ObsMini label="tools" value={node.tools.length} divider/>
        <ObsMini label="hooks" value={node.hooks.length} divider tint={node.hooks.length ? OBS.amber : OBS.text}/>
      </div>

      {/* Sparkline pretending to be live */}
      {active && (
        <div style={{ height: 24, borderTop: `1px solid ${OBS.border}`,
          background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'flex-end',
          padding: '0 8px', gap: 2 }}>
          {Array.from({length: 28}).map((_, i) => {
            const h = 4 + Math.abs(Math.sin(i * 0.7 + t * 2)) * 14;
            return (
              <div key={i} style={{ flex: 1, height: h, background: OBS.green,
                opacity: 0.4 + Math.abs(Math.sin(i * 0.7 + t * 2)) * 0.6, borderRadius: 1 }}/>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ObsMini({ label, value, divider, tint }) {
  return (
    <div style={{ padding: '6px 10px', textAlign: 'center',
      borderLeft: divider ? `1px solid ${OBS.border}` : 'none' }}>
      <div style={{ fontSize: 9, color: OBS.muted, textTransform: 'uppercase',
        letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: tint || OBS.text,
        fontFamily: mono2, marginTop: 1 }}>{value}</div>
    </div>
  );
}

function ObsDetail({ node }) {
  const meta = ROLE_META[node.kind];
  const m = node.model ? MODELS[node.model] : null;
  const pct = node.tokens.budget ? node.tokens.used / node.tokens.budget : 0;

  return (
    <>
      <div style={{ padding: '16px 18px', borderBottom: `1px solid ${OBS.border}` }}>
        <div style={{ fontSize: 10, color: OBS.muted, textTransform: 'uppercase',
          letterSpacing: '0.08em' }}>Inspecting</div>
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 36, height: 36, borderRadius: 9, background: meta.tintBg,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, color: meta.tint }}>{meta.glyph}</span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{node.label}</div>
            <div style={{ fontSize: 11, color: OBS.muted }}>{meta.label} · {node.id}</div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {/* Context window viz */}
        <ObsSec label="Context window">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 8 }}>
            <span style={{ fontSize: 26, fontWeight: 700, fontFamily: mono2,
              color: pct > 0.8 ? OBS.red : OBS.text }}>
              {(node.tokens.used/1000).toFixed(1)}k
            </span>
            <span style={{ fontSize: 12, color: OBS.muted }}>
              / {(node.tokens.budget/1000)}k tokens
            </span>
            <div style={{ flex: 1 }}/>
            <span style={{ fontSize: 11, color: pct > 0.8 ? OBS.red : OBS.muted,
              fontWeight: 600 }}>{(pct*100).toFixed(0)}%</span>
          </div>
          <div style={{ height: 22, background: OBS.panel3, borderRadius: 6,
            display: 'flex', overflow: 'hidden' }}>
            <div style={{ flex: '1240', background: OBS.purple, borderRight: `1px solid ${OBS.bg}` }} title="system 1.2k"/>
            <div style={{ flex: '2180', background: OBS.accent, borderRight: `1px solid ${OBS.bg}` }} title="tool defs 2.2k"/>
            <div style={{ flex: `${Math.max(node.tokens.used - 3420, 100)}`, background: OBS.green }} title="conversation"/>
            <div style={{ flex: `${Math.max(node.tokens.budget - node.tokens.used, 100)}`, background: 'transparent' }}/>
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 10, color: OBS.muted }}>
            <Legend c={OBS.purple} t="system"/>
            <Legend c={OBS.accent} t="tools"/>
            <Legend c={OBS.green} t="convo"/>
          </div>
        </ObsSec>

        <ObsSec label="System prompt">
          <div style={{ background: OBS.bg, border: `1px solid ${OBS.border}`,
            borderRadius: 8, padding: 12, fontSize: 12, lineHeight: 1.5,
            maxHeight: 100, overflow: 'auto', fontFamily: mono2, color: OBS.text }}>
            {node.prompt}
          </div>
        </ObsSec>

        {m && (
          <ObsSec label="Model">
            <div style={{ background: OBS.bg, border: `1px solid ${OBS.border}`,
              borderRadius: 8, padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>{m.short}</span>
                <span style={{ fontSize: 10, color: OBS.muted, fontFamily: mono2 }}>
                  ${m.costIn}/${m.costOut} per Mtok
                </span>
              </div>
              <div style={{ fontSize: 10, color: OBS.muted, fontFamily: mono2 }}>
                ctx {(m.ctx/1000)|0}k · {node.model}
              </div>
            </div>
          </ObsSec>
        )}

        <ObsSec label={`Tools · ${node.tools.length}`}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {node.tools.map(t => (
              <span key={t} style={{ padding: '3px 8px', background: OBS.panel3,
                border: `1px solid ${OBS.border}`, borderRadius: 999, fontSize: 10,
                color: OBS.text, fontFamily: mono2 }}>{t}</span>
            ))}
          </div>
        </ObsSec>

        {node.hooks.length > 0 && (
          <ObsSec label={`Hooks · ${node.hooks.length}`}>
            {node.hooks.map(h => (
              <div key={h} style={{ display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px', background: OBS.bg, border: `1px solid ${OBS.border}`,
                borderLeft: `3px solid ${OBS.amber}`, borderRadius: 6, marginBottom: 4 }}>
                <span style={{ color: OBS.amber, fontFamily: mono2, fontSize: 11 }}>✕</span>
                <span style={{ fontSize: 11, fontFamily: mono2 }}>{h}</span>
                <div style={{ flex: 1 }}/>
                <span style={{ fontSize: 9, color: OBS.muted }}>pre-tool</span>
              </div>
            ))}
          </ObsSec>
        )}
      </div>
    </>
  );
}

function ObsSec({ label, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 10, color: OBS.muted, textTransform: 'uppercase',
        letterSpacing: '0.08em', marginBottom: 8, fontWeight: 600 }}>{label}</div>
      {children}
    </div>
  );
}

function Legend({ c, t }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
    <span style={{ width: 8, height: 8, borderRadius: 2, background: c }}/>{t}
  </span>;
}

function ObsTimeline({ t, setT, playing, setPlaying, workflow }) {
  const TOTAL = 12;
  // events scattered on timeline derived from AUDIT_ENTRIES
  return (
    <div style={{ gridArea: 'bottom', background: OBS.panel, borderTop: `1px solid ${OBS.border}`,
      display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 16px',
        borderBottom: `1px solid ${OBS.border}`, gap: 12 }}>
        <button onClick={() => setPlaying(p => !p)} style={{
          width: 28, height: 28, borderRadius: 6, border: `1px solid ${OBS.border}`,
          background: playing ? OBS.accent : OBS.panel3, color: playing ? OBS.bg : OBS.text,
          cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center',
          justifyContent: 'center' }}>{playing ? '❚❚' : '▶'}</button>
        <div style={{ fontSize: 11, color: OBS.muted }}>
          Trajectory replay · <span style={{ color: OBS.text, fontFamily: mono2 }}>
            {t.toFixed(1)}s / {TOTAL.toFixed(1)}s
          </span>
        </div>
        <div style={{ flex: 1 }}/>
        <button style={{ height: 24, padding: '0 10px', borderRadius: 6,
          border: `1px solid ${OBS.border}`, background: 'transparent',
          color: OBS.muted, cursor: 'pointer', fontSize: 11 }}>
          Open trace ↗
        </button>
        <button style={{ height: 24, padding: '0 10px', borderRadius: 6,
          border: `1px solid ${OBS.border}`, background: 'transparent',
          color: OBS.muted, cursor: 'pointer', fontSize: 11 }}>
          Export JSONL
        </button>
      </div>

      {/* swimlane track */}
      <div style={{ flex: 1, position: 'relative', padding: '6px 16px', overflow: 'auto' }}>
        <div style={{ position: 'relative', minWidth: '100%' }}>
          {workflow.nodes.slice(0, 6).map((n, ri) => {
            const meta = ROLE_META[n.kind];
            // pseudo-random span based on index
            const start = (ri * 0.6) % TOTAL;
            const dur = 2 + (ri % 3);
            return (
              <div key={n.id} style={{ display: 'flex', alignItems: 'center',
                height: 22, gap: 8, marginBottom: 2 }}>
                <div style={{ width: 110, display: 'flex', alignItems: 'center',
                  gap: 6, fontSize: 10, color: OBS.muted, flexShrink: 0 }}>
                  <span style={{ color: meta.tint }}>{meta.glyph}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {n.label}
                  </span>
                </div>
                <div style={{ flex: 1, height: 14, background: OBS.bg,
                  borderRadius: 3, position: 'relative', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute',
                    left: `${(start/TOTAL)*100}%`,
                    width: `${(dur/TOTAL)*100}%`,
                    height: '100%', background: meta.tint, opacity: 0.7,
                    borderRadius: 3 }}/>
                  {/* tool call ticks */}
                  {Array.from({length: 3}).map((_, i) => (
                    <div key={i} style={{ position: 'absolute',
                      left: `${((start + i * dur / 3)/TOTAL)*100}%`,
                      top: 0, bottom: 0, width: 2, background: '#fff', opacity: 0.6 }}/>
                  ))}
                </div>
              </div>
            );
          })}
          {/* scrubber */}
          <div style={{ position: 'absolute', left: `calc(118px + ${(t/TOTAL)*100}% - ${(t/TOTAL)*118}px)`,
            top: 0, bottom: 0, width: 2, background: OBS.accent,
            boxShadow: `0 0 8px ${OBS.accent}` }}>
            <div style={{ position: 'absolute', top: -4, left: -4, width: 10, height: 10,
              borderRadius: '50%', background: OBS.accent }}/>
          </div>
        </div>
      </div>

      <input type="range" min="0" max={TOTAL} step="0.05" value={t}
        onChange={e => setT(parseFloat(e.target.value))}
        style={{ width: '100%', height: 4, accentColor: OBS.accent, marginTop: 0 }}/>
    </div>
  );
}

window.ObservatoryApp = ObservatoryApp;
window.OBS = OBS;
