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

/** What a file search lists. */
export interface FileSearchResult {
  /** The matches to show: the first `limit` files, in tree order, inside the folders that hold
   *  them. A folder that holds none of the shown files is left out, so every folder in it is
   *  worth opening. */
  tree: FileTreeEntry[];
  /** How many files the search lists in all, shown or not (0 without a query). The files of a
   *  folder whose name matches count too, as they are listed. */
  total: number;
}

/** `filterFileTree`, cut off after `limit` files: rows are what a big workspace cannot afford
 *  to render. Without a query the tree is returned as it is. */
export function searchFileTree(entries: FileTreeEntry[], query: string, limit: number): FileSearchResult {
  const matches = filterFileTree(entries, query);
  if (!query.trim()) return { tree: matches, total: 0 };
  let total = 0;
  const cut = (list: FileTreeEntry[]): FileTreeEntry[] => list.flatMap((entry) => {
    if (!entry.isDirectory) return ++total <= limit ? [entry] : [];
    const children = cut(entry.children ?? []);
    // A folder whose files were all cut off is left out; an empty one that matched stays.
    return children.length > 0 || !entry.children?.length ? [{ ...entry, children }] : [];
  });
  const tree = cut(matches);
  return { tree, total };
}
