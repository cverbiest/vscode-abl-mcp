import * as vscode from "vscode";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../utils/logger";

const ABL_EXTENSION_ID = "RiversideSoftware.openedge-abl-lsp";

/**
 * Resolves a user-supplied path (workspace-relative, absolute, or file URI)
 * to a vscode.Uri. Falls back to the active ABL editor when no path is given.
 */
function resolveFileUri(filePath?: string): vscode.Uri | undefined {
  if (filePath) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filePath)) {
      return vscode.Uri.parse(filePath);
    }
    if (path.isAbsolute(filePath)) {
      return vscode.Uri.file(filePath);
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error(
        `Cannot resolve relative path "${filePath}": no workspace folder is open`
      );
    }
    return vscode.Uri.joinPath(workspaceFolder.uri, filePath);
  }

  const editor = vscode.window.activeTextEditor;
  if (editor?.document.languageId === "abl") {
    return editor.document.uri;
  }
  return undefined;
}

/**
 * Invokes a Language Model tool contributed by the vscode-abl extension
 * (RiversideSoftware.openedge-abl-lsp) and returns its text output.
 */
async function invokeAblLmTool(
  toolName: string,
  input: Record<string, unknown>
): Promise<string> {
  const ablExtension = vscode.extensions.getExtension(ABL_EXTENSION_ID);
  if (!ablExtension) {
    throw new Error(
      `The OpenEdge ABL extension (${ABL_EXTENSION_ID}) is not installed. ` +
        `Install version 1.33.7 or later (1.33.9+ for check syntax) to use the ABL tools.`
    );
  }
  if (!ablExtension.isActive) {
    logger.info(`[invokeAblLmTool] Activating ${ABL_EXTENSION_ID}`);
    try {
      await ablExtension.activate();
    } catch (error) {
      throw new Error(
        `The OpenEdge ABL extension (${ABL_EXTENSION_ID}) failed to activate: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Do not pre-check vscode.lm.tools: its listing can be filtered and may
  // omit tools that are perfectly invocable by name. Invoke directly and
  // diagnose on failure.
  logger.info(
    `[invokeAblLmTool] Invoking ${toolName} with input: ${JSON.stringify(
      input
    )}`
  );
  let result: vscode.LanguageModelToolResult;
  try {
    result = await vscode.lm.invokeTool(toolName, {
      input,
      toolInvocationToken: undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/client is not running/i.test(message)) {
      const startHint = supportsLanguageServerTools()
        ? "Start it with the start_language_server_abl tool."
        : 'Start it from VS Code with the "Restart Language Server" command (abl.restart.langserv).';
      throw new Error(
        `Invoking language model tool "${toolName}" failed: ${message}. ` +
          `The ABL language server is not running. ${startHint}`
      );
    }
    const ablVersion = ablExtension.packageJSON?.version ?? "unknown";
    const registered =
      vscode.lm.tools.map((t) => t.name).join(", ") || "(none)";
    throw new Error(
      `Invoking language model tool "${toolName}" failed: ${message}. ` +
        `LM tools require ${ABL_EXTENSION_ID} 1.33.7+ (1.33.9+ for abl_check_syntax). ` +
        `Detected version: ${ablVersion} (active: ${ablExtension.isActive}). ` +
        `Tools listed in vscode.lm.tools: ${registered}`
    );
  }

  const text = result.content
    .filter(
      (part): part is vscode.LanguageModelTextPart =>
        part instanceof vscode.LanguageModelTextPart
    )
    .map((part) => part.value)
    .join("\n");

  logger.info(`[invokeAblLmTool] ${toolName} returned ${text.length} chars`);
  return text;
}

const ABL_COMMAND_TIMEOUT_MS = 20000;

/**
 * Fallback for ABL capabilities not (yet) contributed as Language Model
 * tools. Opens the target file, runs the extension's built-in command
 * (which operates on the active editor and shows its output in a new
 * editor once the language server responds), and captures that editor's
 * text instead of relying on a return value.
 */
async function invokeAblCommand(
  commandId: string,
  uri: vscode.Uri,
  timeoutMs = ABL_COMMAND_TIMEOUT_MS
): Promise<string> {
  await vscode.window.showTextDocument(uri, { preview: false });

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const disposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (settled || !editor || editor.document.uri.toString() === uri.toString()) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      disposable.dispose();
      resolve(editor.document.getText());
    });

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      disposable.dispose();
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for the ABL extension to generate output via command "${commandId}". ` +
            `Check VS Code notifications for a compiler error (the file may not belong to an OpenEdge project, or the compile failed).`
        )
      );
    }, timeoutMs);

    vscode.commands.executeCommand(commandId).then(undefined, (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      disposable.dispose();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/**
 * Shared handler wrapper: resolves the file URI, invokes the LM tool,
 * and maps the outcome onto an MCP CallToolResult. If the LM tool isn't
 * contributed by the installed ABL extension version and a
 * fallbackCommandId is given, falls back to driving the extension's
 * built-in command instead.
 */
async function runAblTool(
  mcpToolName: string,
  lmToolName: string,
  filePath: string | undefined,
  extraInput: Record<string, unknown> = {},
  fallbackCommandId?: string
): Promise<CallToolResult> {
  logger.info(`[${mcpToolName}] Tool called with path=${filePath ?? "(active editor)"}`);

  try {
    const uri = resolveFileUri(filePath);
    if (!uri) {
      return {
        content: [
          {
            type: "text",
            text: "No path provided and no active ABL editor is open. Pass the 'path' parameter (workspace-relative or absolute).",
          },
        ],
        isError: true,
      };
    }

    let text: string;
    try {
      text = await invokeAblLmTool(lmToolName, {
        fileUri: uri.toString(),
        ...extraInput,
      });
    } catch (lmError) {
      if (!fallbackCommandId) {
        throw lmError;
      }
      logger.info(
        `[${mcpToolName}] LM tool "${lmToolName}" unavailable, falling back to command "${fallbackCommandId}": ${
          lmError instanceof Error ? lmError.message : String(lmError)
        }`
      );
      text = await invokeAblCommand(fallbackCommandId, uri);
    }

    return {
      content: [{ type: "text", text }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[${mcpToolName}] Error: ${errorMessage}`);
    return {
      content: [{ type: "text", text: errorMessage }],
      isError: true,
    };
  }
}

/** First vscode-abl version that contributes the language server LM tools. */
const LANGUAGE_SERVER_TOOLS_MIN_VERSION = "1.39.2";

/** Compares major.minor.patch only (pre-release suffixes are ignored). */
function isVersionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string): number[] =>
    v.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const a = parse(version);
  const b = parse(minimum);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) {
      return (a[i] ?? 0) > (b[i] ?? 0);
    }
  }
  return true;
}

/**
 * True when the installed ABL extension contributes the language server
 * LM tools (abl_start/stop/restart_language_server, abl_set_build_mode).
 * Checked on every registration; the server builds a fresh McpServer per
 * request, so an updated ABL extension is picked up without a restart.
 */
function supportsLanguageServerTools(): boolean {
  const version = vscode.extensions.getExtension(ABL_EXTENSION_ID)?.packageJSON
    ?.version;
  return (
    typeof version === "string" &&
    isVersionAtLeast(version, LANGUAGE_SERVER_TOOLS_MIN_VERSION)
  );
}

/**
 * Runs a Language Model tool that takes no file (language server control)
 * and maps the outcome onto an MCP CallToolResult.
 */
async function runAblServerTool(
  mcpToolName: string,
  lmToolName: string,
  input: Record<string, unknown>,
  fallbackText: string
): Promise<CallToolResult> {
  logger.info(`[${mcpToolName}] Tool called`);
  try {
    const text = await invokeAblLmTool(lmToolName, input);
    return { content: [{ type: "text", text: text || fallbackText }] };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[${mcpToolName}] Error: ${errorMessage}`);
    return { content: [{ type: "text", text: errorMessage }], isError: true };
  }
}

/**
 * Registers the language server control tools (start, stop, restart, set
 * build mode). Only registered with vscode-abl 1.39.2+.
 */
function registerLanguageServerTools(server: McpServer): void {
  if (!supportsLanguageServerTools()) {
    logger.info(
      `[registerAblTools] Language server tools not registered: they require ${ABL_EXTENSION_ID} ${LANGUAGE_SERVER_TOOLS_MIN_VERSION}+ (not installed or older).`
    );
    return;
  }

  server.registerTool(
    "start_language_server_abl",
    {
      description: `Starts the ABL language server, or restarts it if it is already running.

        WHEN TO USE: When the language server is not running (e.g. it was stopped). Requires vscode-abl ${LANGUAGE_SERVER_TOOLS_MIN_VERSION}+.`,
      inputSchema: {},
    },
    async (): Promise<CallToolResult> =>
      runAblServerTool(
        "start_language_server_abl",
        "abl_start_language_server",
        {},
        "ABL language server started."
      )
  );

  server.registerTool(
    "stop_language_server_abl",
    {
      description: `Stops the ABL language server. Requires vscode-abl ${LANGUAGE_SERVER_TOOLS_MIN_VERSION}+.`,
      inputSchema: {},
    },
    async (): Promise<CallToolResult> =>
      runAblServerTool(
        "stop_language_server_abl",
        "abl_stop_language_server",
        {},
        "ABL language server stopped."
      )
  );

  server.registerTool(
    "restart_language_server_abl",
    {
      description: `Restarts the ABL language server.

        WHEN TO USE: After changing the build mode or openedge-project.json, or when compile results look stale. Requires vscode-abl ${LANGUAGE_SERVER_TOOLS_MIN_VERSION}+.`,
      inputSchema: {},
    },
    async (): Promise<CallToolResult> =>
      runAblServerTool(
        "restart_language_server_abl",
        "abl_restart_language_server",
        {},
        "ABL language server restarted."
      )
  );

  server.registerTool(
    "set_build_mode_abl",
    {
      description: `Changes the ABL build mode (abl.buildMode setting) of the language server. Use 'none' to disable automatic builds, for example when sources have to be compiled in a particular order. Optionally restarts the language server afterwards. Requires vscode-abl ${LANGUAGE_SERVER_TOOLS_MIN_VERSION}+.`,
      inputSchema: {
        mode: z
          .enum(["everything", "classes", "modified", "none"])
          .describe(
            "everything = build all sources; classes = build only classes; modified = only build files modified after startup; none = never build"
          ),
        restart: z
          .boolean()
          .optional()
          .describe("Restart the language server after changing the mode"),
      },
    },
    async ({ mode, restart }): Promise<CallToolResult> =>
      runAblServerTool(
        "set_build_mode_abl",
        "abl_set_build_mode",
        { mode, restart: restart ?? false },
        `ABL build mode set to '${mode}'.`
      )
  );
}

/**
 * Registers MCP ABL-related tools with the server.
 * These bridge to the Language Model tools contributed by the
 * RiversideSoftware.openedge-abl-lsp extension (abl_compile,
 * abl_check_syntax, abl_xref, abl_preprocess, abl_debug_listing,
 * abl_listing). The last three are only contributed as LM tools since
 * 1.36.0, so on older extension versions they fall back to driving the
 * extension's abl.preprocess/abl.generateDebugListing/abl.generateListing
 * commands and capturing the editor they open.
 * The language server control tools (start/stop/restart, set build mode)
 * are registered only when vscode-abl 1.39.2+ is installed.
 * @param server MCP server instance
 */
export function registerAblTools(server: McpServer): void {
  registerLanguageServerTools(server);

  server.registerTool(
    "compile_abl",
    {
      description: `Compiles an OpenEdge ABL source file using the ABL language server and returns all compiler errors and warnings with their location and severity.

        WHEN TO USE: After editing ABL files, to check whether the code is valid.
        The file is compiled from its saved content on disk; save changes first (or use check_syntax_abl for unsaved buffer content).
        If path is omitted, the currently active ABL editor is compiled.`,
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Path of the ABL file to compile (workspace-relative or absolute). If omitted, the active editor is used."
          ),
      },
    },
    async ({ path: filePath }): Promise<CallToolResult> =>
      runAblTool("compile_abl", "abl_compile", filePath)
  );

  server.registerTool(
    "check_syntax_abl",
    {
      description: `Checks the syntax of an OpenEdge ABL file's buffer content using the ABL language server, without requiring the file to be saved on disk. Returns success or the list of syntax errors.

        WHEN TO USE: To validate ABL code after making changes, including unsaved changes in open editors.
        If path is omitted, the currently active ABL editor is checked.`,
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Path of the ABL file to check (workspace-relative or absolute). If omitted, the active editor is used."
          ),
      },
    },
    async ({ path: filePath }): Promise<CallToolResult> =>
      runAblTool("check_syntax_abl", "abl_check_syntax", filePath)
  );

  server.registerTool(
    "xref_abl",
    {
      description: `Generates an XREF (or XML XREF) file for an OpenEdge ABL source file using the ABL language server and returns its content.

        WHEN TO USE: To inspect cross-reference information such as table/field accesses, procedure calls, and include file references.
        If path is omitted, the currently active ABL editor is used.`,
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Path of the ABL file to process (workspace-relative or absolute). If omitted, the active editor is used."
          ),
        xml: z
          .boolean()
          .optional()
          .describe(
            "When true, generates XML XREF; when false or omitted, generates plain XREF."
          ),
      },
    },
    async ({ path: filePath, xml }): Promise<CallToolResult> =>
      runAblTool("xref_abl", "abl_xref", filePath, { xml: xml ?? false })
  );

  server.registerTool(
    "preprocess_abl",
    {
      description: `Runs COMPILE ... PREPROCESS on an OpenEdge ABL source file using the ABL language server and returns the preprocessed output (all preprocessor directives, includes, and conditional compilation resolved).

        WHEN TO USE: To inspect what the compiler actually sees after include-file expansion and preprocessor directive resolution.
        If path is omitted, the currently active ABL editor is used.`,
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Path of the ABL file to preprocess (workspace-relative or absolute). If omitted, the active editor is used."
          ),
      },
    },
    async ({ path: filePath }): Promise<CallToolResult> =>
      runAblTool("preprocess_abl", "abl_preprocess", filePath, {}, "abl.preprocess")
  );

  server.registerTool(
    "debug_listing_abl",
    {
      description: `Runs COMPILE ... DEBUG-LISTING on an OpenEdge ABL source file using the ABL language server and returns the debug listing (the fully expanded, line-numbered source used by the AVM at runtime, mapping compiled line numbers back to source locations).

        WHEN TO USE: To debug runtime line numbers reported by the AVM (e.g. in STOP/ERROR conditions or a debugger) back to source, or to inspect the exact code the compiler generated.
        If path is omitted, the currently active ABL editor is used.`,
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Path of the ABL file to generate a debug listing for (workspace-relative or absolute). If omitted, the active editor is used."
          ),
      },
    },
    async ({ path: filePath }): Promise<CallToolResult> =>
      runAblTool(
        "debug_listing_abl",
        "abl_debug_listing",
        filePath,
        {},
        "abl.generateDebugListing"
      )
  );

  server.registerTool(
    "listing_abl",
    {
      description: `Runs COMPILE ... LISTING on an OpenEdge ABL source file using the ABL language server and returns the listing (the expanded source with include files, line numbers, block structure, buffer scopes and transaction blocks).

        WHEN TO USE: To inspect block and buffer scoping, or where transactions start and end, e.g. when investigating record locking or unexpected transaction scope.
        If path is omitted, the currently active ABL editor is used.`,
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Path of the ABL file to generate a listing for (workspace-relative or absolute). If omitted, the active editor is used."
          ),
      },
    },
    async ({ path: filePath }): Promise<CallToolResult> =>
      runAblTool(
        "listing_abl",
        "abl_listing",
        filePath,
        {},
        "abl.generateListing"
      )
  );
}
