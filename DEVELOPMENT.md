# Development Guide

How to build, test, debug and maintain the vscode-abl-mcp extension.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `src/extension.ts` | Extension entry point: status bar, commands, server lifecycle |
| `src/server.ts` | Express + MCP server (streamable HTTP on `/mcp`) |
| `src/tools/abl.ts` | ABL bridge: MCP tools → `vscode.lm.invokeTool` (`abl_compile`, `abl_check_syntax`, `abl_xref`) |
| `src/tools/*.ts` | Generic VS Code tools (file, edit, shell, diagnostics, symbol) |
| `src/test/` | Integration tests (run inside a VS Code test instance) |
| `related/` | Reference material, **not part of the build** — see below |
| `dist/extension.js` | esbuild bundle — what VS Code actually runs (`main` in package.json) |
| `out/` | tsc output — used only by the test runner |

### The `related/` folder

`related/vscode-abl` is a git clone of `git@github.com:vscode-abl/vscode-abl.git`
(the RiversideSoftware OpenEdge ABL extension). It is included **for reference
only**: it is where the Language Model tools that this extension bridges to are
implemented (`src/tools/AblCompileTool.ts`, `AblCheckSyntaxTool.ts`,
`AblXrefTool.ts`, and the `languageModelTools` section of its `package.json`).
Do not modify it; update it with `git pull` inside the folder when you need to
check upstream changes. The folder also contains sample OpenEdge projects
(`related/vscode-abl/run_env/sample-oe-projects/`) that are handy for manual
testing. `related/` is git-ignored and excluded from the VSIX.

The other folders under `related/` (formatter, update checker) are reference
clones as well.

## Prerequisites

- Node.js 20+, npm
- VS Code 1.99+
- For end-to-end ABL testing: the **OpenEdge ABL** extension
  (`RiversideSoftware.openedge-abl-lsp`) **1.33.7 or later** (1.33.9+ for
  `check_syntax_abl`), plus a working OpenEdge installation configured for the
  test project

## Build

```
npm install
npm run bundle        # production bundle (minified) -> dist/extension.js
npm run bundle:dev    # dev bundle with sourcemaps  -> dist/extension.js
npm run compile       # tsc type-check + test build -> out/
npm run lint          # eslint
```

There are two build outputs on purpose: VS Code loads the esbuild bundle from
`dist/`, while the test runner (`@vscode/test-cli`) executes the tsc output in
`out/`. `npm test` builds both.

## Run / Debug

**F5** in VS Code runs the `build` task (bundle + type-check) and opens an
Extension Development Host. Alternatively, launch one from a terminal:

```
npm run bundle:dev
code --new-window --extensionDevelopmentPath=<repo-root> <path-to-an-openedge-project>
```

A good test workspace is
`related\vscode-abl\run_env\sample-oe-projects\project1`.

In the development host:

1. Click the **Vscode ABL MCP** status bar item to start the server
   (state persists across reloads of the dev host).
2. The server listens on `http://127.0.0.1:3000/mcp` (settings
   `vscode-abl-mcp.port` / `vscode-abl-mcp.host`).

### Exercising the MCP endpoint

With the MCP Inspector: `npx @modelcontextprotocol/inspector`, transport
"Streamable HTTP", URL `http://localhost:3000/mcp`.

With Claude Code: `claude mcp add --transport http vscode-abl http://localhost:3000/mcp`.

Or plain curl (note the double `Accept` header):

```
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"xref_abl","arguments":{"path":"src/test01.p"}}}'
```

## Tests

```
npm test
```

Downloads a VS Code build on first run, then runs `src/test/**/*.test.ts`
inside it (mocha, sinon, proxyquire). The ABL bridge tests
(`src/test/abl.test.ts`) mock the `vscode` module entirely, so they run
without OpenEdge or the ABL extension installed.

## Architecture Notes

- **Stateless MCP server**: every POST to `/mcp` gets a fresh `McpServer` +
  `StreamableHTTPServerTransport` pair, torn down when the response closes
  (`src/server.ts`). Do not go back to a single shared transport: in
  stateless mode it accepts `initialize` only once, so every client
  *reconnect* fails with HTTP 500.
- **ABL bridge**: the ABL tools do no compilation themselves. They resolve
  the `path` argument to a URI and call `vscode.lm.invokeTool()` on the LM
  tools registered by the vscode-abl extension, which talks to the ABL
  language server (`proparse/*` requests). Keep the bridge thin; behavior
  changes belong upstream in vscode-abl.
- **Do not pre-check `vscode.lm.tools`**: its listing is not reliable for
  tools registered by *other* extensions (observed: only built-in tools are
  listed while `invokeTool` by name works fine). Invoke directly and handle
  the error.

## Gotchas

- **Extension host caching**: an Extension Development Host keeps whatever
  extension versions were loaded at start. After updating the ABL extension
  or rebuilding this bundle, reload the dev host window ("Developer: Reload
  Window") — the Extensions view may already show the new version while the
  running host still has the old one.
- **One window owns the port**: if several dev-host windows are open, only
  one holds port 3000; the others fail to bind. When testing, keep a single
  dev-host window to avoid talking to a stale instance.
- **`related/` is not built**: `tsconfig.json` and `.vscodeignore` exclude
  it; keep it that way so its sources never leak into the build or VSIX.

## Maintenance

### Updating dependencies

- `@modelcontextprotocol/sdk`: check its release notes; tool registration
  uses `server.registerTool()`. After an upgrade run `npm test` and do one
  manual reconnect test (connect, disconnect, reconnect with Claude Code or
  the inspector) — transport/session semantics are where SDK changes bite.
- When upstream vscode-abl changes its LM tools (names, input schema,
  minimum version), `git pull` in `related/vscode-abl`, diff
  `src/tools/Abl*Tool.ts` and the `languageModelTools` contribution, and
  mirror any changes in `src/tools/abl.ts` (tool names, parameters, version
  hints in error messages).

### Release

1. Bump `version` in `package.json`, add a `CHANGELOG.md` entry.
2. `npm test`
3. `npx vsce package` (runs the production bundle via `vscode:prepublish`)
   and smoke-test the VSIX: `code --install-extension vscode-abl-mcp-<version>.vsix`.
4. `npx vsce publish` (publisher `cverbiest`).
