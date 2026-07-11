# Deployment Guide

This repository currently supports three practical deployment modes:

1. Development checkout: run the extension directly from the repo.
2. Lightweight VSIX: package the extension without prebuilt Rust binaries.
3. Self-contained VSIX: package the extension with prebuilt Rust binaries.

The current codebase defaults to the `zoekt` engine, and that engine uses two Rust executables:

- `zoek-rs`: search, update, diagnostics, and general engine work
- `ijss-rebuild`: dedicated full-index rebuild entrypoint

The extension resolves a source-fingerprinted pair from global storage first,
then checks a packaged platform tuple and development checkout outputs:

- `<globalStorage>/zoek-rs/runtime/<platform-arch>/<source-fingerprint>/<artifact-id>/`
- `resources/bin/<platform-arch>/`
- `target/debug/zoek-rs`
- `target/release/zoek-rs`
- `target/debug/ijss-rebuild`
- `target/release/ijss-rebuild`

If a binary is missing and `Cargo.toml` is present, the extension attempts a
release Cargo build. Its Cargo target lives under extension global storage and
is isolated by platform and Rust-source fingerprint. The same source revision
reuses its compiled dependencies; different revisions cannot overwrite one
another's output while extension hosts run concurrently.

## Prerequisites

- Node.js + npm for extension compilation
- Rust + Cargo if you want the Rust engine to be available without relying on an already-built `target/`
- `vsce` to package a VSIX

## Release Checklist

1. Update the extension version in `package.json`.
2. Update `CHANGELOG.md`.
3. Compile the extension:

```bash
npm install
npm run compile
```

4. Run the extension tests:

```bash
npm test
cargo test -p zoek-rs
```

5. Build the Rust binaries you intend to ship:

```bash
cargo build --release -p zoek-rs
```

That single Cargo command builds both:

- `target/release/zoek-rs`
- `target/release/ijss-rebuild`

## Default `vsce package` Behavior

The current `.vscodeignore` excludes `target/**`.

That means a plain:

```bash
vsce package
```

produces a VSIX without prebuilt Rust executables.

What that implies:

- The packaged extension still contains the Rust workspace (`Cargo.toml`, `crates/zoek-rs/**`).
- On first activation, the extension can still build the Rust engine locally if the target machine has Cargo available.
- If Cargo is not available on the target machine, the extension falls back to the TypeScript `codesearch` path when possible, but `zoekt`-specific capabilities will not be fully available until the Rust runtime exists.

Use this mode when:

- You are distributing to developers who already have a Rust toolchain.
- You are okay with first-run local compilation.

## Self-contained VSIX

If you want the VSIX itself to contain runnable Rust binaries, generate a
platform tuple under `resources/bin/`. This path is already included by the
default `.vscodeignore`.

At minimum, the VSIX must include:

- `resources/bin/<platform-arch>/zoek-rs`
- `resources/bin/<platform-arch>/ijss-rebuild`
- `resources/bin/<platform-arch>/manifest.json`

Recommended flow:

1. Build and stage the host tuple:

```bash
npm run build:zoek-runtime
```

   Cross-compilation must name both the Rust target and VS Code platform tuple,
   for example:

```bash
node scripts/buildZoekRuntime.js \
  --rust-target aarch64-apple-darwin \
  --platform-key darwin-arm64
```

   The script copies both binaries, sets Unix execute permissions, and writes a
   manifest containing protocol/schema metadata, the exact Rust-source
   fingerprint, and SHA-256 pair identity. It fails if the Rust sources change
   while Cargo is building.

2. Package the extension for that same target:

```bash
vsce package --target <platform-arch>
```

3. Install and verify the packaged VSIX on a machine without Cargo or repo-local state.

## Local Verification

After packaging, verify the produced VSIX in a clean VS Code environment.

Recommended smoke checks:

- Open `IntelliJ Search: Find in Path (IntelliJ Style)`.
- Run `IntelliJ Search: Rebuild Search Index`.
- Confirm `zoekt` searches return results without falling back unexpectedly.
- Confirm the preview panel and renderer patch recover correctly after window reload.

## Notes

- `npm run compile` only builds the TypeScript side and bundles Monaco.
- `vscode:prepublish` currently runs `npm run compile`; it does not build Rust binaries for you.
- If you want reproducible release artifacts, prefer shipping prebuilt `target/release` binaries instead of relying on first-run Cargo builds.
