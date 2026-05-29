"use strict";
/**
 * webviewPanel.ts — Harness Studio WebviewPanel for VS Code.
 *
 * Loads the built React frontend (dist/ from the main project) in a webview.
 * Bridges invoke() calls from the webview to the extension host using
 * the message-passing protocol below.
 *
 * Message protocol (webview → host):
 *   { type: "invoke", id: string, command: string, args: Record<string, unknown> }
 *
 * Message protocol (host → webview):
 *   { type: "invoke_result", id: string, result: unknown }
 *   { type: "invoke_error",  id: string, error: string }
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.HarnessPanel = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const invoke_1 = require("./invoke");
class HarnessPanel {
    static createOrShow(context, credentials) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;
        if (HarnessPanel.currentPanel) {
            HarnessPanel.currentPanel._panel.reveal(column);
            return HarnessPanel.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel("harnessStudio", "Harness Studio", column ?? vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, "dist"),
                vscode.Uri.joinPath(context.extensionUri, "..", "dist"),
            ],
        });
        HarnessPanel.currentPanel = new HarnessPanel(panel, credentials, context);
        return HarnessPanel.currentPanel;
    }
    constructor(panel, credentials, context) {
        this._disposables = [];
        this._panel = panel;
        this._credentials = credentials;
        this._workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        // Look for dist/ in two places: inside extension dir or one level up (dev mode)
        const inExt = path.join(context.extensionPath, "dist");
        const inParent = path.join(context.extensionPath, "..", "dist");
        this._distPath = fs.existsSync(inExt) ? inExt : inParent;
        this._panel.webview.html = this._getHtml();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type !== "invoke")
                return;
            try {
                const result = await (0, invoke_1.handleInvoke)(msg.command, msg.args ?? {}, this._credentials, this._workspacePath);
                this._panel.webview.postMessage({ type: "invoke_result", id: msg.id, result });
            }
            catch (e) {
                this._panel.webview.postMessage({
                    type: "invoke_error",
                    id: msg.id,
                    error: e instanceof Error ? e.message : String(e),
                });
            }
        }, null, this._disposables);
        // Watch workspace folder changes
        this._disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this._workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        }));
    }
    _getHtml() {
        const webview = this._panel.webview;
        // Read the built index.html and rewrite asset paths to webview URIs
        const indexPath = path.join(this._distPath, "index.html");
        if (!fs.existsSync(indexPath)) {
            return `
        <!DOCTYPE html>
        <html><body style="font-family:system-ui;padding:40px;color:#ccc">
        <h2>Harness Studio</h2>
        <p>Frontend build not found at <code>${this._distPath}</code>.</p>
        <p>Run <code>npm run build</code> in the main project directory first.</p>
        </body></html>`;
        }
        let html = fs.readFileSync(indexPath, "utf-8");
        // Rewrite asset src/href from relative to webview:// URIs
        const distUri = webview.asWebviewUri(vscode.Uri.file(this._distPath));
        html = html
            .replace(/src="\/assets\//g, `src="${distUri}/assets/`)
            .replace(/href="\/assets\//g, `href="${distUri}/assets/`)
            .replace(/src="\/(.+?)"/g, (_, p) => `src="${distUri}/${p}"`)
            .replace(/href="\/(.+?)"/g, (_, p) => `href="${distUri}/${p}"`);
        // Inject the VS Code invoke bridge BEFORE any script tag
        const bridge = `
<script>
(function() {
  // Acquire VS Code API once
  const vscode = acquireVsCodeApi();
  let __reqId = 0;
  const __pending = new Map();

  // Listen for responses from extension host
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'invoke_result' || msg.type === 'invoke_error') {
      const p = __pending.get(msg.id);
      if (!p) return;
      __pending.delete(msg.id);
      if (msg.type === 'invoke_result') p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    }
  });

  // Override the global __HARNESS_INVOKE__ which tauriCommands.ts checks first
  window.__HARNESS_VSCODE__ = true;
  window.__HARNESS_INVOKE__ = function(command, args) {
    return new Promise((resolve, reject) => {
      const id = String(++__reqId);
      __pending.set(id, { resolve, reject });
      vscode.postMessage({ type: 'invoke', id, command, args: args ?? {} });
    });
  };
  console.log('[Harness Studio] VS Code invoke bridge ready');
})();
</script>`;
        html = html.replace("<head>", `<head>${bridge}`);
        return html;
    }
    dispose() {
        HarnessPanel.currentPanel = undefined;
        this._panel.dispose();
        for (const d of this._disposables)
            d.dispose();
        this._disposables = [];
    }
}
exports.HarnessPanel = HarnessPanel;
