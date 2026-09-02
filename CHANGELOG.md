# Changelog

## 0.1.7147 - 2026-09-02

- Added host-memory pressure gates and cancellation for codesearch and zoek-rs indexing work.
- Bounded generated global storage, retained active and rollback runtimes/indexes, and coordinated cleanup safely across VS Code windows.
- Removed obsolete Cargo targets, abandoned runtime stages, and inactive trigram caches through strict generated-artifact allowlists and age gates.
- Updated the shipped WebSocket runtime and build tooling to remove known runtime and bundler advisories.

- Restored VS Code hover, completions, signature help, navigation, symbols, folding, diagnostics, and semantic tokens in the tab-free bundled Monaco preview.
- Bound bundled preview models to their real file URIs and kept lexical syntax tokenization without loading Monaco's duplicate language workers.
- Added a lazy TextMate/Oniguruma bridge for installed VS Code extension grammars, including multiline state, external includes, injection grammars, opaque asset IDs, payload chunking, and Monarch fallback.
- Made bundled hover stream immediate TextMate lexical scopes, cached VS Code semantic-token classification, and range-safe language-provider documentation without duplicate same-word LSP requests.
- Added clean, viewport-preserving bundled-to-native preview recovery without requiring another preview event, while retaining bundled Monaco across failed native mounts and unsaved edits.
- Retried tab-free passive native capture after cold misses and rejected retained renderer bridges that point at a stale extension host.
- Synchronized the preview language-feature flag across retained renderer patches so bundled hover and completions cannot remain disabled after a settings or extension-host transition.

## 0.0.1 - 2026-04-19

Initial public release.

- Added an IntelliJ-style project search overlay for VS Code.
- Added selected-text project search and editor context-menu integration.
- Added streamed ripgrep search with trigram-index candidate narrowing.
- Added editable Monaco preview support with hover and IntelliSense behavior when renderer capture is available.
- Added fallback preview and JavaScript search paths for recovery cases.
- Added first-activation ripgrep setup in extension global storage.
- Added recovery and diagnostics commands for renderer patching and index inspection.
