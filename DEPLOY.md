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
- `resources/bin/<platform>-<arch>/zoek-rs`
- `resources/bin/<platform>-<arch>/ijss-rebuild`

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

5. Build the self-contained VSIX for the current platform:

```bash
npm run package
```

`npm run package` builds and stages:

- `resources/bin/<platform>-<arch>/zoek-rs`
- `resources/bin/<platform>-<arch>/ijss-rebuild`

Install this VSIX on another computer with the same platform/architecture to run without Rust/Cargo on the target machine.

## Default `vsce package` Behavior

The current `.vscodeignore` excludes `target/**`, but it allows staged `resources/bin/**` binaries.

That means a plain:

```bash
vsce package
```

from a clean tree produces a VSIX without prebuilt Rust executables. If you already ran `npm run rust:stage`, the staged `resources/bin/<platform>-<arch>/` binaries are included.

What that implies:

- The packaged extension still contains the Rust workspace (`Cargo.toml`, `crates/zoek-rs/**`).
- On first activation, the extension can still build the Rust engine locally if the target machine has Cargo available.
- If Cargo is not available on the target machine, `zoekt` and rust-native call graph rebuilds are unavailable until a Rust runtime exists.

Use this mode when:

- You are distributing to developers who already have a Rust toolchain.
- You are okay with first-run local compilation.

## Self-contained VSIX

If you want the VSIX itself to contain runnable Rust binaries, use the repository packaging script:

```bash
npm run package
```

That script runs:

```bash
cargo build --release -p zoek-rs
node scripts/stageRustBinaries.js
vsce package
```

The staged binaries live under:

- `resources/bin/darwin-arm64/`
- `resources/bin/darwin-x64/`
- `resources/bin/linux-x64/`
- `resources/bin/win32-x64/`
- or the matching `<process.platform>-<process.arch>` directory for the build host

Build the VSIX on each platform/architecture you intend to support, or stage the matching binaries for each target before packaging. Do not expect a macOS-built binary to run on Windows or Linux.

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
