import { useState } from "react";
import { ChevronRight, ChevronDown, FileText, Folder, FolderOpen } from "lucide-react";
import type { FileTreeEntry } from "@/types/filesystem";
import { useUIStore } from "@/store/uiStore";

interface FileTreeNodeProps {
  entry: FileTreeEntry;
  depth?: number;
}

export function FileTreeNodeComponent({ entry, depth = 0 }: FileTreeNodeProps) {
  const [expanded, setExpanded] = useState(depth < 1);
  const openEditorFile = useUIStore((s) => s.openEditorFile);
  const activeEditorPath = useUIStore((s) => s.activeEditorPath);
  const isActive = activeEditorPath === entry.path;

  const indent = depth * 12;

  if (entry.isDirectory) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          style={{ paddingLeft: `${indent + 8}px` }}
          className="w-full flex items-center gap-1.5 py-1 text-xs text-gray-700 hover:bg-gray-100 rounded"
        >
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {expanded ? <FolderOpen size={13} className="text-blue-400" /> : <Folder size={13} className="text-blue-400" />}
          <span className="font-medium">{entry.name}</span>
        </button>
        {expanded && entry.children?.map((child) => (
          <FileTreeNodeComponent key={child.path} entry={child} depth={depth + 1} />
        ))}
      </div>
    );
  }

  return (
    <button
      onClick={() => openEditorFile(entry.path)}
      style={{ paddingLeft: `${indent + 20}px` }}
      className={`w-full flex items-center gap-1.5 py-1 text-xs rounded ${isActive ? "bg-blue-100 text-blue-700" : "text-gray-600 hover:bg-gray-100"}`}
    >
      <FileText size={12} className="shrink-0" />
      <span className="truncate">{entry.name}</span>
    </button>
  );
}
