import * as assert from 'assert';
import { compileIncludeMatcher, parseIncludePatternInput, toRipgrepGlobs } from '../../pathScope';

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
});
