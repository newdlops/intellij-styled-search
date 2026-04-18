import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import WebSocket from 'ws';
import { runSearch, SearchOptions, FileMatch, MatchRange } from './search';
import { getRendererPatchScript } from './rendererPatch';

type RendererEvent =
  | { type: 'search'; options: SearchOptions }
  | { type: 'cancel' }
  | { type: 'openFile'; uri: string; line: number; column: number }
  | { type: 'previewFile'; uri: string; line: number; column: number }
  | { type: 'requestPreview'; uri: string; line: number; ranges?: MatchRange[]; contextLines: number }
  | { type: 'openInSideEditor'; uri: string; line: number; column: number }
  | { type: 'pinInSideEditor'; uri: string; line: number; column: number }
  | { type: 'requestHover'; reqId: number; uri: string; line: number; column: number; x: number; y: number }
  | { type: 'runCommand'; command: string; args: unknown[] }
  | { type: 'saveFile'; uri: string; content: string }
  | { type: 'log'; msg: string };

type PreviewLine = { lineNumber: number; text: string };
type HoverContent = { value: string; isTrusted: boolean; allowedCommands?: readonly string[] };

type OverlayMessage =
  | { type: 'results:start' }
  | { type: 'results:file'; match: FileMatch }
  | { type: 'results:done'; totalFiles: number; totalMatches: number; truncated: boolean }
  | { type: 'results:error'; message: string }
  | { type: 'preview'; uri: string; relPath: string; focusLine: number; ranges?: MatchRange[]; lines: PreviewLine[]; languageId: string }
  | { type: 'hover'; reqId: number; uri: string; line: number; column: number; x: number; y: number; contents: HoverContent[] };

const BRIDGE_BINDING = 'irSearchMainBridge';
const RENDERER_BINDING = 'irSearchEvent';

export class OverlayPanel {
  private static instance: OverlayPanel | undefined;
  private ws: WebSocket | undefined;
  private msgId = 1;
  private pending = new Map<number, (resp: any) => void>();
  private activeSearch: vscode.CancellationTokenSource | undefined;
  private injectPromise: Promise<void> | undefined;
  private log: vscode.OutputChannel;
  private activeWindowId: number | undefined;
  private monacoBundleSrc: string = '';
  private monacoInjectedWindows = new Set<number>();

  static get(context: vscode.ExtensionContext): OverlayPanel {
    if (!OverlayPanel.instance) {
      OverlayPanel.instance = new OverlayPanel(context);
    }
    return OverlayPanel.instance;
  }

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.log = vscode.window.createOutputChannel('IntelliJ Styled Search');
    context.subscriptions.push(this.log);
    context.subscriptions.push({ dispose: () => this.dispose() });
    // Load the bundled monaco source so we can inject it into the renderer
    // once CDP is up. If it's missing we fall back to DOM rendering.
    try {
      const bundlePath = path.join(context.extensionPath, 'resources', 'monaco.bundle.js');
      this.monacoBundleSrc = fs.readFileSync(bundlePath, 'utf-8');
      this.log.appendLine(`Monaco bundle loaded: ${Math.round(this.monacoBundleSrc.length / 1024)} KB`);
    } catch (err) {
      this.log.appendLine(`Monaco bundle NOT found: ${err instanceof Error ? err.message : err}`);
    }
  }

  logActivation() {
    this.log.show(true);
    this.log.appendLine(`[${new Date().toISOString()}] Extension activated. Ext host pid=${process.pid}, ppid=${process.ppid}`);
  }

  logCommand(name: string) {
    this.log.show(true);
    this.log.appendLine(`[${new Date().toISOString()}] Command invoked: ${name}`);
  }

  async forceReinject(): Promise<void> {
    this.log.appendLine('Forcing reinject...');
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = undefined;
    }
    this.injectPromise = undefined;
    await this.ensureInjected();
  }

  async show(initialQuery: string): Promise<void> {
    try {
      await this.ensureInjected();
      const focusedId = await this.getFocusedWindowId();
      if (focusedId === null) {
        this.log.appendLine('show() aborted: no focused VSCode window');
        return;
      }
      this.activeWindowId = focusedId;
      // Bundle injection kept as a last-resort tool (can be re-enabled), but
      // not run by default — it brings its own CSS which leaks into VSCode's
      // native monaco editors. The preview pane instead steals the real
      // VSCode editor DOM (see renderPreview in rendererPatch.ts).
      // await this.ensureMonacoInjectedInWindow(focusedId);
      // Auto-hide any lingering overlay in other windows so only one is ever open.
      await this.evalInAllWindowsExcept(
        focusedId,
        `try { window.__ijFindHide && window.__ijFindHide(); } catch (e) {}`,
      );
      const showExpr = `(function(){ try { return window.__ijFindShow ? window.__ijFindShow(${JSON.stringify(initialQuery)}) : 'no-show-fn'; } catch (e) { return 'show-throw:' + (e && e.message); } })()`;
      const result = await this.evalInWindow(focusedId, showExpr);
      this.log.appendLine(`Show(win=${focusedId}): ${result}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`show() failed: ${err instanceof Error ? err.stack : msg}`);
      vscode.window.showErrorMessage(`IntelliJ Styled Search: ${msg}`);
    }
  }

  private async ensureMonacoInjectedInWindow(winId: number): Promise<void> {
    if (!this.monacoBundleSrc) { return; }
    if (this.monacoInjectedWindows.has(winId)) { return; }
    const sizeKB = Math.round(this.monacoBundleSrc.length / 1024);
    this.log.appendLine(`Injecting monaco bundle into window ${winId} (${sizeKB} KB)...`);
    const t0 = Date.now();
    // Wrap so it's idempotent in the renderer; the bundle itself sets
    // globalThis.monaco, we just need to run it once.
    const guarded = `
      (function () {
        if (globalThis.__ijFindMonacoInjected) { return 'already'; }
        globalThis.__ijFindMonacoInjected = true;
        try {
          ${this.monacoBundleSrc}
          var api = globalThis.__ijFindMonacoApi;
          return 'ok:' + (typeof api) + ':' + (api && typeof api.editor);
        } catch (e) {
          globalThis.__ijFindMonacoInjected = false;
          return 'err:' + (e && e.message ? e.message : String(e)).slice(0, 300);
        }
      })()
    `;
    try {
      const result = await this.evalInWindow(winId, guarded);
      const elapsed = Date.now() - t0;
      this.log.appendLine(`Monaco inject win=${winId} (${elapsed}ms): ${String(result).slice(0, 200)}`);
      if (String(result).startsWith('ok') || result === 'already') {
        this.monacoInjectedWindows.add(winId);
      }
    } catch (err) {
      this.log.appendLine(`Monaco inject exception: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async getFocusedWindowId(): Promise<number | null> {
    const script = `
      (function () {
        var BW = require('electron').BrowserWindow;
        var w = BW.getFocusedWindow();
        if (!w) {
          // Fall back to the last-focused patchable (workbench) window.
          var ws = BW.getAllWindows();
          for (var i = 0; i < ws.length; i++) {
            try {
              var url = (ws[i].webContents && ws[i].webContents.getURL && ws[i].webContents.getURL()) || '';
              if (/workbench\\./.test(url)) { w = ws[i]; break; }
            } catch (e) {}
          }
        }
        return w ? w.id : 0;
      })()
    `.trim();
    const resp = await this.send('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      includeCommandLineAPI: true,
    });
    const id = resp?.result?.value;
    return typeof id === 'number' && id > 0 ? id : null;
  }

  private async evalInWindow(winId: number, expr: string): Promise<string> {
    const script = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var w = BW.fromId(${winId});
        if (!w || !w.webContents) { return 'no-window:' + ${winId}; }
        try {
          var r = await w.webContents.debugger.sendCommand('Runtime.evaluate', { expression: ${JSON.stringify(expr)}, returnByValue: true });
          if (r && r.exceptionDetails) {
            return 'exc:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || '').split('\\n')[0].slice(0, 200);
          }
          var v = (r && r.result) ? r.result.value : undefined;
          return v === undefined ? '' : String(v);
        } catch (e) { return 'err:' + (e && e.message); }
      })()
    `.trim();
    const resp = await this.send('Runtime.evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    });
    const value = resp?.result?.value;
    return typeof value === 'string' ? value : String(value ?? '');
  }

  private async evalInAllWindowsExcept(exceptId: number, expr: string): Promise<void> {
    const script = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var wins = BW.getAllWindows();
        for (var i = 0; i < wins.length; i++) {
          if (wins[i].id === ${exceptId}) { continue; }
          try {
            await wins[i].webContents.debugger.sendCommand('Runtime.evaluate', { expression: ${JSON.stringify(expr)} });
          } catch (e) {}
        }
      })()
    `.trim();
    await this.send('Runtime.evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    });
  }

  private async evalInAllWindowsCollect(expr: string): Promise<string> {
    const script = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var wins = BW.getAllWindows();
        var results = [];
        for (var i = 0; i < wins.length; i++) {
          var wid = wins[i].id;
          try {
            var r = await wins[i].webContents.debugger.sendCommand('Runtime.evaluate', { expression: ${JSON.stringify(expr)}, returnByValue: true });
            if (r && r.exceptionDetails) {
              results.push(wid + ':exc:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || '').split('\\n')[0].slice(0, 150));
            } else {
              var v = (r && r.result) ? r.result.value : '(no-result)';
              if (v !== undefined && v !== null && String(v) !== '') { results.push(wid + ':' + v); }
            }
          } catch (e) { /* debugger not attached for this window */ }
        }
        return results.join(' || ');
      })()
    `.trim();
    const resp = await this.send('Runtime.evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    });
    const value = resp?.result?.value;
    if (typeof value === 'string') { return value; }
    if (value === undefined || value === null) { return '(no output)'; }
    return `(non-string value: ${JSON.stringify(value).slice(0, 200)}; resp=${JSON.stringify(resp).slice(0, 200)})`;
  }

  private dispose() {
    this.cancelActive();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = undefined;
    }
  }

  private async ensureInjected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { return; }
    if (this.injectPromise) { return this.injectPromise; }
    this.injectPromise = this.inject().finally(() => { this.injectPromise = undefined; });
    return this.injectPromise;
  }

  private async inject(): Promise<void> {
    const mainPid = this.findMainPid();
    if (!mainPid) { throw new Error('Could not locate VSCode main (Electron) process'); }
    this.log.appendLine(`Main PID ${mainPid}: sending SIGUSR1`);
    try { process.kill(mainPid, 'SIGUSR1'); } catch (e) {
      throw new Error(`SIGUSR1 to pid ${mainPid} failed: ${e instanceof Error ? e.message : e}`);
    }

    // Wait for the inspector listener to open, retry a few times.
    let wsUrl: string | undefined;
    for (let i = 0; i < 10; i++) {
      await delay(200);
      try {
        const targets = await fetchJson('http://127.0.0.1:9229/json/list');
        if (Array.isArray(targets) && targets.length > 0 && targets[0].webSocketDebuggerUrl) {
          wsUrl = targets[0].webSocketDebuggerUrl;
          break;
        }
      } catch {}
    }
    if (!wsUrl) { throw new Error('CDP inspector did not come up on 127.0.0.1:9229'); }

    this.log.appendLine('Connecting CDP WebSocket');
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onErr = (err: Error) => { cleanup(); reject(err); };
      const cleanup = () => {
        ws.removeListener('open', onOpen);
        ws.removeListener('error', onErr);
      };
      ws.once('open', onOpen);
      ws.once('error', onErr);
    });
    this.ws = ws;
    ws.on('message', (data) => this.handleWsMessage(data));
    ws.on('close', () => {
      this.log.appendLine('CDP WebSocket closed');
      this.ws = undefined;
    });

    await this.send('Runtime.enable', {});
    await this.send('Runtime.addBinding', { name: BRIDGE_BINDING });

    // Pass the patch script directly as the expression — no base64/atob round-trip,
    // which previously corrupted any non-ASCII characters (they arrived as raw UTF-8
    // bytes through atob and broke the parser).
    const patchExpr = getRendererPatchScript();

    const injectScript = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var wins = BW.getAllWindows();
        var results = [];
        for (var i = 0; i < wins.length; i++) {
          var w = wins[i];
          try {
            var url = '';
            try { url = (w.webContents && w.webContents.getURL && w.webContents.getURL()) || ''; } catch (eu) {}
            // Only patch the main workbench windows.
            if (!/workbench\\.(?:esm\\.)?html(?:\\?|#|$)/.test(url)) {
              results.push('skip:' + w.id + ':url=' + url.split('?')[0].split('/').pop());
              continue;
            }
            // ── Cooperative debugger attachment ──
            // Other extensions (e.g. intellisense-recursion) use the SAME
            // webContents.debugger to install their own bindings/listeners
            // (irGoToType for cmd+click navigation, etc.). If we detach +
            // reattach, we evict their session and break their plugin.
            // Only attach if the debugger isn't already attached, and add our
            // binding/listener on top of whatever's there. Both bindings can
            // coexist on a single CDP session.
            var alreadyAttached = false;
            try { alreadyAttached = w.webContents.debugger.isAttached(); } catch (eIs) {}
            if (!alreadyAttached) {
              try { w.webContents.debugger.attach('1.3'); }
              catch (eAtt) { results.push('attach-fail:' + w.id + ':' + eAtt.message); continue; }
            }
            try { await w.webContents.debugger.sendCommand('Runtime.enable'); } catch (eRe) {}
            var r = await w.webContents.debugger.sendCommand('Runtime.evaluate', { expression: ${JSON.stringify(patchExpr)}, returnByValue: true });
            if (r && r.exceptionDetails) {
              var ed = r.exceptionDetails;
              var exStr = ed.exception && ed.exception.description ? ed.exception.description : (ed.text || JSON.stringify(ed));
              results.push('exc:' + w.id + ':' + String(exStr).split('\\n')[0].slice(0, 200));
              try { w.webContents.debugger.detach(); } catch (e3) {}
              continue;
            }
            var val = r && r.result ? r.result.value : undefined;
            if (val === 'ij-find patch installed' || val === 'already patched') {
              results.push('ok:' + w.id + ':' + val);
              try {
                await w.webContents.debugger.sendCommand('Runtime.addBinding', { name: ${JSON.stringify(RENDERER_BINDING)} });
                w.webContents.debugger.on('message', function (ev, method, params) {
                  if (method === 'Runtime.bindingCalled' && params && params.name === ${JSON.stringify(RENDERER_BINDING)}) {
                    if (typeof global.${BRIDGE_BINDING} === 'function') {
                      global.${BRIDGE_BINDING}(params.payload);
                    }
                  }
                });
              } catch (eb) { results.push('bind-err:' + w.id + ':' + eb.message); }
            } else {
              var type = r && r.result ? r.result.type : 'no-result';
              results.push('skip:' + w.id + ':type=' + type + ':val=' + String(val));
              try { w.webContents.debugger.detach(); } catch (e3) {}
            }
          } catch (e) { results.push('err:' + w.id + ':' + e.message); }
        }
        return results.join(' | ');
      })()
    `.trim();

    const resp = await this.send('Runtime.evaluate', {
      expression: injectScript,
      includeCommandLineAPI: true,
      returnByValue: true,
      awaitPromise: true,
    });
    const report = resp?.result?.value ?? '(no result)';
    this.log.appendLine(`Injection: ${report}`);
    if (!/\bok:/.test(String(report))) {
      throw new Error(`Renderer patch did not install: ${report}`);
    }
    // Immediately sample renderer state via __ijFindStatus to confirm DOM install.
    try {
      const status = await this.evalInAllWindowsCollect(
        `(function(){ try { return window.__ijFindStatus ? window.__ijFindStatus() : 'no-status-fn'; } catch(e){ return 'status-throw:' + (e && e.message); } })()`,
      );
      this.log.appendLine(`Post-install status: ${status}`);
    } catch (e) {
      this.log.appendLine(`Post-install status probe failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private handleWsMessage(data: WebSocket.RawData) {
    let msg: any;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const cb = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      cb(msg);
      return;
    }
    if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === BRIDGE_BINDING) {
      this.handleRendererEvent(String(msg.params.payload));
    }
  }

  private handleRendererEvent(payload: string) {
    let evt: RendererEvent;
    try { evt = JSON.parse(payload); } catch { return; }
    switch (evt.type) {
      case 'search': void this.runSearch(evt.options); break;
      case 'cancel': this.cancelActive(); break;
      case 'openFile': void this.openFile(evt.uri, evt.line, evt.column, false); break;
      case 'previewFile': void this.openFile(evt.uri, evt.line, evt.column, true); break;
      case 'requestPreview': void this.sendPreview(evt.uri, evt.line, evt.contextLines, evt.ranges); break;
      case 'openInSideEditor': void this.openInSideEditor(evt.uri, evt.line, evt.column, true, true); break;
      case 'pinInSideEditor': void this.openInSideEditor(evt.uri, evt.line, evt.column, false, false); break;
      case 'requestHover': void this.sendHover(evt.reqId, evt.uri, evt.line, evt.column, evt.x, evt.y); break;
      case 'runCommand': void this.runHoverCommand(evt.command, evt.args); break;
      case 'saveFile': void this.saveFile(evt.uri, evt.content); break;
      case 'log': this.log.appendLine(`[renderer] ${evt.msg}`); break;
    }
  }

  private async openInSideEditor(uriStr: string, line: number, column: number, preview: boolean, preserveFocus: boolean) {
    try {
      const uri = vscode.Uri.parse(uriStr);
      const doc = await vscode.workspace.openTextDocument(uri);
      const pos = new vscode.Position(Math.max(0, line), Math.max(0, column));
      // Open in Beside; the renderer immediately hides that editor-group
      // container so the user never sees a new column/tab. We steal the
      // monaco widget out of the hidden group. The widget shares VSCode's
      // TextModel, so edits in our preview propagate to any tab the user
      // already has open on the same file (and vice-versa).
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus,
        preview,
        selection: new vscode.Range(pos, pos),
      });
    } catch (err) {
      this.log.appendLine(`openInSideEditor failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async saveFile(uriStr: string, content: string) {
    try {
      const uri = vscode.Uri.parse(uriStr);
      // Use a WorkspaceEdit so VSCode's edit pipeline tracks the change (undo
      // history, dirty state on any open editor, etc). Fall back to direct
      // fs.writeFile if applyEdit fails.
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, fullRange, content);
      const ok = await vscode.workspace.applyEdit(edit);
      if (ok) {
        const refreshed = await vscode.workspace.openTextDocument(uri);
        await refreshed.save();
      } else {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      }
      vscode.window.setStatusBarMessage(
        `IJ Find: saved ${vscode.workspace.asRelativePath(uri)}`, 2000,
      );
    } catch (err) {
      this.log.appendLine(`saveFile failed: ${err instanceof Error ? err.message : err}`);
      vscode.window.showErrorMessage(`Save failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async runHoverCommand(command: string, args: unknown[]) {
    if (typeof command !== 'string' || !command) { return; }
    try {
      const safeArgs = Array.isArray(args) ? args : (args === undefined || args === null ? [] : [args]);
      await vscode.commands.executeCommand(command, ...safeArgs);
    } catch (err) {
      this.log.appendLine(`runHoverCommand(${command}) failed: ${err instanceof Error ? err.message : err}`);
      vscode.window.showErrorMessage(`Command failed: ${command}`);
    }
  }

  private async sendPreview(uriStr: string, line: number, _contextLines: number, ranges: MatchRange[] | undefined) {
    try {
      const uri = vscode.Uri.parse(uriStr);
      const doc = await vscode.workspace.openTextDocument(uri);
      const allLines = doc.getText().split(/\r?\n/);
      // Send the entire file. Cap at 10k lines to avoid massive payloads /
      // DOM blowups; for huge files we still fall back to a window around the
      // focus line.
      const HARD_CAP = 10000;
      let lines: PreviewLine[];
      if (allLines.length <= HARD_CAP) {
        lines = allLines.map((text, lineNumber) => ({ lineNumber, text: text ?? '' }));
      } else {
        const half = Math.floor(HARD_CAP / 2);
        const start = Math.max(0, line - half);
        const end = Math.min(allLines.length, start + HARD_CAP);
        lines = [];
        for (let i = start; i < end; i++) {
          lines.push({ lineNumber: i, text: allLines[i] ?? '' });
        }
      }
      const relPath = vscode.workspace.asRelativePath(uri, false);
      await this.postToRenderer({
        type: 'preview',
        uri: uriStr,
        relPath,
        focusLine: line,
        ranges,
        lines,
        languageId: doc.languageId,
      });
    } catch (err) {
      this.log.appendLine(`preview fetch failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async sendHover(reqId: number, uriStr: string, line: number, column: number, x: number, y: number) {
    try {
      const uri = vscode.Uri.parse(uriStr);
      // Make sure the document is loaded so language services pick it up.
      await vscode.workspace.openTextDocument(uri);
      const pos = new vscode.Position(line, column);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider', uri, pos,
      );
      // Preserve markdown structure: each hover provider's contents become one
      // group, joined into a single markdown string (with code-fences for
      // MarkedString language hints). Groups are sent separately so the
      // renderer can place a horizontal rule between them, matching the real
      // hover widget.
      // Build per-hover groups, preserving the trust flag for each
      // MarkdownString. Trusted markdown gets its `command:` links activated;
      // untrusted gets them rendered as inert text. This mirrors how VSCode's
      // own hover widget treats command links.
      const groups: HoverContent[] = [];
      if (hovers) {
        for (const h of hovers) {
          const parts: HoverContent[] = [];
          for (const c of h.contents) {
            if (typeof c === 'string') {
              parts.push({ value: c, isTrusted: false });
            } else if (c instanceof vscode.MarkdownString) {
              const trustedRaw = (c as any).isTrusted;
              const isTrusted = trustedRaw === true ||
                (typeof trustedRaw === 'object' && trustedRaw !== null);
              const allowedCommands = (typeof trustedRaw === 'object' && trustedRaw !== null && Array.isArray(trustedRaw.enabledCommands))
                ? trustedRaw.enabledCommands as readonly string[]
                : undefined;
              parts.push({ value: c.value, isTrusted, allowedCommands });
            } else if (c && typeof (c as any).language === 'string' && typeof (c as any).value === 'string') {
              parts.push({
                value: '```' + (c as any).language + '\n' + (c as any).value + '\n```',
                isTrusted: false,
              });
            } else if (c && typeof (c as any).value === 'string') {
              parts.push({ value: (c as any).value, isTrusted: false });
            }
          }
          const valid = parts.filter((p) => p.value && p.value.trim().length > 0);
          if (valid.length === 0) { continue; }
          groups.push({
            value: valid.map((p) => p.value).join('\n\n').trim(),
            isTrusted: valid.some((p) => p.isTrusted),
            allowedCommands: valid.flatMap((p) => p.allowedCommands ?? []) as readonly string[],
          });
        }
      }
      const contents = groups.filter((g) => g.value.length > 0);
      await this.postToRenderer({ type: 'hover', reqId, uri: uriStr, line, column, x, y, contents });
    } catch (err) {
      this.log.appendLine(`hover fetch failed: ${err instanceof Error ? err.message : err}`);
      await this.postToRenderer({ type: 'hover', reqId, uri: uriStr, line, column, x, y, contents: [] });
    }
  }

  private cancelActive() {
    if (this.activeSearch) {
      this.activeSearch.cancel();
      this.activeSearch.dispose();
      this.activeSearch = undefined;
    }
  }

  private async runSearch(options: SearchOptions) {
    this.cancelActive();
    const cts = new vscode.CancellationTokenSource();
    this.activeSearch = cts;
    await this.postToRenderer({ type: 'results:start' });
    try {
      await runSearch(options, cts.token, {
        onFile: (m) => { if (!cts.token.isCancellationRequested) { void this.postToRenderer({ type: 'results:file', match: m }); } },
        onDone: (s) => { if (!cts.token.isCancellationRequested) { void this.postToRenderer({ type: 'results:done', ...s }); } },
        onError: (e) => { void this.postToRenderer({ type: 'results:error', message: e.message }); },
      });
    } finally {
      if (this.activeSearch === cts) {
        this.activeSearch.dispose();
        this.activeSearch = undefined;
      }
    }
  }

  private async postToRenderer(msg: OverlayMessage) {
    if (this.activeWindowId === undefined) { return; }
    const payload = JSON.stringify(msg);
    const js = `try { window.__ijFindOnMessage && window.__ijFindOnMessage(${payload}); } catch (e) {}`;
    await this.evalInWindow(this.activeWindowId, js);
  }

  private async evalInAllWindows(expr: string) {
    const script = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var wins = BW.getAllWindows();
        for (var i = 0; i < wins.length; i++) {
          try {
            await wins[i].webContents.debugger.sendCommand('Runtime.evaluate', { expression: ${JSON.stringify(expr)} });
          } catch (e) {}
        }
      })()
    `.trim();
    await this.send('Runtime.evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    });
  }

  private async openFile(uriStr: string, line: number, column: number, preview: boolean) {
    try {
      const uri = vscode.Uri.parse(uriStr);
      const doc = await vscode.workspace.openTextDocument(uri);
      const pos = new vscode.Position(Math.max(0, line), Math.max(0, column));
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: preview,
        preview,
        selection: new vscode.Range(pos, pos),
      });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to open file: ${err instanceof Error ? err.message : err}`);
    }
  }

  private send(method: string, params: any): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP WebSocket is not open'));
    }
    const id = this.msgId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (resp) => {
        if (resp.error) { reject(new Error(resp.error.message || 'CDP error')); }
        else { resolve(resp.result); }
      });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  private findMainPid(): number | null {
    // Match the Electron main process of VSCode on macOS/Linux via `ps`.
    // Accepts stable, insiders, OSS, and raw Electron dev-host binaries.
    try {
      const out = execSync('ps -o pid=,command= -ax', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      const lines = out.split('\n');
      const patterns: RegExp[] = [
        /\/Visual Studio Code\.app\/Contents\/MacOS\/(?:Electron|Code)\s*$/,
        /\/Visual Studio Code - Insiders\.app\/Contents\/MacOS\/(?:Electron|Code - Insiders)\s*$/,
        /\/VSCodium\.app\/Contents\/MacOS\/(?:Electron|VSCodium)\s*$/,
        /\/Code - OSS\.app\/Contents\/MacOS\/(?:Electron|Code - OSS)\s*$/,
        /\/Electron\.app\/Contents\/MacOS\/Electron\s*$/,
      ];
      for (const line of lines) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!m) { continue; }
        const cmd = m[2];
        if (/Helper/.test(cmd)) { continue; }
        if (patterns.some((p) => p.test(cmd))) {
          return parseInt(m[1], 10);
        }
      }
    } catch (e) {
      this.log.appendLine(`findMainPid ps error: ${e instanceof Error ? e.message : e}`);
    }
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => { req.destroy(new Error('HTTP timeout')); });
  });
}
