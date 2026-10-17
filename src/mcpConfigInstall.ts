import * as vscode from "vscode";
import { logger } from "./utils/logger";

const SERVER_NAME = "vscode-abl";

export interface HttpTransportOptions {
  port: number;
  host: string;
}

export interface PipeTransportOptions {
  /** Named pipe (Windows) or Unix domain socket path (Linux/macOS) the extension listens on. */
  path: string;
  /** Absolute path to the bundled stdio<->pipe proxy script clients spawn. */
  shimPath: string;
}

export interface InstallMcpConfigOptions {
  http?: HttpTransportOptions;
  pipe?: PipeTransportOptions;
  /**
   * Non-destructive mode used by auto-creation: create missing files/entries,
   * and refresh an existing `vscode-abl` entry only when it was written by this
   * extension (its args reference `mcp-pipe-proxy.js`) and is out of date.
   * Any other existing entry is left untouched.
   */
  auto?: boolean;
}

const SHIM_FILE_NAME = "mcp-pipe-proxy.js";

function buildUrl(host: string, port: number): string {
  const clientHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${clientHost}:${port}/mcp`;
}

/**
 * Prefer the pipe transport when both are enabled: it can't collide across
 * workspace windows the way a shared HTTP port can.
 */
function pickServerEntry(
  options: InstallMcpConfigOptions
): { command: string; args: string[] } | { url: string } {
  if (options.pipe) {
    return {
      command: "node",
      args: [options.pipe.shimPath, options.pipe.path],
    };
  }
  if (options.http) {
    return { url: buildUrl(options.http.host, options.http.port) };
  }
  throw new Error(
    "No MCP transport is enabled - enable the pipe or HTTP transport before installing client config"
  );
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
  serverEntry: Record<string, unknown>,
  auto: boolean = false
): Promise<boolean> {
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
  if (auto) {
    const current = json.mcpServers[serverKey];
    if (current) {
      const shimArg = Array.isArray(current.args) ? current.args[0] : undefined;
      const generatedByUs =
        typeof shimArg === "string" && shimArg.endsWith(SHIM_FILE_NAME);
      const upToDate = JSON.stringify(current) === JSON.stringify(serverEntry);
      if (!generatedByUs || upToDate) {
        return false;
      }
    }
  }
  json.mcpServers[serverKey] = serverEntry;
  await writeFile(fileUri, JSON.stringify(json, null, 2) + "\n");
  return true;
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
}

function buildTomlEntryBody(
  entry: { command: string; args: string[] } | { url: string }
): string {
  if ("url" in entry) {
    return `url = ${JSON.stringify(entry.url)}`;
  }
  return `command = ${JSON.stringify(entry.command)}\nargs = ${tomlStringArray(
    entry.args
  )}`;
}

/**
 * Replaces (or appends) a `[mcp_servers.<key>]` table in a Codex TOML config,
 * leaving the rest of the file untouched. Only handles the simple `url = "..."`
 * or `command = "..."` / `args = [...]` shapes this extension writes;
 * hand-added subtables under the same key are left as-is after the replaced
 * header.
 */
function upsertTomlMcpServer(
  existing: string,
  serverKey: string,
  entry: { command: string; args: string[] } | { url: string }
): string {
  const escapedKey = serverKey.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const headerRegex = new RegExp(
    String.raw`\[mcp_servers\.${escapedKey}\][^]*?(?=\n\[|$)`
  );
  const section = `[mcp_servers.${serverKey}]\n${buildTomlEntryBody(entry)}`;

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
 * Auto mode for Codex TOML: write when the table is missing, or when it was
 * generated by this extension (references the pipe shim) and is out of date.
 */
function shouldAutoWriteToml(
  existing: string,
  serverKey: string,
  entry: { command: string; args: string[] } | { url: string }
): boolean {
  const escapedKey = serverKey.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const match = new RegExp(
    String.raw`\[mcp_servers\.${escapedKey}\][^]*?(?=\n\[|$)`
  ).exec(existing);
  if (!match) {
    return true;
  }
  const generatedByUs = match[0].includes(SHIM_FILE_NAME);
  const expected = `[mcp_servers.${serverKey}]\n${buildTomlEntryBody(entry)}`;
  return generatedByUs && match[0].trimEnd() !== expected;
}

/**
 * Writes/updates project-local MCP client config for Claude Code, Codex CLI
 * and Gemini CLI so they can reach this extension's MCP server. When both
 * transports are enabled, the pipe transport is used since it can't collide
 * across workspace windows the way a shared HTTP port can.
 * Returns the list of file paths written.
 */
export async function installMcpConfigs(
  options: InstallMcpConfigOptions
): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error("No workspace folder is open");
  }
  const root = folders[0].uri;
  const entry = pickServerEntry(options);
  const written: string[] = [];

  // Claude Code: .mcp.json at the project root.
  const claudeUri = vscode.Uri.joinPath(root, ".mcp.json");
  const claudeWritten = await upsertJsonMcpServer(
    claudeUri,
    SERVER_NAME,
    "url" in entry
      ? { type: "http", url: entry.url }
      : { type: "stdio", command: entry.command, args: entry.args },
    options.auto
  );
  if (claudeWritten) {
    written.push(claudeUri.fsPath);
  }

  // Gemini CLI: .gemini/settings.json at the project root.
  const geminiDir = vscode.Uri.joinPath(root, ".gemini");
  await ensureDir(geminiDir);
  const geminiUri = vscode.Uri.joinPath(geminiDir, "settings.json");
  const geminiWritten = await upsertJsonMcpServer(
    geminiUri,
    SERVER_NAME,
    "url" in entry
      ? { httpUrl: entry.url }
      : { command: entry.command, args: entry.args },
    options.auto
  );
  if (geminiWritten) {
    written.push(geminiUri.fsPath);
  }

  // Codex CLI: .codex/config.toml at the project root (trusted projects only).
  const codexDir = vscode.Uri.joinPath(root, ".codex");
  await ensureDir(codexDir);
  const codexUri = vscode.Uri.joinPath(codexDir, "config.toml");
  const existingToml = (await readFileIfExists(codexUri)) ?? "";
  if (!options.auto || shouldAutoWriteToml(existingToml, SERVER_NAME, entry)) {
    await writeFile(codexUri, upsertTomlMcpServer(existingToml, SERVER_NAME, entry));
    written.push(codexUri.fsPath);
  }

  const target = "url" in entry ? entry.url : `${entry.command} ${entry.args.join(" ")}`;
  logger.info(
    `[installMcpConfigs] Wrote MCP config for Claude Code, Gemini CLI and Codex CLI targeting ${target}`
  );
  return written;
}
