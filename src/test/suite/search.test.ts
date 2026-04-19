import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';
import type { FileMatch } from '../../search';

const EXTENSION_ID = 'newdlops.intellij-styled-search';

async function getApi(): Promise<ExtensionTestApi> {
  const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
  assert.ok(ext);
  return ext.activate();
}

function relPaths(matches: FileMatch[]): string[] {
  return matches.map((m) => m.relPath).sort();
}

suite('Search — engine end-to-end against fixture workspace', () => {
  suiteSetup(async function () {
    this.timeout(60_000);
    const { overlay } = await getApi();
    await overlay.rebuildIndex();
    await overlay.waitForIndexReady(30_000);
  });

  test('literal single-line match returns exactly the expected file', async () => {
    const { overlay } = await getApi();
    const matches = await overlay.searchForTests({
      query: 'class AlphaService:',
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    const files = relPaths(matches);
    assert.deepStrictEqual(
      files,
      ['alpha.py'],
      `expected only alpha.py to match, got ${JSON.stringify(files)}`,
    );
    const m = matches[0].matches[0];
    assert.strictEqual(m.line, 0, 'class AlphaService should live on line 0');
  });

  test('candidate narrowing does not drop correct file (regression: --files-from bug)', async () => {
    // Regression for the period where rg was invoked with --files-from=-
    // via stdin and silently returned 0 matches for every narrowed query.
    // Narrowing to a single file must still hand the file to rg correctly.
    const { overlay } = await getApi();
    const matches = await overlay.searchForTests({
      query: 'class BetaWidget',
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    assert.ok(matches.length > 0, 'expected at least one match');
    assert.deepStrictEqual(relPaths(matches), ['beta.js']);
  });

  test('multi-line literal match sets endLine/endCol on the range', async () => {
    // The fixture's docs.md has a 3-line blockquote we can reach for.
    const { overlay } = await getApi();
    const query = [
      '> Line one of the pull quote.',
      '> Line two continues here.',
      '> Line three wraps up.',
    ].join('\n');
    const matches = await overlay.searchForTests({
      query,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    assert.deepStrictEqual(relPaths(matches), ['docs.md']);
    const range = matches[0].matches[0].ranges[0];
    assert.ok(
      typeof (range as { endLine?: number }).endLine === 'number',
      'multi-line range must carry endLine for preview-side highlighting',
    );
    const endLine = (range as { endLine: number }).endLine;
    assert.ok(endLine > matches[0].matches[0].line, 'endLine should be past match start');
  });

  test('multi-line literal with indentation matches exactly', async () => {
    const { overlay } = await getApi();
    const query = [
      '    def process(self, data: str) -> str:',
      '        self.counter += 1',
    ].join('\n');
    const matches = await overlay.searchForTests({
      query,
      caseSensitive: true,
      wholeWord: false,
      useRegex: false,
    });
    assert.deepStrictEqual(relPaths(matches), ['alpha.py']);
  });

  test('case-sensitive literal search respects case', async () => {
    const { overlay } = await getApi();
    const exact = await overlay.searchForTests({
      query: 'BETA_DEFAULT',
      caseSensitive: true,
      wholeWord: false,
      useRegex: false,
    });
    assert.deepStrictEqual(relPaths(exact), ['beta.js']);

    const wrongCase = await overlay.searchForTests({
      query: 'beta_default',
      caseSensitive: true,
      wholeWord: false,
      useRegex: false,
    });
    assert.deepStrictEqual(wrongCase, [], 'wrong-case literal query should not match');
  });

  test('include pattern scopes search to matching files', async () => {
    const { overlay } = await getApi();
    const matches = await overlay.searchForTests({
      query: 'class',
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
      includePatterns: ['**/*.py'],
    });
    assert.deepStrictEqual(relPaths(matches), ['alpha.py']);
  });

  test('directory include pattern scopes search to nested subtree', async () => {
    const { overlay } = await getApi();
    const matches = await overlay.searchForTests({
      query: 'DirectoryScopedThing',
      caseSensitive: true,
      wholeWord: false,
      useRegex: false,
      includePatterns: ['nested/'],
    });
    assert.deepStrictEqual(relPaths(matches), ['nested/delta.js']);
  });

  test('UTF-8 / Korean literal hits docs.md', async () => {
    const { overlay } = await getApi();
    const matches = await overlay.searchForTests({
      query: '한국어 지원',
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    assert.deepStrictEqual(relPaths(matches), ['docs.md']);
  });

  test('query with no matching files returns empty result set', async () => {
    const { overlay } = await getApi();
    const matches = await overlay.searchForTests({
      query: 'thisStringDefinitelyDoesNotExistInFixture_zzz_42',
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    assert.deepStrictEqual(matches, [], 'expected no matches');
  });
});
