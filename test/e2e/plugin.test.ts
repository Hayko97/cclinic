/** What the Claude Code plugin runs, through the built binary (spec: claude-plugin). */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { makeTempFolder, writeProject } from "../support/helpers.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const BIN = path.join(REPO, "bin/luseen.js");
const PLUGIN_PREFIX = "mcp__plugin_luseen_luseen__";
const RESPONSE_TIMEOUT_MS = 10_000;

function environment(): NodeJS.ProcessEnv {
  const bin = makeTempFolder();
  symlinkSync(process.execPath, path.join(bin, "node"));
  copyFileSync(path.join(REPO, "test/fixtures/fake-claude/claude"), path.join(bin, "claude"));
  chmodSync(path.join(bin, "claude"), 0o755);
  const home = makeTempFolder();
  return { PATH: bin, HOME: home, XDG_CONFIG_HOME: path.join(home, "c") };
}

function luseen(args: readonly string[], input = "") {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: makeTempFolder(),
    encoding: "utf8",
    env: environment(),
    input,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function connect(root: string) {
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
    return JSON.parse((result.content as { text: string }[])[0]?.text ?? "") as Record<string, unknown>;
  };
  return { client, call };
}

function setUpProject(): string {
  const root = makeTempFolder();
  writeProject(root, {
    ".luseen/sdd/README.md": "# SDD documentation\n",
    ".luseen/sdd/specs/user-login/spec.md": "# user-login\n",
  });
  return root;
}

function hook(root: string, sessionId: string, toolName: string, response: unknown = []): number | null {
  const input = JSON.stringify({
    session_id: sessionId,
    transcript_path: `/home/me/.claude/projects/p/${sessionId}.jsonl`,
    cwd: root,
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_response: response,
  });
  const result = spawnSync(process.execPath, [BIN, "session-link"], {
    cwd: root,
    encoding: "utf8",
    env: environment(),
    input,
  });
  expect(result.stdout).toBe("");
  return result.status;
}

describe("session-link with the plugin's tool names", () => {
  it("TC-PLUG-006: links the Claude session to the change, then to the planning session, as with mcp__luseen__", async () => {
    const root = setUpProject();
    const { client, call } = await connect(root);
    await call("workflow_begin", { changeType: "bug", spec: "user-login" });
    const begun = await call("plan_begin", { target: { kind: "new-roadmap" }, request: "A portal" });
    await client.close();
    const planId = String(begun["planId"]);

    expect(hook(root, "s1", `${PLUGIN_PREFIX}workflow_status`)).toBe(0);
    const workflow = path.join(root, ".luseen/workflow");
    const [stateFile] = readdirSync(workflow).filter((name) => name.endsWith(".json"));
    const state = JSON.parse(readFileSync(path.join(workflow, stateFile ?? ""), "utf8")) as {
      sessions: { sessionId: string }[];
    };
    expect(state.sessions.map((session) => session.sessionId)).toEqual(["s1"]);

    const reply = [{ type: "text", text: JSON.stringify({ status: "ok", planId }) }];
    expect(hook(root, "s2", `${PLUGIN_PREFIX}plan_begin`, reply)).toBe(0);
    const session = JSON.parse(readFileSync(path.join(root, ".luseen/plans", planId, "session.json"), "utf8")) as {
      claudeSessionId: string;
      lastPlace: string;
    };
    expect(session).toMatchObject({ claudeSessionId: "s2", lastPlace: "claude-code" });
  });
});

describe("luseen mcp in a project that isn't set up", () => {
  it("TC-PLUG-008 and TC-MCP-004: starts with only workflow_status, which names /luseen:init", async () => {
    const root = makeTempFolder();
    const { client, call } = await connect(root);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["workflow_status"]);
    const status = await call("workflow_status");
    expect(status).toMatchObject({ status: "ok", change: null });
    expect(String(status["message"])).toContain("isn't set up");
    expect(String(status["message"])).toContain("/luseen:init");
    await client.close();
    expect(existsSync(path.join(root, ".luseen"))).toBe(false);
  });

  it("TC-PLUG-008: stdout carries only MCP messages", async () => {
    const root = makeTempFolder();
    const child = spawn(process.execPath, [BIN, "mcp", "-C", root], { env: environment(), stdio: "pipe" });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1.0.0" } },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workflow_status", arguments: {} } },
    ];
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    await expect
      .poll(() => stdout.split("\n").filter((line) => line !== "").length, { timeout: RESPONSE_TIMEOUT_MS })
      .toBe(3);
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    const messages = stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { jsonrpc: string; id: number });
    expect(messages.map((message) => [message.jsonrpc, message.id])).toEqual([
      ["2.0", 1],
      ["2.0", 2],
      ["2.0", 3],
    ]);
  });

  it("TC-PLUG-009: a set-up project still gets every tool", async () => {
    const { client } = await connect(setUpProject());
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect([...names].sort()).toEqual(
      [
        "workflow_status",
        "workflow_begin",
        "workflow_advance",
        "workflow_skip",
        "workflow_reset",
        "workflow_resume",
        "tasks_list",
        "task_get",
        "task_next",
        "task_start",
        "task_block",
        "task_add",
        "qa_handoff",
        "qa_report",
        "review_report",
        "preview_start",
        "auto_status",
        "plan_begin",
        "plan_resume",
        "plan_status",
        "plan_suggest",
        "plan_propose",
      ].sort(),
    );
    await client.close();
  });
});

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

function expectServerAndHook(root: string): void {
  expect(readJson(path.join(root, ".mcp.json"))).toEqual({
    mcpServers: { luseen: { command: "npx", args: ["luseen", "mcp"] } },
  });
  expect(readJson(path.join(root, ".claude/settings.json"))).toEqual({
    hooks: {
      PostToolUse: [{ matcher: "mcp__luseen__.*", hooks: [{ type: "command", command: "npx luseen session-link" }] }],
    },
  });
}

function expectPluginSections(root: string): void {
  const agents = readFileSync(path.join(root, "AGENTS.md"), "utf8");
  expect(agents).toContain("<!-- luseen:start -->");
  expect(agents).toContain("`/luseen:create-spec`");
  expect(agents).toContain("`/luseen:product-engineer`");
  expect(agents).not.toContain(".agents/skills");
  expect(readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
  expectServerAndHook(root);
  for (const absent of [".agents", ".claude/skills"]) expect(existsSync(path.join(root, absent))).toBe(false);
}

describe("--plugin", () => {
  it("TC-PLUG-014: luseen skills --plugin installs the sections, the MCP server and the hook, and no skill folders", () => {
    const root = makeTempFolder();
    const result = luseen(["skills", root, "--plugin"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Agent instructions: 4 installed");
    expect(result.stdout).not.toContain("codex");
    expectPluginSections(root);
  });

  it("TC-PLUG-019: luseen skills without --plugin installs everything, as before", () => {
    const root = makeTempFolder();
    const result = luseen(["skills", root]);
    expect(result.code).toBe(0);
    for (const folder of [".agents/skills", ".claude/skills"])
      expect(readdirSync(path.join(root, folder)).sort()).toHaveLength(9);
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain(".agents/skills/");
    expect(readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
    expectServerAndHook(root);
  });

  it("TC-PLUG-015: luseen --yes --plugin generates the documents and installs the sections, server and hook", () => {
    const root = makeTempFolder();
    writeProject(root, { "src/a.ts": "export const a = 1;\n" });
    const result = luseen([root, "--yes", "--plugin"]);
    expect(result.code).toBe(0);
    expect(existsSync(path.join(root, ".luseen/sdd/README.md"))).toBe(true);
    expectPluginSections(root);
  });
});
