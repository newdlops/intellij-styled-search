// Ship Windows MSVC executables with a static C runtime, so users do not need
// Cargo or a separately installed Visual C++ runtime to load the native engine.
function windowsRuntimeBuildEnv(env) {
  if (env.CARGO_ENCODED_RUSTFLAGS !== undefined) {
    return { ...env, CARGO_ENCODED_RUSTFLAGS: [env.CARGO_ENCODED_RUSTFLAGS, '-C', 'target-feature=+crt-static']
      .filter(Boolean).join('\x1f') };
  }
  return { ...env, RUSTFLAGS: [env.RUSTFLAGS, '-C target-feature=+crt-static'].filter(Boolean).join(' ') };
}

module.exports = { windowsRuntimeBuildEnv };
