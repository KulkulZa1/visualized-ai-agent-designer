// forge.jsx — Variation 2: "Forge"
// Terminal/brutalist. Mono everywhere, ASCII chrome, sharp edges, high contrast.

const FORGE = {
  bg: '#0a0a0a', surface: '#111111', surface2: '#181818', surface3: '#222222',
  border: '#2a2a2a', borderH: '#444', text: '#e8e8e8', muted: '#7a7a7a', dim: '#4a4a4a',
  accent: '#c8ff3e', warn: '#ffb84a', err: '#ff5e5e', ok: '#7affb7', blue: '#7ab8ff',
};

const mono = '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';

function ForgeApp({ workflow }) {
  const [selected, setSelected] = React.useState(workflow.nodes[0]?.id);
  const [tab, setTab] = React.useState('prompt');
  const [positions, setPositions] = React.useState(() =>
    Object.fromEntries(workflow.nodes.map(n => [n.id, { x: n.x, y: n.y }])));
  const [dragId, setDragId] = React.useState(null);

  React.useEffect(() => {
    setPositions(Object.fromEntries(workflow.nodes.map(n => [n.id, { x: n.x, y: n.y }])));
    setSelected(workflow.nodes[0]?.id);
  }, [workflow.id]);

  const onDown = (e, id) => {
    e.stopPropagation(); setSelected(id);
    const sx = e.clientX, sy = e.clientY, start = positions[id];
    const mv = ev => { setPositions(p => ({ ...p, [id]: { x: start.x + ev.clientX - sx, y: start.y + ev.clientY - sy }})); setDragId(id); };
    const up = () => { setDragId(null); window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  const sel = workflow.nodes.find(n => n.id === selected);

  return (
    <div data-screen-label="02 Forge" style={{
      width: '100%', height: '100%', background: FORGE.bg, color: FORGE.text,
      fontFamily: mono, fontSize: 12, display: 'grid', overflow: 'hidden',
      gridTemplateRows: '28px 1fr 200px',
      gridTemplateColumns: '240px 1fr 340px',
      gridTemplateAreas: `"top top top" "left center right" "bottom bottom bottom"`,
    }}>
      {/* Top bar */}
      <div style={{ gridArea: 'top', display: 'flex', alignItems: 'center', gap: 0,
        background: FORGE.surface, borderBottom: `1px solid ${FORGE.border}`, padding: '0 0 0 10px' }}>
        <span style={{ color: FORGE.accent, fontWeight: 700 }}>FORGE</span>
        <span style={{ color: FORGE.dim, margin: '0 8px' }}>::</span>
        <span style={{ color: FORGE.muted }}>research-agent</span>
        <span style={{ color: FORGE.dim, margin: '0 6px' }}>/</span>
        <span>{workflow.name}</span>
        <span style={{ color: FORGE.warn, marginLeft: 6 }}>[modified]</span>
        <div style={{ flex: 1 }}/>
        {['validate','save','run'].map((b,i) => (
          <button key={b} style={{ height: 28, padding: '0 14px', border: 'none',
            borderLeft: `1px solid ${FORGE.border}`,
            background: i === 2 ? FORGE.accent : 'transparent',
            color: i === 2 ? '#0a0a0a' : FORGE.text, cursor: 'pointer',
            fontFamily: mono, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em',
            fontWeight: i === 2 ? 700 : 500 }}>
            {i === 2 ? '▶ run' : `[${b[0]}] ${b}`}
          </button>
        ))}
      </div>

      {/* Left: file tree */}
      <div style={{ gridArea: 'left', background: FORGE.surface, borderRight: `1px solid ${FORGE.border}`,
        overflow: 'auto' }}>
        <div style={{ padding: '8px 10px', borderBottom: `1px solid ${FORGE.border}`,
          color: FORGE.muted, fontSize: 10, letterSpacing: '0.1em' }}>
          ── WORKSPACE ──────
        </div>
        <div style={{ padding: '6px 0', fontSize: 11 }}>
          {flattenTree(WORKSPACE_FILES).map((f, i) => (
            <div key={i} style={{
              padding: `1px ${10 + f.depth * 12}px`,
              color: f.active ? FORGE.accent : f.type === 'dir' ? FORGE.text : f.muted ? FORGE.dim : FORGE.muted,
              background: f.active ? 'rgba(200,255,62,0.08)' : 'transparent',
              borderLeft: f.active ? `2px solid ${FORGE.accent}` : '2px solid transparent',
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}>
              <span style={{ color: FORGE.dim, marginRight: 4 }}>
                {f.type === 'dir' ? '▸' : '·'}
              </span>
              {f.name}
            </div>
          ))}
        </div>
        <div style={{ padding: '10px', borderTop: `1px solid ${FORGE.border}`,
          color: FORGE.muted, fontSize: 10 }}>
          <div style={{ marginBottom: 4 }}><span style={{ color: FORGE.dim }}>git</span> main · clean</div>
          <div><span style={{ color: FORGE.dim }}>env</span> .env.local · 3 keys</div>
        </div>
      </div>

      {/* Center: canvas */}
      <ForgeCanvas workflow={workflow} positions={positions}
        selected={selected} onSelect={setSelected} onDown={onDown} dragId={dragId} />

      {/* Right: inspector */}
      <div style={{ gridArea: 'right', background: FORGE.surface, borderLeft: `1px solid ${FORGE.border}`,
        display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {sel && <ForgeInspector node={sel} tab={tab} setTab={setTab} />}
      </div>

      {/* Bottom: trajectory tail */}
      <ForgeTrace />
    </div>
  );
}

function flattenTree(items, depth = 0) {
  const out = [];
  items.forEach(it => {
    out.push({ ...it, depth });
    if (it.children) out.push(...flattenTree(it.children, depth + 1));
  });
  return out;
}

function ForgeCanvas({ workflow, positions, selected, onSelect, onDown, dragId }) {
  const xs = workflow.nodes.map(n => positions[n.id].x);
  const ys = workflow.nodes.map(n => positions[n.id].y);
  const minX = Math.min(...xs) - 40, minY = Math.min(...ys) - 40;
  const maxX = Math.max(...xs.map((x, i) => x + workflow.nodes[i].w)) + 60;
  const maxY = Math.max(...ys) + 220;

  return (
    <div style={{ gridArea: 'center', position: 'relative', overflow: 'auto',
      background: `repeating-linear-gradient(0deg, transparent 0, transparent 23px, rgba(255,255,255,0.025) 23px, rgba(255,255,255,0.025) 24px),
                   repeating-linear-gradient(90deg, transparent 0, transparent 23px, rgba(255,255,255,0.025) 23px, rgba(255,255,255,0.025) 24px)
                   ${FORGE.bg}` }}>
      <div style={{ position: 'relative', width: maxX - minX + 80, height: maxY - minY + 80,
        transform: `translate(${-minX + 40}px, ${-minY + 40}px)` }}>
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}>
          {workflow.edges.map((e, i) => {
            const from = workflow.nodes.find(n => n.id === e.from);
            const to = workflow.nodes.find(n => n.id === e.to);
            if (!from || !to) return null;
            const sx = positions[from.id].x + from.w;
            const sy = positions[from.id].y + 28;
            const tx = positions[to.id].x;
            const ty = positions[to.id].y + 28;
            // orthogonal routing
            const midX = (sx + tx) / 2;
            const isFB = e.kind === 'feedback';
            const offY = isFB ? Math.max(positions[from.id].y, positions[to.id].y) + 180 : null;
            const path = isFB
              ? `M ${sx} ${sy + 56} L ${sx + 30} ${sy + 56} L ${sx + 30} ${offY} L ${tx - 30} ${offY} L ${tx - 30} ${ty + 56} L ${tx} ${ty + 56}`
              : `M ${sx} ${sy} L ${midX} ${sy} L ${midX} ${ty} L ${tx} ${ty}`;
            const color = isFB ? FORGE.err : e.kind === 'memory' ? '#b88bd9' : e.kind === 'control' ? FORGE.muted : FORGE.borderH;
            return (
              <g key={i}>
                <path d={path} stroke={color} strokeWidth={1.5} fill="none"
                  strokeDasharray={e.kind === 'memory' || e.kind === 'control' ? '4 3' : ''}/>
                <polygon points={`${tx-6},${(isFB ? ty + 56 : ty) - 4} ${tx},${isFB ? ty + 56 : ty} ${tx-6},${(isFB ? ty + 56 : ty) + 4}`}
                  fill={color}/>
                {e.label && (
                  <g transform={`translate(${midX}, ${(sy + ty) / 2})`}>
                    <rect x={-(e.label.length*3.2)} y={-7} width={e.label.length*6.4} height={14}
                      fill={FORGE.bg} stroke={FORGE.border}/>
                    <text textAnchor="middle" y={3} fontSize={9} fill={FORGE.muted}
                      style={{ fontFamily: mono }}>{e.label}</text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>

        {workflow.nodes.map(n => (
          <ForgeNode key={n.id} node={n} pos={positions[n.id]}
            selected={selected === n.id} dragging={dragId === n.id}
            onPointerDown={(e) => onDown(e, n.id)} />
        ))}
      </div>

      {/* legend */}
      <div style={{ position: 'absolute', top: 10, right: 10, background: FORGE.surface,
        border: `1px solid ${FORGE.border}`, padding: '6px 10px', fontSize: 10,
        color: FORGE.muted, lineHeight: 1.6 }}>
        <div style={{ color: FORGE.text, letterSpacing: '0.1em', marginBottom: 2 }}>LEGEND</div>
        <div><span style={{ color: FORGE.borderH }}>──▶</span> data</div>
        <div><span style={{ color: '#b88bd9' }}>┄┄▶</span> memory</div>
        <div><span style={{ color: FORGE.err }}>──▶</span> feedback</div>
      </div>
    </div>
  );
}

function ForgeNode({ node, pos, selected, dragging, onPointerDown }) {
  const meta = ROLE_META[node.kind];
  const st = STATUS_COLORS[node.status] || STATUS_COLORS.idle;
  const pct = node.tokens.budget ? node.tokens.used / node.tokens.budget : 0;
  const barWidth = 22;
  const filled = Math.round(pct * barWidth);
  const barChar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  const m = node.model ? MODELS[node.model] : null;

  return (
    <div onPointerDown={onPointerDown}
      style={{ position: 'absolute', left: pos.x, top: pos.y, width: node.w,
        background: FORGE.surface2,
        border: `1px solid ${selected ? FORGE.accent : FORGE.border}`,
        outline: selected ? `1px solid ${FORGE.accent}` : 'none',
        outlineOffset: 2,
        cursor: dragging ? 'grabbing' : 'grab', userSelect: 'none',
        boxShadow: selected ? `0 0 0 1px ${FORGE.accent}` : 'none',
      }}>
      <div style={{ padding: '5px 8px', borderBottom: `1px solid ${FORGE.border}`,
        background: selected ? 'rgba(200,255,62,0.06)' : FORGE.surface,
        display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: meta.tint, fontSize: 13 }}>{meta.glyph}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: FORGE.text, flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.label.toLowerCase().replace(/\s+/g, '_')}
        </span>
        <span style={{ fontSize: 9, color: st.dot, textTransform: 'uppercase' }}>
          [{st.label}]
        </span>
      </div>
      <div style={{ padding: '6px 8px', fontSize: 10, color: FORGE.muted, lineHeight: 1.4 }}>
        <div style={{ color: FORGE.dim }}>// {meta.label.toLowerCase()}</div>
        <div style={{ height: 30, overflow: 'hidden',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          color: FORGE.muted }}>
          {node.prompt}
        </div>
      </div>
      <div style={{ padding: '4px 8px 4px', display: 'grid',
        gridTemplateColumns: 'auto 1fr', columnGap: 6, fontSize: 9, lineHeight: 1.6,
        color: FORGE.muted, borderTop: `1px solid ${FORGE.border}` }}>
        <span style={{ color: FORGE.dim }}>model</span>
        <span style={{ color: m ? FORGE.text : FORGE.dim }}>{m ? m.short : '—'}</span>
        <span style={{ color: FORGE.dim }}>tools</span>
        <span style={{ color: FORGE.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          [{node.tools.length}] {node.tools.slice(0,2).join(' ')}{node.tools.length > 2 ? ' …' : ''}
        </span>
        {node.hooks.length > 0 && <>
          <span style={{ color: FORGE.dim }}>hooks</span>
          <span style={{ color: '#d97757' }}>{node.hooks.join(' ')}</span>
        </>}
        {node.tokens.budget > 0 && <>
          <span style={{ color: FORGE.dim }}>ctx</span>
          <span style={{ color: pct > 0.8 ? FORGE.err : pct > 0.5 ? FORGE.warn : FORGE.ok,
            letterSpacing: '-1px' }}>
            {barChar} {(pct*100).toFixed(0)}%
          </span>
        </>}
      </div>
    </div>
  );
}

function ForgeInspector({ node, tab, setTab }) {
  const meta = ROLE_META[node.kind];
  const tabs = ['role', 'prompt', 'tools', 'hooks', 'memory'];

  return (
    <>
      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${FORGE.border}` }}>
        <div style={{ color: FORGE.dim, fontSize: 10, letterSpacing: '0.1em' }}>── INSPECTOR ──────</div>
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ color: meta.tint, fontSize: 16 }}>{meta.glyph}</span>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{node.label}</span>
        </div>
        <div style={{ fontSize: 10, color: FORGE.muted, marginTop: 2 }}>
          {meta.label.toLowerCase()} · id={node.id}
        </div>
      </div>
      <div style={{ display: 'flex', borderBottom: `1px solid ${FORGE.border}` }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: '6px 0', border: 'none',
            background: tab === t ? FORGE.bg : 'transparent',
            color: tab === t ? FORGE.accent : FORGE.muted,
            borderBottom: tab === t ? `2px solid ${FORGE.accent}` : '2px solid transparent',
            fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em',
            cursor: 'pointer',
          }}>{t}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12, fontSize: 11 }}>
        {tab === 'role' && <ForgeRoleTab node={node}/>}
        {tab === 'prompt' && <ForgePromptTab node={node}/>}
        {tab === 'tools' && <ForgeToolsTab node={node}/>}
        {tab === 'hooks' && <ForgeHooksTab node={node}/>}
        {tab === 'memory' && <ForgeMemoryTab node={node}/>}
      </div>
    </>
  );
}

const fInput = { width: '100%', boxSizing: 'border-box', background: FORGE.bg,
  border: `1px solid ${FORGE.border}`, color: FORGE.text, padding: '5px 8px',
  fontFamily: mono, fontSize: 11, outline: 'none' };

function FSec({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ color: FORGE.muted, fontSize: 9, letterSpacing: '0.1em',
        textTransform: 'uppercase', marginBottom: 6 }}>
        ▸ {label}
      </div>
      {children}
    </div>
  );
}

function ForgeRoleTab({ node }) {
  const m = node.model ? MODELS[node.model] : null;
  return (
    <div>
      <FSec label="identity">
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 8px', fontSize: 11 }}>
          <span style={{ color: FORGE.dim }}>label</span><span>{node.label}</span>
          <span style={{ color: FORGE.dim }}>kind</span><span style={{ color: ROLE_META[node.kind].tint }}>{node.kind}</span>
          <span style={{ color: FORGE.dim }}>id</span><span>{node.id}</span>
        </div>
      </FSec>
      <FSec label="model">
        <select style={fInput} defaultValue={node.model || ''}>
          {Object.entries(MODELS).map(([k,v]) => <option key={k} value={k}>{v.short}</option>)}
        </select>
        {m && (
          <div style={{ marginTop: 6, padding: 8, background: FORGE.bg, border: `1px solid ${FORGE.border}`,
            display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', fontSize: 10, color: FORGE.muted }}>
            <span>ctx</span><span style={{ textAlign: 'right', color: FORGE.text }}>{(m.ctx/1000)|0}k tok</span>
            <span>cost.in</span><span style={{ textAlign: 'right', color: FORGE.text }}>${m.costIn}/Mtok</span>
            <span>cost.out</span><span style={{ textAlign: 'right', color: FORGE.text }}>${m.costOut}/Mtok</span>
          </div>
        )}
      </FSec>
      <FSec label="limits">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 6 }}>
          <span style={{ color: FORGE.muted, alignSelf: 'center', fontSize: 10 }}>token_budget</span>
          <input defaultValue={node.tokens.budget} style={fInput}/>
          <span style={{ color: FORGE.muted, alignSelf: 'center', fontSize: 10 }}>max_steps</span>
          <input defaultValue={20} style={fInput}/>
          <span style={{ color: FORGE.muted, alignSelf: 'center', fontSize: 10 }}>timeout_ms</span>
          <input defaultValue={30000} style={fInput}/>
        </div>
      </FSec>
    </div>
  );
}

function ForgePromptTab({ node }) {
  return (
    <div>
      <FSec label={`system_prompt · ${node.prompt.length}ch · ~${Math.ceil(node.prompt.length/4)}tok`}>
        <div style={{ background: FORGE.bg, border: `1px solid ${FORGE.border}`,
          padding: 10, fontFamily: mono, fontSize: 11, lineHeight: 1.55,
          maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
          {node.prompt}
        </div>
      </FSec>
      <FSec label="prediction · per AHE">
        <div style={{ fontSize: 10, color: FORGE.muted, lineHeight: 1.5 }}>
          <div><span style={{ color: FORGE.dim }}>pred:</span> reduces hallucination rate by ~15% vs v3</div>
          <div><span style={{ color: FORGE.dim }}>verify:</span> next eval round</div>
          <div><span style={{ color: FORGE.warn }}>UNVERIFIED</span></div>
        </div>
      </FSec>
      <FSec label="history">
        <div style={{ fontSize: 10, color: FORGE.muted }}>
          <div><span style={{ color: FORGE.dim }}>v4 (HEAD)</span> 2026-05-11 · +2 lines</div>
          <div><span style={{ color: FORGE.dim }}>v3</span> 2026-05-09 · rewrite</div>
          <div><span style={{ color: FORGE.dim }}>v2</span> 2026-05-07</div>
        </div>
      </FSec>
    </div>
  );
}

function ForgeToolsTab({ node }) {
  const ALL = ['web_search','web_fetch','grep','read_file','list_files','fs.write','fs.append',
    'fs.read','bash','classify','vector_search','cite','puppeteer','git','todo_write','subagent_dispatch'];
  return (
    <FSec label={`permitted · ${node.tools.length}/${ALL.length}`}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
        {ALL.map(t => {
          const on = node.tools.includes(t);
          return (
            <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 5,
              padding: '3px 0', fontSize: 10, color: on ? FORGE.text : FORGE.dim, cursor: 'pointer' }}>
              <span style={{ color: on ? FORGE.accent : FORGE.dim, fontWeight: 700 }}>
                [{on ? 'x' : ' '}]
              </span>
              {t}
            </label>
          );
        })}
      </div>
    </FSec>
  );
}

function ForgeHooksTab({ node }) {
  return (
    <div>
      <FSec label={`hooks · ${node.hooks.length}`}>
        {node.hooks.length === 0 ? (
          <div style={{ color: FORGE.dim, fontSize: 10, padding: '10px 0' }}>
            no hooks attached. tool calls run with default permissions.
          </div>
        ) : node.hooks.map((h, i) => (
          <div key={i} style={{ padding: 8, background: FORGE.bg,
            border: `1px solid ${FORGE.border}`, marginBottom: 6, fontSize: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: '#d97757' }}>✕</span>
              <span style={{ color: FORGE.text, fontWeight: 600 }}>{h}</span>
              <div style={{ flex: 1 }}/>
              <span style={{ color: FORGE.ok }}>[pre-tool]</span>
            </div>
            <div style={{ color: FORGE.dim, marginTop: 3 }}>
              .harness/hooks/{h}{h.includes('_') ? '.py' : '.sh'}
            </div>
            <div style={{ color: FORGE.muted, marginTop: 3 }}>
              fires 12× last 24h · 1 blocked
            </div>
          </div>
        ))}
        <button style={{ width: '100%', padding: 6, background: 'transparent',
          border: `1px dashed ${FORGE.border}`, color: FORGE.muted, fontFamily: mono,
          fontSize: 10, cursor: 'pointer' }}>+ attach hook</button>
      </FSec>
      <FSec label="consent">
        <div style={{ fontSize: 10, color: FORGE.muted, lineHeight: 1.6 }}>
          <div>[<span style={{ color: FORGE.accent }}>x</span>] require approval per run</div>
          <div>[<span style={{ color: FORGE.dim }}> </span>] auto-approve known-safe</div>
          <div>[<span style={{ color: FORGE.accent }}>x</span>] block on un-allowlisted url</div>
        </div>
      </FSec>
    </div>
  );
}

function ForgeMemoryTab({ node }) {
  const pct = node.tokens.budget ? node.tokens.used / node.tokens.budget : 0;
  return (
    <div>
      <FSec label="context window">
        <div style={{ fontSize: 24, fontWeight: 700, color: pct > 0.8 ? FORGE.err : FORGE.text }}>
          {(node.tokens.used / 1000).toFixed(1)}k
          <span style={{ fontSize: 12, color: FORGE.muted, fontWeight: 400 }}>
            {' / '}{(node.tokens.budget / 1000)}k
          </span>
        </div>
        <div style={{ marginTop: 6, fontFamily: mono, fontSize: 10, color: FORGE.muted,
          letterSpacing: '-1px' }}>
          {'█'.repeat(Math.round(pct * 32))}
          <span style={{ color: FORGE.dim }}>{'░'.repeat(32 - Math.round(pct * 32))}</span>
          {' '}{(pct * 100).toFixed(0)}%
        </div>
        <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr auto',
          gap: '2px 8px', fontSize: 10, color: FORGE.muted }}>
          <span>system</span><span style={{ color: FORGE.text }}>1,240</span>
          <span>tool_defs</span><span style={{ color: FORGE.text }}>2,180</span>
          <span>conversation</span><span style={{ color: FORGE.text }}>{(node.tokens.used - 3420).toLocaleString()}</span>
          <span style={{ color: FORGE.warn }}>compact_at</span><span style={{ color: FORGE.warn }}>0.80</span>
        </div>
      </FSec>
      <FSec label="long_term_memory">
        <select style={fInput} defaultValue="append-jsonl">
          <option>append-jsonl</option><option>vector_store</option>
          <option>rolling_summary</option><option>none</option>
        </select>
        <input style={{ ...fInput, marginTop: 6 }} defaultValue=".harness/memory/web-searcher.jsonl"/>
      </FSec>
    </div>
  );
}

function ForgeTrace() {
  return (
    <div style={{ gridArea: 'bottom', background: FORGE.surface, borderTop: `1px solid ${FORGE.border}`,
      display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px 10px',
        borderBottom: `1px solid ${FORGE.border}`, fontSize: 10 }}>
        <span style={{ color: FORGE.dim, letterSpacing: '0.1em' }}>── TRAJECTORY ──────</span>
        <div style={{ flex: 1 }}/>
        <span style={{ color: FORGE.muted }}>
          ★ <span style={{ color: FORGE.text }}>36.4k</span> tok
          {'  '}$ <span style={{ color: FORGE.text }}>0.74</span>
          {'  '}t <span style={{ color: FORGE.text }}>8.2s</span>
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 0', fontSize: 10, fontFamily: mono }}>
        {AUDIT_ENTRIES.map((e, i) => {
          const c = { run: FORGE.accent, tool: FORGE.ok, fanout: '#b88bd9', consent: '#d97757',
            done: FORGE.blue, warn: FORGE.warn, error: FORGE.err, edge: FORGE.muted, tokens: FORGE.dim };
          return (
            <div key={i} style={{ display: 'flex', gap: 8, padding: '1px 12px', lineHeight: 1.4 }}>
              <span style={{ color: FORGE.dim, minWidth: 88 }}>{e.t}</span>
              <span style={{ color: c[e.kind] || FORGE.muted, minWidth: 52, textTransform: 'uppercase' }}>
                {e.kind}
              </span>
              <span style={{ color: FORGE.muted, minWidth: 120 }}>{e.node}</span>
              <span style={{ color: FORGE.text }}>{e.msg}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

window.ForgeApp = ForgeApp;
