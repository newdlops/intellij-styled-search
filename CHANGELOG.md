# Changelog

## 0.1.698 - 2026-05-07

- Added self-contained VSIX packaging for the Rust `zoek-rs` and `ijss-rebuild` binaries.
- Taught the extension to resolve bundled platform binaries from `resources/bin/<platform>-<arch>/`.
- Clarified deployment docs for Rust-free target machines.

## 0.0.1 - 2026-04-19

Initial public release.

- Added an IntelliJ-style project search overlay for VS Code.
- Added selected-text project search and editor context-menu integration.
- Added streamed ripgrep search with trigram-index candidate narrowing.
- Added editable Monaco preview support with hover and IntelliSense behavior when renderer capture is available.
- Added fallback preview and JavaScript search paths for recovery cases.
- Added first-activation ripgrep setup in extension global storage.
- Added recovery and diagnostics commands for renderer patching and index inspection.
