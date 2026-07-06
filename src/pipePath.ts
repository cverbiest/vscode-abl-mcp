import * as vscode from "vscode";
import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";

/**
 * Derives a per-workspace pipe/socket path so multiple VS Code windows never
 * collide the way a single fixed TCP port does. Falls back to a per-process
 * seed when no workspace folder is open (e.g. an empty window).
 */
export function getPipePath(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const seed = folder ?? `${vscode.env.machineId}-${process.pid}`;
  const hash = crypto
    .createHash("sha256")
    .update(seed)
    .digest("hex")
    .slice(0, 16);
  const name = `vscode-abl-mcp-${hash}`;

  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${name}`;
  }
  return path.join(os.tmpdir(), `${name}.sock`);
}
