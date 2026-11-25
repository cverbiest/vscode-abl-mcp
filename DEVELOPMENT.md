# Development Guide

How to build, test, debug and maintain the vscode-abl-mcp extension.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `src/extension.ts` | Extension entry point: status bar, commands, server lifecycle |
| `src/server.ts` | Express + MCP server (streamable HTTP on `/mcp`) |
| `src/tools/abl.ts` | ABL bridge: MCP tools → `vscode.lm.invokeTool` (`abl_compile`, `abl_check_syntax`, `abl_xref`, `abl_preprocess`, `abl_debug_listing`, `abl_listing`) |
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

- Node.js 20+, pnpm
- VS Code 1.99+
- For end-to-end ABL testing: the **OpenEdge ABL** extension
  (`RiversideSoftware.openedge-abl-lsp`) **1.33.7 or later** (1.33.9+ for
  `check_syntax_abl`), plus a working OpenEdge installation configured for the
  test project

## Build

```
pnpm install
pnpm run bundle        # production bundle (minified) -> dist/extension.js
pnpm run bundle:dev    # dev bundle with sourcemaps  -> dist/extension.js
pnpm run compile       # tsc type-check + test build -> out/
pnpm run lint          # eslint
```

There are two build outputs on purpose: VS Code loads the esbuild bundle from
`dist/`, while the test runner (`@vscode/test-cli`) executes the tsc output in
`out/`. `pnpm test` builds both.

## Run / Debug

**F5** in VS Code runs the `build` task (bundle + type-check) and opens an
Extension Development Host. Alternatively, launch one from a terminal:

```
pnpm run bundle:dev
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

With the MCP Inspector: `pnpm dlx @modelcontextprotocol/inspector`, transport
"Streamable HTTP", URL `http://localhost:3000/mcp`.

With Claude Code: `claude mcp add --transport http vscode-abl http://localhost:3000/mcp`,
or run the **VsCode ABL MCP: Install Config for Claude Code, Codex CLI, Gemini CLI**
command (`vscode-abl-mcp.installMcpConfig`) from the Command Palette, which asks
which clients to set up and writes/updates their config (`.mcp.json`,
`.gemini/settings.json`, `.codex/config.toml`) in the workspace root with the
currently configured transport.

Or plain curl (note the double `Accept` header):

```
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"xref_abl","arguments":{"path":"src/test01.p"}}}'
```

## Tests

```
pnpm test
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
  uses `server.registerTool()`. After an upgrade run `pnpm test` and do one
  manual reconnect test (connect, disconnect, reconnect with Claude Code or
  the inspector) — transport/session semantics are where SDK changes bite.
- When upstream vscode-abl changes its LM tools (names, input schema,
  minimum version), `git pull` in `related/vscode-abl`, diff
  `src/tools/Abl*Tool.ts` and the `languageModelTools` contribution, and
  mirror any changes in `src/tools/abl.ts` (tool names, parameters, version
  hints in error messages).

### Release

1. Bump `version` in `package.json`, add a `CHANGELOG.md` entry.
2. `pnpm test`
3. `pnpm exec vsce package --no-dependencies` (runs the production bundle via
   `vscode:prepublish`) and smoke-test the VSIX:
   `code --install-extension vscode-abl-mcp-<version>.vsix`.
   `--no-dependencies` is required under pnpm: vsce's dependency step shells
   out to `npm list`, which can't parse pnpm's symlinked `node_modules` and
   fails with bogus "missing"/"invalid" errors. Harmless to skip here since
   `.vscodeignore` excludes `node_modules/**` anyway — the VSIX ships only
   the esbuild bundle in `dist/`.
   Use `pnpm exec` (not `pnpm dlx vsce`) so it runs the `@vscode/vsce`
   devDependency already pinned in `package.json` — `pnpm dlx vsce` fetches
   the old, deprecated, unscoped `vsce` package from npm instead.
4. Commit and push to `develop`, then publish with the **Publish to
   Marketplace** GitHub Actions workflow (see below): Actions tab → *Publish
   to Marketplace* → **Run workflow** on `develop`, leave *pre-release*
   unticked, then approve the `marketplace` deployment when it asks.
5. Tag the published commit with the bare version (`git tag 0.6.0`, no `v`)
   and push the tag.

### Publishing workflow (Trusted Publishing)

Publishing runs in [.github/workflows/publish.yml](.github/workflows/publish.yml)
and authenticates to the Marketplace with **Trusted Publishing** (GitHub OIDC),
not a Personal Access Token. Global Azure DevOps PATs are retired on
2026-12-01, so the old `vsce publish` with `VSCE_PAT` no longer works. No
secret is stored; each run gets a single-use token that expires after
15 minutes. It costs nothing: Actions minutes are free on a public repo, and
neither an Azure subscription nor an Azure DevOps organization is needed.

The workflow re-checks what it can (version is `major.minor.patch`, odd/even
minor matches the *pre-release* input, `CHANGELOG.md` has a `## [x.y.z]`
section), runs lint and type-check, packages the VSIX (kept as a run
artifact) and publishes exactly that file. It does **not** run `pnpm test`
— that needs a VS Code instance; run it locally before publishing.

Only the maintainer can publish:

- **Manual trigger only** (`workflow_dispatch`); running it needs write access
  to the repo. No push, tag or pull-request trigger.
- The job is skipped unless `github.actor` is `cverbiest` and it runs on the
  default branch.
- The job uses the `marketplace` environment, which requires the maintainer's
  approval before it starts.
- The Marketplace policy only accepts tokens from this repo, this workflow
  file and that environment, so a fork running the same workflow is rejected.

One-time setup (already done once; redo only if the repo, workflow file name
or environment changes):

1. GitHub → repo **Settings → Environments → New environment** `marketplace`.
   Tick **Required reviewers** and add `cverbiest`; under **Deployment
   branches and tags** choose *Selected branches* and add `develop`.
2. <https://marketplace.visualstudio.com/manage> → publisher `cverbiest` →
   **Trusted Publishing → Create**: repository owner `cverbiest`, repository
   `vscode-abl-mcp`, workflow `publish.yml`, environment `marketplace`.

`--oidc` needs `@vscode/vsce` 4.1.0 or later.

Fallback without GitHub: package locally as above and upload the VSIX by
hand at <https://marketplace.visualstudio.com/manage> (extension → **Update**).

### Pre-release

The Marketplace has a separate pre-release channel: users opt in with
**Switch to Pre-Release Version** on the extension page and from then on get
whichever is the highest published version, pre-release or not.

Versioning — the Marketplace only accepts `major.minor.patch`, so semver
suffixes like `0.5.0-beta.1` are rejected. Instead, by convention (the one
VS Code recommends):

- **odd minor = pre-release** (`0.5.0`, `0.5.1`, …),
- **even minor = release** (`0.6.0`).

The next release must have a **higher** version than every pre-release, or
pre-release users never get moved back to it.

Steps — same as a release, with `--pre-release`:

1. Bump `version` in `package.json` (odd minor). In `CHANGELOG.md` move the
   `## [Unreleased]` entries under `## [x.y.z] - YYYY-MM-DD (pre-release)`.
2. `pnpm test`
3. `pnpm exec vsce package --pre-release --no-dependencies` and smoke-test the
   VSIX: `code --install-extension vscode-abl-mcp-<version>.vsix`.
4. Commit, push, and run the **Publish to Marketplace** workflow with
   *pre-release* ticked (the default); approve the deployment. Then tag.

Promoting to a release: bump to the next even minor (e.g. `0.5.2` → `0.6.0`),
add a `CHANGELOG.md` entry that points back to the pre-release entries it
includes, and follow the normal release steps above (no `--pre-release`).
A pre-release version cannot be re-published as a release under the same
number.
