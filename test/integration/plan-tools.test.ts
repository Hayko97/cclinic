/** The MCP planning tools through a real MCP client, connected in memory (roadmap-planning, mcp-server). */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { select } from "@inquirer/prompts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import { openTaskStore, tasksDatabaseFile } from "../../src/adapters/storage/task-store.js";
import { approveProposal } from "../../src/application/planning-session.js";
import { createProjectServer, runApproveCommand, runSessionLink } from "../../src/cli/mcp-command.js";
import { decisionPorts } from "../../src/cli/planning-ports.js";
import { createReporter } from "../../src/cli/reporter.js";
import { UsageError } from "../../src/core/errors.js";
import { newPlanSession, roadmapRequest, type PlanTarget, type RoadmapProposal } from "../../src/core/planning.js";
import { makeTempFolder, writeProject } from "../support/helpers.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn(), input: vi.fn() }));
const selectMock = vi.mocked(select);

const output = { out: "" };
const context = {
  reporter: createReporter({
    quiet: true,
    debug: false,
    color: "never",
    environment: {},
    stdout: { write: (text: string) => (output.out += text) },
    stderr: { write: () => true },
  }),
  environment: process.env,
  signal: new AbortController().signal,
  version: "0.1.0",
};

const isTty = process.stdin.isTTY;
beforeEach(() => {
  output.out = "";
  process.stdin.isTTY = true;
});
const open: Client[] = [];
afterEach(async () => {
  process.stdin.isTTY = isTty;
  vi.resetAllMocks();
  await Promise.all(open.splice(0).map((client) => client.close()));
});

const planned = (key: string, dependsOn: (string | number)[] = []) => ({
  key,
  title: `Task ${key}`,
  description: `About ${key}`,
  spec: null,
  dependsOn,
});
const roadmap = (extra: Partial<RoadmapProposal> = {}): RoadmapProposal => ({
  roadmap: { title: "Portal", goal: "Book visits" },
  milestones: [{ title: "Sign-in", goal: "Log in", tasks: [planned("login"), planned("book", ["login"])] }],
  openQuestions: [],
  ...extra,
});

/** A project with documents, and roadmap 1 with milestone 1 and task 1. */
function project(): string {
  const root = makeTempFolder();
  writeProject(root, { ".luseen/sdd/overview.md": "# Overview\n", ".luseen/sdd/README.md": "# Specs\n" });
  const store = openTaskStore(path.join(root, ".luseen"), "create");
  store?.savePlan({
    roadmap: { title: "Launch", goal: "Ship" },
    milestones: [{ title: "One", goal: "", tasks: [planned("x")] }],
  });
  store?.close();
  return root;
}

/** A client for the project's server. With answers, it supports elicitation and answers each question in turn. */
async function connect(root: string, options: { answers?: string[]; plan?: string } = {}) {
  const server = await createProjectServer(
    { dir: root, approver: "user", ...(options.plan === undefined ? {} : { plan: options.plan }) },
    context,
  );
  const client = new Client(
    { name: "test", version: "1.0.0" },
    { capabilities: options.answers === undefined ? {} : { elicitation: {} } },
  );
  const asked: { message: string; answers: unknown }[] = [];
  if (options.answers !== undefined) {
    const answers = options.answers;
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      if (!("requestedSchema" in request.params)) throw new Error("Expected a form question");
      const field = request.params.requestedSchema.properties["answer"];
      asked.push({ message: request.params.message, answers: field && "enum" in field ? field.enum : undefined });
      return { action: "accept", content: { answer: answers.shift() ?? "keep chatting" } };
    });
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  open.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { message: text };
    }
    return { ...body, isError: result.isError === true } as Record<string, unknown> & { isError: boolean };
  };
  return { client, call, asked };
}

async function begin(call: Awaited<ReturnType<typeof connect>>["call"], target: PlanTarget = { kind: "new-roadmap" }) {
  const begun = await call("plan_begin", { target, request: "A patient portal" });
  return String(begun["planId"]);
}

/** A session luseen drives, held by this test's process. */
async function drivenSession(root: string, target: PlanTarget = { kind: "new-roadmap" }, pid = process.ppid) {
  return openPlanStore(root).create((id) =>
    newPlanSession({
      id,
      target,
      summary: "Idea",
      holder: { place: "terminal", pid },
      claudeSessionId: "u-1",
      transcriptPath: null,
      now: new Date().toISOString(),
    }),
  );
}

describe("planning tools in Claude Code", () => {
  it("TC-MCP-073: the server lists the workflow tools and the five planning tools", async () => {
    const { client } = await connect(project());
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      "plan_begin",
      "plan_resume",
      "plan_status",
      "plan_suggest",
      "plan_propose",
      "workflow_status",
      "task_add",
    ]) {
      expect(names).toContain(name);
    }
    expect(names.filter((name) => name.startsWith("plan_"))).toHaveLength(5);
  });

  it("TC-PLAN-064: plan_begin records the session and returns the context; plan_resume takes it in another server", async () => {
    const root = project();
    const { call } = await connect(root);
    const begun = await call("plan_begin", {
      target: { kind: "new-roadmap" },
      request: "A patient portal for clinics",
    });
    expect(begun).toMatchObject({ status: "ok", planId: "plan-1", isError: false });
    for (const part of [
      ".luseen/sdd/overview.md",
      ".luseen/sdd/README.md",
      '"title":"Launch"',
      '"status":"open"',
      "plan-1",
      "Plan a NEW roadmap",
    ]) {
      expect(String(begun["context"]), part).toContain(part);
    }
    const session = await openPlanStore(root).read("plan-1");
    expect(session).toMatchObject({
      status: "open",
      summary: "A patient portal for clinics",
      holder: { place: "claude-code", pid: process.pid },
    });

    // The first server's process still runs, so another one is refused until the hold is gone.
    const other = await connect(root);
    await openPlanStore(root).update("plan-1", (current) => ({
      save: { ...current, holder: { place: "claude-code", pid: 2 ** 30 } },
      value: undefined,
    }));
    const resumed = await other.call("plan_resume", { planId: "plan-1" });
    expect(resumed).toMatchObject({ status: "ok", waitingProposal: null, isError: false });
    expect(String(resumed["context"])).toContain("Plan a NEW roadmap");
    expect((await call("plan_begin", { target: { kind: "extend-roadmap", roadmapId: 9 }, request: "x" })).isError).toBe(
      true,
    );
  });

  it("TC-PLAN-009: plan_suggest and plan_propose name the field they reject", async () => {
    const root = project();
    const { call } = await connect(root);
    const planId = await begin(call);
    expect(
      (
        await call("plan_suggest", {
          planId,
          suggestions: ["Web", "Mobile"],
          sources: [{ title: "HHS", url: "https://hhs.gov" }],
        })
      ).isError,
    ).toBe(false);
    expect((await openPlanStore(root).read(planId))?.suggestions).toEqual(["Web", "Mobile"]);
    for (const bad of [
      { suggestions: ["1", "2", "3", "4", "5"] },
      { suggestions: ["x".repeat(201)] },
      { suggestions: [], sources: [{ title: "F", url: "ftp://a" }] },
      { suggestions: [], sources: Array.from({ length: 11 }, () => ({ title: "S", url: "https://a.example" })) },
    ]) {
      expect((await call("plan_suggest", { planId, ...bad })).isError, JSON.stringify(bad).slice(0, 40)).toBe(true);
    }
    const noDependsOn = roadmap({
      milestones: [{ title: "M", goal: "", tasks: [{ key: "a", title: "A", description: "", spec: null } as never] }],
    });
    const shapeError = await call("plan_propose", { planId, proposal: noDependsOn });
    expect(shapeError.isError).toBe(true);
    expect(String(shapeError["message"])).toContain("dependsOn");
    expect(String((await call("plan_propose", { planId, proposal: roadmap({ roadmap: null }) }))["message"])).toContain(
      "roadmap",
    );
  });

  it("TC-PLAN-030: in task mode only one task with existing dependencies is accepted", async () => {
    const root = project();
    const { call } = await connect(root, { answers: ["keep chatting", "keep chatting"] });
    const planId = await begin(call, { kind: "task", roadmapId: 1 });
    const task = (extra: Record<string, unknown> = {}, milestoneId: number | null = 1) => ({
      task: { title: "Lock", description: "After 5", spec: null, dependsOn: [], ...extra },
      milestoneId,
      openQuestions: [],
    });
    expect((await call("plan_propose", { planId, proposal: task() })).isError).toBe(false);
    expect(
      (await call("plan_propose", { planId, proposal: { ...task(), task: [task().task, task().task] } })).isError,
    ).toBe(true);
    expect((await call("plan_propose", { planId, proposal: task({ title: undefined }) })).isError).toBe(true);
    expect((await call("plan_propose", { planId, proposal: task({ dependsOn: ["a"] }) })).isError).toBe(true);
    const standalone = await connect(root, { answers: ["keep chatting"] });
    const alone = await begin(standalone.call, { kind: "task", roadmapId: null });
    expect((await standalone.call("plan_propose", { planId: alone, proposal: task({}, null) })).isError).toBe(false);
  });

  it("TC-PLAN-065: the user keeps chatting, then approves; another session is cancelled", async () => {
    const root = project();
    const { call, asked } = await connect(root, { answers: ["keep chatting", "approve"] });
    const planId = await begin(call);
    const kept = await call("plan_propose", { planId, proposal: roadmap() });
    expect(kept).toMatchObject({ status: "waiting", isError: false });
    expect(asked[0]?.answers).toEqual(["approve", "keep chatting", "cancel"]);
    expect(asked[0]?.message).toContain("Roadmap: Portal");
    const store = () => openTaskStore(path.join(root, ".luseen"), "read");
    expect(store()?.listRoadmaps()).toHaveLength(1);
    const approved = await call("plan_propose", { planId, proposal: roadmap() });
    expect(approved).toMatchObject({
      status: "approved",
      message: "Saved roadmap #2. Run it with: luseen auto --roadmap 2",
    });
    expect(
      store()
        ?.listRoadmaps()
        .map((item) => item.title),
    ).toEqual(["Launch", "Portal"]);
    expect((await openPlanStore(root).read(planId))?.status).toBe("approved");

    const other = await connect(root, { answers: ["cancel"] });
    const second = await begin(other.call);
    expect(await other.call("plan_propose", { planId: second, proposal: roadmap() })).toMatchObject({
      status: "cancelled",
    });
    expect((await openPlanStore(root).read(second))?.status).toBe("cancelled");
    expect(store()?.listRoadmaps()).toHaveLength(2);
  });

  it("TC-PLAN-066: without elicitation the proposal waits, and luseen approve saves it while Claude Code holds the session", async () => {
    const root = project();
    const { call } = await connect(root);
    const planId = await begin(call);
    const waiting = await call("plan_propose", { planId, proposal: roadmap() });
    expect(waiting).toMatchObject({ status: "waiting-for-approval", isError: false });
    expect(String(waiting["message"])).toContain("Needs you");
    expect(String(waiting["message"])).toContain("luseen approve");
    selectMock.mockResolvedValueOnce("approve");
    await runApproveCommand(root, context);
    expect(output.out).toBe("Saved roadmap #2. Run it with: luseen auto --roadmap 2\n");
    expect(await call("plan_status", { planId })).toMatchObject({
      sessionStatus: "approved",
      outcome: "Saved roadmap #2. Run it with: luseen auto --roadmap 2",
    });
  });

  it("TC-PLAN-049: a planning tool of a session this server doesn't hold is refused", async () => {
    const root = project();
    const session = await drivenSession(root);
    const { call } = await connect(root);
    expect(await call("plan_suggest", { planId: session.id, suggestions: [] })).toMatchObject({ isError: true });
    expect(String((await call("plan_propose", { planId: session.id, proposal: roadmap() }))["message"])).toContain(
      "plan_resume",
    );
  });
});

describe("luseen mcp --plan", () => {
  it("TC-MCP-075: serves only the planning tools of its session, never asks, and refuses others", async () => {
    const root = project();
    const session = await drivenSession(root);
    const other = await drivenSession(root);
    const { client, call } = await connect(root, { plan: session.id, answers: [] });
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "plan_propose",
      "plan_status",
      "plan_suggest",
    ]);
    expect(await call("plan_propose", { planId: session.id, proposal: roadmap() })).toMatchObject({
      status: "shown",
      isError: false,
    });
    expect((await openPlanStore(root).read(session.id))?.proposal?.kind).toBe("roadmap");
    expect(await call("plan_propose", { planId: other.id, proposal: roadmap() })).toMatchObject({ isError: true });
    await expect(createProjectServer({ dir: root, approver: "user", plan: "plan-9" }, context)).rejects.toThrow(
      UsageError,
    );
  });

  it("TC-MCP-076: only .luseen/plans changes until approval, then the task database too", async () => {
    const root = project();
    const database = tasksDatabaseFile(path.join(root, ".luseen"));
    const before = readFileSync(database);
    const listing = () =>
      readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.parentPath.includes(".luseen"))
        .map((entry) => path.join(entry.parentPath, entry.name));
    const outside = listing();
    const { call } = await connect(root, { answers: ["keep chatting", "approve"] });
    const planId = await begin(call);
    await call("plan_suggest", { planId, suggestions: ["Yes"] });
    await call("plan_propose", { planId, proposal: roadmap() });
    expect(readFileSync(database).equals(before)).toBe(true);
    expect(listing()).toEqual(outside);
    await call("plan_propose", { planId, proposal: roadmap() });
    expect(readFileSync(database).equals(before)).toBe(false);
    expect(listing()).toEqual(outside);
    expect(statSync(path.join(root, ".luseen/plans", planId, "session.json")).isFile()).toBe(true);
  });
});

describe("session-link for planning tools", () => {
  it("TC-MCP-074: a planning tool links its Claude session to the planning session, not to a change", async () => {
    const root = project();
    const session = await drivenSession(root);
    await openPlanStore(root).update(session.id, (current) => ({
      save: { ...current, claudeSessionId: null },
      value: undefined,
    }));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const hook = (input: Record<string, unknown>) =>
      runSessionLink(
        Readable.from([
          JSON.stringify({ cwd: root, transcript_path: "/c/projects/p/s1.jsonl", session_id: "s1", ...input }),
        ]),
        {},
      );
    await hook({
      tool_name: "mcp__luseen__plan_begin",
      tool_input: {},
      tool_response: [{ type: "text", text: JSON.stringify({ status: "ok", planId: session.id }) }],
    });
    expect(await openPlanStore(root).read(session.id)).toMatchObject({
      claudeSessionId: "s1",
      transcriptPath: "/c/projects/p/s1.jsonl",
      lastPlace: "claude-code",
    });
    await hook({ tool_name: "mcp__luseen__plan_suggest", tool_input: { planId: "plan-9" }, session_id: "s2" });
    expect((await openPlanStore(root).read(session.id))?.claudeSessionId).toBe("s1");
  });
});

describe("approving when the record can't be written", () => {
  it("TC-PLAN-019: the plan saved before a failed record write is named, so it isn't approved twice", async () => {
    const root = project();
    const real = openPlanStore(root);
    const session = await drivenSession(root);
    await real.update(session.id, (current) => ({
      save: { ...current, proposal: { kind: "roadmap", proposal: roadmap(), proposedAt: new Date().toISOString() } },
      value: undefined,
    }));
    const failingWrites = {
      ...real,
      update: <T>(id: string, decide: Parameters<typeof real.update<T>>[1]) =>
        real.update<T>(id, (current) => {
          decide(current);
          throw new Error("disk full");
        }),
    };
    const error = await approveProposal({ ...decisionPorts(root), records: failingWrites }, session.id).catch(
      (caught: unknown) => caught,
    );
    expect(String(error)).toContain("Saved roadmap #2");
    expect(String(error)).toContain("don't approve it again");
    expect((await real.read(session.id))?.status).toBe("open");
  });
});

describe("a new project's brief", () => {
  const brief = [
    "# Clinic booking",
    "## What it is",
    "A web app where patients book visits with a clinic's doctors, and doctors manage their day.",
    "## Who uses it",
    "- Patient: books visits",
    "## Main features",
    "### Booking",
    "- A visit is 30 minutes",
    "## Stack",
    "React with TypeScript.",
    "## How we write code",
    "Tests for every rule.",
    "## Out of scope for now",
    "Payments.",
  ].join("\n");

  it("TC-MCP-080: only a new project's server offers brief_propose, which records the brief and writes no file", async () => {
    const empty = makeTempFolder();
    const session = await drivenSession(empty, { kind: "new-project" });
    const { client, call } = await connect(empty, { plan: session.id });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("brief_propose");
    const accepted = await call("brief_propose", { planId: session.id, markdown: brief, hasScreens: true });
    expect(accepted).toMatchObject({ status: "shown", isError: false });
    expect((await openPlanStore(empty).read(session.id))?.project?.brief?.markdown).toBe(brief);
    expect(readdirSync(empty).filter((name) => name !== ".luseen")).toEqual([]);
    const refused = await call("brief_propose", {
      planId: session.id,
      markdown: brief.replace("## Stack\nReact with TypeScript.\n", ""),
      hasScreens: true,
    });
    expect(refused.isError).toBe(true);
    expect(String(refused["message"])).toContain('"## Stack" is missing');

    const root = project();
    const roadmapSession = await drivenSession(root);
    const roadmapServer = await connect(root, { plan: roadmapSession.id });
    expect((await roadmapServer.client.listTools()).tools.map((tool) => tool.name)).not.toContain("brief_propose");
  });

  it("TC-MCP-080 (QA): Claude Code's own server never offers brief_propose", async () => {
    const { client } = await connect(project());
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("brief_propose");
  });

  it("TC-MCP-080 (QA): brief_propose is refused after the brief; plan_propose is refused before the roadmap", async () => {
    const empty = makeTempFolder();
    const session = await drivenSession(empty, { kind: "new-project" });
    const { call } = await connect(empty, { plan: session.id });
    const proposal: RoadmapProposal = {
      roadmap: { title: "First", goal: "Ship" },
      milestones: [{ title: "Foundation", goal: "Shell", tasks: [planned("a")] }],
      openQuestions: [],
    };
    const early = await call("plan_propose", { planId: session.id, proposal });
    expect(early.isError).toBe(true);
    expect(String(early["message"])).toContain("brief_propose");
    expect((await openPlanStore(empty).read(session.id))?.proposal).toBeNull();

    await openPlanStore(empty).update(session.id, (current) => {
      const next = {
        ...current,
        project: current.project === null ? null : { ...current.project, phase: "roadmap" as const },
      };
      return { save: next, value: undefined };
    });
    const late = await call("brief_propose", { planId: session.id, markdown: brief, hasScreens: false });
    expect(late.isError).toBe(true);
    expect((await openPlanStore(empty).read(session.id))?.project?.brief).toBeNull();
    expect(readdirSync(empty).filter((name) => name !== ".luseen")).toEqual([]);
  });

  it("TC-MCP-080 (QA): a brief without hasScreens or a too-short brief is refused", async () => {
    const empty = makeTempFolder();
    const session = await drivenSession(empty, { kind: "new-project" });
    const { call } = await connect(empty, { plan: session.id });
    const noScreens = await call("brief_propose", { planId: session.id, markdown: brief }).catch((error: unknown) => ({
      isError: true,
      message: String(error),
    }));
    expect(noScreens.isError).toBe(true);
    const short = await call("brief_propose", {
      planId: session.id,
      markdown: "# A\n## What it is\nx",
      hasScreens: true,
    });
    expect(short.isError).toBe(true);
    expect((await openPlanStore(empty).read(session.id))?.project?.brief).toBeNull();
  });

  it("TC-MCP-080 (QA run 3): plan_propose at the design says the first roadmap is already saved, and changes nothing", async () => {
    const empty = makeTempFolder();
    const session = await drivenSession(empty, { kind: "new-project" });
    await openPlanStore(empty).update(session.id, (current) => {
      const next = {
        ...current,
        project: current.project === null ? null : { ...current.project, phase: "design" as const, hasScreens: true },
      };
      return { save: next, value: undefined };
    });
    const { call } = await connect(empty, { plan: session.id });
    const proposal: RoadmapProposal = {
      roadmap: { title: "Second", goal: "Ship" },
      milestones: [{ title: "Foundation", goal: "Shell", tasks: [planned("a")] }],
      openQuestions: [],
    };
    const refused = await call("plan_propose", { planId: session.id, proposal });
    expect(refused.isError).toBe(true);
    expect(String(refused["message"])).toContain("The first roadmap is already saved");
    expect(await openPlanStore(empty).read(session.id)).toMatchObject({ proposal: null, project: { phase: "design" } });
  });

  it("FR-PLAN-053 (QA run 3): the first roadmap's request gives the PM the proposal's shape", () => {
    const request = roadmapRequest(".luseen/sdd", ["booking", "accounts"]);
    expect(request).toContain("The specs are: booking, accounts.");
    expect(request).toContain('The proposal\'s shape: { "roadmap": { "title", "goal" }');
    expect(request).toContain('"milestones": [{ "title", "goal", "tasks": [{ "key", "title", "description", "spec"');
    expect(request).not.toContain('"task": {');
  });
});
