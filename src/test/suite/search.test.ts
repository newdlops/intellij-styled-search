import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';
import {
  getConfiguredExcludeGlobs,
  getConfiguredSearchEngine,
  type FileMatch,
  type SearchForTestsResult,
} from '../../search';
import { extractTrigramsLower } from '../../trigramIndex';

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

function formatEngineRoute(result: SearchForTestsResult): string {
  return [
    `requested=${result.requestedEngine}`,
    `effective=${result.effectiveEngine}`,
    `fallback=${result.fallbackReason ?? 'none'}`,
  ].join(' ');
}

suite('Search — engine end-to-end against fixture workspace', () => {
  suiteSetup(async function () {
    this.timeout(60_000);
    const { overlay } = await getApi();
    await overlay.rebuildIndex();
    await overlay.waitForIndexReady(30_000);
  });

  test('search engine setting accepts zoekt and codesearch, defaulting invalid values to zoekt', () => {
    const cfg = (value: string) => ({
      get: <T>(_key: string, _fallback: T) => value as T,
    }) as vscode.WorkspaceConfiguration;

    assert.strictEqual(getConfiguredSearchEngine(cfg('zoekt')), 'zoekt');
    assert.strictEqual(getConfiguredSearchEngine(cfg('codesearch')), 'codesearch');
    assert.strictEqual(getConfiguredSearchEngine(cfg('bad-value')), 'zoekt');
  });

  test('configured excludes default to empty and are not engine performance policy', () => {
    const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
    const properties = ext?.packageJSON?.contributes?.configuration?.properties ?? {};
    const packageDefault = properties['intellijStyledSearch.excludeGlobs']?.default ?? [];
    assert.deepStrictEqual(packageDefault, [], 'package default excludes must stay empty');
    const emptyCfg = {
      get: <T>(_key: string, fallback: T) => fallback,
    } as vscode.WorkspaceConfiguration;
    assert.deepStrictEqual(getConfiguredExcludeGlobs(emptyCfg), [], 'effective configured excludes default to empty');
  });

  test('fixture workspace searches execute via zoekt without fallback', async () => {
    const { overlay } = await getApi();
    const result = await overlay.searchForTestsDetailed({
      query: 'class AlphaService:',
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    console.log(`[zoek-e2e] ${formatEngineRoute(result)}`);
    assert.strictEqual(result.requestedEngine, 'zoekt');
    assert.strictEqual(
      result.effectiveEngine,
      'zoekt',
      `expected fixture search to stay on zoekt; ${formatEngineRoute(result)}`,
    );
    assert.deepStrictEqual(relPaths(result.matches), ['alpha.py']);
  });

  test('zoekt applies explicit configured excludes without baking in default excludes', async function () {
    this.timeout(60_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const prior = cfg.inspect<string[]>('excludeGlobs');
    const cacheDir = vscode.Uri.joinPath(folder!.uri, '.mypy_cache', '3.11');
    const generated = vscode.Uri.joinPath(cacheDir, 'ijss-default-exclude.data.json');
    const needle = `ijss_default_exclude_token_${Date.now()}`;

    try {
      await vscode.workspace.fs.createDirectory(cacheDir);
      await vscode.workspace.fs.writeFile(generated, Buffer.from(`${needle}\n`, 'utf8'));
      await overlay.rebuildIndex();
      await overlay.waitForIndexReady(30_000);

      const withoutExclude = await overlay.searchForTestsDetailed({
        query: needle,
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      });
      assert.strictEqual(withoutExclude.effectiveEngine, 'zoekt', `expected zoekt; ${formatEngineRoute(withoutExclude)}`);
      assert.deepStrictEqual(
        relPaths(withoutExclude.matches),
        ['.mypy_cache/3.11/ijss-default-exclude.data.json'],
        'zoekt must not hide cache paths unless the user configured an exclude',
      );

      await cfg.update('excludeGlobs', ['**/.mypy_cache/**'], vscode.ConfigurationTarget.Workspace);
      const withExplicitExclude = await overlay.searchForTestsDetailed({
        query: needle,
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      });
      assert.strictEqual(withExplicitExclude.effectiveEngine, 'zoekt', `expected zoekt; ${formatEngineRoute(withExplicitExclude)}`);
      assert.deepStrictEqual(relPaths(withExplicitExclude.matches), []);
    } finally {
      await cfg.update('excludeGlobs', prior?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder!.uri, '.mypy_cache'), { recursive: true }); } catch {}
      await overlay.rebuildIndex();
      await overlay.waitForIndexReady(30_000);
    }
  });

  test('zoekt index reflects saved edits before the next search', async function () {
    this.timeout(60_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const generated = vscode.Uri.joinPath(folder!.uri, 'edit-resilience.txt');
    const before = 'edit_resilience_before_token';
    const after = 'edit_resilience_after_token';

    try {
      await vscode.workspace.fs.writeFile(generated, Buffer.from(`${before}\n`, 'utf8'));
      await overlay.rebuildIndex();
      await overlay.waitForIndexReady(30_000);

      const beforeResult = await overlay.searchForTestsDetailed({
        query: before,
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      });
      assert.strictEqual(beforeResult.effectiveEngine, 'zoekt', `expected zoekt before edit; ${formatEngineRoute(beforeResult)}`);
      assert.deepStrictEqual(relPaths(beforeResult.matches), ['edit-resilience.txt']);

      const doc = await vscode.workspace.openTextDocument(generated);
      const fullRange = new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(generated, fullRange, `${after}\n`);
      assert.strictEqual(await vscode.workspace.applyEdit(edit), true, 'expected edit to apply');
      assert.strictEqual(await doc.save(), true, 'expected edited document to save');

      const afterResult = await overlay.searchForTestsDetailed({
        query: after,
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      });
      assert.strictEqual(afterResult.effectiveEngine, 'zoekt', `expected zoekt after edit; ${formatEngineRoute(afterResult)}`);
      assert.deepStrictEqual(relPaths(afterResult.matches), ['edit-resilience.txt']);

      const staleResult = await overlay.searchForTestsDetailed({
        query: before,
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      });
      assert.deepStrictEqual(relPaths(staleResult.matches), []);
    } finally {
      try { await vscode.workspace.fs.delete(generated, { useTrash: false }); } catch {}
      await overlay.rebuildIndex();
      await overlay.waitForIndexReady(30_000);
    }
  });

  test('zoekt workspace sync survives branch-like modify, create, and delete', async function () {
    this.timeout(60_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const gitFile = vscode.Uri.joinPath(folder!.uri, '.git');
    const gitStore = vscode.Uri.joinPath(folder!.uri, '.branch-sync-git');
    const gitRefs = vscode.Uri.joinPath(gitStore, 'refs', 'heads');
    const gitMainRef = vscode.Uri.joinPath(gitRefs, 'main');
    const gitFeatureRef = vscode.Uri.joinPath(gitRefs, 'feature');
    const modified = vscode.Uri.joinPath(folder!.uri, 'branch-sync-modified.txt');
    const deleted = vscode.Uri.joinPath(folder!.uri, 'branch-sync-deleted.txt');
    const created = vscode.Uri.joinPath(folder!.uri, 'branch-sync-created.txt');
    const before = 'branch_sync_before_token';
    const after = 'branch_sync_after_token';
    const removed = 'branch_sync_removed_token';
    const added = 'branch_sync_added_token';

    const cleanup = async () => {
      for (const uri of [modified, deleted, created, gitFile, gitStore]) {
        try { await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false }); } catch {}
      }
    };

    try {
      await cleanup();
      await vscode.workspace.fs.createDirectory(gitRefs);
      await vscode.workspace.fs.writeFile(gitFile, Buffer.from('gitdir: .branch-sync-git\n', 'utf8'));
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(gitStore, 'HEAD'), Buffer.from('ref: refs/heads/main\n', 'utf8'));
      await vscode.workspace.fs.writeFile(gitMainRef, Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', 'utf8'));
      await vscode.workspace.fs.writeFile(modified, Buffer.from(`${before}\n`, 'utf8'));
      await vscode.workspace.fs.writeFile(deleted, Buffer.from(`${removed}\n`, 'utf8'));
      await overlay.rebuildIndex();
      await overlay.waitForIndexReady(30_000);

      const initial = await overlay.searchForTestsDetailed({
        query: before,
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      });
      assert.strictEqual(initial.effectiveEngine, 'zoekt', `expected zoekt on initial branch; ${formatEngineRoute(initial)}`);
      assert.deepStrictEqual(relPaths(initial.matches), ['branch-sync-modified.txt']);

      await vscode.workspace.fs.writeFile(gitFeatureRef, Buffer.from('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n', 'utf8'));
      await vscode.workspace.fs.writeFile(gitFile, Buffer.from('gitdir: .branch-sync-git\n', 'utf8'));
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(gitStore, 'HEAD'), Buffer.from('ref: refs/heads/feature\n', 'utf8'));
      await vscode.workspace.fs.writeFile(modified, Buffer.from(`${after}\n`, 'utf8'));
      await vscode.workspace.fs.writeFile(created, Buffer.from(`${added}\n`, 'utf8'));
      await vscode.workspace.fs.delete(deleted, { useTrash: false });

      const afterResult = await overlay.searchForTestsDetailed({
        query: after,
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      });
      assert.strictEqual(afterResult.effectiveEngine, 'zoekt', `expected zoekt after branch-like change; ${formatEngineRoute(afterResult)}`);
      assert.deepStrictEqual(relPaths(afterResult.matches), ['branch-sync-modified.txt']);

      const addedResult = await overlay.searchForTestsDetailed({
        query: added,
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      });
      assert.deepStrictEqual(relPaths(addedResult.matches), ['branch-sync-created.txt']);

      const staleBefore = await overlay.searchForTestsDetailed({
        query: before,
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      });
      assert.deepStrictEqual(relPaths(staleBefore.matches), []);

      const staleRemoved = await overlay.searchForTestsDetailed({
        query: removed,
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      });
      assert.deepStrictEqual(relPaths(staleRemoved.matches), []);
    } finally {
      await cleanup();
      await overlay.rebuildIndex();
      await overlay.waitForIndexReady(30_000);
    }
  });

  test('rebuildIndex follows codesearch setting and repopulates the trigram cache', async function () {
    this.timeout(60_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const prior = cfg.inspect<string>('engine');
    const generated = vscode.Uri.joinPath(folder!.uri, 'rebuild-codesearch.txt');
    const query = 'codesearch_rebuild_marker_token';

    try {
      await cfg.update('engine', 'codesearch', vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.fs.writeFile(generated, Buffer.from(`export const VALUE = "${query}";\n`, 'utf8'));
      await overlay.rebuildIndex();
      await overlay.waitForIndexReady(30_000);

      const diagnosis = overlay.getTrigramIndex().diagnoseFile(
        generated.toString(),
        extractTrigramsLower(query),
      );
      assert.ok(diagnosis.inIndex, 'expected generated file to be present in the trigram index after rebuild');
      assert.ok(diagnosis.presentInFile > 0, 'expected generated file to contribute trigrams after rebuild');

      const result = await overlay.searchForTestsDetailed({
        query,
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      });
      console.log(`[rebuild-e2e] ${formatEngineRoute(result)}`);
      assert.strictEqual(result.requestedEngine, 'codesearch');
      assert.strictEqual(result.effectiveEngine, 'codesearch');
      assert.deepStrictEqual(relPaths(result.matches), ['rebuild-codesearch.txt']);
    } finally {
      try { await vscode.workspace.fs.delete(generated); } catch {}
      await cfg.update('engine', prior?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      await overlay.rebuildIndex();
      await overlay.waitForIndexReady(30_000);
    }
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

  test('regex search spans lines and ignores case by default', async () => {
    const { overlay } = await getApi();
    const matches = await overlay.searchForTests({
      query: 'line one of the pull quote.*LINE THREE WRAPS UP',
      caseSensitive: false,
      wholeWord: false,
      useRegex: true,
    });
    assert.deepStrictEqual(relPaths(matches), ['docs.md']);
    const range = matches[0].matches[0].ranges[0];
    assert.ok(
      typeof (range as { endLine?: number }).endLine === 'number',
      'regex match that crosses lines must carry endLine for highlighting',
    );

    const wrongCase = await overlay.searchForTests({
      query: 'line one of the pull quote.*LINE THREE WRAPS UP',
      caseSensitive: true,
      wholeWord: false,
      useRegex: true,
    });
    assert.deepStrictEqual(wrongCase, [], 'case-sensitive regex should not match wrong-case text');
  });

  test('regex single-line mode does not span lines', async () => {
    const { overlay } = await getApi();
    const matches = await overlay.searchForTests({
      query: 'line one of the pull quote.*LINE THREE WRAPS UP',
      caseSensitive: false,
      wholeWord: false,
      useRegex: true,
      regexMultiline: false,
    });
    assert.deepStrictEqual(matches, [], 'single-line regex should not cross newline boundaries');
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

  test('exclude pattern removes files from scoped search', async () => {
    const { overlay } = await getApi();
    const matches = await overlay.searchForTests({
      query: 'class',
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
      excludePatterns: ['nested/'],
    });
    assert.deepStrictEqual(relPaths(matches), [
      'alpha.py',
      'beta.js',
      'callgraph_external_api.js',
      'callgraph_external_consumer.js',
      'docs.md',
    ]);
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
  test('multi-line literal candidatesFor returns narrowed set including the matching file', async function () {
    this.timeout(60_000);
    const { overlay } = await getApi();
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const prior = cfg.inspect<string>('engine');

    try {
      await cfg.update('engine', 'codesearch', vscode.ConfigurationTarget.Workspace);
      await overlay.rebuildIndex();
      await overlay.waitForIndexReady(30_000);

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
    } finally {
      await cfg.update('engine', prior?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      await overlay.rebuildIndex();
      await overlay.waitForIndexReady(30_000);
    }
  });
});
