import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  TextMateGrammarCatalog,
  TextMateGrammarAssetError,
  resolveTextMateGrammarInjections,
  splitTextMateContributionPath,
} from '../../preview/textMateGrammarCatalog';

suite('TextMate grammar catalog', () => {
  test('accepts conventional relative contribution paths', () => {
    assert.deepStrictEqual(
      splitTextMateContributionPath('./syntaxes/language.tmLanguage.json'),
      ['syntaxes', 'language.tmLanguage.json'],
    );
    assert.deepStrictEqual(
      splitTextMateContributionPath('syntaxes\\nested\\language.tmLanguage'),
      ['syntaxes', 'nested', 'language.tmLanguage'],
    );
  });

  test('rejects absolute, URI, NUL, and traversal contribution paths', () => {
    const unsafePaths = [
      '../language.tmLanguage.json',
      './syntaxes/../language.tmLanguage.json',
      '/syntaxes/language.tmLanguage.json',
      '\\server\\share\\language.tmLanguage.json',
      'C:\\syntaxes\\language.tmLanguage.json',
      'file:///syntaxes/language.tmLanguage.json',
      './syntaxes/\0language.tmLanguage.json',
      './syntaxes/%2e%2e/language.tmLanguage.json',
      './syntaxes/%2E%2E%2Flanguage.tmLanguage.json',
    ];
    for (const path of unsafePaths) {
      assert.strictEqual(splitTextMateContributionPath(path), undefined, path);
    }
  });

  test('resolves injection scopes by increasingly specific prefixes in encounter order', () => {
    const injections = {
      source: ['injection.base.first', 'injection.base.second'],
      'source.language': ['injection.language'],
      'source.language.embedded': ['injection.embedded'],
      'source.unrelated': ['injection.unrelated'],
    };

    assert.deepStrictEqual(
      resolveTextMateGrammarInjections(injections, 'source.language.embedded.variant'),
      [
        'injection.base.first',
        'injection.base.second',
        'injection.language',
        'injection.embedded',
      ],
    );
    assert.deepStrictEqual(resolveTextMateGrammarInjections(injections, ''), []);
  });

  test('discovers grammar-only extensions lazily without activating them or exposing paths', async () => {
    const fixture = vscode.extensions.getExtension('fixture.textmate-bridge-fixture');
    assert.ok(fixture, 'expected the grammar-only fixture extension');
    assert.strictEqual(fixture.isActive, false, 'catalog discovery must not activate a grammar-only extension');

    const registry = new TextMateGrammarCatalog();
    try {
      const catalog = await registry.getCatalog('fixture-structured-text');
      assert.ok(catalog, 'expected the contributed language grammar catalog');
      assert.strictEqual(catalog.rootScopeName, 'source.fixture-structured-text');
      assert.match(catalog.rootAssetId, /^tm-[a-f0-9]{64}$/);
      assert.deepStrictEqual(
        resolveTextMateGrammarInjections(catalog.injections, catalog.rootScopeName),
        ['source.fixture-structured-text.injection'],
      );
      assert.strictEqual(
        catalog.configuration.embeddedLanguages['meta.embedded.block.fixture-structured-text'],
        'plaintext',
      );
      assert.strictEqual(catalog.configuration.tokenTypes['comment.line.fixture-structured-text'], 'comment');

      const rootAsset = await registry.getAsset(catalog.generation, catalog.rootAssetId);
      assert.strictEqual(rootAsset.pathHint, 'grammar.json');
      assert.match(rootAsset.sha256, /^[a-f0-9]{64}$/);
      const rawGrammar = JSON.parse(Buffer.from(rootAsset.bytes).toString('utf8')) as { scopeName?: string };
      assert.strictEqual(rawGrammar.scopeName, catalog.rootScopeName);
      assert.ok(!('uri' in (rootAsset as unknown as Record<string, unknown>)));
      assert.ok(!('path' in (rootAsset as unknown as Record<string, unknown>)));
      assert.strictEqual(fixture.isActive, false, 'lazy asset reads must not activate the owning extension');

      let invalidations = 0;
      const invalidationSubscription = registry.onDidInvalidate(() => { invalidations += 1; });
      registry.invalidate();
      invalidationSubscription.dispose();
      assert.strictEqual(invalidations, 1, 'catalog consumers must be notified when their generation is invalidated');
      await assert.rejects(
        registry.getAsset(catalog.generation, catalog.rootAssetId),
        (error: unknown) => error instanceof TextMateGrammarAssetError && error.code === 'stale-generation',
      );
    } finally {
      registry.dispose();
    }
  });
});
