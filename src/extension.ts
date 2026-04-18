import * as vscode from 'vscode';
import { OverlayPanel } from './overlayPanel';

export function activate(context: vscode.ExtensionContext) {
  const overlay = OverlayPanel.get(context);
  overlay.logActivation();

  context.subscriptions.push(
    vscode.commands.registerCommand('intellijStyledSearch.searchInProject', () => {
      overlay.logCommand('searchInProject');
      void overlay.show('');
    }),
    vscode.commands.registerCommand('intellijStyledSearch.searchSelection', () => {
      overlay.logCommand('searchSelection');
      void overlay.show(getQueryFromActiveEditor());
    }),
    vscode.commands.registerCommand('intellijStyledSearch.reinject', async () => {
      overlay.logCommand('reinject');
      await overlay.forceReinject();
      vscode.window.showInformationMessage('IntelliJ Styled Search: re-injected.');
    }),
  );
}

export function deactivate() {}

function getQueryFromActiveEditor(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return ''; }
  const { selection, document } = editor;
  if (!selection.isEmpty) {
    const text = document.getText(selection);
    if (text && !text.includes('\n')) { return text; }
    if (text) { return text.split('\n')[0]; }
  }
  const wordRange = document.getWordRangeAtPosition(selection.active);
  if (wordRange) { return document.getText(wordRange); }
  return '';
}
