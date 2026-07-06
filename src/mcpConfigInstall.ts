import * as vscode from "vscode";
import { logger } from "./utils/logger";

const SERVER_NAME = "vscode-abl";

function buildUrl(host: string, port: number): string {
  const clientHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${clientHost}:${port}/mcp`;
}

async function readFileIfExists(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return undefined;
  }
}

async function writeFile(uri: vscode.Uri, content: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}

async function ensureDir(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(uri);
  } catch {
    // Already exists.
  }
}

/**
 * Merges a single `mcpServers.<key>` entry into a JSON config file,
 * preserving any other content already in the file.
 */
async function upsertJsonMcpServer(
  fileUri: vscode.Uri,
  serverKey: string,
  serverEntry: Record<string, unknown>
): Promise<void> {
  const existing = await readFileIfExists(fileUri);
  let json: any = {};
  if (existing && existing.trim().length > 0) {
    try {
      json = JSON.parse(existing);
    } catch (error) {
      throw new Error(
        `Could not parse existing ${fileUri.fsPath} as JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  json.mcpServers = json.mcpServers || {};
  json.mcpServers[serverKey] = serverEntry;
  await writeFile(fileUri, JSON.stringify(json, null, 2) + "\n");
}

/**
 * Replaces (or appends) a `[mcp_servers.<key>]` table in a Codex TOML config,
 * leaving the rest of the file untouched. Only handles the simple
 * `url = "..."` shape this extension writes; hand-added subtables under the
 * same key are left as-is after the replaced header.
 */
function upsertTomlMcpServer(
  existing: string,
  serverKey: string,
  url: string
): string {
  const escapedKey = serverKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerRegex = new RegExp(
    `\\[mcp_servers\\.${escapedKey}\\][^]*?(?=\\n\\[|$)`
  );
  const section = `[mcp_servers.${serverKey}]\nurl = "${url}"`;

  if (headerRegex.test(existing)) {
    return existing.replace(headerRegex, section);
  }

  if (existing.trim().length === 0) {
    return `${section}\n`;
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${section}\n`;
}

/**
 * Writes/updates project-local MCP client config for Claude Code, Codex CLI
 * and Gemini CLI so they can reach this extension's HTTP MCP server.
 * Returns the list of file paths written.
 */
export async function installMcpConfigs(
  port: number,
  host: string
): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error("No workspace folder is open");
  }
  const root = folders[0].uri;
  const url = buildUrl(host, port);
  const written: string[] = [];

  // Claude Code: .mcp.json at the project root.
  const claudeUri = vscode.Uri.joinPath(root, ".mcp.json");
  await upsertJsonMcpServer(claudeUri, SERVER_NAME, { type: "http", url });
  written.push(claudeUri.fsPath);

  // Gemini CLI: .gemini/settings.json at the project root.
  const geminiDir = vscode.Uri.joinPath(root, ".gemini");
  await ensureDir(geminiDir);
  const geminiUri = vscode.Uri.joinPath(geminiDir, "settings.json");
  await upsertJsonMcpServer(geminiUri, SERVER_NAME, { httpUrl: url });
  written.push(geminiUri.fsPath);

  // Codex CLI: .codex/config.toml at the project root (trusted projects only).
  const codexDir = vscode.Uri.joinPath(root, ".codex");
  await ensureDir(codexDir);
  const codexUri = vscode.Uri.joinPath(codexDir, "config.toml");
  const existingToml = (await readFileIfExists(codexUri)) ?? "";
  const updatedToml = upsertTomlMcpServer(existingToml, SERVER_NAME, url);
  await writeFile(codexUri, updatedToml);
  written.push(codexUri.fsPath);

  logger.info(
    `[installMcpConfigs] Wrote MCP config for Claude Code, Gemini CLI and Codex CLI targeting ${url}`
  );
  return written;
}
