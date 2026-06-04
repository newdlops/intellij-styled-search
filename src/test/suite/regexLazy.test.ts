import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';
import type { FileMatch, SearchForTestsResult } from '../../search';
import { seedFixtureFiles, type FixtureSeed } from '../util/fixtureWorkspace';

const EXTENSION_ID = 'newdlops.intellij-styled-search';
const REL = 'regex-lazy-fixture.txt';

// Each line is crafted to discriminate greedy vs lazy quantifiers and to
// exercise capture groups. Line indices (0-based) matter for assertions:
//   0: two quoted strings on one line  → lazy stops at first close quote
//   1: two HTML-ish tags               → lazy yields four separate tags
//   2: identifier built from two groups
//   3: OPEN marker (multi-line dotAll test, pairs with line 4)
//   4: CLOSE marker
const FIXTURE = [
  'const x = "alpha" + "beta";',
  '<div>a</div><span>b</span>',
  'function foobar() { return 42; }',
  'aaa OPEN bbb',
  'ccc CLOSE ddd',
].join('\n') + '\n';

async function getApi(): Promise<ExtensionTestApi> {
  const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
  assert.ok(ext);
  return ext.activate();
}

// Flatten every single-line match into the exact substring it matched.
// Multi-line matches (endLine set) are skipped here — counted separately.
function matchedTexts(result: SearchForTestsResult): string[] {
  const out: string[] = [];
  for (const f of result.matches as FileMatch[]) {
    if (f.relPath !== REL) { continue; }
    for (const m of f.matches) {
      for (const r of m.ranges) {
        if (r.endLine !== undefined && r.endLine !== m.line) { continue; }
        out.push(m.preview.slice(r.start, r.end));
      }
    }
  }
  return out;
}

// Does any returned match span more than one source line?
function hasMultiLineMatch(result: SearchForTestsResult): boolean {
  for (const f of result.matches as FileMatch[]) {
    if (f.relPath !== REL) { continue; }
    for (const m of f.matches) {
      for (const r of m.ranges) {
        if (r.endLine !== undefined && r.endLine !== m.line) { return true; }
      }
    }
  }
  return false;
}

suite('Regex — lazy quantifiers & capture groups end-to-end (zoekt)', () => {
  let seed: FixtureSeed | undefined;
  let fixtureUri: vscode.Uri;

  async function searchRegex(
    query: string,
    regexMultiline?: boolean,
  ): Promise<SearchForTestsResult> {
    const { overlay } = await getApi();
    const result = await overlay.searchForTestsDetailed({
      query,
      caseSensitive: true,
      wholeWord: false,
      useRegex: true,
      ...(regexMultiline === undefined ? {} : { regexMultiline }),
      includePatterns: [REL],
    });
    assert.strictEqual(
      result.effectiveEngine,
      'zoekt',
      `expected zoekt engine for ${query}; got ${result.effectiveEngine} (${result.fallbackReason ?? 'none'})`,
    );
    return result;
  }

  suiteSetup(async function () {
    this.timeout(90_000);
    seed = await seedFixtureFiles();
    await vscode.workspace.getConfiguration('intellijStyledSearch')
      .update('engine', 'zoekt', vscode.ConfigurationTarget.Workspace);
    const { overlay } = await getApi();
    await overlay.ensureIndexBuiltForTests();
    await overlay.waitForIndexReady(30_000);

    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    fixtureUri = vscode.Uri.joinPath(folder!.uri, REL);
    await vscode.workspace.fs.writeFile(fixtureUri, Buffer.from(FIXTURE, 'utf8'));
    await overlay.notifyFileChangedForTests(fixtureUri);
    await overlay.flushPendingUpdatesForTests();
    await overlay.waitForIndexReady(30_000);
  });

  suiteTeardown(async function () {
    this.timeout(30_000);
    const { overlay } = await getApi();
    try { await vscode.workspace.fs.delete(fixtureUri, { useTrash: false }); } catch {}
    try {
      await overlay.notifyFileChangedForTests(fixtureUri, 'deleted');
      await overlay.flushPendingUpdatesForTests();
    } catch {}
    await seed?.cleanup();
  });

  // ── The user's core complaint: does the lazy `?` actually shorten matches? ──

  test('lazy ".*?" stops at the first closing quote (NOT greedy)', async () => {
    const texts = matchedTexts(await searchRegex('".*?"', false));
    assert.ok(
      texts.includes('"alpha"'),
      `lazy should match "alpha" alone; got ${JSON.stringify(texts)}`,
    );
    assert.ok(
      texts.includes('"beta"'),
      `lazy should also match "beta" alone; got ${JSON.stringify(texts)}`,
    );
    assert.ok(
      !texts.some((t) => t.includes('+')),
      `lazy must NOT span both strings (would mean greedy); got ${JSON.stringify(texts)}`,
    );
  });

  test('greedy ".*" DOES span both strings — the contrast that proves lazy works', async () => {
    const texts = matchedTexts(await searchRegex('".*"', false));
    assert.ok(
      texts.includes('"alpha" + "beta"'),
      `greedy should span first-to-last quote; got ${JSON.stringify(texts)}`,
    );
  });

  test('lazy "<.*?>" yields four separate tags, not one big span', async () => {
    const texts = matchedTexts(await searchRegex('<.*?>', false)).sort();
    assert.deepStrictEqual(
      texts,
      ['</div>', '</span>', '<div>', '<span>'].sort(),
      `lazy tag match wrong; got ${JSON.stringify(texts)}`,
    );
  });

  // ── The user's second question: do capture groups `()` work at all? ──

  test('capture group concatenation "(foo)(bar)" matches "foobar"', async () => {
    const texts = matchedTexts(await searchRegex('(foo)(bar)', false));
    assert.ok(
      texts.includes('foobar'),
      `(foo)(bar) should match foobar; got ${JSON.stringify(texts)}`,
    );
  });

  test('group alternation "(alpha|beta)" matches both branches', async () => {
    const texts = matchedTexts(await searchRegex('(alpha|beta)', false)).sort();
    assert.deepStrictEqual(
      texts,
      ['alpha', 'beta'],
      `group alternation wrong; got ${JSON.stringify(texts)}`,
    );
  });

  // ── Why "greedy" is often perceived: multiline + dotAll is the DEFAULT, so
  //    `.` crosses newlines. This is the real footgun, not a broken `?`. ──

  test('regexMultiline=true: "." crosses newlines (dotAll opt-in)', async () => {
    const result = await searchRegex('OPEN.*CLOSE', true);
    assert.ok(
      hasMultiLineMatch(result),
      'with regexMultiline=true, OPEN.*CLOSE should match across lines (dotAll on)',
    );
  });

  test('regexMultiline=false: "." stops at newline, so OPEN.*CLOSE finds nothing', async () => {
    const texts = matchedTexts(await searchRegex('OPEN.*CLOSE', false));
    assert.strictEqual(
      texts.length,
      0,
      `singleline "." must not cross newline; got ${JSON.stringify(texts)}`,
    );
  });

  // ── New default (line-bounded): regexMultiline unspecified behaves like
  //    grep/ripgrep/VSCode — "." does NOT cross newlines unless ML is on. ──

  test('DEFAULT (regexMultiline unspecified): "." is line-bounded, OPEN.*CLOSE finds nothing', async () => {
    const texts = matchedTexts(await searchRegex('OPEN.*CLOSE'));
    assert.strictEqual(
      texts.length,
      0,
      `default regex must be line-bounded (dotAll off); got ${JSON.stringify(texts)}`,
    );
  });

  // ── Invalid/unsupported pattern surfaces a clear error instead of the old
  //    silent "0 results" (which hid the real cause when the trigram
  //    pre-filter selected no candidate files). ──

  test('invalid regex (backreference) surfaces an error, not silent empty results', async () => {
    const { overlay } = await getApi();
    const result = await overlay.searchForTestsDetailed({
      query: '(a)\\1',                  // backreference — unsupported by the RE2-family engine
      caseSensitive: true,
      wholeWord: false,
      useRegex: true,
      includePatterns: [REL],
    });
    assert.ok(
      result.error && /regex parse error|backreference/i.test(result.error),
      `expected a regex compile error to surface; got error=${JSON.stringify(result.error)} matches=${result.matches.length}`,
    );
    assert.strictEqual(result.matches.length, 0, 'invalid pattern must yield no matches');
  });
});
