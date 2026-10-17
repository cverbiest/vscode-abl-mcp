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

const RETRY_INTERVAL_MS = 250;
const RETRY_TIMEOUT_MS = 30_000;
const RETRYABLE_CODES = new Set(["ENOENT", "ECONNREFUSED", "EAGAIN"]);

const startedAt = Date.now();
let connected = false;
let currentSocket: net.Socket | undefined;

function fail(message: string): void {
  process.stderr.write(`mcp-pipe-proxy: ${message}\n`);
  process.exitCode = 1;
  process.exit(process.exitCode);
}

function connectOnce(): void {
  const socket = net.connect(pipePath);
  currentSocket = socket;

  socket.on("connect", () => {
    connected = true;
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });

  socket.on("error", (error: NodeJS.ErrnoException) => {
    if (connected) {
      process.stderr.write(`mcp-pipe-proxy: connection error: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }

    const retryable = error.code !== undefined && RETRYABLE_CODES.has(error.code);
    if (retryable && Date.now() - startedAt < RETRY_TIMEOUT_MS) {
      setTimeout(connectOnce, RETRY_INTERVAL_MS);
      return;
    }

    fail(`connection error: ${error.message}`);
  });

  socket.on("close", () => {
    if (connected) {
      process.exit(process.exitCode ?? 0);
    }
  });
}

process.stdin.on("error", () => {
  currentSocket?.destroy();
});

connectOnce();
