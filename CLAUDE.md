# CLAUDE.md

Guidance for Claude Code in the `vscode-abl-mcp` extension repo (publisher `cverbiest`).

Read @DEVELOPMENT.md first — repo layout, build, run/debug, tests, architecture
notes, gotchas, and the release procedure all live there and all apply. This file
adds only what an agent needs on top of it.

## Never edit generated or vendored code

Three directories look editable and are not. Check the path before every write:

- `dist/` — esbuild output (`dist/extension.js`, `dist/mcp-pipe-proxy.js`).
  Generated from `src/` by `pnpm run bundle`; any edit is silently overwritten by
  the next build. Change the `src/` file and rebuild.
- `out/` — tsc output, consumed only by the test runner. Same rule.
- `related/` — reference git clones, chiefly `related/vscode-abl` (the upstream
  RiversideSoftware OpenEdge ABL extension). Git-ignored, excluded from the
  build and the VSIX, and **not ours to change**. This is the likeliest trap:
  a search for ABL tool implementations lands in `related/vscode-abl/src/tools/`,
  which is upstream code. Behaviour changes there belong upstream; mirror them in
  `src/tools/abl.ts` instead. Refresh it with `git pull` inside the folder, never
  by editing.

## Two transports, one server

Clients reach the same MCP server two ways, and a change to one often affects the
other:

- **Streamable HTTP** on `/mcp` (`src/server.ts`) — the primary path.
- **stdio** via `src/pipeProxy.ts`, a standalone byte-forwarder over a named pipe
  (Windows) / Unix socket, for clients that only support `command`/`args`.

`src/pipeProxy.ts` must keep **zero dependencies on `vscode` and on the MCP SDK** —
it is bundled separately and runs as a bare node script. Node built-ins only. It
must also stay agnostic to the JSON-RPC framing: forward raw bytes, never parse or
buffer messages.

**Do not change the pipe naming scheme in `src/pipePath.ts`.** Consumer configs pin
the derived path as a literal string (e.g. `C:\cce\workspaces\develop\.mcp.json`),
so changing the derivation silently breaks every installed client config. The hash
is a sha256 of the first workspace folder path — that is what makes it stable
across VS Code restarts, and it is load-bearing.

## Verify claims about tool behaviour

This repo bridges to tools owned by other extensions, so assumptions go stale
quietly. Two specific traps, both documented at more length in DEVELOPMENT.md:

- `vscode.lm.tools` does **not** reliably list tools registered by other
  extensions. Never gate behaviour on that listing; invoke by name and handle the
  error.
- An Extension Development Host pins the extension versions loaded at its start.
  After rebuilding, reload the window before believing a test result — the
  Extensions view can show a new version while the host still runs the old one.

If a change could not be exercised against a running dev host, report it as
unverified rather than implying it was tested. Do not infer success from a clean
build; `pnpm run compile` type-checks, it does not prove the bridge works.

## Releasing is the maintainer's call

Do not bump `version` in `package.json`, package a `.vsix`, or run `vsce publish`
unless explicitly asked. Publishing is outward-facing and hard to undo.

Routine changes should land as: code in `src/`, a test, and a `CHANGELOG.md` entry
under `## [Unreleased]` (the repo follows Keep a Changelog). Leave the version bump
and the release steps in DEVELOPMENT.md to a deliberate release.
