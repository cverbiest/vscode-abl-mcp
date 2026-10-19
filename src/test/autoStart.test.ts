import * as assert from "assert";
import * as proxyquireLib from "proxyquire";

// Configure proxyquire
const proxyquire = proxyquireLib.noPreserveCache().noCallThru();

type Window = {
  hasFolders: boolean;
  isWorkspaceFile: boolean;
  hasOpenEdgeProject: boolean;
};

const EMPTY: Window = { hasFolders: false, isWorkspaceFile: false, hasOpenEdgeProject: false };
const FOLDER: Window = { hasFolders: true, isWorkspaceFile: false, hasOpenEdgeProject: false };
const WORKSPACE: Window = { hasFolders: true, isWorkspaceFile: true, hasOpenEdgeProject: false };
const OE_FOLDER: Window = { ...FOLDER, hasOpenEdgeProject: true };
const OE_WORKSPACE: Window = { ...WORKSPACE, hasOpenEdgeProject: true };

suite("Auto Start Test Suite", () => {
  let fakeVscode: any;
  let autoStart: any;

  const fakeConfig = (values: Record<string, unknown>) => ({
    get: (key: string) => values[key],
  });

  setup(() => {
    fakeVscode = {
      workspace: { workspaceFolders: undefined, workspaceFile: undefined, fs: {} },
      Uri: {
        joinPath: (base: { path: string }, ...parts: string[]) => ({
          path: [base.path, ...parts].join("/"),
        }),
      },
    };
    autoStart = proxyquire("../autoStart", { vscode: fakeVscode });
  });

  test("shouldAutoStart follows the mode", () => {
    const cases: [string, Window, boolean][] = [
      ["never", OE_WORKSPACE, false],
      ["always", EMPTY, true],
      ["folder", FOLDER, true],
      ["folder", WORKSPACE, false],
      ["folder", EMPTY, false],
      ["workspace", WORKSPACE, true],
      ["workspace", FOLDER, false],
      ["openedgeProject", OE_FOLDER, true],
      ["openedgeProject", OE_WORKSPACE, true],
      ["openedgeProject", FOLDER, false],
      ["bogus", OE_WORKSPACE, false],
    ];
    for (const [mode, window, expected] of cases) {
      assert.strictEqual(
        autoStart.shouldAutoStart(mode, window),
        expected,
        `${mode} with ${JSON.stringify(window)}`
      );
    }
  });

  test("getAutoStartMode returns the configured mode", () => {
    const config = fakeConfig({ autoStart: "openedgeProject" });
    assert.strictEqual(autoStart.getAutoStartMode(config), "openedgeProject");
  });

  test("getAutoStartMode falls back to never for unknown values", () => {
    assert.strictEqual(autoStart.getAutoStartMode(fakeConfig({ autoStart: "sometimes" })), "never");
    assert.strictEqual(autoStart.getAutoStartMode(fakeConfig({})), "never");
  });

  test("getWindowContent detects openedge-project.json in any folder root", async () => {
    fakeVscode.workspace.workspaceFolders = [
      { uri: { path: "/plain" } },
      { uri: { path: "/abl" } },
    ];
    fakeVscode.workspace.workspaceFile = { path: "/ws.code-workspace" };
    fakeVscode.workspace.fs.stat = async (uri: { path: string }) => {
      if (uri.path !== "/abl/openedge-project.json") {
        throw new Error("FileNotFound");
      }
      return {};
    };

    assert.deepStrictEqual(await autoStart.getWindowContent(), OE_WORKSPACE);
  });

  test("getWindowContent reports an empty window", async () => {
    assert.deepStrictEqual(await autoStart.getWindowContent(), EMPTY);
  });
});
