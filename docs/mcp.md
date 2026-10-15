# Codeidx MCP usage

This repository includes project MCP config files:

- `.mcp.json` for Claude Code project-scoped MCP discovery.
- `.codex/config.toml` for Codex project-scoped MCP configuration when supported by the installed Codex CLI.

The MCP clients spawn a stdio proxy, but the proxy still needs the VS Code extension's localhost endpoint. In trusted workspaces the extension auto-starts that endpoint by default. Each VS Code window binds an OS-assigned free port and writes the actual URL to `.codeidx/mcp-server.json`, so multiple projects can run at the same time without sharing a fixed port. The extension also writes `.codeidx/codeidx-mcp-stdio.js`, which lets project MCP configs launch the proxy through `node` without depending on a global `codeidx-mcp` binary. Auto-setup writes only project-local MCP config files such as `.mcp.json` and `.codex/config.toml`; it does not write `~/.codex/config.toml` or any other user/global MCP config.

Manual stdio proxy command:

```bash
codeidx-mcp stdio --workspace .
```

From a workspace where the extension has started, use the generated project launcher:

```bash
node .codeidx/codeidx-mcp-stdio.js stdio --workspace .
```

The proxy discovers the VS Code endpoint from `.codeidx/mcp-server.json` and verifies that the endpoint reports the same workspace ID. A stale `CODEIDX_MCP_URL` from another VS Code window is ignored instead of pinning the proxy to the wrong project. If you disable `intellijStyledSearch.mcpAutoStart`, the extension still publishes a workspace-local control API in `.codeidx/mcp-control.json`; agents can call `mcp_start` from the stopped stdio fallback to ask that VS Code window to start the workspace MCP endpoint. You can also pass the URL explicitly:

```bash
codeidx-mcp stdio --url http://127.0.0.1:<port>/mcp
```

Codex should use the generated project-scoped `.codex/config.toml` when your Codex CLI supports it. Avoid `codex mcp add` for this launcher when it writes to `~/.codex/config.toml`, because user/global MCP config can pin `codeidx` to one workspace. If a global entry is necessary, use a cwd-based command rather than a project-specific `.codeidx/codeidx-mcp-stdio.js` absolute path.

Claude Code example:

```bash
claude mcp add --transport stdio codeidx -- node .codeidx/codeidx-mcp-stdio.js stdio --workspace .
```

Claude Code also auto-detects the checked-in `.mcp.json` after you approve the project-scoped MCP server.

Useful MCP self-check tools:

- `mcp_health`: verifies the MCP connection and reports endpoint, discovery file, capabilities, index status, and the agent startup policy.
- `mcp_start`: when `mcp_health` reports `health.mcp_connection == "stopped"` and `control.available == true`, asks the VS Code extension control API to start this workspace's MCP endpoint.

Agents should initialize codeidx with `mcp_health({ "include_agent_policy": true, "include_discovery": true })`, then follow the policy returned in `agent_policy`. If health reports `health.mcp_connection == "stopped"` and the stopped stdio fallback advertises `mcp_start`, call `mcp_start` once, rediscover, then call `mcp_health` again before using search, symbol, reference, or graph tools. Unless higher-priority user or project policy such as `AGENTS.md`, `CLAUDE.md`, or direct user instructions says otherwise, agents should automatically use codeidx before broad grep or whole-file reads: use `codeidx_probe`/`codeidx_exists` for cardinality, `codeidx_search_code` with `output_mode: "minimal"` for path:line candidates, and only then expand selected ranges with `codeidx_read_snippets` or `codeidx_symbol_slice`. MCP intentionally does not expose index refresh/rebuild tools; if the index is not ready, a full scan is required, or final audit ordering matters, fall back to `rg` or ask the user to prepare the index.

Native OR search is available through `queries`; the engine unions per-term index candidates before verification, so this avoids broad regex alternation for simple keyword sets:

```json
{
  "queries": ["AlphaService", "BetaService", "GammaService"],
  "query_kind": "literal",
  "query_operator": "any"
}
```

By default, `codeidx_search_code` protects common dependency/generated/sensitive paths such as `node_modules/**`, `out/**`, `dist/**`, `graphql-codegen/**`, and `.env*`. To deliberately search a normally excluded path, pass a narrow include plus an exclude policy override:

```json
{
  "query": "SomeGeneratedSymbol",
  "include_globs": ["out/**/*.js"],
  "exclude_policy": "custom_only"
}
```

Use `exclude_policy: "none"` only when you intentionally want to ignore both default excludes and `exclude_globs`.
Both override modes bypass `intellijStyledSearch.excludeGlobs` for that MCP request; keep `include_globs` narrow when searching dependency or generated trees.
For generated/codegen searches, `include_generated: true` disables generated excludes and uses a bounded full scan with a larger MCP file-size cap so large generated files are not silently missed.
If a generated/full-scan request explicitly forbids fallback, MCP returns `fallback_policy_requires_full_scan` instead of pretending the indexed search found zero results.

`codeidx_search_code` defaults to token-first `output_mode: "minimal"` and returns only `path:line` rows. Use `output_mode: "rg_like"` when you need line previews, and `codeidx_read_snippets` for selected ranges instead of paying snippet cost in the broad search response.
Compact search diagnostics are opt-in for compact text calls: pass `"include_diagnostics": true` when you need engine/fallback/scope/timing metadata in `structuredContent`. Pass `"structured": true` or `"output_mode": "structured"` only for full JSON-rich search results.
Pass `"diagnostic_level": "full"` only when you need full query terms and verbose ranking metadata.

Envelope tools such as symbols, references, snippets, counts and health send a single JSON text copy by default. Read it from `content[0].text`; pass `"structured": true` if your client consumes `structuredContent`. Rich mode retains the full schema and its JSON text mirror. Warnings, confidence, IDs and continuation cursors remain available in both modes.
Scope presets are explicit: `source` means production plus tests while excluding migrations/generated/dependencies/local editor context, `production` excludes tests too, `tests` keeps only tests, and `all` disables those preset filters.
For architectural inventories, `codeidx_top_files` supports `group_by: "directory"` plus `directory_depth`; this is useful for summarizing where notification implementations, senders, or callers are concentrated before reading files.

Example prompt for Codex or Claude:

```text
Use the codeidx MCP mcp_health tool, then search for "UserService" with codeidx_search_symbols first and codeidx_search_code if text locations are needed.
```


[Back to the extension overview](../README.md)
