# Change Log

All notable changes to the "vscode-abl-mcp" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added

- `vscode-abl-mcp.autoCreateMcpConfig` setting: on server start, automatically creates the workspace MCP client config (`.mcp.json`, `.gemini/settings.json`, `.codex/config.toml`) when missing, and refreshes an entry previously written by this extension if its shim/pipe path is stale. Other existing entries are never overwritten.

## [0.4.3] - 2026-07-09

### Added

- `preprocess_abl` MCP tool: runs `COMPILE ... PREPROCESS` on an ABL file and returns the preprocessed output.
- `debug_listing_abl` MCP tool: runs `COMPILE ... DEBUG-LISTING` on an ABL file and returns the debug listing.

Both assume halucinated `abl_preprocess` and `abl_debug_listing` Language Model tools exists in the RiversideSoftware.openedge-abl-lsp extension.
If they don't exists a work-around does debug-list and preprocess in the editor and returns the resulting editor contents.

## [0.4.0] - 2026-07-04

### Added

- `compile_abl` MCP tool: compiles an ABL file via the vscode-abl language server and returns compiler diagnostics.
- `check_syntax_abl` MCP tool: syntax-checks an ABL file's buffer content (including unsaved changes).
- `xref_abl` MCP tool: generates XREF or XML-XREF for an ABL file and returns its content.
- All ABL tools accept an optional `path` parameter (workspace-relative or absolute) and fall back to the active editor. They bridge to the Language Model tools (`abl_compile`, `abl_check_syntax`, `abl_xref`) contributed by the RiversideSoftware.openedge-abl-lsp extension (>= 1.33.7; >= 1.33.9 for check syntax).

### Changed

- Upgraded `@modelcontextprotocol/sdk` to 1.29, `express` to 5, `zod` to 4; migrated tool registration to the `registerTool` API.
- Extension is now bundled with esbuild (`dist/extension.js`).

### Removed

- `compile_buffer` MCP tool (replaced by `compile_abl`; the old tool only worked on the active editor and relied on polling diagnostics).
- `Test: Call abl.compileBuffer` and `Hello World` commands.

## [0.3.1] and earlier

- MCP server exposing VS Code file, edit, shell, diagnostics and symbol tools, based on [vscode-mcp-server](https://github.com/JuehangQin/vscode-mcp-server).
