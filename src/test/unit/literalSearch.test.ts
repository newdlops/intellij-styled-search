import assert from 'node:assert/strict';
import test from 'node:test';
import { literalSearchRegexSource } from '../../literalSearch';

test('literal snippets match logical LF and CRLF lines while preserving punctuation and indentation', () => {
  const lines = ['const value = [1, 2];', '  return value;'];
  for (const queryEnding of ['\n', '\r\n']) {
    const pattern = new RegExp(literalSearchRegexSource(lines.join(queryEnding)));
    for (const fileEnding of ['\n', '\r\n']) {
      assert.equal(pattern.test(lines.join(fileEnding)), true);
      assert.equal(pattern.test(['const value = [1, 2];', ' return value;'].join(fileEnding)), false);
      assert.equal(pattern.test(['const value = 1;', '  return value;'].join(fileEnding)), false);
    }
  }
  assert.equal(new RegExp(literalSearchRegexSource('.*\\path')).test('anything'), false);
  assert.equal(new RegExp(literalSearchRegexSource('.*\\path')).test('.*\\path'), true);
});
