import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import * as proxyquireLib from "proxyquire";
import { createMockContext } from "./testUtils";

// Configure proxyquire
const proxyquire = proxyquireLib.noPreserveCache().noCallThru();

suite("Extension Test Suite", () => {
  let mockMCPServer: any;
  let MockServerConstructor: sinon.SinonStub;
  let extension: any;
  let workspaceConfig: any;
  let statusBarItem: any;
  let context: any; // Changed type to any to avoid type errors
  let getConfigurationStub: sinon.SinonStub;
  let createStatusBarItemStub: sinon.SinonStub;
  let registerCommandStub: sinon.SinonStub;
  let onDidChangeConfigurationStub: sinon.SinonStub;

  setup(() => {
    // Create mock MCPServer
    mockMCPServer = {
      start: sinon.stub().resolves(),
      stop: sinon.stub().resolves(),
      setFileListingCallback: sinon.spy(),
    };

    // Mock constructor for MCPServer
    MockServerConstructor = sinon.stub().returns(mockMCPServer);

    // Load extension with mocked dependencies
    extension = proxyquire("../extension", {
      "./server": { MCPServer: MockServerConstructor },
    });

    // Create mock status bar item
    statusBarItem = {
      text: "",
      tooltip: "",
      command: "",
      show: sinon.spy(),
      dispose: sinon.spy(),
    };

    // Mock vscode.window.createStatusBarItem
    createStatusBarItemStub = sinon
      .stub(vscode.window, "createStatusBarItem")
      .returns(statusBarItem);

    // Mock configuration - server enabled by default so activation starts it
    const configGet = sinon.stub();
    configGet.withArgs("port").returns(4321);
    configGet.withArgs("defaultEnabled").returns(true);
    workspaceConfig = { get: configGet };
    getConfigurationStub = sinon
      .stub(vscode.workspace, "getConfiguration")
      .returns(workspaceConfig);

    // Create a mocked extension context
    context = createMockContext();

    // Mock command registration
    registerCommandStub = sinon
      .stub(vscode.commands, "registerCommand")
      .returns({
        dispose: sinon.spy(),
      });

    // Mock onDidChangeConfiguration
    onDidChangeConfigurationStub = sinon
      .stub(vscode.workspace, "onDidChangeConfiguration")
      .returns({
        dispose: sinon.spy(),
      });
  });

  teardown(() => {
    // Restore all sinon stubs and mocks after each test
    sinon.restore();
  });

  test("Extension should read port from configuration", async () => {
    // Activate the extension
    await extension.activate(context);

    // Check that configuration was accessed
    assert.strictEqual(
      getConfigurationStub.called,
      true,
      "Configuration not accessed"
    );
    assert.strictEqual(
      workspaceConfig.get.calledWith("port"),
      true,
      "Port not read from configuration"
    );

    // Check that MCPServer was created with configured port
    assert.strictEqual(
      MockServerConstructor.calledWith(4321),
      true,
      "MCPServer not created with configured port"
    );
  });

  test("Status bar item should be created with proper attributes", async () => {
    // Activate the extension
    await extension.activate(context);

    // Verify status bar was created
    assert.strictEqual(
      createStatusBarItemStub.called,
      true,
      "Status bar item not created"
    );

    // Check the status bar attributes
    assert.strictEqual(
      statusBarItem.command,
      "vscode-abl-mcp.toggleServer",
      "Status bar command not set correctly"
    );
    assert.strictEqual(statusBarItem.show.called, true, "Status bar not shown");

    // Pipe transport is enabled by default (and HTTP is not), so the status
    // bar should reflect the pipe transport rather than a port number.
    assert.strictEqual(
      statusBarItem.text.includes("pipe"),
      true,
      "Status bar does not show the enabled pipe transport"
    );
  });

  test("Server info command should be registered", async () => {
    // Activate the extension
    await extension.activate(context);

    // Check that the command was registered
    const showServerInfoCall = registerCommandStub
      .getCalls()
      .find((call) => call.args[0] === "vscode-abl-mcp.showServerInfo");
    assert.strictEqual(
      showServerInfoCall !== undefined,
      true,
      "Server info command not registered"
    );
  });

  test("Configuration change listener should be registered", async () => {
    // Activate the extension
    await extension.activate(context);

    // Check that the listener was registered
    assert.strictEqual(
      onDidChangeConfigurationStub.called,
      true,
      "Configuration change listener not registered"
    );
  });

  test("Deactivate should clean up resources", async () => {
    // First activate to set up resources
    await extension.activate(context);

    // Then deactivate
    await extension.deactivate();

    // Check that status bar was disposed
    assert.strictEqual(
      statusBarItem.dispose.called,
      true,
      "Status bar not disposed during deactivation"
    );

    // Check that server was stopped
    assert.strictEqual(
      mockMCPServer.stop.called,
      true,
      "Server not stopped during deactivation"
    );
  });
});

suite("Extension autoCreateMcpConfig Test Suite", () => {
  let mockMCPServer: any;
  let installMcpConfigsStub: sinon.SinonStub;
  let extension: any;
  let context: any;
  let settings: Record<string, unknown>;
  let workspaceFolders: vscode.WorkspaceFolder[] | undefined;
  let serverConstructorStub: sinon.SinonStub;
  let configListener: (event: vscode.ConfigurationChangeEvent) => Promise<void>;

  // Builds a fake change event reporting only the given settings as affected
  const changeEvent = (...keys: string[]) =>
    ({
      affectsConfiguration: (section: string) => keys.includes(section),
    }) as vscode.ConfigurationChangeEvent;

  setup(() => {
    mockMCPServer = {
      start: sinon.stub().resolves(),
      stop: sinon.stub().resolves(),
      setFileListingCallback: sinon.spy(),
    };
    serverConstructorStub = sinon.stub().returns(mockMCPServer);
    installMcpConfigsStub = sinon.stub().resolves([]);

    extension = proxyquire("../extension", {
      "./server": { MCPServer: serverConstructorStub },
      "./mcpConfigInstall": { installMcpConfigs: installMcpConfigsStub },
      // The real logger is a shared singleton that the "Deactivate" test above
      // disposes, so any later use of it throws "Channel has been closed".
      "./utils/logger": {
        logger: {
          info: sinon.spy(),
          warn: sinon.spy(),
          error: sinon.spy(),
          debug: sinon.spy(),
          dispose: sinon.spy(),
        },
      },
    });

    // Defaults: server enabled, setting on, pipe transport (its default) enabled
    settings = {
      port: 4321,
      defaultEnabled: true,
      autoCreateMcpConfig: true,
    };
    workspaceFolders = [
      { uri: vscode.Uri.file("C:\\ws\\project"), name: "project", index: 0 },
    ];

    sinon.stub(vscode.workspace, "getConfiguration").returns({
      get: (key: string) => settings[key],
    } as any);
    sinon.stub(vscode.workspace, "workspaceFolders").get(() => workspaceFolders);
    sinon.stub(vscode.window, "createStatusBarItem").returns({
      text: "",
      tooltip: "",
      command: "",
      show: sinon.spy(),
      dispose: sinon.spy(),
    } as any);
    sinon.stub(vscode.commands, "registerCommand").returns({
      dispose: sinon.spy(),
    });
    sinon
      .stub(vscode.workspace, "onDidChangeConfiguration")
      .callsFake((listener: any) => {
        configListener = listener;
        return { dispose: sinon.spy() } as any;
      });
    sinon.stub(vscode.window, "showInformationMessage");

    context = createMockContext();
  });

  teardown(() => {
    sinon.restore();
  });

  test("Creates the MCP config when the setting is turned on while the server is running", async () => {
    settings.autoCreateMcpConfig = false;
    await extension.activate(context);
    assert.strictEqual(installMcpConfigsStub.called, false);

    settings.autoCreateMcpConfig = true;
    await configListener(changeEvent("vscode-abl-mcp.autoCreateMcpConfig"));

    assert.strictEqual(installMcpConfigsStub.calledOnce, true);
    assert.strictEqual(installMcpConfigsStub.firstCall.args[0].auto, true);
    assert.strictEqual(
      mockMCPServer.stop.called,
      false,
      "Toggling the setting should not restart the server"
    );
    assert.strictEqual(serverConstructorStub.calledOnce, true);
  });

  test("Ignores setting changes that don't affect the MCP config", async () => {
    await extension.activate(context);
    installMcpConfigsStub.resetHistory();

    await configListener(changeEvent("editor.fontSize"));

    assert.strictEqual(installMcpConfigsStub.called, false);
  });

  test("Does not create the config on a setting change when the server is disabled", async () => {
    settings.defaultEnabled = false;
    await extension.activate(context);

    await configListener(changeEvent("vscode-abl-mcp.autoCreateMcpConfig"));

    assert.strictEqual(installMcpConfigsStub.called, false);
  });

  test("Does not create the config when the setting is turned off", async () => {
    await extension.activate(context);
    installMcpConfigsStub.resetHistory();

    settings.autoCreateMcpConfig = false;
    await configListener(changeEvent("vscode-abl-mcp.autoCreateMcpConfig"));

    assert.strictEqual(installMcpConfigsStub.called, false);
  });

  test("Re-creates the config after a transport setting change restarts the server", async () => {
    await extension.activate(context);
    installMcpConfigsStub.resetHistory();

    settings.httpEnabled = true;
    await configListener(changeEvent("vscode-abl-mcp.httpEnabled"));

    assert.strictEqual(mockMCPServer.stop.calledOnce, true);
    assert.strictEqual(serverConstructorStub.calledTwice, true);
    assert.strictEqual(installMcpConfigsStub.calledOnce, true);
    assert.deepStrictEqual(installMcpConfigsStub.firstCall.args[0].http, {
      port: 4321,
      host: "127.0.0.1",
    });
  });

  test("Creates the MCP config with auto mode when the setting is on", async () => {
    await extension.activate(context);

    assert.strictEqual(installMcpConfigsStub.calledOnce, true);
    const options = installMcpConfigsStub.firstCall.args[0];
    assert.strictEqual(options.auto, true);
    assert.strictEqual(options.http, undefined);
    assert.strictEqual(
      options.pipe.shimPath,
      context.asAbsolutePath("dist/mcp-pipe-proxy.js")
    );
    assert.ok(
      options.pipe.path.includes("vscode-abl-mcp-"),
      "Pipe path should be the per-workspace pipe path"
    );
    assert.strictEqual(
      mockMCPServer.start.calledBefore(installMcpConfigsStub),
      true,
      "Config should be created after the server starts"
    );
  });

  test("Passes the HTTP endpoint when the HTTP transport is enabled", async () => {
    settings.httpEnabled = true;
    settings.pipeEnabled = false;
    settings.host = "10.0.0.5";

    await extension.activate(context);

    const options = installMcpConfigsStub.firstCall.args[0];
    assert.deepStrictEqual(options.http, { port: 4321, host: "10.0.0.5" });
    assert.strictEqual(options.pipe, undefined);
  });

  test("Does nothing when the setting is off", async () => {
    settings.autoCreateMcpConfig = false;

    await extension.activate(context);

    assert.strictEqual(installMcpConfigsStub.called, false);
  });

  test("Does nothing when the setting is unset (default off)", async () => {
    delete settings.autoCreateMcpConfig;

    await extension.activate(context);

    assert.strictEqual(installMcpConfigsStub.called, false);
  });

  test("Does nothing when the server is disabled", async () => {
    settings.defaultEnabled = false;

    await extension.activate(context);

    assert.strictEqual(installMcpConfigsStub.called, false);
  });

  test("Does nothing when no workspace folder is open", async () => {
    workspaceFolders = undefined;

    await extension.activate(context);

    assert.strictEqual(installMcpConfigsStub.called, false);
  });

  test("Does nothing when no transport is enabled", async () => {
    settings.pipeEnabled = false;
    settings.httpEnabled = false;

    await extension.activate(context);

    assert.strictEqual(installMcpConfigsStub.called, false);
  });

  test("A config write failure does not stop the server from starting", async () => {
    installMcpConfigsStub.rejects(new Error("disk full"));
    const showErrorStub = sinon.stub(vscode.window, "showErrorMessage");

    await extension.activate(context);

    assert.strictEqual(installMcpConfigsStub.calledOnce, true);
    assert.strictEqual(mockMCPServer.start.calledOnce, true);
    assert.strictEqual(
      showErrorStub.called,
      false,
      "Activation should not surface the auto-create failure as a startup error"
    );
  });
});
