import * as vscode from 'vscode';
import { OverlayPanel } from './overlayPanel';
import type { SearchEngine } from './search';

/** Shape exposed via `ext.exports` for integration / E2E tests. Plain
 *  production consumers don't need to touch this. */
export interface ExtensionTestApi {
  overlay: OverlayPanel;
}

export function activate(context: vscode.ExtensionContext): ExtensionTestApi {
  const overlay = OverlayPanel.get(context);
  overlay.logActivation();
  // Warm CDP + patch install in the background so the first user command
  // doesn't eat the SIGUSR1 / WebSocket / inject round-trip itself.
  void overlay.prewarm();

  context.subscriptions.push(
    vscode.commands.registerCommand('intellijStyledSearch.searchInProject', () => {
      overlay.logCommand('searchInProject');
      void overlay.show('');
    }),
    vscode.commands.registerCommand('intellijStyledSearch.searchSelection', () => {
      overlay.logCommand('searchSelection');
      void overlay.show(getQueryFromActiveEditor(), { forceLiteral: true });
    }),
    vscode.commands.registerCommand('intellijStyledSearch.reinject', async () => {
      overlay.logCommand('reinject');
      await overlay.forceReinject();
      vscode.window.showInformationMessage('IntelliJ Styled Search: re-injected.');
    }),
    vscode.commands.registerCommand('intellijStyledSearch.rebuildIndex', async () => {
      overlay.logCommand('rebuildIndex');
      try {
        await overlay.rebuildIndex();
        vscode.window.showInformationMessage('IntelliJ Styled Search: index rebuilt.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Index rebuild failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('intellijStyledSearch.switchEngine', async () => {
      overlay.logCommand('switchEngine');
      const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
      const current = cfg.get<SearchEngine>('engine', 'zoekt') === 'codesearch' ? 'codesearch' : 'zoekt';
      const picked = await vscode.window.showQuickPick(
        [
          {
            label: 'zoekt',
            description: current === 'zoekt' ? 'Current' : 'Rust shard/mmap engine',
            target: 'zoekt' as SearchEngine,
          },
          {
            label: 'codesearch',
            description: current === 'codesearch' ? 'Current' : 'TypeScript trigram + ripgrep engine',
            target: 'codesearch' as SearchEngine,
          },
        ],
        {
          title: 'Switch Search Engine',
          placeHolder: `Current engine: ${current}`,
        },
      );
      if (!picked || picked.target === current) { return; }
      const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      try {
        await cfg.update('engine', picked.target, target);
        await overlay.rebuildIndex();
        vscode.window.showInformationMessage(`IntelliJ Styled Search: switched engine to ${picked.target}.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Search engine switch failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('intellijStyledSearch.showZoektInfo', async () => {
      overlay.logCommand('showZoektInfo');
      await overlay.showZoektInfo();
    }),
    vscode.commands.registerCommand('intellijStyledSearch.explainZoektQuery', async () => {
      overlay.logCommand('explainZoektQuery');
      const query = await vscode.window.showInputBox({
        prompt: 'Query to explain with zoek-rs',
        value: getQueryFromActiveEditor(),
        placeHolder: 'e.g. class AlphaService:',
      });
      if (query === undefined) { return; }
      await overlay.explainZoektQuery({
        query,
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      });
    }),
    vscode.commands.registerCommand('intellijStyledSearch.diagnoseFileInIndex', async () => {
      overlay.logCommand('diagnoseFileInIndex');
      const query = await vscode.window.showInputBox({
        prompt: 'Paste the query you expected to find in the active file',
        placeHolder: 'e.g. class EmailTemplateParameter(TypedDict):',
      });
      if (query === undefined) { return; }
      await overlay.diagnoseCurrentFile(query);
    }),
  );

  return { overlay };
}

export function deactivate() {}

function getQueryFromActiveEditor(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return ''; }
  const { selection, document } = editor;
  if (!selection.isEmpty) {
    // Pass the full multi-line selection through. Leading/trailing
    // whitespace and blank lines get trimmed — they're almost always
    // accidental when copy/selecting code, and rg's literal matcher
    // wouldn't match them against the file anyway.
    const text = document.getText(selection).replace(/^[\s\n]+|[\s\n]+$/g, '');
    if (text) { return text; }
  }
  const wordRange = document.getWordRangeAtPosition(selection.active);
  if (wordRange) { return document.getText(wordRange); }
  return '';
}
