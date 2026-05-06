# IntelliJ Styled Search

IntelliJ Styled Search adds an IntelliJ IDEA-like project search panel to VS Code. It opens as a movable overlay, streams workspace results, and shows an editable Monaco preview for the selected match.

![IntelliJ Styled Search preview](intellijfind.png)

## Features

- Find in project from a movable IntelliJ-style overlay.
- Search the selected text directly from the editor context menu or keybinding.
- Preview matches in an embedded Monaco editor with hover, completions, and editor-style highlighting when renderer capture is available.
- Narrow large searches with a local trigram index, then verify results with ripgrep.
- Support literal, regex, case-sensitive, whole-word, and multi-line searches.
- Keep results responsive by streaming matches and showing candidate files while ripgrep is still running.

## Commands

| Command | Description |
| --- | --- |
| `IntelliJ Search: Find in Path (IntelliJ Style)` | Open the search panel. |
| `IntelliJ Search: Find Selection in Project` | Search the current selection. |
| `IntelliJ Search: Reinject Renderer Patch (Recovery)` | Reinstall the renderer overlay if VS Code's renderer state changes. |
| `IntelliJ Search: Rebuild Search Index` | Rebuild the trigram search index. |
| `IntelliJ Search: Switch Search Engine` | Switch between `zoekt` and `codesearch`, then rebuild the selected engine. |
| `IntelliJ Search: Show Zoekt Diagnostics` | Print shard, overlay, journal, and process stats for the Rust engine. |
| `IntelliJ Search: Explain Query With Zoekt` | Print the Rust engine's candidate plan for a query. |
| `IntelliJ Search: Diagnose Active File in Search Index` | Inspect why the active file may not be in the index. |
| `IntelliJ Search: Start Codeidx MCP Server` | Start the local Codeidx MCP endpoint for Codex, Claude, and other MCP clients. |
| `IntelliJ Search: Stop Codeidx MCP Server` | Stop the local Codeidx MCP endpoint. |

## MCP Usage

This repository includes project MCP config files:

- `.mcp.json` for Claude Code project-scoped MCP discovery.
- `.codex/config.toml` for Codex project-scoped MCP configuration when supported by the installed Codex CLI.

The MCP clients spawn a stdio proxy, but the proxy still needs the VS Code extension's localhost endpoint. In trusted workspaces the extension auto-starts that endpoint by default. Each VS Code window binds an OS-assigned free port and writes the actual URL to `.codeidx/mcp-server.json`, so multiple projects can run at the same time without sharing a fixed port.

Manual stdio proxy command:

```bash
codeidx-mcp stdio --workspace .
```

From a development checkout without `npm link`, use the compiled entrypoint directly:

```bash
node out/codeidxMcpCli.js stdio --workspace .
```

The proxy discovers the VS Code endpoint from `.codeidx/mcp-server.json`. If you disable `intellijStyledSearch.mcpAutoStart`, run `IntelliJ Search: Start Codeidx MCP Server` in that VS Code window before starting Codex or Claude Code. You can also pass the URL explicitly:

```bash
codeidx-mcp stdio --url http://127.0.0.1:<port>/mcp
```

Codex example:

```bash
codex mcp add codeidx -- codeidx-mcp stdio --workspace .
```

If your Codex CLI does not load project-scoped `.codex/config.toml`, run the `codex mcp add` command once to register it in your user config.

Claude Code example:

```bash
claude mcp add --transport stdio codeidx -- codeidx-mcp stdio --workspace .
```

Claude Code also auto-detects the checked-in `.mcp.json` after you approve the project-scoped MCP server.

Useful MCP self-check tools:

- `mcp_health`: verifies the MCP connection and reports endpoint, discovery file, capabilities, and index status.
- `mcp_test`: compares `codeidx_search_code` against a bounded grep-like workspace scan and reports result overlap plus estimated token savings.

By default, `codeidx_search_code` protects common dependency/generated/sensitive paths such as `node_modules/**`, `out/**`, `dist/**`, and `.env*`. To deliberately search a normally excluded path, pass a narrow include plus an exclude policy override:

```json
{
  "query": "SomeGeneratedSymbol",
  "include_globs": ["out/**/*.js"],
  "exclude_policy": "custom_only"
}
```

Use `exclude_policy: "none"` only when you intentionally want to ignore both default excludes and `exclude_globs`.
Both override modes bypass `intellijStyledSearch.excludeGlobs` for that MCP request; keep `include_globs` narrow when searching dependency or generated trees.

Example prompt for Codex or Claude:

```text
Use the codeidx MCP mcp_health tool, then run mcp_test with query "UserService".
```

## Keybindings

| Platform | Search Selection | Open Search |
| --- | --- | --- |
| macOS | `Cmd+Shift+Alt+F` | `Cmd+Shift+Alt+P` |
| Windows/Linux | `Ctrl+Shift+Alt+F` | `Ctrl+Shift+Alt+P` |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `intellijStyledSearch.engine` | `zoekt` | Search engine selection. `zoekt` uses the Rust local shard/mmap engine and falls back to `codesearch` while the runtime is unavailable or still preparing its index. `codesearch` is the current TypeScript codesearch planner plus ripgrep verifier. |
| `intellijStyledSearch.excludeGlobs` | common build/cache folders | Glob patterns excluded from full searches. |
| `intellijStyledSearch.maxFileSize` | `1048576` | Maximum file size in bytes to search. |
| `intellijStyledSearch.maxResults` | `2000` | Match lines to load per batch. Scrolling near the bottom loads the next batch. Values at or below `0` use the built-in default. |
| `intellijStyledSearch.searchHistoryLimit` | `100` | Executed search queries to keep in the History dropdown. Set to `0` to disable storing search history. |

## Runtime Notes

On first activation, the extension attempts to install a platform-specific ripgrep binary into VS Code's extension global storage. If that install fails or the platform is unsupported, it falls back to VS Code's bundled ripgrep when available, and finally to the JavaScript search path.

The editable preview relies on VS Code renderer internals. If the overlay appears but the preview falls back to plain DOM rendering, run `IntelliJ Search: Reinject Renderer Patch (Recovery)`.

## Development

```bash
npm install
npm run compile
npm test
npm run bench:zoekt -- --files 10000,50000,100000
```

`npm run bench:zoekt` saves a timestamped artifact plus `latest.json` under `artifacts/benchmarks/zoekt/`. The artifact includes the raw benchmark response, wall-clock runtime, git commit, Rust toolchain versions, and host metadata so repeated runs stay comparable.

## Deployment

Deployment and release steps now live in [DEPLOY.md](DEPLOY.md).

Short version:

- `vsce package` builds a lightweight VSIX from the current `.vscodeignore`.
- That default VSIX does not include `target/**`, so it relies on first-run Cargo builds for the Rust `zoekt` runtime.
- A self-contained VSIX requires prebuilding `target/release/zoek-rs` and `target/release/ijss-rebuild`, then allowing those artifacts through `.vscodeignore` before packaging.

Quick local package:

```bash
vsce package
```
