# Search controls and settings

## Keybindings

| Platform | Search Selection | Open Search |
| --- | --- | --- |
| macOS | `Cmd+Shift+Alt+F` | `Cmd+Shift+Alt+P` |
| Windows/Linux | `Ctrl+Shift+Alt+F` | `Ctrl+Shift+Alt+P` |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `intellijStyledSearch.engine` | `zoekt` | Search engine selection. `zoekt` uses the Rust local shard/mmap engine and falls back to `codesearch` while the runtime is unavailable or still preparing its index. `codesearch` is the current TypeScript codesearch planner plus ripgrep verifier. |
| `intellijStyledSearch.excludeGlobs` | `[]` | User-controlled glob patterns excluded from full searches. |
| `intellijStyledSearch.callGraphExcludeGlobs` | common dependency/build/cache folders | Glob patterns excluded only from call graph rebuilds; set to `[]` to include those folders intentionally. |
| `intellijStyledSearch.callGraphMemoryBudgetMb` | `8192` | Total memory ceiling for full call graph rebuilds. It caps the JavaScript worker heap and the Rust process/spill buffers. |
| `intellijStyledSearch.disableMonacoCapture` | `false` | Disable probing VS Code's private Monaco services. The bundled Monaco preview and its VS Code language-provider bridge remain available. |
| `intellijStyledSearch.allowTransientPreviewCaptureEditor` | `true` | Allow a short-lived background editor when passive capture cannot upgrade the bundled preview to VS Code's native editor. Disable it to guarantee Search never changes editor tabs. |
| `intellijStyledSearch.previewLanguageFeatures` | `true` | Enable bundled TextMate/lexical hover and relay semantic hover, completions, navigation, diagnostics, and semantic tokens from VS Code language providers. |
| `intellijStyledSearch.maxFileSize` | `1048576` | Maximum file size in bytes to search. |
| `intellijStyledSearch.maxResults` | `2000` | Match lines to load per batch. Scrolling near the bottom loads the next batch. Values at or below `0` use the built-in default. |
| `intellijStyledSearch.searchHistoryLimit` | `100` | Entries to keep in each query and Files scope History dropdown. Files scope history is stored per workspace. Set to `0` to disable storing history. |
| `intellijStyledSearch.defaultFilesScope` | `""` | Initial Files scope for a workspace with no remembered value. Accepts comma-separated Ant patterns, such as `**/*.vue,**/*.ts`. |

The Files scope field remembers your last edit separately for each workspace, including after VS Code restarts. A remembered scope takes precedence over `defaultFilesScope`. Clearing the field remembers an unrestricted search, even when a default is configured. You can set the default in User or Workspace settings.

Open **History** or press **Alt+H** in the search panel to filter previous queries. Matching is case-insensitive and supports multiple words. Use ↑/↓ and Enter to select a query; Escape closes the history popup. Selecting restores the complete query, including newlines, and waits for Enter or Run before searching. The current Files scope and options stay in effect.

In the query field, press **↑** for older searches and **↓** for newer searches. Moving down past the newest entry restores your unfinished query and its selection. The current query is skipped when it is already in history; editing a recalled query starts a new history walk. For multiline drafts, move to the start before pressing ↑; normal line movement and Shift selections remain available. **Alt+↑/↓** moves through search results. Recalling history does not run a search; press Enter or Run when ready.

The **History** button beside **Files scope** keeps the complete Ant expressions used in executed searches, including folder patterns (`src/**`), file types (`**/*.ts`) and combined exclusions (`src/**, !**/*.test.ts`). Patterns are stored separately for each workspace. Filter the list or press **↑/↓** in Files scope to recall a pattern; moving down past the newest entry restores your draft. **Alt+H** opens the history of the focused input. Selecting a pattern restores only Files scope and waits for **Enter** or **Run** before searching. Empty scopes and typing drafts are not added to history.


[Back to the extension overview](../README.md)
