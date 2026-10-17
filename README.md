# VS Code ABL MCP Server

A Visual Studio Code extension that runs an MCP (Model Context Protocol) server inside VS Code, exposing **OpenEdge ABL compile, syntax-check and XREF tools** — plus general VS Code workspace tools — to external MCP clients such as Claude Code, Claude Desktop or any other MCP-capable agent.

The ABL tools bridge to the Language Model tools contributed by the [OpenEdge ABL extension](https://marketplace.visualstudio.com/items?itemName=RiversideSoftware.openedge-abl-lsp) (`RiversideSoftware.openedge-abl-lsp`), so the actual compilation and cross-referencing is done by the ABL language server against your `openedge-project.json` configuration.

> Note: if you use GitHub Copilot Chat inside VS Code, the ABL Language Model tools are already available to it directly. This extension is for **external** agents that talk MCP.

## Requirements

- VS Code 1.99+
- For the ABL tools: `RiversideSoftware.openedge-abl-lsp` **1.33.7 or later** (**1.33.9+** for `check_syntax_abl`), with a configured OpenEdge project (`openedge-project.json`)

## Installation

1. Install the extension from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=cverbiest.vscode-abl-mcp) or clone this repository and run `pnpm install` and `pnpm run bundle` to build it.
2. Click the **Vscode ABL MCP** status bar item to start the server (or set `vscode-abl-mcp.defaultEnabled`).
3. Run the **VsCode ABL MCP: Install Config for Claude Code, Codex CLI, Gemini CLI** command (or configure your client manually, see below) to point it at the server.

## Transports

The extension exposes two transports, each independently toggled via settings:

- **Pipe (default, `vscode-abl-mcp.pipeEnabled`)**: a named pipe on Windows (`\\.\pipe\...`) or a Unix domain socket on Linux/macOS. The path is derived per-workspace (hashed from the workspace folder), so multiple VS Code windows never collide the way a shared TCP port can. Clients that only support stdio-based (`command`/`args`) MCP servers spawn a small bundled proxy (`dist/mcp-pipe-proxy.js`) that forwards stdio to the pipe.
- **HTTP (opt-in, `vscode-abl-mcp.httpEnabled`)**: streamable HTTP on `http://localhost:3000/mcp` (host/port configurable). Useful for clients that can't spawn a local process, but a shared port can conflict when multiple workspace windows are open.

If both are enabled, the **Install Config** command prefers the pipe transport.

## ABL Tools

- **compile_abl**: Compiles an ABL source file and returns all compiler errors and warnings with location and severity.

  - Parameters:
    - `path` (optional): Path of the file to compile, workspace-relative or absolute. Defaults to the active editor.
  - Compiles the saved file content; save first, or use `check_syntax_abl` for unsaved changes.

- **check_syntax_abl**: Checks the syntax of an ABL file's **buffer content**, without requiring the file to be saved on disk.

  - Parameters:
    - `path` (optional): Path of the file to check. Defaults to the active editor.

- **xref_abl**: Generates an XREF (or XML XREF) for an ABL file and returns its content — table/field accesses, procedure calls, include references.

  - Parameters:
    - `path` (optional): Path of the file to process. Defaults to the active editor.
    - `xml` (optional): When `true`, generates XML XREF instead of plain XREF.

- **preprocess_abl**: Runs `COMPILE ... PREPROCESS` and returns the preprocessed output (includes expanded, preprocessor directives resolved).

  - Parameters:
    - `path` (optional): Path of the file to preprocess. Defaults to the active editor.

- **debug_listing_abl**: Runs `COMPILE ... DEBUG-LISTING` and returns the debug listing — the expanded, line-numbered source used by the AVM at runtime, for mapping runtime line numbers back to source.

  - Parameters:
    - `path` (optional): Path of the file to process. Defaults to the active editor.

## Client Configuration

The **VsCode ABL MCP: Install Config for Claude Code, Codex CLI, Gemini CLI** command writes project-local config for Claude Code (`.mcp.json`), Codex CLI (`.codex/config.toml`) and Gemini CLI (`.gemini/settings.json`) automatically, using whichever transport is enabled.

### Restart extension host after configuration

Agents frequently ignore newly added MCP config, a restart can help

Manual setup is also possible:

### Claude Code

Pipe transport (default), via the bundled stdio proxy:

```json
{
  "mcpServers": {
    "vscode-abl": {
      "type": "stdio",
      "command": "node",
      "args": ["<extension install dir>/dist/mcp-pipe-proxy.js", "<pipe path>"]
    }
  }
}
```

Or, with `vscode-abl-mcp.httpEnabled` turned on:

```
claude mcp add --transport http vscode-abl http://localhost:3000/mcp
```

### Claude Desktop

`claude_desktop_config.json`, with the HTTP transport enabled:

```json
{
  "mcpServers": {
    "vscode-abl-mcp": {
      "command": "npx",
      "args": ["mcp-remote@next", "http://localhost:3000/mcp"]
    }
  }
}
```

Any other MCP client can connect via streamable HTTP at `http://localhost:3000/mcp` (or your configured host/port) when `vscode-abl-mcp.httpEnabled` is set, or by spawning `dist/mcp-pipe-proxy.js <pipe path>` as a stdio server when using the pipe transport.

## General VS Code Tools

Besides the ABL tools, the server exposes VS Code workspace capabilities, each category individually switchable via `vscode-abl-mcp.enabledTools`:

### File Tools

- **list_files_code**: Lists files and directories in your workspace

  - Parameters:
    - `path`: The path to list files from
    - `recursive` (optional): Whether to list files recursively

- **read_file_code**: Reads file contents
  - Parameters:
    - `path`: The path to the file to read
    - `encoding` (optional): File encoding (default: utf-8)
    - `maxCharacters` (optional): Maximum character count (default: 100,000)
    - `startLine` / `endLine` (optional): 1-based line range for partial reads

### Edit Tools

- **create_file_code**: Creates a new file using VS Code's WorkspaceEdit API

  - Parameters:
    - `path`: The path to the file to create
    - `content`: The content to write to the file
    - `overwrite` (optional): Whether to overwrite if the file exists (default: false)
    - `ignoreIfExists` (optional): Whether to ignore if the file exists (default: false)

- **replace_lines_code**: Replaces specific lines in a file
  - Parameters:
    - `path`: The path to the file to modify
    - `startLine`: The start line number (1-based, inclusive)
    - `endLine`: The end line number (1-based, inclusive)
    - `content`: The new content to replace the lines with
    - `originalCode`: The original code for validation

### Diagnostics Tools

- **get_diagnostics_code**: Checks for warnings and errors in your workspace

  - Parameters:
    - `path` (optional): File path to check (if not provided, checks the entire workspace)
    - `severities` (optional): Array of severity levels to include (0=Error, 1=Warning, 2=Information, 3=Hint). Default: [0, 1]
    - `format` (optional): Output format ('text' or 'json'). Default: 'text'
    - `includeSource` (optional): Whether to include the diagnostic source. Default: true

### Symbol Tools

- **search_symbols_code**: Searches for symbols across the workspace

  - Parameters:
    - `query`: The search query for symbol names
    - `maxResults` (optional): Maximum number of results to return (default: 10)

- **get_symbol_definition_code**: Gets definition information for a symbol in a file

  - Parameters:
    - `path`: The path to the file containing the symbol
    - `line`: The line number of the symbol
    - `symbol`: The symbol name to look for on the specified line

- **get_document_symbols_code**: Gets an outline of all symbols in a file, showing the hierarchical structure

  - Parameters:
    - `path`: The path to the file to analyze (relative to workspace)
    - `maxDepth` (optional): Maximum nesting depth to display

### Shell Tools (disabled by default)

- **execute_shell_command_code**: Executes a shell command in the VS Code integrated terminal with shell integration

  - Parameters:
    - `command`: The shell command to execute
    - `cwd` (optional): Optional working directory for the command (default: '.')
    - `timeout` (optional): Command timeout in milliseconds (default: 10000)

## Extension Settings

- `vscode-abl-mcp.pipeEnabled`: Enable the named pipe / Unix domain socket transport (default: true)
- `vscode-abl-mcp.autoCreateMcpConfig`: On server start, automatically create the workspace MCP client config (`.mcp.json`, `.gemini/settings.json`, `.codex/config.toml`) if missing, and refresh an entry this extension wrote earlier if its shim/pipe path went stale (e.g. after an extension upgrade). Hand-edited entries are never overwritten (default: false)
- `vscode-abl-mcp.httpEnabled`: Enable the HTTP transport on a fixed TCP port (default: false)
- `vscode-abl-mcp.port`: The port number for the MCP server, used only when the HTTP transport is enabled (default: 3000)
- `vscode-abl-mcp.host`: Host address for the MCP server, used only when the HTTP transport is enabled (default: 127.0.0.1)
- `vscode-abl-mcp.defaultEnabled`: Whether the MCP server should be enabled by default on VS Code startup
- `vscode-abl-mcp.enabledTools`: Configure which tool categories are enabled (file, edit, shell, diagnostics, symbol, abl)

**Selective Tool Configuration**: Useful for coding agents that already have certain capabilities. For example, with Claude Code you might disable the file/edit/shell tools and only enable the abl and symbol tools, adding ABL compilation and VS Code symbol search without duplicating tools the agent already has.

## Security

This extension can allow for execution of shell commands (when the shell tool category is enabled). This means that there is a potential security risk, so use with caution, and ensure that you trust the MCP client that you are using and that the port is not exposed to anything. The server binds to 127.0.0.1 by default.

## Caveats

Currently, only the first workspace folder is supported.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for the full build/test/debug/release guide. Quick start:

```
pnpm install
pnpm run bundle:dev     # esbuild bundle (dist/, what VS Code runs)
pnpm test               # integration tests via @vscode/test-cli
```

Press F5 in VS Code to launch an Extension Development Host. The `related/` folder contains a reference clone of [vscode-abl](https://github.com/vscode-abl/vscode-abl) (the extension whose Language Model tools this project bridges to); it is not part of the build.

## Attributions

This extension is based on the [VS Code MCP Server](https://github.com/juehang/vscode-mcp-server) extension by Juehang Qin, modified to support ABL.

## Contributing

Contributions are welcome! Feel free to submit issues or pull requests.

## License

[MIT](LICENSE)
