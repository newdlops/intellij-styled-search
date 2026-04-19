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

function countMatchLines(matches: FileMatch[]): number {
  return matches.reduce((sum, m) => sum + m.matches.length, 0);
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

  test('default safety cap prevents unbounded result explosions', async function () {
    this.timeout(60_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const prior = cfg.inspect<number>('maxResults');
    const generated = vscode.Uri.joinPath(folder!.uri, 'generated-many-results.txt');
    const lines = Array.from({ length: 2500 }, (_, i) => `safetycap needle ${i}`).join('\n');

    try {
      await cfg.update('maxResults', 0, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.fs.writeFile(generated, Buffer.from(lines, 'utf8'));
      await overlay.rebuildIndex();
      await overlay.waitForIndexReady(30_000);

      const matches = await overlay.searchForTests({
        query: 'safetycap needle',
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      });

      assert.deepStrictEqual(relPaths(matches), ['generated-many-results.txt']);
      assert.strictEqual(
        countMatchLines(matches),
        2000,
        `expected built-in safety cap to truncate at 2000 match lines, got ${countMatchLines(matches)}`,
      );
    } finally {
      try { await vscode.workspace.fs.delete(generated); } catch {}
      await cfg.update('maxResults', prior?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      await overlay.rebuildIndex();
      await overlay.waitForIndexReady(30_000);
    }
  });

  test('offset + limit pages through large result sets without duplicating prior matches', async function () {
    this.timeout(60_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const generated = vscode.Uri.joinPath(folder!.uri, 'generated-paged-results.txt');
    const lines = Array.from({ length: 2500 }, (_, i) => `paged needle ${i}`).join('\n');

    try {
      await vscode.workspace.fs.writeFile(generated, Buffer.from(lines, 'utf8'));
      await overlay.rebuildIndex();
      await overlay.waitForIndexReady(30_000);

      const page1 = await overlay.searchForTests({
        query: 'paged needle',
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
        resultLimit: 2000,
      });
      const page2 = await overlay.searchForTests({
        query: 'paged needle',
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
        resultOffset: 2000,
        resultLimit: 2000,
      });

      assert.deepStrictEqual(relPaths(page1), ['generated-paged-results.txt']);
      assert.deepStrictEqual(relPaths(page2), ['generated-paged-results.txt']);
      assert.strictEqual(countMatchLines(page1), 2000, 'first page should stop at the batch size');
      assert.strictEqual(countMatchLines(page2), 500, 'second page should contain only the remaining matches');
      assert.strictEqual(page2[0].matches[0].line, 2000, 'second page should resume at line 2001 (0-based 2000)');
      assert.strictEqual(
        page2[0].matches[page2[0].matches.length - 1].line,
        2499,
        'second page should end at the last matching line',
      );
    } finally {
      try { await vscode.workspace.fs.delete(generated); } catch {}
      await overlay.rebuildIndex();
      await overlay.waitForIndexReady(30_000);
    }
  });

  // Regression: `candidatesFor` used to bail out for any query containing
  // '\n', forcing rg to scan every file in the workspace. On large
  // workspaces (e.g. 215K files with .venv) that was 3-8s per search.
  // Trigram intersection must return a narrowed candidate set for
  // multi-line literal queries — the block's long unique text is exactly
  // where narrowing wins big.
  test('multi-line literal candidatesFor returns narrowed set including the matching file', async () => {
    const { overlay } = await getApi();
    const idx = overlay.getTrigramIndex();
    const query = [
      '> Line one of the pull quote.',
      '> Line two continues here.',
      '> Line three wraps up.',
    ].join('\n');
    const { uris, reason } = idx.candidatesFor(query, {
      useRegex: false,
      caseSensitive: false,
      wholeWord: false,
    });
    assert.ok(uris !== null, `expected narrowed candidate set for multi-line literal, got null (reason=${reason})`);
    assert.ok(uris!.size > 0, `expected at least the matching file in candidates, got empty set (reason=${reason})`);
    assert.ok(uris!.size < idx.size, `narrowing should be stricter than the whole index; got size=${uris!.size}/${idx.size} reason=${reason}`);
    const docsMd = Array.from(uris!).find((u) => u.endsWith('/docs.md'));
    assert.ok(docsMd, `docs.md (the file containing the block) must be in candidate set; got ${JSON.stringify(Array.from(uris!).slice(0, 5))} reason=${reason}`);
  });
});
