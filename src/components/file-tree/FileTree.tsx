import { useWorkspaceStore } from "@/store/workspaceStore";
import { FileTreeNodeComponent } from "./FileTreeNode";

export function FileTree() {
  const fileTree = useWorkspaceStore((s) => s.fileTree);
  const isLoading = useWorkspaceStore((s) => s.isLoading);

  if (isLoading) {
    return <div className="p-3 text-xs text-gray-400">Loading…</div>;
  }

  if (fileTree.length === 0) {
    return <div className="p-3 text-xs text-gray-400">No files. Open a workspace to browse files.</div>;
  }

  return (
    <div className="overflow-y-auto flex-1 py-1 px-1">
      {fileTree.map((entry) => (
        <FileTreeNodeComponent key={entry.path} entry={entry} />
      ))}
    </div>
  );
}
