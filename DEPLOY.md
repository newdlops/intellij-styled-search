# Deployment Guide

This repository currently supports three practical deployment modes:

1. Development checkout: run the extension directly from the repo.
2. Lightweight VSIX: package the extension without prebuilt Rust binaries.
3. Self-contained VSIX: package the extension with prebuilt Rust binaries.

The current codebase defaults to the `zoekt` engine, and that engine uses two Rust executables:

- `zoek-rs`: search, update, diagnostics, and general engine work
- `ijss-rebuild`: dedicated full-index rebuild entrypoint

The extension resolves binaries from:

- `target/debug/zoek-rs`
- `target/release/zoek-rs`
- `target/debug/ijss-rebuild`
- `target/release/ijss-rebuild`

If a binary is missing and `Cargo.toml` is present, the extension attempts a local fallback build with:

```bash
cargo build -q -p zoek-rs
```

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

If you want the VSIX itself to contain runnable Rust binaries, you must ship the `target/release` artifacts.

The current codebase does not have a dedicated packaging script for this. The required manual step is to allow the release binaries through `.vscodeignore` before packaging.

At minimum, the VSIX must include:

- `target/release/zoek-rs`
- `target/release/ijss-rebuild`

Recommended flow:

1. Build release binaries:

```bash
cargo build --release -p zoek-rs
```

2. Update `.vscodeignore` so `target/release/zoek-rs*` and `target/release/ijss-rebuild*` are included.
3. Package the extension:

```bash
vsce package
```

4. Install and verify the packaged VSIX on a machine without relying on repo-local state.

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
