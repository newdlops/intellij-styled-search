import * as assert from 'assert';
import {
  compileIncludeMatcher,
  compilePathScopeMatcher,
  parseIncludePatternInput,
  parsePathScopePatternInput,
  toRipgrepGlobs,
} from '../../pathScope';

suite('Path scope matcher', () => {
  test('parses comma/newline separated patterns', () => {
    assert.deepStrictEqual(
      parseIncludePatternInput('src/**, **/*.ts\napi/'),
      ['src/**', '**/*.ts', 'api/'],
    );
  });

  test('directory pattern matches descendants', () => {
    const matcher = compileIncludeMatcher(['nested/']);
    assert.ok(matcher, 'matcher should be created');
    assert.strictEqual(matcher!('nested/delta.js'), true);
    assert.strictEqual(matcher!('alpha.py'), false);
  });

  test('file glob without slash matches any depth', () => {
    const matcher = compileIncludeMatcher(['*.js']);
    assert.ok(matcher, 'matcher should be created');
    assert.strictEqual(matcher!('nested/delta.js'), true);
    assert.strictEqual(matcher!('alpha.py'), false);
  });

  test('ripgrep globs expand plain directory names to subtree matches', () => {
    assert.deepStrictEqual(toRipgrepGlobs(['nested']), ['**/nested', '**/nested/**']);
  });

  test('parses scope whitelist and blacklist patterns', () => {
    assert.deepStrictEqual(
      parsePathScopePatternInput('src/**, !src/**/*.test.ts\n-docs/'),
      {
        includePatterns: ['src/**'],
        excludePatterns: ['src/**/*.test.ts', 'docs/'],
      },
    );
  });

  test('blacklist pattern removes paths from an otherwise included scope', () => {
    const matcher = compilePathScopeMatcher(['src/**'], ['src/**/*.test.ts']);
    assert.ok(matcher, 'matcher should be created');
    assert.strictEqual(matcher!('src/app/main.ts'), true);
    assert.strictEqual(matcher!('src/app/main.test.ts'), false);
    assert.strictEqual(matcher!('docs/main.ts'), false);
  });

  test('blacklist pattern can exclude without a whitelist', () => {
    const matcher = compilePathScopeMatcher([], ['**/*.map']);
    assert.ok(matcher, 'matcher should be created');
    assert.strictEqual(matcher!('nested/delta.js'), true);
    assert.strictEqual(matcher!('nested/delta.js.map'), false);
  });
});
