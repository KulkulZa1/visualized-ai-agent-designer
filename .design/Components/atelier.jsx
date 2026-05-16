// atelier.jsx — Variation 1: "Atelier"
// Refined dark, Linear/Zed-inspired. Tight type, restrained color, amber accent.
// Layout: top toolbar / left file tree / center canvas / right config / bottom audit.

const ATELIER = {
  bg: '#0e0f13',
  surface: '#15171c',
  surface2: '#1c1f26',
  surface3: '#23262f',
  border: 'rgba(255,255,255,0.06)',
  borderStrong: 'rgba(255,255,255,0.12)',
  text: '#e6e7eb',
  textMuted: '#9097a3',
  textHint: '#5d6473',
  accent: '#e5a142',
  accentSoft: 'rgba(229,161,66,0.12)',
};

function AtelierApp({ workflow, density = 'regular' }) {
  const [selected, setSelected] = React.useState('w1');
  const [tab, setTab] = React.useState('prompt');
  const [dragNode, setDragNode] = React.useState(null);
  const [positions, setPositions] = React.useState(() =>
    Object.fromEntries(workflow.nodes.map(n => [n.id, { x: n.x, y: n.y }])));
  const [auditOpen, setAuditOpen] = React.useState(true);

  // re-sync on workflow change
  React.useEffect(() => {
    setPositions(Object.fromEntries(workflow.nodes.map(n => [n.id, { x: n.x, y: n.y }])));
    setSelected(workflow.nodes[0]?.id);
  }, [workflow.id]);

  const nodeById = Object.fromEntries(workflow.nodes.map(n => [n.id, n]));
  const selectedNode = nodeById[selected];

  // drag handler
  const onPointerDown = (e, id) => {
    e.stopPropagation();
    setSelected(id);
    const sx = e.clientX, sy = e.clientY;
    const start = positions[id];
    const onMove = (ev) => {
      setPositions(p => ({ ...p, [id]: { x: start.x + (ev.clientX - sx), y: start.y + (ev.clientY - sy) } }));
      setDragNode(id);
    };
    const onUp = () => {
      setDragNode(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // styles
  const T = ATELIER;
  const fontStack = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  const monoStack = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace';

  return (
    <div data-screen-label="01 Atelier" style={{
      width: '100%', height: '100%', display: 'grid',
      gridTemplateRows: '40px 1fr ' + (auditOpen ? '180px' : '28px'),
      gridTemplateColumns: '224px 1fr 320px',
      gridTemplateAreas: `"top top top" "left center right" "bottom bottom bottom"`,
      background: T.bg, color: T.text, fontFamily: fontStack, fontSize: 13,
      overflow: 'hidden',
    }}>
      <AtelierTopBar workflow={workflow} />
      <AtelierFileTree />
      <AtelierCanvas
        workflow={workflow} positions={positions} selected={selected}
        onSelect={setSelected} onDrag={onPointerDown} dragNode={dragNode} />
      <AtelierConfigPanel node={selectedNode} tab={tab} setTab={setTab} />
      <AtelierAudit open={auditOpen} setOpen={setAuditOpen} />
    </div>
  );
}

function AtelierTopBar({ workflow }) {
  const T = ATELIER;
  const Btn = ({ children, primary, onClick }) => (
    <button onClick={onClick} style={{
      height: 26, padding: '0 12px', border: 'none',
      background: primary ? T.accent : 'transparent',
      color: primary ? '#1a1207' : T.text, borderRadius: 5,
      fontSize: 12, fontWeight: primary ? 600 : 500, cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', gap: 6,
    }}>{children}</button>
  );
  return (
    <div style={{
      gridArea: 'top', display: 'flex', alignItems: 'center',
      padding: '0 12px', gap: 12, background: T.surface,
      borderBottom: `1px solid ${T.border}`,
    }}>
      <div style={{ width: 14, height: 14, borderRadius: 4, background: T.accent,
        display: 'grid', placeItems: 'center', color: '#1a1207', fontSize: 9, fontWeight: 700 }}>H</div>
      <span style={{ color: T.textMuted, fontSize: 12 }}>harness-studio</span>
      <span style={{ color: T.textHint }}>/</span>
      <span style={{ fontSize: 12 }}>research-agent</span>
      <span style={{ color: T.textHint }}>/</span>
      <span style={{ fontSize: 12, color: T.text, fontWeight: 500 }}>{workflow.name}</span>
      <span style={{ color: T.accent, fontSize: 10, marginLeft: 4 }}>● unsaved</span>

      <div style={{ flex: 1 }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: T.textMuted, fontSize: 11 }}>
        <Icon name="undo" size={13} />
        <Icon name="redo" size={13} />
        <div style={{ width: 1, height: 14, background: T.border, margin: '0 4px' }} />
        <span><b style={{ color: T.text }}>8</b> nodes</span>
        <span><b style={{ color: T.text }}>12</b> edges</span>
        <span style={{ color: '#5fbf7f' }}>● valid</span>
        <div style={{ width: 1, height: 14, background: T.border, margin: '0 4px' }} />
      </div>

      <Btn><Icon name="check" size={12} /> Validate</Btn>
      <Btn><Icon name="save" size={12} /> Save</Btn>
      <Btn primary><Icon name="play" size={12} /> Run</Btn>
    </div>
  );
}

function AtelierFileTree() {
  const T = ATELIER;
  const [expanded, setExpanded] = React.useState({ '.harness': true, 'hooks': false, 'prompts': false, 'trajectories': true, 'src': false });

  const renderEntry = (entry, depth = 0) => {
    if (entry.type === 'dir') {
      const open = expanded[entry.name];
      return (
        <div key={entry.name}>
          <div onClick={() => setExpanded(e => ({ ...e, [entry.name]: !open }))}
            style={{ display: 'flex', alignItems: 'center', gap: 4,
              padding: `3px 0 3px ${8 + depth * 12}px`, cursor: 'pointer',
              color: T.textMuted, fontSize: 12 }}>
            <span style={{ width: 10, display: 'inline-flex' }}>
              <Icon name={open ? 'chev-d' : 'chev'} size={10} />
            </span>
            <Icon name="folder" size={12} style={{ color: T.accent, opacity: 0.7 }} />
            <span>{entry.name}</span>
          </div>
          {open && entry.children?.map(c => renderEntry(c, depth + 1))}
        </div>
      );
    }
    return (
      <div key={entry.name} style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: `3px 0 3px ${8 + depth * 12 + 14}px`,
        color: entry.active ? T.text : (entry.muted ? T.textHint : T.textMuted),
        background: entry.active ? T.accentSoft : 'transparent',
        borderLeft: entry.active ? `2px solid ${T.accent}` : '2px solid transparent',
        fontSize: 12, cursor: 'pointer',
      }}>
        <Icon name="file" size={11} style={{ opacity: 0.6 }} />
        <span>{entry.name}</span>
      </div>
    );
  };

  return (
    <div style={{ gridArea: 'left', background: T.surface, borderRight: `1px solid ${T.border}`,
      overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '12px 12px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: T.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Workspace</span>
        <Icon name="cog" size={11} style={{ color: T.textHint }} />
      </div>
      <div style={{ padding: '0 12px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="folder" size={12} style={{ color: T.accent }} />
        <span style={{ fontSize: 12, fontWeight: 500 }}>research-agent</span>
        <Icon name="chev-d" size={10} style={{ color: T.textHint, marginLeft: 'auto' }} />
      </div>
      <div style={{ padding: '0 4px 8px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', background: T.bg, border: `1px solid ${T.border}`,
          borderRadius: 4, padding: '3px 6px', margin: '0 8px', gap: 4 }}>
          <Icon name="search" size={11} style={{ color: T.textHint }} />
          <input placeholder="search files" style={{ flex: 1, background: 'transparent', border: 'none',
            color: T.text, fontSize: 11, outline: 'none', fontFamily: 'inherit' }} />
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '6px 0' }}>
        {WORKSPACE_FILES.map(e => renderEntry(e))}
      </div>
    </div>
  );
}

function AtelierCanvas({ workflow, positions, selected, onSelect, onDrag, dragNode }) {
  const T = ATELIER;
  // Compute viewbox bounds
  const xs = workflow.nodes.map(n => positions[n.id].x);
  const ys = workflow.nodes.map(n => positions[n.id].y);
  const minX = Math.min(...xs) - 40, minY = Math.min(...ys) - 40;
  const maxX = Math.max(...xs.map((x, i) => x + workflow.nodes[i].w)) + 60;
  const maxY = Math.max(...ys) + 240;

  const nodeRect = (n) => ({ x: positions[n.id].x, y: positions[n.id].y, w: n.w });

  return (
    <div style={{ gridArea: 'center', position: 'relative', overflow: 'auto',
      background: `radial-gradient(circle at 1px 1px, rgba(255,255,255,0.04) 1px, transparent 1px) ${T.bg}`,
      backgroundSize: '20px 20px',
    }}>
      <div style={{ position: 'relative', width: maxX - minX + 80, height: maxY - minY + 80,
        transform: `translate(${-minX + 40}px, ${-minY + 40}px)` }}>
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}>
          <defs>
            <marker id="atelier-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="rgba(255,255,255,0.35)"/>
            </marker>
            <marker id="atelier-arrow-fb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="#e07575"/>
            </marker>
          </defs>
          {workflow.edges.map((e, i) => {
            const from = workflow.nodes.find(n => n.id === e.from);
            const to = workflow.nodes.find(n => n.id === e.to);
            if (!from || !to) return null;
            const fromR = { ...nodeRect(from), y: positions[from.id].y };
            const toR = { ...nodeRect(to), y: positions[to.id].y };
            const path = edgePath(fromR, toR, e.kind);
            const color = e.kind === 'feedback' ? '#e07575'
                       : e.kind === 'memory' ? '#b88bd9'
                       : e.kind === 'control' ? '#9aa4b2'
                       : 'rgba(255,255,255,0.28)';
            return (
              <g key={i}>
                <path d={path} fill="none" stroke={color}
                  strokeWidth={e.kind === 'feedback' ? 1.5 : 1.25}
                  strokeDasharray={e.kind === 'memory' || e.kind === 'control' ? '3 3' : ''}
                  markerEnd={e.kind === 'feedback' ? 'url(#atelier-arrow-fb)' : 'url(#atelier-arrow)'}/>
                {e.label && (() => {
                  // place label near midpoint
                  const sx = fromR.x + fromR.w, sy = fromR.y + 60;
                  const tx = toR.x, ty = toR.y + 60;
                  const mx = (sx + tx) / 2, my = (sy + ty) / 2 - 6;
                  return (
                    <g transform={`translate(${mx}, ${my})`}>
                      <rect x={-30} y={-9} width={60} height={16} rx={3}
                        fill={T.bg} stroke={T.border}/>
                      <text textAnchor="middle" y={2} fontSize={10} fill={T.textMuted}
                        style={{ fontFamily: 'inherit' }}>{e.label}</text>
                    </g>
                  );
                })()}
              </g>
            );
          })}
        </svg>

        {workflow.nodes.map(n => (
          <AtelierNode key={n.id} node={n} pos={positions[n.id]}
            selected={selected === n.id} dragging={dragNode === n.id}
            onSelect={() => onSelect(n.id)} onPointerDown={(e) => onDrag(e, n.id)} />
        ))}
      </div>

      <AtelierMinimap workflow={workflow} positions={positions} selected={selected} />
      <AtelierCanvasToolbar />
    </div>
  );
}

function AtelierNode({ node, pos, selected, dragging, onSelect, onPointerDown }) {
  const T = ATELIER;
  const meta = ROLE_META[node.kind];
  const status = STATUS_COLORS[node.status] || STATUS_COLORS.idle;
  const model = node.model ? MODELS[node.model] : null;
  const tokenPct = node.tokens.budget ? (node.tokens.used / node.tokens.budget) : 0;

  return (
    <div onPointerDown={onPointerDown}
      style={{
        position: 'absolute', left: pos.x, top: pos.y, width: node.w,
        background: T.surface2,
        border: `1px solid ${selected ? T.accent : T.border}`,
        borderRadius: 8, padding: 0, cursor: dragging ? 'grabbing' : 'grab',
        boxShadow: selected ? `0 0 0 3px ${T.accentSoft}, 0 12px 32px rgba(0,0,0,0.4)` : '0 1px 0 rgba(255,255,255,0.03) inset, 0 6px 18px rgba(0,0,0,0.3)',
        transition: dragging ? 'none' : 'border-color 120ms, box-shadow 120ms',
        userSelect: 'none',
      }}>
      {/* ports */}
      <div style={{ position: 'absolute', left: -5, top: 54, width: 10, height: 10, borderRadius: '50%',
        background: T.bg, border: `2px solid ${meta.tint}` }}/>
      <div style={{ position: 'absolute', right: -5, top: 54, width: 10, height: 10, borderRadius: '50%',
        background: T.bg, border: `2px solid ${meta.tint}` }}/>

      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 12px 8px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ width: 22, height: 22, borderRadius: 5,
          background: `${meta.tint}1f`,
          color: meta.tint, display: 'grid', placeItems: 'center' }}>
          <Icon name={roleIcon(node.kind)} size={12} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.label}</div>
          <div style={{ fontSize: 10, color: T.textHint, fontFamily: '"JetBrains Mono", monospace',
            letterSpacing: '0.04em', textTransform: 'uppercase' }}>{meta.label}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: status.dot }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: status.dot,
            boxShadow: node.status === 'running' ? `0 0 8px ${status.dot}` : 'none',
            animation: node.status === 'running' ? 'atelier-pulse 1.4s infinite' : '' }}/>
          {status.label}
        </div>
      </div>

      {/* prompt preview */}
      <div style={{ padding: '8px 12px 6px', fontSize: 11, lineHeight: 1.45,
        color: T.textMuted, fontFamily: '"JetBrains Mono", monospace',
        display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        height: 50 }}>
        {node.prompt}
      </div>

      {/* footer: model + tools */}
      <div style={{ padding: '6px 12px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
        {model ? (
          <div style={{ fontSize: 10, color: T.textMuted, display: 'inline-flex', alignItems: 'center', gap: 4,
            fontFamily: '"JetBrains Mono", monospace' }}>
            <Icon name="cpu" size={10}/>
            {model.short}
          </div>
        ) : (
          <div style={{ fontSize: 10, color: T.textHint, fontFamily: '"JetBrains Mono", monospace' }}>—</div>
        )}
        <div style={{ flex: 1 }}/>
        <div style={{ display: 'flex', gap: 3 }}>
          {node.tools.slice(0, 4).map((t, i) => (
            <span key={i} style={{ fontSize: 9, padding: '2px 5px', borderRadius: 3,
              background: T.surface3, color: T.textMuted, fontFamily: '"JetBrains Mono", monospace',
              whiteSpace: 'nowrap' }}>{t}</span>
          ))}
          {node.tools.length > 4 && (
            <span style={{ fontSize: 9, padding: '2px 5px', borderRadius: 3,
              background: T.surface3, color: T.textHint }}>+{node.tools.length - 4}</span>
          )}
        </div>
      </div>

      {/* token bar */}
      {node.tokens.budget > 0 && (
        <div style={{ padding: '0 12px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ flex: 1, height: 3, background: T.surface3, borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.min(100, tokenPct * 100)}%`,
              background: tokenPct > 0.8 ? '#e07575' : tokenPct > 0.5 ? T.accent : '#5fbf7f',
              transition: 'width 300ms' }}/>
          </div>
          <span style={{ fontSize: 9, color: T.textHint, fontFamily: '"JetBrains Mono", monospace',
            fontVariantNumeric: 'tabular-nums', minWidth: 64, textAlign: 'right' }}>
            {(node.tokens.used / 1000).toFixed(1)}k / {(node.tokens.budget / 1000)}k
          </span>
        </div>
      )}

      {/* hooks chips */}
      {node.hooks.length > 0 && (
        <div style={{ padding: '0 10px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {node.hooks.map((h, i) => (
            <span key={i} style={{ fontSize: 9, padding: '2px 6px 2px 4px', borderRadius: 99,
              background: 'rgba(217,119,87,0.12)', color: '#d97757',
              display: 'inline-flex', alignItems: 'center', gap: 3,
              fontFamily: '"JetBrains Mono", monospace' }}>
              <Icon name="shield" size={9}/>
              {h}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function AtelierMinimap({ workflow, positions, selected }) {
  const T = ATELIER;
  const xs = workflow.nodes.map(n => positions[n.id].x);
  const ys = workflow.nodes.map(n => positions[n.id].y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const maxX = Math.max(...xs.map((x, i) => x + workflow.nodes[i].w));
  const maxY = Math.max(...ys) + 200;
  const W = 180, H = 110;
  const sx = W / (maxX - minX);
  const sy = H / (maxY - minY);
  const s = Math.min(sx, sy);
  return (
    <div style={{ position: 'absolute', right: 12, bottom: 12, width: W, height: H,
      background: 'rgba(15,16,20,0.85)', border: `1px solid ${T.border}`, borderRadius: 6,
      overflow: 'hidden', backdropFilter: 'blur(8px)' }}>
      <div style={{ position: 'absolute', top: 4, left: 6, fontSize: 9,
        color: T.textHint, fontFamily: '"JetBrains Mono", monospace', letterSpacing: '0.06em',
        textTransform: 'uppercase' }}>MAP</div>
      {workflow.nodes.map(n => {
        const meta = ROLE_META[n.kind];
        const p = positions[n.id];
        return (
          <div key={n.id} style={{
            position: 'absolute', left: (p.x - minX) * s, top: (p.y - minY) * s,
            width: n.w * s, height: 18 * s + 30 * s,
            background: meta.tint, borderRadius: 1, opacity: selected === n.id ? 1 : 0.55,
            boxShadow: selected === n.id ? `0 0 0 1px ${T.accent}` : 'none',
          }}/>
        );
      })}
    </div>
  );
}

function AtelierCanvasToolbar() {
  const T = ATELIER;
  return (
    <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', gap: 4,
      background: 'rgba(28,31,38,0.85)', border: `1px solid ${T.border}`, borderRadius: 6,
      padding: 3, backdropFilter: 'blur(8px)' }}>
      {[
        { i: 'cpu',    l: 'Orchestrator' },
        { i: 'branch', l: 'Gateway' },
        { i: 'zap',    l: 'Worker' },
        { i: 'eye',    l: 'Critic' },
        { i: 'db',     l: 'Memory' },
        { i: 'shield', l: 'Hook' },
      ].map((b, i) => (
        <button key={i} title={`Add ${b.l}`} style={{
          width: 26, height: 24, border: 'none', borderRadius: 4, background: 'transparent',
          color: T.textMuted, cursor: 'pointer', display: 'grid', placeItems: 'center',
        }} onMouseEnter={e => e.currentTarget.style.background = T.surface3}
           onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
          <Icon name={b.i} size={13}/>
        </button>
      ))}
    </div>
  );
}

function AtelierConfigPanel({ node, tab, setTab }) {
  const T = ATELIER;
  if (!node) return <div style={{ gridArea: 'right', background: T.surface, borderLeft: `1px solid ${T.border}` }}/>;
  const meta = ROLE_META[node.kind];
  const tabs = ['role', 'prompt', 'tools', 'hooks', 'memory'];

  return (
    <div style={{ gridArea: 'right', background: T.surface, borderLeft: `1px solid ${T.border}`,
      display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '12px 14px 10px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 26, height: 26, borderRadius: 6, background: `${meta.tint}1f`,
            color: meta.tint, display: 'grid', placeItems: 'center' }}>
            <Icon name={roleIcon(node.kind)} size={14}/>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{node.label}</div>
            <div style={{ fontSize: 10, color: T.textHint, fontFamily: '"JetBrains Mono", monospace',
              letterSpacing: '0.04em', textTransform: 'uppercase' }}>{meta.label} · {node.id}</div>
          </div>
          <button style={{ width: 24, height: 24, border: 'none', borderRadius: 4,
            background: 'transparent', color: T.textHint, cursor: 'pointer',
            display: 'grid', placeItems: 'center' }}>
            <Icon name="history" size={13}/>
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', borderBottom: `1px solid ${T.border}`, padding: '0 6px' }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 10px', border: 'none', background: 'transparent',
            color: tab === t ? T.text : T.textMuted,
            borderBottom: tab === t ? `2px solid ${T.accent}` : '2px solid transparent',
            marginBottom: -1, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em',
            cursor: 'pointer', fontFamily: 'inherit',
          }}>{t}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
        {tab === 'role' && <RoleTab node={node}/>}
        {tab === 'prompt' && <PromptTab node={node}/>}
        {tab === 'tools' && <ToolsTab node={node}/>}
        {tab === 'hooks' && <HooksTab node={node}/>}
        {tab === 'memory' && <MemoryTab node={node}/>}
      </div>
    </div>
  );
}

function Section({ title, children, action }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: ATELIER.textMuted,
          letterSpacing: '0.06em', textTransform: 'uppercase' }}>{title}</span>
        <div style={{ flex: 1 }}/>
        {action}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: ATELIER.textMuted, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function RoleTab({ node }) {
  const T = ATELIER;
  const model = node.model ? MODELS[node.model] : null;
  return (
    <div>
      <Section title="Identity">
        <Field label="Display name">
          <input value={node.label} readOnly style={inputStyle}/>
        </Field>
        <Field label="Role">
          <select value={node.kind} style={{ ...inputStyle, appearance: 'none' }}>
            {Object.entries(ROLE_META).map(([k, m]) => (
              <option key={k} value={k}>{m.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Description">
          <textarea readOnly defaultValue="A specialized agent in the parallel research pipeline."
            style={{ ...inputStyle, height: 50, resize: 'none', fontFamily: 'inherit' }}/>
        </Field>
      </Section>

      <Section title="Model">
        <Field label="Provider · model">
          <div style={{ display: 'flex', gap: 6 }}>
            <select style={{ ...inputStyle, flex: 1 }} defaultValue={node.model || ''}>
              {Object.entries(MODELS).map(([k, m]) => <option key={k} value={k}>{m.short}</option>)}
            </select>
          </div>
        </Field>
        {model && (
          <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 5,
            padding: 10, fontSize: 11, color: T.textMuted, display: 'grid',
            gridTemplateColumns: '1fr 1fr', gap: '6px 12px',
            fontFamily: '"JetBrains Mono", monospace' }}>
            <div>context</div>
            <div style={{ color: T.text, textAlign: 'right' }}>{(model.ctx/1000)|0}k</div>
            <div>in / Mtok</div>
            <div style={{ color: T.text, textAlign: 'right' }}>${model.costIn}</div>
            <div>out / Mtok</div>
            <div style={{ color: T.text, textAlign: 'right' }}>${model.costOut}</div>
          </div>
        )}
      </Section>

      <Section title="Limits">
        <Field label={`Token budget · ${node.tokens.budget.toLocaleString()}`}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="range" min={1000} max={100000} step={1000} defaultValue={node.tokens.budget}
              style={{ flex: 1, accentColor: T.accent }}/>
          </div>
        </Field>
        <Field label="Max steps">
          <input defaultValue={20} style={inputStyle}/>
        </Field>
      </Section>
    </div>
  );
}

const inputStyle = {
  width: '100%', boxSizing: 'border-box',
  background: ATELIER.bg, border: `1px solid ${ATELIER.border}`,
  borderRadius: 4, padding: '6px 8px', color: ATELIER.text, fontSize: 12,
  fontFamily: 'inherit', outline: 'none',
};

function PromptTab({ node }) {
  const T = ATELIER;
  return (
    <div>
      <Section title="System prompt" action={
        <span style={{ fontSize: 10, color: T.textHint, fontFamily: '"JetBrains Mono", monospace' }}>
          {node.prompt.length}ch · ~{Math.ceil(node.prompt.length / 4)}tok
        </span>
      }>
        <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 5,
          padding: 10, fontSize: 11.5, lineHeight: 1.55, color: T.text,
          fontFamily: '"JetBrains Mono", monospace', maxHeight: 200, overflow: 'auto',
          whiteSpace: 'pre-wrap' }}>
          {node.prompt}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button style={{ ...inputStyle, width: 'auto', cursor: 'pointer' }}>Edit in Monaco</button>
          <button style={{ ...inputStyle, width: 'auto', cursor: 'pointer' }}>Diff vs v3</button>
        </div>
      </Section>
      <Section title="Variables">
        <div style={{ fontSize: 11, color: T.textMuted, fontFamily: '"JetBrains Mono", monospace' }}>
          <div>{'{{workspace}}'}  →  /Users/me/research-agent</div>
          <div>{'{{date}}'}       →  2026-05-11</div>
          <div style={{ color: T.textHint }}>{'{{user_query}}'}  →  (runtime)</div>
        </div>
      </Section>
      <Section title="Input schema (Zod)">
        <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 5,
          padding: 10, fontSize: 11, color: T.text, fontFamily: '"JetBrains Mono", monospace',
          whiteSpace: 'pre' }}>
{`z.object({
  query: z.string().min(1),
  context: z.string().optional(),
})`}
        </div>
      </Section>
    </div>
  );
}

function ToolsTab({ node }) {
  const T = ATELIER;
  const ALL_TOOLS = ['web_search', 'web_fetch', 'grep', 'read_file', 'list_files', 'fs.write',
    'fs.append', 'fs.read', 'bash', 'classify', 'vector_search', 'cite', 'puppeteer', 'git',
    'todo_write', 'subagent_dispatch', 'test'];
  return (
    <div>
      <Section title={`Permitted tools · ${node.tools.length}`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {ALL_TOOLS.map(t => {
            const enabled = node.tools.includes(t);
            return (
              <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 8,
                padding: '5px 6px', borderRadius: 4, background: enabled ? T.accentSoft : 'transparent',
                cursor: 'pointer' }}>
                <span style={{ width: 14, height: 14, borderRadius: 3,
                  background: enabled ? T.accent : 'transparent',
                  border: `1px solid ${enabled ? T.accent : T.borderStrong}`,
                  display: 'grid', placeItems: 'center', color: '#1a1207' }}>
                  {enabled && <Icon name="check" size={10}/>}
                </span>
                <span style={{ fontSize: 12, color: enabled ? T.text : T.textMuted,
                  fontFamily: '"JetBrains Mono", monospace' }}>{t}</span>
                <div style={{ flex: 1 }}/>
                {enabled && <Icon name="cog" size={11} style={{ color: T.textHint }}/>}
              </label>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

function HooksTab({ node }) {
  const T = ATELIER;
  return (
    <div>
      <Section title="Active hooks" action={
        <button style={{ background: 'transparent', border: 'none', color: T.accent, fontSize: 11, cursor: 'pointer' }}>
          + Add
        </button>
      }>
        {node.hooks.length === 0 ? (
          <div style={{ fontSize: 11, color: T.textHint, padding: 10, textAlign: 'center',
            border: `1px dashed ${T.border}`, borderRadius: 5 }}>
            No hooks. Add one to gate tool calls.
          </div>
        ) : node.hooks.map((h, i) => (
          <div key={i} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 5,
            padding: 10, marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <Icon name="shield" size={11} style={{ color: '#d97757' }}/>
              <span style={{ fontSize: 12, fontWeight: 500, color: T.text }}>{h}</span>
              <div style={{ flex: 1 }}/>
              <span style={{ fontSize: 9, padding: '2px 5px', borderRadius: 3,
                background: 'rgba(95,191,127,0.15)', color: '#5fbf7f',
                fontFamily: '"JetBrains Mono", monospace' }}>pre-tool</span>
            </div>
            <div style={{ fontSize: 10, color: T.textMuted, fontFamily: '"JetBrains Mono", monospace' }}>
              .harness/hooks/{h}.{h.endsWith('shell') ? 'sh' : 'py'}
            </div>
          </div>
        ))}
      </Section>
      <Section title="Consent">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: T.text }}>
          <span style={{ width: 28, height: 16, borderRadius: 8, background: T.accent,
            position: 'relative' }}>
            <span style={{ position: 'absolute', right: 2, top: 2, width: 12, height: 12,
              borderRadius: '50%', background: '#1a1207' }}/>
          </span>
          Require user consent before each run
        </label>
      </Section>
    </div>
  );
}

function MemoryTab({ node }) {
  const T = ATELIER;
  const pct = node.tokens.budget ? node.tokens.used / node.tokens.budget : 0;
  return (
    <div>
      <Section title="Context window">
        <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 5,
          padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 8,
            fontFamily: '"JetBrains Mono", monospace' }}>
            <span style={{ fontSize: 22, fontWeight: 600, color: T.text }}>
              {(node.tokens.used / 1000).toFixed(1)}
            </span>
            <span style={{ fontSize: 12, color: T.textMuted }}>
              / {(node.tokens.budget / 1000)}k tokens
            </span>
          </div>
          <div style={{ height: 6, background: T.surface3, borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
            <div style={{ height: '100%', width: `${pct * 100}%`,
              background: pct > 0.8 ? '#e07575' : pct > 0.5 ? T.accent : '#5fbf7f' }}/>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '3px 8px',
            fontSize: 11, color: T.textMuted, fontFamily: '"JetBrains Mono", monospace' }}>
            <span>system prompt</span><span style={{ color: T.text }}>1,240</span>
            <span>tool defs</span><span style={{ color: T.text }}>2,180</span>
            <span>conversation</span><span style={{ color: T.text }}>{(node.tokens.used - 3420).toLocaleString()}</span>
            <span>compaction at</span><span style={{ color: T.accent }}>80%</span>
          </div>
        </div>
      </Section>
      <Section title="Long-term memory">
        <Field label="Strategy">
          <select style={inputStyle} defaultValue="append-jsonl">
            <option value="append-jsonl">Append-only JSONL</option>
            <option value="vector">Vector store</option>
            <option value="summary">Rolling summary</option>
            <option value="none">None</option>
          </select>
        </Field>
        <Field label="Backing path">
          <input defaultValue=".harness/memory/web-searcher.jsonl"
            style={{ ...inputStyle, fontFamily: '"JetBrains Mono", monospace', fontSize: 11 }}/>
        </Field>
      </Section>
    </div>
  );
}

function AtelierAudit({ open, setOpen }) {
  const T = ATELIER;
  const KIND_COLOR = {
    run: T.accent, tokens: T.textMuted, edge: '#7c9eff', tool: '#5fbf7f',
    fanout: '#b88bd9', consent: '#d97757', done: '#7c9eff', warn: '#e5a142', error: '#e07575',
  };
  return (
    <div style={{ gridArea: 'bottom', background: T.surface, borderTop: `1px solid ${T.border}`,
      display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 12px',
        borderBottom: open ? `1px solid ${T.border}` : 'none' }}>
        <button onClick={() => setOpen(!open)} style={{
          background: 'transparent', border: 'none', color: T.textMuted, cursor: 'pointer',
          fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name={open ? 'chev-d' : 'chev'} size={10}/>
          <span style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600,
            color: T.text }}>Audit · Trace</span>
        </button>
        <div style={{ marginLeft: 12, display: 'flex', gap: 4 }}>
          {['all', 'tool', 'consent', 'warn', 'error'].map((f, i) => (
            <button key={f} style={{ padding: '2px 8px', borderRadius: 99, border: 'none',
              background: i === 0 ? T.surface3 : 'transparent', color: i === 0 ? T.text : T.textMuted,
              fontSize: 10, cursor: 'pointer', fontFamily: 'inherit' }}>{f}</button>
          ))}
        </div>
        <div style={{ flex: 1 }}/>
        <span style={{ fontSize: 10, color: T.textHint, fontFamily: '"JetBrains Mono", monospace' }}>
          tokens 36.4k · $0.74 · 8.2s elapsed
        </span>
      </div>
      {open && (
        <div style={{ flex: 1, overflow: 'auto', padding: '6px 0',
          fontFamily: '"JetBrains Mono", monospace', fontSize: 11 }}>
          {AUDIT_ENTRIES.map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '2px 12px',
              borderLeft: `2px solid transparent` }}>
              <span style={{ color: T.textHint, minWidth: 90 }}>{e.t}</span>
              <span style={{ color: KIND_COLOR[e.kind] || T.textMuted, minWidth: 56,
                textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.04em',
                paddingTop: 1 }}>{e.kind}</span>
              <span style={{ color: T.textMuted, minWidth: 130 }}>{e.node}</span>
              <span style={{ color: T.text }}>{e.msg}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// pulse keyframes
if (typeof document !== 'undefined' && !document.getElementById('atelier-anim')) {
  const s = document.createElement('style');
  s.id = 'atelier-anim';
  s.textContent = '@keyframes atelier-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }';
  document.head.appendChild(s);
}

window.AtelierApp = AtelierApp;
window.ATELIER = ATELIER;
