import express from "express";
import * as vscode from "vscode";
import * as net from "net";
import * as fs from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "http";
import { Request, Response } from "express";
import { registerFileTools, FileListingCallback } from "./tools/file-tools";
import { registerEditTools } from "./tools/edit-tools";
import { registerShellTools } from "./tools/shell-tools";
import { registerDiagnosticsTools } from "./tools/diagnostics-tools";
import { registerSymbolTools } from "./tools/symbol-tools";
import { registerAblTools } from "./tools/abl";
import { logger } from "./utils/logger";

export interface TransportConfiguration {
  /** HTTP transport on a TCP port - simple, but a fixed port can collide across workspace windows. */
  http?: boolean;
  /** Named pipe (Windows) / Unix domain socket (Linux/macOS) transport - one per workspace, no port conflicts. */
  pipe?: boolean;
  /** Filesystem path (Unix) or pipe name (Windows) to listen on when `pipe` is enabled. */
  pipePath?: string;
}

export interface ToolConfiguration {
  file: boolean;
  edit: boolean;
  shell: boolean;
  diagnostics: boolean;
  symbol: boolean;
  abl: boolean;
}

export class MCPServer {
  private app: express.Application;
  private httpServer?: Server;
  private pipeServer?: net.Server;
  private port: number;
  private host: string;
  private httpEnabled: boolean;
  private pipeEnabled: boolean;
  private pipePath?: string;
  private fileListingCallback?: FileListingCallback;
  private terminal?: vscode.Terminal;
  private toolConfig: ToolConfiguration;

  public setFileListingCallback(callback: FileListingCallback) {
    this.fileListingCallback = callback;
  }

  constructor(
    port: number = 3000,
    host: string = "127.0.0.1",
    terminal?: vscode.Terminal,
    toolConfig?: ToolConfiguration,
    transport?: TransportConfiguration
  ) {
    this.port = port;
    this.host = host;
    this.terminal = terminal;
    this.toolConfig = toolConfig || {
      file: true,
      edit: true,
      shell: true,
      diagnostics: true,
      symbol: true,
      abl: true,
    };
    // Defaults keep this class usable standalone (e.g. in tests); the
    // extension itself always passes explicit transport settings.
    this.httpEnabled = transport?.http ?? true;
    this.pipeEnabled = transport?.pipe ?? false;
    this.pipePath = transport?.pipePath;

    this.app = express();
    this.app.use(express.json());

    this.setupRoutes();
    this.setupEventHandlers();
  }

  /**
   * Creates a fresh McpServer with all enabled tools registered.
   * The server runs stateless: each POST request gets its own
   * McpServer + transport pair, so clients can (re)initialize at any time.
   */
  private createMcpServer(): McpServer {
    const server = new McpServer(
      {
        name: "vscode-abl-mcp",
        version: "0.4.0",
      },
      {
        capabilities: {
          logging: {},
          tools: {
            listChanged: false,
          },
        },
      }
    );

    if (this.toolConfig.file) {
      if (this.fileListingCallback) {
        registerFileTools(server, this.fileListingCallback);
      } else {
        logger.warn("File listing callback not set - file tools disabled");
      }
    }
    if (this.toolConfig.edit) {
      registerEditTools(server);
    }
    if (this.toolConfig.shell) {
      registerShellTools(server, this.terminal);
    }
    if (this.toolConfig.diagnostics) {
      registerDiagnosticsTools(server);
    }
    if (this.toolConfig.symbol) {
      registerSymbolTools(server);
    }
    if (this.toolConfig.abl) {
      registerAblTools(server);
    }

    return server;
  }

  private setupRoutes(): void {
    // Handle POST requests for client-to-server communication.
    // Stateless mode: a fresh McpServer + transport per request, torn down
    // when the response closes, so clients can (re)connect at any time.
    this.app.post("/mcp", async (req, res) => {
      logger.info(`Request received: ${req.method} ${req.url}`);
      try {
        const server = this.createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });

        res.on("close", () => {
          transport.close();
          server.close();
        });

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        logger.error(
          `Error handling MCP request: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          });
        }
      }
    });

    // Handle unsupported methods
    this.app.get("/mcp", async (req, res) => {
      logger.info(
        `Received GET MCP request from ${req.ip}: ${req.method} ${req.url}`
      );
      res.writeHead(405).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed.",
          },
          id: null,
        })
      );
    });

    this.app.delete("/mcp", async (req, res) => {
      logger.info(
        `Received DELETE MCP request from ${req.ip}: ${req.method} ${req.url}`
      );
      res.writeHead(405).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed.",
          },
          id: null,
        })
      );
    });

    // Handle OPTIONS requests for CORS
    this.app.options("/mcp", (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
      res.status(204).end();
    });
  }

  private setupEventHandlers(): void {
    // Log HTTP server events
    if (this.httpServer) {
      this.httpServer.on("error", (error: Error) => {
        logger.error(`[Server] HTTP Server Error: ${error.message}`);
      });

      this.httpServer.on("listening", () => {
        logger.info(`[Server] HTTP Server ready`);
      });

      this.httpServer.on("close", () => {
        logger.info(`[Server] HTTP Server closed`);
      });
    }
  }

  private async startHttp(): Promise<void> {
    logger.info("[MCPServer.start] Starting HTTP server");
    const httpServerStartTime = Date.now();

    return new Promise((resolve, reject) => {
      // Bind to localhost only for security
      this.httpServer = this.app.listen(this.port, this.host, () => {
        const httpStartTime = Date.now() - httpServerStartTime;
        logger.info(
          `[MCPServer.start] HTTP Server started (took ${httpStartTime}ms)`
        );
        logger.info(`Vscode ABL MCP listening on ${this.host}:${this.port}`);
        resolve();
      });
      this.httpServer.once("error", reject);
    });
  }

  /**
   * Starts a named pipe (Windows) / Unix domain socket (Linux/macOS) server.
   * Each connection gets its own McpServer + StdioServerTransport pair -
   * a net.Socket is duck-type compatible with the stdin/stdout streams that
   * transport expects, so no custom transport is needed. Unlike the fixed
   * HTTP port, the pipe path is derived per-workspace, so it can't collide
   * with another VS Code window.
   */
  private async startPipe(): Promise<void> {
    if (!this.pipePath) {
      throw new Error("Pipe transport enabled but no pipe path was configured");
    }
    const pipePath = this.pipePath;

    // Unix domain sockets are backed by a filesystem entry; a stale one left
    // behind by a crashed previous run must be removed before listen() can
    // bind. Windows named pipes have no such filesystem entry.
    if (process.platform !== "win32" && fs.existsSync(pipePath)) {
      try {
        fs.unlinkSync(pipePath);
      } catch (error) {
        logger.warn(
          `[MCPServer.start] Could not remove stale socket at ${pipePath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return new Promise((resolve, reject) => {
      this.pipeServer = net.createServer((socket) => {
        const mcpServer = this.createMcpServer();
        const transport = new StdioServerTransport(socket, socket);

        socket.on("close", () => {
          transport.close();
          mcpServer.close();
        });
        socket.on("error", (error) => {
          logger.error(`[Server] Pipe connection error: ${error.message}`);
        });

        mcpServer.connect(transport).catch((error) => {
          logger.error(
            `[Server] Failed to connect pipe transport: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          socket.destroy();
        });
      });

      this.pipeServer.once("error", reject);
      this.pipeServer.listen(pipePath, () => {
        logger.info(`[Server] Pipe server listening on ${pipePath}`);
        resolve();
      });
    });
  }

  public async start(): Promise<void> {
    try {
      logger.info("[MCPServer.start] Starting Vscode ABL MCP");
      const startTime = Date.now();

      logger.info(
        `Serving MCP tools with configuration: ${JSON.stringify(
          this.toolConfig
        )}`
      );

      if (!this.httpEnabled && !this.pipeEnabled) {
        logger.warn(
          "[MCPServer.start] No MCP transport enabled (both HTTP and pipe are disabled) - server will not accept connections"
        );
      }

      const startups: Promise<void>[] = [];
      if (this.httpEnabled) {
        startups.push(this.startHttp());
      }
      if (this.pipeEnabled) {
        startups.push(this.startPipe());
      }
      await Promise.all(startups);

      const totalTime = Date.now() - startTime;
      logger.info(
        `[MCPServer.start] Server startup complete (total: ${totalTime}ms)`
      );
    } catch (error) {
      logger.error(
        `[MCPServer.start] Failed to start Vscode ABL MCP: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
  }

  public async stop(forceTimeout: number = 5000): Promise<void> {
    logger.info("[MCPServer.stop] Starting server shutdown process");
    const stopStartTime = Date.now();

    try {
      // Close HTTP server with timeout
      if (this.httpServer) {
        logger.info("[MCPServer.stop] Closing HTTP server (with timeout)");
        const httpServerCloseStart = Date.now();

        await Promise.race([
          // Normal close operation
          new Promise<void>((resolve, reject) => {
            this.httpServer!.close((err) => {
              const httpCloseTime = Date.now() - httpServerCloseStart;
              if (err) {
                logger.error(
                  `[MCPServer.stop] HTTP server closed with error: ${err.message} (took ${httpCloseTime}ms)`
                );
                reject(err);
              } else {
                logger.info(
                  `[MCPServer.stop] HTTP server closed successfully (took ${httpCloseTime}ms)`
                );
                resolve();
              }
            });
          }),

          // Timeout fallback
          new Promise<void>((resolve) => {
            setTimeout(() => {
              logger.warn(
                `[MCPServer.stop] HTTP server close timed out after ${forceTimeout}ms - forcing close`
              );
              // We resolve anyway to continue with the shutdown process
              resolve();
            }, forceTimeout);
          }),
        ]);
      }

      // Close pipe server with timeout
      if (this.pipeServer) {
        logger.info("[MCPServer.stop] Closing pipe server (with timeout)");
        const pipeServerCloseStart = Date.now();
        const pipePath = this.pipePath;

        await Promise.race([
          new Promise<void>((resolve, reject) => {
            this.pipeServer!.close((err) => {
              const pipeCloseTime = Date.now() - pipeServerCloseStart;
              if (err) {
                logger.error(
                  `[MCPServer.stop] Pipe server closed with error: ${err.message} (took ${pipeCloseTime}ms)`
                );
                reject(err);
              } else {
                logger.info(
                  `[MCPServer.stop] Pipe server closed successfully (took ${pipeCloseTime}ms)`
                );
                resolve();
              }
            });
          }),
          new Promise<void>((resolve) => {
            setTimeout(() => {
              logger.warn(
                `[MCPServer.stop] Pipe server close timed out after ${forceTimeout}ms - forcing close`
              );
              resolve();
            }, forceTimeout);
          }),
        ]).catch(() => undefined);

        // Clean up the socket file so a fresh listen() doesn't need to.
        if (process.platform !== "win32" && pipePath && fs.existsSync(pipePath)) {
          try {
            fs.unlinkSync(pipePath);
          } catch {
            // Best effort - a stale file is cleaned up on next start anyway.
          }
        }
      }

      // Per-request/connection servers and transports are torn down as
      // their connections close; closing the listeners is all that remains.
      const totalStopTime = Date.now() - stopStartTime;
      logger.info(
        `[MCPServer.stop] Vscode ABL MCP shutdown complete (total: ${totalStopTime}ms)`
      );
    } catch (error) {
      logger.error(
        `[MCPServer.stop] Error during server shutdown: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
  }
}
