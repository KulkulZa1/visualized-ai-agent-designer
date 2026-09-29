import type { FileTreeEntry } from "@/types/filesystem";

/** The entries whose name contains `query` (in any case), inside the folders that
 *  hold them. A folder whose name matches keeps all it contains. */
export function filterFileTree(entries: FileTreeEntry[], query: string): FileTreeEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  const walk = (list: FileTreeEntry[]): FileTreeEntry[] => list.flatMap((entry) => {
    if (entry.name.toLowerCase().includes(q)) return [entry];
    const children = entry.isDirectory && entry.children ? walk(entry.children) : [];
    return children.length > 0 ? [{ ...entry, children }] : [];
  });
  return walk(entries);
}
