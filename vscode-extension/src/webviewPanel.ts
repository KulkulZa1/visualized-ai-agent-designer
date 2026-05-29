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

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { handleInvoke } from "./invoke";
import { CredentialService } from "./credentialService";

export class HarnessPanel {
  public static currentPanel: HarnessPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _credentials: CredentialService;
  private readonly _distPath: string;
  private _workspacePath: string;
  private _disposables: vscode.Disposable[] = [];

  static createOrShow(
    context: vscode.ExtensionContext,
    credentials: CredentialService,
  ): HarnessPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (HarnessPanel.currentPanel) {
      HarnessPanel.currentPanel._panel.reveal(column);
      return HarnessPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "harnessStudio",
      "Harness Studio",
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "dist"),
          vscode.Uri.joinPath(context.extensionUri, "..", "dist"),
        ],
      },
    );

    HarnessPanel.currentPanel = new HarnessPanel(panel, credentials, context);
    return HarnessPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    credentials: CredentialService,
    context: vscode.ExtensionContext,
  ) {
    this._panel     = panel;
    this._credentials = credentials;
    this._workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

    // Look for dist/ in two places: inside extension dir or one level up (dev mode)
    const inExt   = path.join(context.extensionPath, "dist");
    const inParent = path.join(context.extensionPath, "..", "dist");
    this._distPath = fs.existsSync(inExt) ? inExt : inParent;

    this._panel.webview.html = this._getHtml();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (msg: { type: string; id: string; command: string; args: Record<string, unknown> }) => {
        if (msg.type !== "invoke") return;
        try {
          const result = await handleInvoke(
            msg.command,
            msg.args ?? {},
            this._credentials,
            this._workspacePath,
          );
          this._panel.webview.postMessage({ type: "invoke_result", id: msg.id, result });
        } catch (e) {
          this._panel.webview.postMessage({
            type: "invoke_error",
            id: msg.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
      null,
      this._disposables,
    );

    // Watch workspace folder changes
    this._disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this._workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      }),
    );
  }

  private _getHtml(): string {
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

  public dispose() {
    HarnessPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
  }
}
