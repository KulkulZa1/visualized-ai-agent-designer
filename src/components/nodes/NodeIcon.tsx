/**
 * Lucide-style inline SVG icons — matches the design system icon set exactly.
 * Using inline SVG avoids an import from lucide-react for every node render.
 */
interface IconProps {
  name: string;
  size?: number;
  stroke?: number;
  color?: string;
  style?: React.CSSProperties;
}

export function NodeIcon({ name, size = 14, stroke = 1.6, color = "currentColor", style }: IconProps) {
  const p = {
    width: size, height: size, viewBox: "0 0 24 24",
    fill: "none", stroke: color, strokeWidth: stroke,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    style: { display: "block", ...style },
  };
  switch (name) {
    case "cpu":    return <svg {...p}><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>;
    case "branch": return <svg {...p}><circle cx="6" cy="3" r="2"/><circle cx="6" cy="21" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 5v14M6 12h10"/></svg>;
    case "zap":    return <svg {...p}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>;
    case "eye":    return <svg {...p}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>;
    case "db":     return <svg {...p}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0018 0V5"/><path d="M3 12a9 3 0 0018 0"/></svg>;
    case "shield": return <svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
    case "send":   return <svg {...p}><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg>;
    case "cog":    return <svg {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 010-4h.09A1.65 1.65 0 004.6 8a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V2a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H22a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>;
    case "play":   return <svg {...p}><path d="M6 4l14 8-14 8V4z"/></svg>;
    case "stop":   return <svg {...p}><rect x="6" y="6" width="12" height="12" rx="2"/></svg>;
    case "save":   return <svg {...p}><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>;
    case "check":  return <svg {...p}><path d="M20 6L9 17l-5-5"/></svg>;
    case "x":      return <svg {...p}><path d="M18 6L6 18M6 6l12 12"/></svg>;
    case "folder": return <svg {...p}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;
    case "file":   return <svg {...p}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>;
    case "chev":   return <svg {...p}><path d="M9 18l6-6-6-6"/></svg>;
    case "chev-d": return <svg {...p}><path d="M6 9l6 6 6-6"/></svg>;
    case "search": return <svg {...p}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>;
    case "undo":   return <svg {...p}><path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-15-6.7L3 13"/></svg>;
    case "redo":   return <svg {...p}><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0115-6.7L21 13"/></svg>;
    case "history":return <svg {...p}><path d="M3 12a9 9 0 1 0 9-9 9.7 9.7 0 0 0-6.4 2.6L3 8"/><path d="M3 3v5h5M12 7v5l3 3"/></svg>;
    case "lock":   return <svg {...p}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>;
    case "plus":   return <svg {...p}><path d="M12 5v14M5 12h14"/></svg>;
    case "alert":  return <svg {...p}><path d="M10.3 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>;
    case "grid":   return <svg {...p}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>;
    default: return <svg {...p}><circle cx="12" cy="12" r="4"/></svg>;
  }
}
