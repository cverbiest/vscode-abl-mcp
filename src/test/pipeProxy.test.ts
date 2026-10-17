import * as assert from "assert";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";

const PROXY_PATH = path.resolve(__dirname, "../../dist/mcp-pipe-proxy.js");

function scratchPipePath(): string {
  const id = crypto.randomBytes(8).toString("hex");
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\mcp-pipe-proxy-test-${id}`;
  }
  return path.join(os.tmpdir(), `mcp-pipe-proxy-test-${id}.sock`);
}

function spawnProxy(pipePath: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [PROXY_PATH, pipePath], { stdio: "pipe" });
}

function collectStderr(proxy: ChildProcessWithoutNullStreams): { get: () => string } {
  let stderr = "";
  proxy.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  return { get: () => stderr };
}

suite("mcp-pipe-proxy Test Suite", () => {
  test("pipe absent at spawn, created shortly after -> proxy connects and forwards", async function () {
    this.timeout(10_000);
    const pipePath = scratchPipePath();
    const proxy = spawnProxy(pipePath);
    const stderr = collectStderr(proxy);

    const forwarded: Buffer[] = [];
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => forwarded.push(chunk));
      socket.write("pong\n");
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    await new Promise<void>((resolve) => server.listen(pipePath, resolve));

    proxy.stdin.write("ping\n");

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (forwarded.length > 0) {
          resolve();
        } else if (Date.now() - start > 5000) {
          reject(new Error(`proxy never forwarded bytes; stderr: ${stderr.get()}`));
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });

    assert.strictEqual(Buffer.concat(forwarded).toString(), "ping\n");

    proxy.kill();
    server.close();
  });

  test("pipe never appears -> exits 1 within the bounded window, stderr intact", async function () {
    this.timeout(35_000);
    const pipePath = scratchPipePath();
    const proxy = spawnProxy(pipePath);
    const stderr = collectStderr(proxy);

    const exitCode = await new Promise<number | null>((resolve) => {
      proxy.on("exit", (code) => resolve(code));
    });

    assert.strictEqual(exitCode, 1);
    assert.match(stderr.get(), /mcp-pipe-proxy: connection error:/);
  });

  test("pipe present at spawn -> connects on first attempt, no added latency", async function () {
    this.timeout(10_000);
    const pipePath = scratchPipePath();
    const server = net.createServer((socket) => {
      socket.end();
    });
    await new Promise<void>((resolve) => server.listen(pipePath, resolve));

    const start = Date.now();
    const proxy = spawnProxy(pipePath);
    await new Promise<void>((resolve, reject) => {
      proxy.on("exit", () => resolve());
      setTimeout(() => reject(new Error("proxy did not exit promptly")), 5000);
    });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 2000, `expected fast connect, took ${elapsed}ms`);
    server.close();
  });

  test("established connection then closed -> still exits, does not retry", async function () {
    this.timeout(10_000);
    const pipePath = scratchPipePath();
    let socketRef: net.Socket | undefined;
    const server = net.createServer((socket) => {
      socketRef = socket;
    });
    await new Promise<void>((resolve) => server.listen(pipePath, resolve));

    const proxy = spawnProxy(pipePath);
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    socketRef?.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      proxy.on("exit", (code) => resolve(code));
      setTimeout(() => reject(new Error("proxy did not exit after close")), 5000);
    });

    assert.strictEqual(exitCode, 0);
    server.close();
  });
});
