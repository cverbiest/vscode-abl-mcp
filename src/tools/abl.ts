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

/**
 * Shared handler wrapper: resolves the file URI, invokes the LM tool,
 * and maps the outcome onto an MCP CallToolResult.
 */
async function runAblTool(
  mcpToolName: string,
  lmToolName: string,
  filePath: string | undefined,
  extraInput: Record<string, unknown> = {}
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

    const text = await invokeAblLmTool(lmToolName, {
      fileUri: uri.toString(),
      ...extraInput,
    });

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

/**
 * Registers MCP ABL-related tools with the server.
 * These bridge to the Language Model tools contributed by the
 * RiversideSoftware.openedge-abl-lsp extension (abl_compile,
 * abl_check_syntax, abl_xref).
 * @param server MCP server instance
 */
export function registerAblTools(server: McpServer): void {
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
}
