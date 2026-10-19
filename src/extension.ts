import * as vscode from "vscode";
import { MCPServer, ToolConfiguration, TransportConfiguration } from "./server";
import { listWorkspaceFiles } from "./tools/file-tools";
import {
  installMcpConfigs,
  MCP_CLIENT_LABELS,
  MCP_CLIENTS,
  McpClient,
  toMcpClients,
} from "./mcpConfigInstall";
import { getPipePath } from "./pipePath";
import { getAutoStartMode, getWindowContent, shouldAutoStart } from "./autoStart";
import { logger } from "./utils/logger";

// Re-export for testing purposes
export { MCPServer };

let mcpServer: MCPServer | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let sharedTerminal: vscode.Terminal | undefined;
// Server state - disabled by default
let serverEnabled: boolean = false;

// Terminal name constant
const TERMINAL_NAME = "MCP Shell Commands";
// workspaceState key: the user's on/off choice for this workspace, which
// overrides the autoStart setting once set
const SERVER_ENABLED_KEY = "mcpServerEnabled";

/**
 * Gets the transport configuration from VS Code settings. The pipe path is
 * derived from the workspace folder, so it's only computed when the pipe
 * transport is actually enabled.
 */
function getTransportConfiguration(): TransportConfiguration {
  const config = vscode.workspace.getConfiguration("vscode-abl-mcp");
  const pipe = config.get<boolean>("pipeEnabled") ?? true;
  const http = config.get<boolean>("httpEnabled") ?? false;

  return {
    http,
    pipe,
    pipePath: pipe ? getPipePath() : undefined,
  };
}

/**
 * Gets the tool configuration from VS Code settings
 * @returns ToolConfiguration object with all tool enablement settings
 */
function getToolConfiguration(): ToolConfiguration {
  const config = vscode.workspace.getConfiguration("vscode-abl-mcp");
  const enabledTools = config.get<any>("enabledTools") || {};

  return {
    file: enabledTools.file ?? true,
    edit: enabledTools.edit ?? true,
    shell: enabledTools.shell ?? false,
    diagnostics: enabledTools.diagnostics ?? true,
    symbol: enabledTools.symbol ?? true,
    abl: enabledTools.abl ?? true,
  };
}

/**
 * Gets or creates the shared terminal for the extension
 * @param context The extension context
 * @returns The shared terminal instance
 */
export function getExtensionTerminal(
  context: vscode.ExtensionContext
): vscode.Terminal {
  // Check if a terminal with our name already exists
  const existingTerminal = vscode.window.terminals.find(
    (t) => t.name === TERMINAL_NAME
  );

  if (existingTerminal && existingTerminal.exitStatus === undefined) {
    // Reuse the existing terminal if it's still open
    logger.info(
      "[getExtensionTerminal] Reusing existing terminal for shell commands"
    );
    return existingTerminal;
  }

  // Create a new terminal if it doesn't exist or if it has exited
  sharedTerminal = vscode.window.createTerminal(TERMINAL_NAME);
  logger.info("[getExtensionTerminal] Created new terminal for shell commands");
  context.subscriptions.push(sharedTerminal);

  return sharedTerminal;
}

/**
 * For the clients selected in `autoCreateMcpConfig`, creates any missing
 * workspace MCP client config and refreshes stale entries this extension
 * wrote earlier. Never throws: a failure here must not stop the server from
 * starting.
 */
async function autoCreateMcpConfigIfEnabled(
  context: vscode.ExtensionContext
): Promise<void> {
  const config = vscode.workspace.getConfiguration("vscode-abl-mcp");
  const clients = toMcpClients(config.get("autoCreateMcpConfig"));
  if (clients.length === 0) {
    return;
  }
  const transport = getTransportConfiguration();
  if (
    !vscode.workspace.workspaceFolders?.length ||
    (!transport.pipe && !transport.http)
  ) {
    return;
  }

  try {
    const written = await installMcpConfigs({
      http: transport.http
        ? {
            port: config.get<number>("port") || 3000,
            host: config.get<string>("host") || "127.0.0.1",
          }
        : undefined,
      pipe: transport.pipe
        ? {
            path: transport.pipePath!,
            shimPath: context.asAbsolutePath("dist/mcp-pipe-proxy.js"),
          }
        : undefined,
      auto: true,
      clients,
    });
    if (written.length > 0) {
      logger.info(`[autoCreateMcpConfig] Wrote: ${written.join(", ")}`);
    }
  } catch (error) {
    logger.error(
      `[autoCreateMcpConfig] ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function describeTransport(
  port: number,
  transport: TransportConfiguration,
  suffix: string = ""
): string {
  const parts: string[] = [];
  if (transport.pipe) {
    parts.push(`pipe at ${transport.pipePath}`);
  }
  if (transport.http) {
    parts.push(`http://localhost:${port}/mcp`);
  }
  const description =
    parts.length > 0 ? parts.join(" and ") : "no transport enabled";
  return `Vscode ABL MCP running on ${description}${suffix ? " " + suffix : ""}`;
}

// Function to update status bar
function updateStatusBar(port: number, transport: TransportConfiguration) {
  if (!statusBarItem) {
    return;
  }

  if (serverEnabled) {
    const parts: string[] = [];
    if (transport.pipe) {
      parts.push("pipe");
    }
    if (transport.http) {
      parts.push(`:${port}`);
    }
    statusBarItem.text = `$(server) Vscode ABL MCP: ${
      parts.length > 0 ? parts.join(", ") : "no transport"
    }`;
    statusBarItem.tooltip = describeTransport(port, transport, "(Click to toggle)");
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = `$(server) Vscode ABL MCP: Off`;
    statusBarItem.tooltip = `Vscode ABL MCP is disabled (Click to toggle)`;
    // Use a subtle color to indicate disabled state
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  }
  statusBarItem.show();
}

// Function to toggle server state
async function toggleServerState(
  context: vscode.ExtensionContext
): Promise<void> {
  logger.info(
    `[toggleServerState] Starting toggle operation - changing from ${serverEnabled} to ${!serverEnabled}`
  );

  serverEnabled = !serverEnabled;

  // Remember the choice for this workspace only
  context.workspaceState.update(SERVER_ENABLED_KEY, serverEnabled);

  const config = vscode.workspace.getConfiguration("vscode-abl-mcp");
  const port = config.get<number>("port") || 3000;
  const host = config.get<string>("host") || "127.0.0.1";
  const transportConfig = getTransportConfiguration();

  // Update status bar immediately to provide feedback
  updateStatusBar(port, transportConfig);

  if (serverEnabled) {
    // Start the server if it was disabled
    if (!mcpServer) {
      logger.info(`[toggleServerState] Creating Vscode ABL MCP instance`);
      const terminal = getExtensionTerminal(context);
      const toolConfig = getToolConfiguration();
      mcpServer = new MCPServer(port, host, terminal, toolConfig, transportConfig);
      mcpServer.setFileListingCallback(
        async (path: string, recursive: boolean) => {
          try {
            return await listWorkspaceFiles(path, recursive);
          } catch (error) {
            logger.error(
              `[toggleServerState] Error listing files: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
            throw error;
          }
        }
      );

      logger.info(
        `[toggleServerState] Starting server at ${new Date().toISOString()}`
      );
      const startTime = Date.now();

      await mcpServer.start();
      await autoCreateMcpConfigIfEnabled(context);

      const duration = Date.now() - startTime;
      logger.info(
        `[toggleServerState] Server started successfully at ${new Date().toISOString()} (took ${duration}ms)`
      );

      vscode.window.showInformationMessage(
        describeTransport(port, transportConfig)
      );
    }
  } else {
    // Stop the server if it was enabled
    if (mcpServer) {
      // Show progress indicator
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Stopping Vscode ABL MCP",
          cancellable: false,
        },
        async (progress) => {
          logger.info(
            `[toggleServerState] Stopping server at ${new Date().toISOString()}`
          );
          progress.report({ message: "Closing connections..." });

          const stopTime = Date.now();
          if (mcpServer) {
            await mcpServer.stop();
          }

          const duration = Date.now() - stopTime;
          logger.info(
            `[toggleServerState] Server stopped successfully at ${new Date().toISOString()} (took ${duration}ms)`
          );

          mcpServer = undefined;
        }
      );

      vscode.window.showInformationMessage("Vscode ABL MCP has been disabled");
    }
  }

  logger.info(`[toggleServerState] Toggle operation completed`);
}

export async function activate(context: vscode.ExtensionContext) {
  logger.info("Activating vscode-abl-mcp extension");

  try {
    // Get configuration
    const config = vscode.workspace.getConfiguration("vscode-abl-mcp");
    const port = config.get<number>("port") || 3000;
    const host = config.get<string>("host") || "127.0.0.1";

    // The user's toggle for this workspace wins; otherwise the autoStart rule
    const saved = context.workspaceState.get<boolean>(SERVER_ENABLED_KEY);
    if (saved !== undefined) {
      serverEnabled = saved;
      logger.info(`[activate] Server enabled: ${serverEnabled} (saved for this workspace)`);
    } else {
      const mode = getAutoStartMode(config);
      serverEnabled = shouldAutoStart(mode, await getWindowContent());
      logger.info(`[activate] Server enabled: ${serverEnabled} (autoStart: ${mode})`);
    }

    logger.info(`[activate] Using port ${port} from configuration`);

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    statusBarItem.command = "vscode-abl-mcp.toggleServer";

    let transportConfig = getTransportConfiguration();

    // Only start the server if enabled
    if (serverEnabled) {
      // Create the shared terminal
      const terminal = getExtensionTerminal(context);

      // Initialize Vscode ABL MCP with the configured port, terminal, tool and transport configuration
      const toolConfig = getToolConfiguration();
      mcpServer = new MCPServer(port, host, terminal, toolConfig, transportConfig);

      // Set up file listing callback
      mcpServer.setFileListingCallback(
        async (path: string, recursive: boolean) => {
          try {
            return await listWorkspaceFiles(path, recursive);
          } catch (error) {
            logger.error(
              `Error listing files: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
            throw error;
          }
        }
      );

      await mcpServer.start();
      await autoCreateMcpConfigIfEnabled(context);
      logger.info("Vscode ABL MCP started successfully");
    } else {
      logger.info("Vscode ABL MCP not started in this window");
    }

    // Update status bar after server state is determined
    updateStatusBar(port, transportConfig);

    // Register commands
    const toggleServerCommand = vscode.commands.registerCommand(
      "vscode-abl-mcp.toggleServer",
      () => toggleServerState(context)
    );

    const showServerInfoCommand = vscode.commands.registerCommand(
      "vscode-abl-mcp.showServerInfo",
      () => {
        if (serverEnabled) {
          const currentConfig = vscode.workspace.getConfiguration("vscode-abl-mcp");
          const currentPort = currentConfig.get<number>("port") || 3000;
          vscode.window.showInformationMessage(
            describeTransport(currentPort, getTransportConfiguration())
          );
        } else {
          vscode.window.showInformationMessage(
            "Vscode ABL MCP is currently disabled. Click on the status bar item to enable it."
          );
        }
      }
    );

    const resetServerStateCommand = vscode.commands.registerCommand(
      "vscode-abl-mcp.resetServerState",
      async () => {
        await context.workspaceState.update(SERVER_ENABLED_KEY, undefined);
        vscode.window.showInformationMessage(
          "Vscode ABL MCP: this workspace follows the autoStart setting again from the next start."
        );
      }
    );

    const installMcpConfigCommand = vscode.commands.registerCommand(
      "vscode-abl-mcp.installMcpConfig",
      async () => {
        const currentConfig = vscode.workspace.getConfiguration("vscode-abl-mcp");
        const currentPort = currentConfig.get<number>("port") || 3000;
        const currentHost = currentConfig.get<string>("host") || "127.0.0.1";
        const currentTransport = getTransportConfiguration();

        // Preselect the auto-create clients, or all of them when none are set
        const configured = toMcpClients(currentConfig.get("autoCreateMcpConfig"));
        const preselected = configured.length > 0 ? configured : MCP_CLIENTS;
        const picked = await vscode.window.showQuickPick(
          MCP_CLIENTS.map((client) => ({
            label: MCP_CLIENT_LABELS[client],
            client,
            picked: preselected.includes(client),
          })),
          { canPickMany: true, title: "Write MCP config for" }
        );
        if (!picked || picked.length === 0) {
          return;
        }
        const clients: McpClient[] = picked.map((item) => item.client);

        try {
          const written = await installMcpConfigs({
            clients,
            http: currentTransport.http
              ? { port: currentPort, host: currentHost }
              : undefined,
            pipe: currentTransport.pipe
              ? {
                  path: currentTransport.pipePath!,
                  shimPath: context.asAbsolutePath("dist/mcp-pipe-proxy.js"),
                }
              : undefined,
          });
          logger.info(
            `[installMcpConfig] Wrote MCP client config: ${written.join(", ")}`
          );
          vscode.window.showInformationMessage(
            `Vscode ABL MCP: updated MCP config (${written.length} file(s)).`
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.error(`[installMcpConfig] Failed to write MCP config: ${message}`);
          vscode.window.showErrorMessage(
            `Vscode ABL MCP: failed to update MCP config: ${message}`
          );
        }
      }
    );

    // Listen for configuration changes to restart server if needed
    const configChangeListener = vscode.workspace.onDidChangeConfiguration(
      async (event) => {
        if (
          event.affectsConfiguration("vscode-abl-mcp.autoCreateMcpConfig") &&
          serverEnabled
        ) {
          await autoCreateMcpConfigIfEnabled(context);
        }

        const transportSettingsChanged =
          event.affectsConfiguration("vscode-abl-mcp.pipeEnabled") ||
          event.affectsConfiguration("vscode-abl-mcp.httpEnabled") ||
          event.affectsConfiguration("vscode-abl-mcp.port") ||
          event.affectsConfiguration("vscode-abl-mcp.host");

        if (
          event.affectsConfiguration("vscode-abl-mcp.enabledTools") ||
          transportSettingsChanged
        ) {
          logger.info(
            "[configChangeListener] Configuration changed - restarting server if enabled"
          );
          transportConfig = getTransportConfiguration();

          if (serverEnabled && mcpServer) {
            // Stop current server
            await mcpServer.stop();
            mcpServer = undefined;

            // Start new server with updated configuration
            const config = vscode.workspace.getConfiguration("vscode-abl-mcp");
            const port = config.get<number>("port") || 3000;
            const host = config.get<string>("host") || "127.0.0.1";
            const terminal = getExtensionTerminal(context);
            const toolConfig = getToolConfiguration();

            mcpServer = new MCPServer(port, host, terminal, toolConfig, transportConfig);
            mcpServer.setFileListingCallback(
              async (path: string, recursive: boolean) => {
                try {
                  return await listWorkspaceFiles(path, recursive);
                } catch (error) {
                  logger.error(
                    `[configChangeListener] Error listing files: ${
                      error instanceof Error ? error.message : String(error)
                    }`
                  );
                  throw error;
                }
              }
            );
            await mcpServer.start();
            await autoCreateMcpConfigIfEnabled(context);
            updateStatusBar(port, transportConfig);

            vscode.window.showInformationMessage(
              "Vscode ABL MCP restarted with updated configuration"
            );
          } else {
            updateStatusBar(port, transportConfig);
          }
        }
      }
    );

    // Add all disposables to the context subscriptions
    context.subscriptions.push(
      statusBarItem,
      toggleServerCommand,
      showServerInfoCommand,
      resetServerStateCommand,
      installMcpConfigCommand,
      configChangeListener,
      { dispose: async () => mcpServer && (await mcpServer.stop()) }
    );
  } catch (error) {
    logger.error(
      `Failed to start Vscode ABL MCP: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
    vscode.window.showErrorMessage(
      `Failed to start Vscode ABL MCP: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}

export async function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
    statusBarItem = undefined;
  }

  // Dispose the shared terminal
  if (sharedTerminal) {
    sharedTerminal.dispose();
    sharedTerminal = undefined;
  }

  if (!mcpServer) {
    return;
  }

  try {
    logger.info("Stopping Vscode ABL MCP during extension deactivation");
    await mcpServer.stop();
    logger.info("Vscode ABL MCP stopped successfully");
  } catch (error) {
    logger.error(
      `Error stopping Vscode ABL MCP: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    throw error; // Re-throw to ensure VS Code knows about the failure
  } finally {
    mcpServer = undefined;
    // Dispose the logger
    logger.dispose();
  }
}
