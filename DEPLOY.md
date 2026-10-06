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

On Windows the packaged runtime tuple is `resources/bin/win32-x64/` (or the matching `win32-arm64` / `win32-ia32` tuple), containing `zoek-rs.exe`, `ijss-rebuild.exe`, and `manifest.json`. Run `npm run build:zoek-runtime` on the target Windows architecture before packaging. Windows builds link the MSVC C runtime statically, avoiding a separate Cargo or Visual C++ runtime installation on the user's machine. The desktop compatibility workflow uploads its native runtime pair as a build artifact. Preserve its manifest when including the pair in a VSIX; `.gitattributes` keeps Rust source fingerprints consistent between Windows and macOS checkouts.

## Release Checklist

1. Update the extension version in `package.json` and `package-lock.json`.
2. Update `CHANGELOG.md`.
3. Compile the extension:

```bash
npm ci
npm run compile
```

4. Run the extension tests:

```bash
npm test
cargo test -p zoek-rs
```

5. Build and stage the Rust binaries on each platform you intend to ship:

```bash
npm run build:zoek-runtime
```

This builds both executables and writes their source-fingerprinted manifest to
`resources/bin/<platform-arch>/`. A plain `cargo build` leaves binaries under
`target/`, which is excluded from the VSIX.

6. Package the staged tuples, verify the VSIX contents, and publish that exact
file using the universal or platform-specific flow below.

## Default `vsce package` Behavior

The current `.vscodeignore` excludes `target/**` and includes
`resources/bin/<platform-arch>/`.

On a fresh checkout without staged tuples:

```bash
vsce package
```

produces a VSIX without prebuilt Rust executables. If tuples have already been
staged under `resources/bin/`, the same command includes them in a universal
VSIX. The prepublish step compiles TypeScript; it does not build or download
Rust runtimes.

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

2. Choose a universal package containing all staged tuples, or a
   platform-specific package containing the matching tuple.

### Universal Marketplace release

Build the Windows and macOS tuples separately, or download their runtime pairs
from the same successful desktop compatibility workflow commit. Copy each
complete tuple, including `manifest.json`, into its own `resources/bin/`
directory. Preserve Unix executable permissions when staging macOS binaries.

The current desktop release bundles `win32-x64` and `darwin-arm64`. Other
architectures need their own matching tuples to use the native engine without
a local Cargo build; a universal package does not create missing binaries.

Package without `--target`:

```bash
vsce package --out intellij-styled-search-universal.vsix
```

Before publishing, verify both tuples are present, their manifest fingerprints
match the packaged Rust sources, and their binary hashes match the manifests.
Confirm the version and compiled JavaScript match the release checkout.
Install and smoke-test the package as described below.

Publish the exact file that was verified:

```bash
vsce publish --packagePath intellij-styled-search-universal.vsix
```

This is one upload to the existing `newdlops.intellij-styled-search` Marketplace
listing. The extension selects its native runtime by OS and architecture.

### Platform-specific Marketplace release

Stage the matching tuple and package it with a target:

```bash
vsce package --target <platform-arch>
```

Publish each verified target VSIX under the same extension ID and version with
`vsce publish --packagePath <target-vsix>`. VS Code selects the matching package;
separate Marketplace listings are unnecessary. `--target` does not compile the
native binaries. See the [official platform-specific publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platform-specific-extensions).

## Local Verification

After packaging, verify the produced VSIX in a clean VS Code environment.

The desktop compatibility workflow also tests x64 VS Code UserSetup 1.114.0
and stable on Windows 11 under a newly created standard account. It checks the
extension host's actual executable, architecture, OS, and non-administrator
token before exercising the native engine and overlay. This uses x64
application emulation on GitHub's `windows-11-arm` runner; native x64 Windows 11
hardware and native ARM64 VS Code are separate environments.

Renderer timing checks disable Chromium's background animation/timer throttling
only in the isolated test workbench and log its actual window policy. Their
interactive deadlines still include the first full-file hint request without
provider warmup. CPU profiling is separately opt-in via
`IJSS_E2E_PROFILE_INLAYS=1`; CI timing measurements run without that profiler.

Shared hosted runners report hardware timing budgets separately from required
functional checks. Every measured operation must still complete, and all
renderer, save/recovery, repeated-click, stale-response, and ownership assertions
remain required. The job summary lists every original budget, measured value,
and overrun; raw samples are saved as `renderer-timings.json` in the desktop
artifact. An overrun in report mode does not mean the performance budget passed.

Local renderer tests enforce the original budgets by default. Use a controlled
foreground desktop for strict performance verification:

```bash
npm test -- --run out/test/suite/renderer.test.js
```

`IJSS_E2E_TIMING_MODE=strict` makes that policy explicit;
`IJSS_E2E_TIMING_MODE=report` records hardware measurements without failing on
wall-clock overruns. Unknown modes and incomplete/non-finite measurements fail
in either mode. The workflow defines `enforce_timings` for strict manual runs.
GitHub requires the workflow to be registered on the repository's default
branch before manual dispatch is available. This workflow currently lives on
`main2`, while the default branch is `main`; use the local strict command until
that registration is made. See [GitHub's manual workflow requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

Recommended smoke checks:

- Open `IntelliJ Search: Find in Path (IntelliJ Style)`.
- Run `IntelliJ Search: Rebuild Search Index`.
- Confirm `zoekt` searches return results without falling back unexpectedly.
- Confirm the preview panel and renderer patch recover correctly after window reload.

## Notes

- `npm run compile` only builds the TypeScript side and bundles Monaco.
- `vscode:prepublish` currently runs `npm run compile`; it does not build Rust binaries for you.
- For reproducible release artifacts, stage complete, source-matched runtime tuples under `resources/bin/` instead of relying on first-run Cargo builds.
