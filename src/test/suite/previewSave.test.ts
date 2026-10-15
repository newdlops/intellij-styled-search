import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';

suite('Preview save integrity', () => {
  async function withDocument(check: (
    doc: vscode.TextDocument,
    save: (content: string, expectedHash?: string) => Promise<any>,
    initialHash: string,
  ) => Promise<void>): Promise<void> {
    const extension = vscode.extensions.getExtension<ExtensionTestApi>('newdlops.intellij-styled-search');
    assert.ok(extension);
    const { overlay } = await extension.activate();
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ijss-preview-save-'));
    const uri = vscode.Uri.file(path.join(root, 'source.txt'));
    const original = 'initial content\n';
    await fs.promises.writeFile(uri.fsPath, original);
    const doc = await vscode.workspace.openTextDocument(uri);
    const save = (content: string, expectedHash?: string) =>
      (overlay as any).saveFile(uri.toString(), content, expectedHash);
    try {
      const initial = await save(original);
      assert.strictEqual(initial.ok, true);
      await check(doc, save, initial.documentHash);
    } finally {
      // Discard only the document created by this test before removing it.
      if (doc.isDirty) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), original);
        await vscode.workspace.applyEdit(edit);
        await doc.save();
      }
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }

  async function editDocument(doc: vscode.TextDocument, content: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
    assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
    assert.strictEqual(doc.isDirty, true);
  }

  test('saves preview edits already present in the shared document model', async () => {
    await withDocument(async (doc, save, initialHash) => {
      const edited = 'updated by the native preview\n';
      await editDocument(doc, edited);
      assert.strictEqual(await fs.promises.readFile(doc.uri.fsPath, 'utf8'), 'initial content\n');

      const result = await save(edited, initialHash);
      assert.strictEqual(result.ok, true, JSON.stringify(result));
      assert.strictEqual(result.actualContent, edited);
      assert.notStrictEqual(result.documentHash, initialHash);
      assert.strictEqual(doc.isDirty, false);
      assert.strictEqual(await fs.promises.readFile(doc.uri.fsPath, 'utf8'), edited);
    });
  });

  test('rejects different concurrent edits without overwriting the document or disk', async () => {
    await withDocument(async (doc, save, initialHash) => {
      const concurrent = 'changed by another editor\n';
      await editDocument(doc, concurrent);

      const result = await save('stale preview edit\n', initialHash);
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /file changed after this preview was loaded/);
      assert.strictEqual(doc.getText(), concurrent);
      assert.strictEqual(doc.isDirty, true);
      assert.strictEqual(await fs.promises.readFile(doc.uri.fsPath, 'utf8'), 'initial content\n');
    });
  });
});
