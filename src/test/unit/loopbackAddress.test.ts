import assert from 'node:assert/strict';
import test from 'node:test';
import { isMatchingLoopbackOrigin, loopbackHttpOrigin, normalizeLoopbackHost } from '../../loopbackAddress';

test('dedicated loopbacks and IPv6 keep their configured listener and discovery address', () => {
  assert.equal(normalizeLoopbackHost('127.42.7.9'), '127.42.7.9');
  assert.equal(loopbackHttpOrigin('127.42.7.9', 43123), 'http://127.42.7.9:43123');
  assert.equal(loopbackHttpOrigin('[::1]', 43123), 'http://[::1]:43123');
  assert.equal(normalizeLoopbackHost('localhost'), '127.0.0.1');
});
test('a listener cannot fall back from an invalid or external address', () => {
  for (const host of ['', '0.0.0.0', '::', '192.168.1.2', 'example.com', '127.999.0.1', '127.0.0.1:9229']) {
    assert.throws(() => normalizeLoopbackHost(host), /explicit loopback/);
  }
});
test('custom loopbacks accept only their own browser origin and reject redirects and credentials', () => {
  assert.equal(isMatchingLoopbackOrigin('http://127.42.7.9:1234', '127.42.7.9'), true);
  assert.equal(isMatchingLoopbackOrigin('http://127.0.0.1:1234', '127.42.7.9'), false);
  assert.equal(isMatchingLoopbackOrigin('http://localhost:1234', '127.0.0.1'), true);
  assert.equal(isMatchingLoopbackOrigin('http://user@127.42.7.9:1234', '127.42.7.9'), false);
  assert.equal(isMatchingLoopbackOrigin('http://127.42.7.9.example.com', '127.42.7.9'), false);
  assert.equal(isMatchingLoopbackOrigin('http://[::1]:1234', '::1'), true);
});
