import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import * as proxyquireLib from "proxyquire";

// Configure proxyquire
const proxyquire = proxyquireLib.noPreserveCache().noCallThru();

// Stand-in for vscode.LanguageModelTextPart so instanceof checks work
class FakeTextPart {
  constructor(public readonly value: string) {}
}

type RegisteredTool = {
  config: { description: string; inputSchema: object };
  handler: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
};

suite("ABL Bridge Tools Test Suite", () => {
  let fakeVscode: any;
  let getExtensionStub: sinon.SinonStub;
  let invokeToolStub: sinon.SinonStub;
  let tools: Map<string, RegisteredTool>;

  function loadAndRegister() {
    const ablModule = proxyquire("../tools/abl", {
      vscode: fakeVscode,
      "../utils/logger": {
        logger: {
          info: sinon.spy(),
          warn: sinon.spy(),
          error: sinon.spy(),
          debug: sinon.spy(),
        },
      },
    });

    tools = new Map();
    const fakeServer = {
      registerTool: (name: string, config: any, handler: any) => {
        tools.set(name, { config, handler });
      },
    };
    ablModule.registerAblTools(fakeServer);
  }

  setup(() => {
    getExtensionStub = sinon.stub().returns({ isActive: true });
    invokeToolStub = sinon.stub().resolves({
      content: [new FakeTextPart("Compilation succeeded with no errors.")],
    });

    fakeVscode = {
      Uri: vscode.Uri,
      LanguageModelTextPart: FakeTextPart,
      extensions: { getExtension: getExtensionStub },
      lm: {
        tools: [
          { name: "abl_compile" },
          { name: "abl_check_syntax" },
          { name: "abl_xref" },
        ],
        invokeTool: invokeToolStub,
      },
      window: { activeTextEditor: undefined },
      workspace: { workspaceFolders: undefined },
    };

    loadAndRegister();
  });

  teardown(() => {
    sinon.restore();
  });

  test("Registers compile_abl, check_syntax_abl and xref_abl", () => {
    assert.deepStrictEqual(
      [...tools.keys()].sort(),
      ["check_syntax_abl", "compile_abl", "xref_abl"],
      "Expected the three ABL bridge tools to be registered"
    );
  });

  test("compile_abl invokes the abl_compile LM tool with the file URI", async () => {
    const result = await tools
      .get("compile_abl")!
      .handler({ path: "C:\\work\\src\\order.p" });

    assert.strictEqual(result.isError, undefined, "Expected success result");
    assert.strictEqual(
      result.content[0].text,
      "Compilation succeeded with no errors."
    );

    assert.strictEqual(invokeToolStub.calledOnce, true);
    const [toolName, options] = invokeToolStub.firstCall.args;
    assert.strictEqual(toolName, "abl_compile");
    assert.strictEqual(
      options.input.fileUri,
      vscode.Uri.file("C:\\work\\src\\order.p").toString()
    );
  });

  test("xref_abl forwards the xml flag", async () => {
    await tools
      .get("xref_abl")!
      .handler({ path: "C:\\work\\src\\order.p", xml: true });

    const [toolName, options] = invokeToolStub.firstCall.args;
    assert.strictEqual(toolName, "abl_xref");
    assert.strictEqual(options.input.xml, true);
  });

  test("check_syntax_abl falls back to the active ABL editor", async () => {
    const editorUri = vscode.Uri.file("C:\\work\\src\\active.p");
    fakeVscode.window.activeTextEditor = {
      document: { languageId: "abl", uri: editorUri },
    };

    await tools.get("check_syntax_abl")!.handler({});

    const [toolName, options] = invokeToolStub.firstCall.args;
    assert.strictEqual(toolName, "abl_check_syntax");
    assert.strictEqual(options.input.fileUri, editorUri.toString());
  });

  test("Returns an error when no path is given and no ABL editor is active", async () => {
    const result = await tools.get("compile_abl")!.handler({});

    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /No path provided/);
    assert.strictEqual(invokeToolStub.called, false);
  });

  test("Returns an error when the ABL extension is not installed", async () => {
    getExtensionStub.returns(undefined);

    const result = await tools
      .get("compile_abl")!
      .handler({ path: "C:\\work\\src\\order.p" });

    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /not installed/);
  });

  test("Returns an error when the LM tool is missing (outdated ABL extension)", async () => {
    fakeVscode.lm.tools = [];

    const result = await tools
      .get("compile_abl")!
      .handler({ path: "C:\\work\\src\\order.p" });

    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /1\.33\.7/);
  });
});
