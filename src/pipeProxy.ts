/**
 * Standalone stdio<->pipe proxy, spawned by MCP clients that only support
 * `command`/`args` (stdio) server configs. It has no dependency on `vscode`
 * or the MCP SDK: it just forwards raw bytes between its own stdio and a
 * named pipe (Windows) / Unix domain socket (Linux/macOS) exposed by the
 * running extension, which speaks the same newline-delimited JSON-RPC
 * framing on both ends.
 */
import * as net from "net";

const pipePath = process.argv[2];

if (!pipePath) {
  process.stderr.write("Usage: mcp-pipe-proxy <pipe-path>\n");
  process.exit(1);
}

const socket = net.connect(pipePath);

socket.on("connect", () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});

socket.on("error", (error: Error) => {
  process.stderr.write(`mcp-pipe-proxy: connection error: ${error.message}\n`);
  process.exitCode = 1;
});

socket.on("close", () => {
  process.exit(process.exitCode ?? 0);
});

process.stdin.on("error", () => {
  socket.destroy();
});
