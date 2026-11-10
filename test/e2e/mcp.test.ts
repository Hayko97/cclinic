/** `cclinic mcp` and `cclinic approve` through the built binary (spec: mcp-server). */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { makeTempFolder, writeProject } from "../support/helpers.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const BIN = path.join(REPO, "bin/cclinic.js");
const RESPONSE_TIMEOUT_MS = 20_000;

function environment(): NodeJS.ProcessEnv {
  const bin = makeTempFolder();
  symlinkSync(process.execPath, path.join(bin, "node"));
  const home = makeTempFolder();
  return { PATH: bin, HOME: home, XDG_CONFIG_HOME: path.join(home, "c") };
}

function cclinic(args: readonly string[], cwd = makeTempFolder()) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: environment(), input: "" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function makeProject(): string {
  const root = makeTempFolder();
  writeProject(root, {
    ".cclinic/sdd/README.md": "# SDD documentation\n",
    ".cclinic/sdd/specs/user-login/spec.md": "# user-login\n",
  });
  return root;
}

/** Starts the server, sends the requests, and returns every stdout line and stderr once the replies arrive. */
async function exchange(args: readonly string[], requests: readonly object[], expectedReplies: number) {
  const child = spawn(process.execPath, [BIN, ...args], { env: environment(), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const replies = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`No reply in time. stderr: ${stderr}`));
    }, RESPONSE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.split("\n").filter((line) => line !== "").length >= expectedReplies) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  await replies;
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  return { lines: stdout.split("\n").filter((line) => line !== ""), stderr };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1.0.0" } },
};
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };

describe("cclinic mcp", () => {
  it("TC-MCP-001: speaks MCP over stdio, with only protocol messages on stdout, and stops when stdin closes", async () => {
    const root = makeProject();
    const { lines } = await exchange(
      ["mcp", "-C", root],
      [INITIALIZE, INITIALIZED, { jsonrpc: "2.0", id: 2, method: "tools/list" }],
      2,
    );
    const messages = lines.map((line) => JSON.parse(line) as { id: number; result: { tools?: { name: string }[] } });
    expect(messages.map((message) => message.id)).toEqual([1, 2]);
    expect(messages[1]?.result.tools?.map((tool) => tool.name)).toContain("workflow_status");
  });

  it("TC-MCP-002: serves the project named with -C", async () => {
    const root = makeProject();
    const { lines } = await exchange(
      ["mcp", "-C", root],
      [
        INITIALIZE,
        INITIALIZED,
        { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "cclinic://specs/user-login" } },
      ],
      2,
    );
    expect(lines[1]).toContain("# user-login");
  });

  it("TC-MCP-003: a wrong --approver, or pm-agent without its options, exits 2 with nothing on stdout", () => {
    const root = makeProject();
    for (const args of [
      ["--approver", "robot"],
      ["--approver", "pm-agent", "--task", "1", "--max-budget-usd", "1"],
      ["--approver", "pm-agent", "--run", "R", "--max-budget-usd", "1"],
      ["--approver", "pm-agent", "--run", "R", "--task", "1"],
    ]) {
      const result = cclinic(["mcp", "-C", root, ...args]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      const named =
        args[1] === "robot" ? "--approver" : ["--run", "--task", "--max-budget-usd"].find((o) => !args.includes(o));
      expect(result.stderr).toContain(named);
    }
  });

  it("TC-MCP-004: a project without cclinic's documents exits 2, saying to run cclinic", () => {
    const result = cclinic(["mcp", "-C", makeTempFolder()]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Run "cclinic"');
  });

  it("TC-CLI-056: help lists the options, and a bad value exits 2", () => {
    const help = cclinic(["help", "mcp"]);
    expect(help.code).toBe(0);
    for (const option of ["--dir", "--approver", "--run", "--task", "--max-budget-usd"])
      expect(help.stdout).toContain(option);
    expect(cclinic(["mcp", "--approver", "robot"]).code).toBe(2);
  });
});

describe("cclinic approve", () => {
  it("TC-CLI-059 and TC-MCP-045: without a terminal it exits 2 and answers nothing", () => {
    const result = cclinic(["approve", makeProject()]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("your own terminal");
  });
});

const SCRIPT = "/usr/bin/script";
const isPseudoTerminalAvailable = process.platform === "darwin" && existsSync(SCRIPT);

/** A project with a spec's three files, so G1 can be asked. */
function makeFullProject(): string {
  const root = makeProject();
  writeProject(root, {
    ".cclinic/sdd/specs/user-login/validation.md": "# validation\n",
    ".cclinic/sdd/specs/user-login/verification.md": "# verification\n",
  });
  return root;
}

/** Connects the SDK's client to `cclinic mcp` over stdio, without elicitation. */
async function stdioClient(root: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "mcp", "-C", root],
    env: environment() as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "e2e", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    return { ...(JSON.parse(text) as Record<string, unknown>), isError: result.isError === true };
  };
  return { client, call };
}

/** A change whose G1 question waits for `cclinic approve`, built through the tools. */
async function waitingProject(): Promise<string> {
  const root = makeFullProject();
  const { client, call } = await stdioClient(root);
  await call("workflow_begin", { changeType: "feature", spec: "user-login" });
  expect(await call("workflow_advance", { to: "implement" })).toMatchObject({ status: "waiting-for-approval" });
  await client.close();
  return root;
}

/** Runs `cclinic approve` in a pseudo-terminal with no keys typed. `script` needs a file, not a socket, as stdin. */
function approveInTerminal(root: string) {
  const keysFile = path.join(makeTempFolder(), "keys");
  writeFileSync(keysFile, "");
  const input = openSync(keysFile, "r");
  try {
    const result = spawnSync(SCRIPT, ["-q", "/dev/null", process.execPath, BIN, "approve", root], {
      encoding: "utf8",
      env: environment(),
      stdio: [input, "pipe", "pipe"],
      timeout: RESPONSE_TIMEOUT_MS,
    });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    closeSync(input);
  }
}

describe("cclinic mcp and approve, QA", () => {
  it("TC-MCP-002: workflow_status reports the state of the folder named with -C", async () => {
    const root = makeFullProject();
    const first = await stdioClient(root);
    await first.call("workflow_begin", { changeType: "bug", spec: "user-login" });
    await first.client.close();
    const other = await stdioClient(makeFullProject());
    expect(await other.call("workflow_status")).toMatchObject({ change: null });
    await other.client.close();
    const same = await stdioClient(root);
    expect(await same.call("workflow_status")).toMatchObject({ change: { step: "spec", changeType: "bug" } });
    await same.client.close();
  });

  it("TC-MCP-045 and TC-CLI-059: with a waiting question and no terminal, it exits 2 and the gate stays closed", async () => {
    const root = await waitingProject();
    const before = readFileSync(path.join(root, ".cclinic/workflow/branch-no-branch.json"), "utf8");
    const result = cclinic(["approve", root]);
    expect(result.code).toBe(2);
    expect(readFileSync(path.join(root, ".cclinic/workflow/branch-no-branch.json"), "utf8")).toBe(before);
    const { client, call } = await stdioClient(root);
    expect(await call("workflow_advance", { to: "implement" })).toMatchObject({ status: "waiting-for-approval" });
    expect(await call("workflow_status")).toMatchObject({ change: { step: "spec" } });
    await client.close();
  });

  it.skipIf(!isPseudoTerminalAvailable)("TC-CLI-058: with nothing waiting, it says so and exits 0", () => {
    const result = approveInTerminal(makeProject());
    expect(result.code).toBe(0);
    expect(result.output).toContain("No question is waiting");
  });

  it("TC-MCP-008: the install prints the Codex block and writes nothing outside the project", () => {
    const root = makeTempFolder();
    writeProject(root, { "src/a.ts": "export const a = 1;\n" });
    const env = environment();
    const home = env["HOME"] ?? "";
    const result = spawnSync(process.execPath, [BIN, "skills", root], { encoding: "utf8", env, input: "" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[mcp_servers.cclinic]");
    expect(result.stdout).toContain("~/.codex/config.toml");
    expect(readdirSync(home)).toEqual([]);
  });
});
