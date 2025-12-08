import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../utils/logger";

export async function compileBuffer() {
  logger.info("Executing abl.compileBuffer command...");
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) {
    logger.warn("callCompileBuffer: No active editor found");
    vscode.window.showWarningMessage(
      "No active editor found. Please open an ABL file first."
    );
    return;
  }

  try {
    // Execute the abl.compileBuffer command provided by the vscode-abl extension
    await vscode.commands.executeCommand("abl.compileBuffer");
    logger.info("abl.compileBuffer command executed successfully");

    const documentUri = activeEditor.document.uri;
    logger.info(
      `compileBuffer: Active document: ${activeEditor.document.fileName}`
    );
    logger.info(
      `compileBuffer: Language ID: ${activeEditor.document.languageId}`
    );
    logger.info(`compileBuffer: Document URI: ${documentUri.toString()}`);

    let diagnostics = vscode.languages.getDiagnostics(documentUri);

    // Method 3: Poll for diagnostics with retries
    if (diagnostics.length === 0) {
      logger.info(
        "compileBuffer: Method 3 - Polling for diagnostics (3 attempts)..."
      );
      for (let attempt = 1; attempt <= 3; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500)); // Wait 500ms between attempts
        diagnostics = vscode.languages.getDiagnostics(documentUri);
        logger.info(
          `compileBuffer: Method 3 attempt ${attempt}/3 found ${diagnostics.length} diagnostic(s)`
        );
        if (diagnostics.length > 0) {
          break;
        }
      }
    }

    if (diagnostics.length > 0) {
      const diagnosticMessages = diagnostics
        .map(
          (d) =>
            `${
              d.severity === vscode.DiagnosticSeverity.Error
                ? "Error"
                : "Warning"
            }: ${d.message} (Line ${d.range.start.line + 1})`
        )
        .join("\n");
      logger.info(`compileBuffer: Diagnostics: ${diagnosticMessages}`);

      return {
        success: true,
        message: `Buffer compiled with diagnostics:\n${diagnosticMessages}`,
      };
    }

    logger.info(`compileBuffer: Diagnostics: None`);
    return { success: true, message: "Buffer compiled successfully" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to execute abl.compileBuffer: ${errorMessage}`);
    return {
      success: false,
      message: `Failed to compile buffer: ${errorMessage}`,
    };
  }
}

export async function callCompileBuffer() {
  logger.info(
    "callCompileBuffer: Starting direct test of abl.compileBuffer command"
  );

  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) {
    logger.warn("callCompileBuffer: No active editor found");
    vscode.window.showWarningMessage(
      "No active editor found. Please open an ABL file first."
    );
    return;
  }

  const documentUri = activeEditor.document.uri;
  logger.info(
    `callCompileBuffer: Active document: ${activeEditor.document.fileName}`
  );
  logger.info(
    `callCompileBuffer: Language ID: ${activeEditor.document.languageId}`
  );
  logger.info(`callCompileBuffer: Document URI: ${documentUri.toString()}`);

  try {
    logger.info(
      "callCompileBuffer: Calling vscode.commands.executeCommand('abl.compileBuffer')..."
    );
    const result = await vscode.commands.executeCommand("abl.compileBuffer");

    logger.info("callCompileBuffer: Command executed successfully");
    logger.info(`callCompileBuffer: Result type: ${typeof result}`);
    logger.info(
      `callCompileBuffer: Result value: ${JSON.stringify(result, null, 2)}`
    );

    // Add delay to allow diagnostics to be updated
    //const delayMs = 1000; // 1 second delay
    //logger.info(
    //  `callCompileBuffer: Waiting ${delayMs}ms for diagnostics to update...`
    //);
    //await new Promise((resolve) => setTimeout(resolve, delayMs));

    let diagnostics = vscode.languages.getDiagnostics(documentUri);

    // Method 3: Poll for diagnostics with retries
    if (diagnostics.length === 0) {
      logger.info(
        "callCompileBuffer: Method 3 - Polling for diagnostics (3 attempts)..."
      );
      for (let attempt = 1; attempt <= 3; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500)); // Wait 500ms between attempts
        diagnostics = vscode.languages.getDiagnostics(documentUri);
        logger.info(
          `callCompileBuffer: Method 3 attempt ${attempt}/3 found ${diagnostics.length} diagnostic(s)`
        );
        if (diagnostics.length > 0) {
          break;
        }
      }
    }

    // Query diagnostics from the Problems view - Method 1: Direct query
    logger.info(
      "callCompileBuffer: Method 1 - Querying diagnostics directly for this file..."
    );

    logger.info(
      `callCompileBuffer: Method 1 found ${diagnostics.length} diagnostic(s)`
    );

    // Method 2: Query all diagnostics and filter
    logger.info(
      "callCompileBuffer: Method 2 - Querying all diagnostics and filtering..."
    );
    const allDiagnostics = vscode.languages.getDiagnostics();
    logger.info(
      `callCompileBuffer: Method 2 found ${allDiagnostics.length} files with diagnostics`
    );

    const matchingDiagnostics = allDiagnostics.find(
      ([uri]) => uri.toString() === documentUri.toString()
    );

    if (matchingDiagnostics) {
      const [, diags] = matchingDiagnostics;
      logger.info(
        `callCompileBuffer: Method 2 found ${diags.length} diagnostic(s) for this file`
      );

      // Use Method 2 results if Method 1 returned empty
      if (diagnostics.length === 0 && diags.length > 0) {
        logger.info(
          "callCompileBuffer: Using Method 2 results as Method 1 was empty"
        );
        diagnostics = diags;
      }
    } else {
      logger.info(
        "callCompileBuffer: Method 2 did not find this file in diagnostics"
      );
    }

    // Categorize diagnostics by severity
    const errors = diagnostics.filter(
      (d) => d.severity === vscode.DiagnosticSeverity.Error
    );
    const warnings = diagnostics.filter(
      (d) => d.severity === vscode.DiagnosticSeverity.Warning
    );
    const infos = diagnostics.filter(
      (d) => d.severity === vscode.DiagnosticSeverity.Information
    );
    const hints = diagnostics.filter(
      (d) => d.severity === vscode.DiagnosticSeverity.Hint
    );

    logger.info(
      `callCompileBuffer: Final count - Errors: ${errors.length}, Warnings: ${warnings.length}, Info: ${infos.length}, Hints: ${hints.length}`
    );

    // Log detailed information about each diagnostic
    if (diagnostics.length > 0) {
      logger.info("callCompileBuffer: Detailed diagnostics:");
      diagnostics.forEach((diagnostic, index) => {
        const severityName =
          diagnostic.severity === vscode.DiagnosticSeverity.Error
            ? "ERROR"
            : diagnostic.severity === vscode.DiagnosticSeverity.Warning
            ? "WARNING"
            : diagnostic.severity === vscode.DiagnosticSeverity.Information
            ? "INFO"
            : "HINT";

        logger.info(
          `callCompileBuffer:   [${index + 1}] ${severityName}: ${
            diagnostic.message
          }`
        );
        logger.info(
          `callCompileBuffer:       Line ${
            diagnostic.range.start.line + 1
          }, Column ${diagnostic.range.start.character + 1}`
        );
        if (diagnostic.source) {
          logger.info(`callCompileBuffer:       Source: ${diagnostic.source}`);
        }
        if (diagnostic.code) {
          logger.info(`callCompileBuffer:       Code: ${diagnostic.code}`);
        }
      });
    } else {
      logger.warn(
        "callCompileBuffer: No diagnostics found after all attempts. This may indicate:"
      );
      logger.warn(
        "callCompileBuffer:   - The file compiled successfully with no issues"
      );
      logger.warn(
        "callCompileBuffer:   - Diagnostics are published with a longer delay"
      );
      logger.warn(
        "callCompileBuffer:   - The ABL extension uses a different diagnostic mechanism"
      );
    }

    // Determine compilation success
    const compilationSuccessful = errors.length === 0;

    if (compilationSuccessful) {
      logger.info(
        `callCompileBuffer: ✓ Compilation SUCCESSFUL (no errors)${
          diagnostics.length === 0 ? " - No diagnostics found" : ""
        }`
      );
      vscode.window.showInformationMessage(
        `Compilation successful! ${
          warnings.length > 0
            ? `${warnings.length} warning(s) found.`
            : diagnostics.length === 0
            ? "No diagnostics found."
            : "No warnings."
        }`
      );
    } else {
      logger.error(
        `callCompileBuffer: ✗ Compilation FAILED with ${errors.length} error(s)`
      );
      vscode.window.showErrorMessage(
        `Compilation failed with ${errors.length} error(s) and ${warnings.length} warning(s). Check output logs for details.`
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error(
      `callCompileBuffer: Failed to execute abl.compileBuffer: ${errorMessage}`
    );
    if (errorStack) {
      logger.error(`callCompileBuffer: Error stack: ${errorStack}`);
    }
    logger.error(
      `callCompileBuffer: Error type: ${
        error?.constructor?.name || typeof error
      }`
    );

    vscode.window.showErrorMessage(
      `Failed to execute abl.compileBuffer: ${errorMessage}`
    );
  }
}

/**
 * Registers MCP ABL-related tools with the server
 * @param server MCP server instance
 */
export function registerAblTools(server: McpServer): void {
  // Add compile_buffer tool
  server.tool(
    "compile_buffer",
    `Compiles the currently active ABL buffer using the vscode-abl extension's compile command.

    This tool executes the abl.compileBuffer command and returns compilation results including any errors, warnings, or other diagnostics.

    WHEN TO USE: After editing ABL files to check for compilation errors.
    NOTE: This compiles the currently active editor buffer. Make sure the ABL file you want to compile is open and active.
    Returns: Compilation status and detailed diagnostics if any issues are found.`,
    {},
    async (): Promise<CallToolResult> => {
      logger.info("[compile_buffer] Tool called");

      try {
        const activeEditor = vscode.window.activeTextEditor;

        if (!activeEditor) {
          const errorMsg =
            "No active editor found. Please open an ABL file first.";
          logger.warn(`[compile_buffer] ${errorMsg}`);
          return {
            content: [
              {
                type: "text",
                text: errorMsg,
              },
            ],
            isError: true,
          };
        }

        const documentUri = activeEditor.document.uri;
        logger.info(
          `[compile_buffer] Compiling: ${activeEditor.document.fileName}`
        );

        // Execute the abl.compileBuffer command
        await vscode.commands.executeCommand("abl.compileBuffer");
        logger.info("[compile_buffer] Command executed successfully");

        // Poll for diagnostics with retries
        let diagnostics = vscode.languages.getDiagnostics(documentUri);

        if (diagnostics.length === 0) {
          logger.info(
            "[compile_buffer] Polling for diagnostics (3 attempts)..."
          );
          for (let attempt = 1; attempt <= 3; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            diagnostics = vscode.languages.getDiagnostics(documentUri);
            logger.info(
              `[compile_buffer] Attempt ${attempt}/3 found ${diagnostics.length} diagnostic(s)`
            );
            if (diagnostics.length > 0) {
              break;
            }
          }
        }

        // Categorize diagnostics by severity
        const errors = diagnostics.filter(
          (d) => d.severity === vscode.DiagnosticSeverity.Error
        );
        const warnings = diagnostics.filter(
          (d) => d.severity === vscode.DiagnosticSeverity.Warning
        );
        const infos = diagnostics.filter(
          (d) => d.severity === vscode.DiagnosticSeverity.Information
        );
        const hints = diagnostics.filter(
          (d) => d.severity === vscode.DiagnosticSeverity.Hint
        );

        logger.info(
          `[compile_buffer] Results - Errors: ${errors.length}, Warnings: ${warnings.length}, Info: ${infos.length}, Hints: ${hints.length}`
        );

        // Format diagnostics for output
        const formatDiagnostic = (d: vscode.Diagnostic) => ({
          severity:
            d.severity === vscode.DiagnosticSeverity.Error
              ? "Error"
              : d.severity === vscode.DiagnosticSeverity.Warning
              ? "Warning"
              : d.severity === vscode.DiagnosticSeverity.Information
              ? "Information"
              : "Hint",
          message: d.message,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          source: d.source,
          code: d.code,
        });

        const result = {
          success: errors.length === 0,
          file: activeEditor.document.fileName,
          diagnostics: {
            errors: errors.map(formatDiagnostic),
            warnings: warnings.map(formatDiagnostic),
            infos: infos.map(formatDiagnostic),
            hints: hints.map(formatDiagnostic),
          },
          summary: {
            totalErrors: errors.length,
            totalWarnings: warnings.length,
            totalInfos: infos.length,
            totalHints: hints.length,
          },
        };

        const resultText = JSON.stringify(result, null, 2);
        logger.info(`[compile_buffer] Completed successfully`);

        return {
          content: [
            {
              type: "text",
              text: resultText,
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(`[compile_buffer] Error: ${errorMessage}`);

        return {
          content: [
            {
              type: "text",
              text: `Failed to compile buffer: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
