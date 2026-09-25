/**
 * Local Monaco setup.
 *
 * By default @monaco-editor/react downloads the editor from cdn.jsdelivr.net
 * at runtime. That is unreachable on air-gapped machines and blocked by the
 * app CSP (script-src 'self') in every packaged build. This module wires the
 * loader to the monaco-editor package bundled by Vite instead, so the editor
 * works fully offline.
 *
 * Imported lazily (React.lazy in MarkdownEditor) so the ~4 MB editor chunk
 * stays out of the startup bundle.
 */
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import Editor, { DiffEditor, loader } from "@monaco-editor/react";

self.MonacoEnvironment = {
  // Markdown/YAML only need the base editor worker (no language services).
  getWorker: () => new editorWorker(),
};

loader.config({ monaco });

export default Editor;
export { DiffEditor };
