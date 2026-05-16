// shared.jsx — Shared primitives used across all three variations.
//   • Icon set (inline SVG, no deps)
//   • Edge path math + ConnectorLayer
//   • Hook/tool chips
//   • Token budget bar

// ── Icons ──────────────────────────────────────────────────────────────────
const Icon = ({ name, size = 14, stroke = 1.6, style }) => {
  const s = size, sw = stroke;
  const props = { width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: sw, strokeLinecap: 'round',
    strokeLinejoin: 'round', style };
  switch (name) {
    case 'play':    return <svg {...props}><path d="M6 4l14 8-14 8V4z"/></svg>;
    case 'save':    return <svg {...props}><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>;
    case 'check':   return <svg {...props}><path d="M20 6L9 17l-5-5"/></svg>;
    case 'x':       return <svg {...props}><path d="M18 6L6 18M6 6l12 12"/></svg>;
    case 'alert':   return <svg {...props}><path d="M10.3 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>;
    case 'folder':  return <svg {...props}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;
    case 'file':    return <svg {...props}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>;
    case 'chev':    return <svg {...props}><path d="M9 18l6-6-6-6"/></svg>;
    case 'chev-d':  return <svg {...props}><path d="M6 9l6 6 6-6"/></svg>;
    case 'search':  return <svg {...props}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>;
    case 'plus':    return <svg {...props}><path d="M12 5v14M5 12h14"/></svg>;
    case 'cog':     return <svg {...props}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 010-4h.09A1.65 1.65 0 004.6 8a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V2a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H22a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>;
    case 'circle':  return <svg {...props}><circle cx="12" cy="12" r="9"/></svg>;
    case 'dot':     return <svg {...props}><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg>;
    case 'undo':    return <svg {...props}><path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-15-6.7L3 13"/></svg>;
    case 'redo':    return <svg {...props}><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0115-6.7L21 13"/></svg>;
    case 'zap':     return <svg {...props}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>;
    case 'shield':  return <svg {...props}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
    case 'history': return <svg {...props}><path d="M3 12a9 9 0 1 0 9-9 9.7 9.7 0 0 0-6.4 2.6L3 8"/><path d="M3 3v5h5M12 7v5l3 3"/></svg>;
    case 'eye':     return <svg {...props}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>;
    case 'pause':   return <svg {...props}><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>;
    case 'branch':  return <svg {...props}><circle cx="6" cy="3" r="2"/><circle cx="6" cy="21" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 5v14M6 12h10"/></svg>;
    case 'cpu':     return <svg {...props}><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>;
    case 'db':      return <svg {...props}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0018 0V5"/><path d="M3 12a9 3 0 0018 0"/></svg>;
    case 'term':    return <svg {...props}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>;
    case 'lock':    return <svg {...props}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>;
    case 'send':    return <svg {...props}><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg>;
    default: return null;
  }
};

const roleIcon = (kind) => ({
  orchestrator: 'cpu', gateway: 'branch', worker: 'zap', critic: 'eye',
  memory: 'db', tool: 'cog', hook: 'shield', aggregator: 'send',
})[kind] || 'circle';

// ── Edge path between two node rects ──────────────────────────────────────
function edgePath(from, to, kind) {
  const sx = from.x + from.w;            // right edge of source
  const sy = from.y + 60;                // approx output port y
  const tx = to.x;                       // left edge of target
  const ty = to.y + 60;
  const dx = Math.max(40, (tx - sx) * 0.45);
  if (kind === 'feedback') {
    // route below
    const midY = Math.max(from.y, to.y) + 220;
    return `M ${sx} ${sy + 60} C ${sx + 80} ${midY}, ${tx - 80} ${midY}, ${tx} ${ty + 60}`;
  }
  return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
}

// Status pill text → color
const STATUS_COLORS = {
  idle:    { dot: '#6b7280', label: 'idle' },
  running: { dot: '#5fbf7f', label: 'running' },
  waiting: { dot: '#e5a142', label: 'waiting' },
  done:    { dot: '#7c9eff', label: 'done' },
  error:   { dot: '#e07575', label: 'error' },
};

Object.assign(window, { Icon, roleIcon, edgePath, STATUS_COLORS });
