import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';

const EXTENSION_ID = 'newdlops.intellij-styled-search';

async function getApi(): Promise<ExtensionTestApi> {
  const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
  assert.ok(ext, `extension ${EXTENSION_ID} not registered`);
  const api = await ext.activate();
  assert.ok(api, 'extension activate() returned no api');
  return api;
}

suite('Activation', () => {
  test('extension is present and activates', async function () {
    this.timeout(15_000);
    const api = await getApi();
    assert.ok(api.overlay, 'overlay was not exposed on ext.exports');
  });

  test('commands are registered', async () => {
    await getApi();
    const expected = [
      'intellijStyledSearch.searchInProject',
      'intellijStyledSearch.searchSelection',
      'intellijStyledSearch.reinject',
      'intellijStyledSearch.rebuildIndex',
      'intellijStyledSearch.switchEngine',
      'intellijStyledSearch.showZoektInfo',
      'intellijStyledSearch.explainZoektQuery',
      'intellijStyledSearch.diagnoseFileInIndex',
    ];
    const all = await vscode.commands.getCommands(true);
    for (const cmd of expected) {
      assert.ok(all.includes(cmd), `command ${cmd} not registered`);
    }
  });

  test('trigram index reaches ready state on fixture workspace', async function () {
    // Default engine is zoekt. A rebuild should make the Rust engine ready
    // without falling back to codesearch.
    this.timeout(60_000);
    const { overlay } = await getApi();
    await overlay.rebuildIndex();
    await overlay.waitForIndexReady(30_000);
    const result = await overlay.searchForTestsDetailed({
      query: 'class AlphaService:',
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    assert.strictEqual(result.requestedEngine, 'zoekt');
    assert.strictEqual(result.effectiveEngine, 'zoekt');
  });
});
