import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as sinon from "sinon";
import * as proxyquireLib from "proxyquire";

// Configure proxyquire
const proxyquire = proxyquireLib.noPreserveCache().noCallThru();

const SHIM_V1 = "C:\\ext\\vscode-abl-mcp-0.4.2\\dist\\mcp-pipe-proxy.js";
const SHIM_V2 = "C:\\ext\\vscode-abl-mcp-0.4.3\\dist\\mcp-pipe-proxy.js";
const PIPE = "\\\\.\\pipe\\vscode-abl-mcp-abc123";

suite("MCP Config Install (autoCreateMcpConfig) Test Suite", () => {
  let root: string;
  let installMcpConfigs: (options: any) => Promise<string[]>;

  const mcpJson = () => path.join(root, ".mcp.json");
  const geminiJson = () => path.join(root, ".gemini", "settings.json");
  const codexToml = () => path.join(root, ".codex", "config.toml");

  const pipeOptions = (shimPath: string, pipePath: string = PIPE) => ({
    pipe: { path: pipePath, shimPath },
  });

  function writeWorkspaceFile(file: string, content: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }

  const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "abl-mcp-config-"));

    // Minimal vscode fake: a single workspace folder and an fs backed by node:fs
    const fakeVscode = {
      Uri: {
        file: (p: string) => ({ fsPath: p }),
        joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
          fsPath: path.join(base.fsPath, ...segments),
        }),
      },
      workspace: {
        workspaceFolders: [{ uri: { fsPath: root } }],
        fs: {
          readFile: (uri: { fsPath: string }) =>
            fs.promises.readFile(uri.fsPath),
          writeFile: (uri: { fsPath: string }, bytes: Uint8Array) =>
            fs.promises.writeFile(uri.fsPath, bytes),
          createDirectory: async (uri: { fsPath: string }) => {
            await fs.promises.mkdir(uri.fsPath, { recursive: true });
          },
        },
      },
    };

    ({ installMcpConfigs } = proxyquire("../mcpConfigInstall", {
      vscode: fakeVscode,
      "./utils/logger": {
        logger: {
          info: sinon.spy(),
          warn: sinon.spy(),
          error: sinon.spy(),
          debug: sinon.spy(),
        },
      },
    }));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("auto mode creates all three config files when none exist", async () => {
    const written = await installMcpConfigs({
      ...pipeOptions(SHIM_V1),
      auto: true,
    });

    assert.strictEqual(written.length, 3);
    assert.deepStrictEqual(readJson(mcpJson()).mcpServers["vscode-abl"], {
      type: "stdio",
      command: "node",
      args: [SHIM_V1, PIPE],
    });
    assert.deepStrictEqual(readJson(geminiJson()).mcpServers["vscode-abl"], {
      command: "node",
      args: [SHIM_V1, PIPE],
    });
    const toml = fs.readFileSync(codexToml(), "utf8");
    assert.ok(toml.includes("[mcp_servers.vscode-abl]"));
    assert.ok(toml.includes(JSON.stringify(SHIM_V1)));
  });

  test("auto mode is a no-op when entries are already up to date", async () => {
    await installMcpConfigs({ ...pipeOptions(SHIM_V1), auto: true });
    const before = fs.readFileSync(mcpJson(), "utf8");

    const written = await installMcpConfigs({
      ...pipeOptions(SHIM_V1),
      auto: true,
    });

    assert.deepStrictEqual(written, []);
    assert.strictEqual(fs.readFileSync(mcpJson(), "utf8"), before);
  });

  test("auto mode refreshes a stale shim path after an extension upgrade", async () => {
    await installMcpConfigs({ ...pipeOptions(SHIM_V1), auto: true });

    const written = await installMcpConfigs({
      ...pipeOptions(SHIM_V2),
      auto: true,
    });

    assert.strictEqual(written.length, 3);
    assert.deepStrictEqual(readJson(mcpJson()).mcpServers["vscode-abl"].args, [
      SHIM_V2,
      PIPE,
    ]);
    assert.deepStrictEqual(
      readJson(geminiJson()).mcpServers["vscode-abl"].args,
      [SHIM_V2, PIPE]
    );
    const toml = fs.readFileSync(codexToml(), "utf8");
    assert.ok(toml.includes(JSON.stringify(SHIM_V2)));
    assert.ok(!toml.includes(JSON.stringify(SHIM_V1)));
  });

  test("auto mode refreshes a stale pipe path (workspace moved)", async () => {
    await installMcpConfigs({ ...pipeOptions(SHIM_V1), auto: true });
    const newPipe = "\\\\.\\pipe\\vscode-abl-mcp-def456";

    await installMcpConfigs({ ...pipeOptions(SHIM_V1, newPipe), auto: true });

    assert.deepStrictEqual(readJson(mcpJson()).mcpServers["vscode-abl"].args, [
      SHIM_V1,
      newPipe,
    ]);
  });

  test("auto mode preserves other servers when refreshing", async () => {
    writeWorkspaceFile(
      mcpJson(),
      JSON.stringify({
        mcpServers: {
          other: { type: "stdio", command: "other-server", args: [] },
          "vscode-abl": {
            type: "stdio",
            command: "node",
            args: [SHIM_V1, PIPE],
          },
        },
      })
    );
    writeWorkspaceFile(
      codexToml(),
      `[mcp_servers.other]\ncommand = "other-server"\n\n[mcp_servers.vscode-abl]\ncommand = "node"\nargs = [${JSON.stringify(
        SHIM_V1
      )}, ${JSON.stringify(PIPE)}]\n\n[mcp_servers.last]\ncommand = "last"\n`
    );

    await installMcpConfigs({ ...pipeOptions(SHIM_V2), auto: true });

    const json = readJson(mcpJson());
    assert.strictEqual(json.mcpServers.other.command, "other-server");
    assert.deepStrictEqual(json.mcpServers["vscode-abl"].args, [SHIM_V2, PIPE]);
    const toml = fs.readFileSync(codexToml(), "utf8");
    assert.ok(toml.includes("[mcp_servers.other]"));
    assert.ok(toml.includes("[mcp_servers.last]"));
    assert.ok(toml.includes(JSON.stringify(SHIM_V2)));
    assert.ok(!toml.includes(JSON.stringify(SHIM_V1)));
  });

  test("auto mode never overwrites a hand-edited entry", async () => {
    const handEdited = {
      type: "stdio",
      command: "node",
      args: ["C:\\dev\\my-custom-proxy.js", PIPE],
    };
    writeWorkspaceFile(
      mcpJson(),
      JSON.stringify({ mcpServers: { "vscode-abl": handEdited } })
    );
    writeWorkspaceFile(
      geminiJson(),
      JSON.stringify({
        mcpServers: { "vscode-abl": { command: "node", args: ["dev.js"] } },
      })
    );
    const customToml = `[mcp_servers.vscode-abl]\ncommand = "node"\nargs = ["C:\\\\dev\\\\my-custom-proxy.js"]\n`;
    writeWorkspaceFile(codexToml(), customToml);

    const written = await installMcpConfigs({
      ...pipeOptions(SHIM_V2),
      auto: true,
    });

    assert.deepStrictEqual(written, []);
    assert.deepStrictEqual(
      readJson(mcpJson()).mcpServers["vscode-abl"],
      handEdited
    );
    assert.deepStrictEqual(readJson(geminiJson()).mcpServers["vscode-abl"], {
      command: "node",
      args: ["dev.js"],
    });
    assert.strictEqual(fs.readFileSync(codexToml(), "utf8"), customToml);
  });

  test("auto mode leaves an existing HTTP-style entry alone", async () => {
    const httpEntry = { type: "http", url: "http://127.0.0.1:3000/mcp" };
    writeWorkspaceFile(
      mcpJson(),
      JSON.stringify({ mcpServers: { "vscode-abl": httpEntry } })
    );

    await installMcpConfigs({ ...pipeOptions(SHIM_V2), auto: true });

    assert.deepStrictEqual(
      readJson(mcpJson()).mcpServers["vscode-abl"],
      httpEntry
    );
  });

  test("auto mode adds the entry to an existing file that lacks it", async () => {
    writeWorkspaceFile(
      mcpJson(),
      JSON.stringify({
        mcpServers: { other: { type: "stdio", command: "x", args: [] } },
      })
    );

    await installMcpConfigs({ ...pipeOptions(SHIM_V1), auto: true });

    const json = readJson(mcpJson());
    assert.strictEqual(json.mcpServers.other.command, "x");
    assert.deepStrictEqual(json.mcpServers["vscode-abl"].args, [SHIM_V1, PIPE]);
  });

  test("writes only the selected clients", async () => {
    const written = await installMcpConfigs({
      ...pipeOptions(SHIM_V1),
      auto: true,
      clients: ["claude"],
    });

    assert.deepStrictEqual(written, [mcpJson()]);
    assert.strictEqual(fs.existsSync(path.dirname(geminiJson())), false);
    assert.strictEqual(fs.existsSync(path.dirname(codexToml())), false);
  });

  test("manual (non-auto) install still overwrites a hand-edited entry", async () => {
    writeWorkspaceFile(
      mcpJson(),
      JSON.stringify({
        mcpServers: {
          "vscode-abl": {
            type: "stdio",
            command: "node",
            args: ["C:\\dev\\my-custom-proxy.js"],
          },
        },
      })
    );

    const written = await installMcpConfigs(pipeOptions(SHIM_V1));

    assert.strictEqual(written.length, 3);
    assert.deepStrictEqual(readJson(mcpJson()).mcpServers["vscode-abl"].args, [
      SHIM_V1,
      PIPE,
    ]);
  });
});
