import * as assert from 'assert';
import {
  decodeTextBytes,
  hasBinaryFileExtension,
  looksBinaryContent,
} from '../../textFiles';

suite('Text file detection', () => {
  test('detects binary content independently of extension', () => {
    assert.strictEqual(looksBinaryContent(Buffer.from([0x63, 0x6c, 0x61, 0x73, 0x73])), false);
    assert.strictEqual(looksBinaryContent(Buffer.from([0x63, 0x6c, 0x00, 0x73, 0x73])), true);
  });

  test('keeps UTF-16 BOM text out of the binary bucket', () => {
    const utf16 = Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]);
    assert.strictEqual(looksBinaryContent(utf16), false);
    assert.strictEqual(decodeTextBytes(utf16), 'AB');
  });

  test('recognizes common binary extensions', () => {
    assert.strictEqual(hasBinaryFileExtension('/tmp/addon.node'), true);
    assert.strictEqual(hasBinaryFileExtension('/tmp/source.ts'), false);
  });
});
