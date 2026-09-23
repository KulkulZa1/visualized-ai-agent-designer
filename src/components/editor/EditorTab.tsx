import { X } from "lucide-react";
import { useUIStore } from "@/store/uiStore";
import { MarkdownEditor } from "./MarkdownEditor";

export function EditorArea() {
  const openEditorTabs = useUIStore((s) => s.openEditorTabs);
  const activeEditorPath = useUIStore((s) => s.activeEditorPath);
  const setActiveEditorPath = useUIStore((s) => s.setActiveEditorPath);
  const closeEditorFile = useUIStore((s) => s.closeEditorFile);

  if (openEditorTabs.length === 0) return null;

  return (
    <div className="flex flex-col h-full border-t border-gray-200">
      <div className="flex items-center border-b border-gray-200 bg-gray-50 overflow-x-auto">
        {openEditorTabs.map((tab) => (
          <div
            key={tab.path}
            onClick={() => setActiveEditorPath(tab.path)}
            className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer border-r border-gray-200 shrink-0 ${
              activeEditorPath === tab.path ? "bg-white text-gray-800" : "text-gray-500 hover:bg-gray-100"
            }`}
          >
            <span className="max-w-[140px] truncate">{tab.path.split(/[\\/]/).at(-1)}</span>
            {tab.isDirty && <span className="text-blue-500 text-[10px]">●</span>}
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (tab.isDirty && !window.confirm(`Discard unsaved changes to ${tab.path}?`)) return;
                closeEditorFile(tab.path);
              }}
              className="hover:text-red-500 ml-0.5"
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex-1 overflow-hidden">
        {/* key: one editor instance per file — its Ctrl+S binding captures the path */}
        {activeEditorPath && <MarkdownEditor key={activeEditorPath} path={activeEditorPath} />}
      </div>
    </div>
  );
}
