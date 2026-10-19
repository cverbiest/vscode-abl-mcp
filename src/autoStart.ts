import * as vscode from "vscode";

/**
 * When the MCP server starts on its own, before the user touches the status
 * bar toggle (`vscode-abl-mcp.autoStart`).
 */
export type AutoStartMode =
  | "never"
  | "always"
  | "folder"
  | "workspace"
  | "openedgeProject";

const MODES: readonly AutoStartMode[] = [
  "never",
  "always",
  "folder",
  "workspace",
  "openedgeProject",
];

/** The project file vscode-abl uses to recognise an OpenEdge project. */
export const OPENEDGE_PROJECT_FILE = "openedge-project.json";

/** What is open in this window, as far as `autoStart` cares. */
export interface WindowContent {
  /** At least one folder is open. */
  hasFolders: boolean;
  /** A `.code-workspace` file is open (possibly multi-root). */
  isWorkspaceFile: boolean;
  /** Some workspace folder has `openedge-project.json` at its root. */
  hasOpenEdgeProject: boolean;
}

export function shouldAutoStart(
  mode: AutoStartMode,
  window: WindowContent
): boolean {
  switch (mode) {
    case "always":
      return true;
    case "folder":
      return window.hasFolders && !window.isWorkspaceFile;
    case "workspace":
      return window.isWorkspaceFile;
    case "openedgeProject":
      return window.hasOpenEdgeProject;
    default:
      return false;
  }
}

/** Reads `autoStart`; anything unrecognised means "never". */
export function getAutoStartMode(
  config: vscode.WorkspaceConfiguration
): AutoStartMode {
  const mode = config.get<string>("autoStart");
  return MODES.includes(mode as AutoStartMode)
    ? (mode as AutoStartMode)
    : "never";
}

export async function getWindowContent(): Promise<WindowContent> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const found = await Promise.all(
    folders.map(async (folder) => {
      try {
        await vscode.workspace.fs.stat(
          vscode.Uri.joinPath(folder.uri, OPENEDGE_PROJECT_FILE)
        );
        return true;
      } catch {
        return false;
      }
    })
  );
  return {
    hasFolders: folders.length > 0,
    isWorkspaceFile: vscode.workspace.workspaceFile !== undefined,
    hasOpenEdgeProject: found.includes(true),
  };
}
