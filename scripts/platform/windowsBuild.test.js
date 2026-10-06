const assert = require('node:assert/strict');
const test = require('node:test');
const { windowsRuntimeBuildEnv } = require('./windowsBuild');

test('preserves compiler flags while selecting a static Windows runtime', () => {
  const env = { RUSTFLAGS: '-C opt-level=2', OTHER: 'preserved' };
  assert.deepEqual(windowsRuntimeBuildEnv(env), { OTHER: 'preserved', RUSTFLAGS: '-C opt-level=2 -C target-feature=+crt-static' });
  assert.equal(env.RUSTFLAGS, '-C opt-level=2');
  assert.equal(windowsRuntimeBuildEnv({ CARGO_ENCODED_RUSTFLAGS: '-C\x1fopt-level=2' }).CARGO_ENCODED_RUSTFLAGS,
    '-C\x1fopt-level=2\x1f-C\x1ftarget-feature=+crt-static');
});
