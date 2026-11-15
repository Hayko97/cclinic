/** `luseen plan` in-process, with a fake `claude` that keeps a transcript and calls the planning tools. */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { input, select } from "@inquirer/prompts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import { openTaskStore, tasksDatabaseFile, type TaskStore } from "../../src/adapters/storage/task-store.js";
import { runPlanCommand, type PlanOptions } from "../../src/cli/plan-command.js";
import { AgentSessionError, CancelledError, exitCodeFor, UsageError } from "../../src/core/errors.js";
import {
  answerLastMessage,
  type PlanSession,
  type RoadmapProposal,
  type TaskProposal,
} from "../../src/core/planning.js";
import { agentHarness, makeDocx, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn(), input: vi.fn() }));
const selectMock = vi.mocked(select);
const inputMock = vi.mocked(input);

/** Starting the fake `claude`, and the `luseen mcp --plan` it starts, can take a few seconds. */
const SPAWN_WAIT = { timeout: 15_000 };
const SLOW = 60_000;

const isTty = process.stdin.isTTY;
beforeAll(() => {}, SLOW);
beforeEach(() => {
  process.stdin.isTTY = true;
});
afterEach(() => {
  process.stdin.isTTY = isTty;
  vi.resetAllMocks();
});

const planned = (key: string, dependsOn: (string | number)[] = [], spec: string | null = null) => ({
  key,
  title: `Task ${key}`,
  description: `About ${key}`,
  spec,
  dependsOn,
});

const roadmapProposal = (extra: Partial<RoadmapProposal> = {}): RoadmapProposal => ({
  roadmap: { title: "Launch", goal: "First release" },
  milestones: [
    { title: "First", goal: "Start", tasks: [planned("a", [], "auth")] },
    { title: "Second", goal: "Grow", tasks: [planned("b", ["a"]), planned("c", ["a", "b"])] },
  ],
  openQuestions: ["Which email provider?"],
  ...extra,
});

const taskProposal = (milestoneId: number | null, dependsOn: number[] = []): TaskProposal => ({
  task: { title: "Lock accounts", description: "After 5 failures", spec: null, dependsOn },
  milestoneId,
  openQuestions: [],
});

/** A PM turn that replies, and may suggest answers or propose. */
const says = (message: string, extra: Omit<FakeClaudeRule, "message"> = {}): FakeClaudeRule => ({ message, ...extra });
const proposing = (message: string, proposal: RoadmapProposal | TaskProposal): FakeClaudeRule =>
  says(message, { tools: [{ name: "plan_propose", input: { proposal } }] });

/** The user's messages, in order, as typed at the "You ›" prompt. */
function typing(...messages: string[]): void {
  for (const message of messages) inputMock.mockResolvedValueOnce(message);
}

/** The options of the nth menu shown. */
const menuAt = (index: number): unknown => selectMock.mock.calls[index]?.[0];

/** A project with documents, and a store with roadmap 1 (milestones 1 and 2) and a task in each. */
function project(withRoadmap = true): string {
  const root = makeTempFolder();
  writeProject(root, { ".luseen/sdd/overview.md": "# Overview\n", ".luseen/sdd/README.md": "# Specs\n" });
  if (withRoadmap) {
    const store = openStore(root);
    store.savePlan({
      roadmap: { title: "Launch", goal: "Ship" },
      milestones: [
        { title: "One", goal: "", tasks: [planned("x")] },
        { title: "Two", goal: "", tasks: [planned("y")] },
      ],
    });
    store.close();
  }
  return root;
}

function openStore(root: string): TaskStore {
  const store = openTaskStore(path.join(root, ".luseen"), "create");
  if (store === undefined) throw new Error("No store");
  return store;
}

async function sessions(root: string): Promise<readonly PlanSession[]> {
  return (await openPlanStore(root).list()).sessions;
}

async function only(root: string): Promise<PlanSession> {
  const [session] = await sessions(root);
  if (session === undefined) throw new Error("No planning session");
  return session;
}

/** Whether Claude Code has written the user's message `text` to the only session's transcript. */
async function isWritten(root: string, text: string): Promise<boolean> {
  const file = (await sessions(root))[0]?.transcriptPath ?? "";
  if (!existsSync(file)) return false;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      const entry = JSON.parse(line) as { type: string; message: { content: unknown } };
      return entry.type === "user" && entry.message.content === text;
    });
}

async function plan(root: string, harness: ReturnType<typeof agentHarness>, options: Partial<PlanOptions> = {}) {
  await runPlanCommand({ dir: root, timeoutMinutes: 30, model: "haiku", effort: "low", ...options }, harness.context);
}

/** The planning tool calls the fake `claude` made, with their results. */
function toolResults(
  harness: ReturnType<typeof agentHarness>,
): { name: string; result: { isError?: boolean; content: { text: string }[] } }[] {
  const file = `${harness.recordFile}.tools.jsonl`;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as never);
}

describe("luseen plan: starting", () => {
  it(
    "TC-PLAN-004: with roadmaps, the user picks one to extend, and the PM is told",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [says("Noted.")] });
      selectMock.mockResolvedValueOnce("1");
      typing("Add exports", "/cancel");
      await plan(root, harness);
      const menu = menuAt(0) as { choices: { name: string }[] };
      expect(menu.choices.map((choice) => choice.name)).toEqual([
        "A new roadmap",
        "Extend Roadmap #1: Launch [planned]",
        "A single task",
      ]);
      expect(harness.calls()[0]?.prompt).toContain("EXTEND roadmap 1");
    },
    SLOW,
  );

  it(
    "TC-PLAN-005: with no roadmaps, only a new roadmap or a single task is offered",
    async () => {
      const root = project(false);
      const harness = agentHarness({ rules: [says("Noted.")] });
      selectMock.mockResolvedValueOnce("new");
      typing("A portal", "/cancel");
      await plan(root, harness);
      const menu = menuAt(0) as { choices: { name: string }[] };
      expect(menu.choices.map((choice) => choice.name)).toEqual(["A new roadmap", "A single task"]);
      expect(harness.calls()[0]?.prompt).toContain("Plan a NEW roadmap");
    },
    SLOW,
  );

  it("TC-PLAN-006, TC-PLAN-029: a roadmap that doesn't exist is a usage error, before Claude is called", async () => {
    const root = project();
    const harness = agentHarness();
    await expect(plan(root, harness, { roadmap: 99 })).rejects.toThrow("Roadmap 99 doesn't exist.");
    await expect(plan(root, harness, { roadmap: 99, task: true })).rejects.toThrow("Roadmap 99 doesn't exist.");
    expect(harness.calls()).toEqual([]);
  });

  it("TC-PLAN-001: --resume can't be mixed with a new session's options, and --attach files are checked first", async () => {
    const root = project();
    writeFileSync(path.join(root, "song.mp3"), "x");
    const harness = agentHarness();
    await expect(plan(root, harness, { attach: ["missing.pdf"] })).rejects.toThrow("missing.pdf can't be read.");
    await expect(plan(root, harness, { attach: ["song.mp3"] })).rejects.toThrow("song.mp3 can't be attached");
    await expect(plan(root, harness, { resume: true, task: true })).rejects.toThrow(UsageError);
    await expect(plan(root, harness, { resume: "plan-1", attach: ["notes.md"] })).rejects.toThrow("--resume");
    expect(harness.calls()).toEqual([]);
  });

  it(
    "TC-PLAN-037: no PM turn runs before the user's first message, which ends the first prompt",
    async () => {
      const root = project(false);
      const harness = agentHarness({ rules: [says("Noted."), says("Noted.")] });
      selectMock.mockResolvedValueOnce("new");
      inputMock.mockImplementationOnce(() => {
        expect(harness.calls()).toEqual([]);
        return Promise.resolve("Add SSO");
      });
      typing("/cancel");
      await plan(root, harness);
      expect(harness.output.err).toContain("What do you want to build?");
      expect(harness.calls()[0]?.prompt.startsWith("## The user's first message\n\nAdd SSO\n")).toBe(true);
      selectMock.mockResolvedValueOnce(null);
      typing("Lock accounts", "/cancel");
      await plan(root, harness, { task: true });
      expect(harness.output.err).toContain("What's the change?");
    },
    SLOW,
  );

  it(
    "TC-PLAN-038: --attach files go with the first message",
    async () => {
      const root = project(false);
      writeProject(root, { "brief.pdf": "%PDF-1.4 brief", "mock.png": "png" });
      const harness = agentHarness({ rules: [says("Noted.")] });
      selectMock.mockResolvedValueOnce("new");
      typing("See attached", "/cancel");
      await plan(root, harness, { attach: ["brief.pdf", "mock.png"] });
      const prompt = harness.calls()[0]?.prompt ?? "";
      expect(prompt).toContain("See attached");
      expect(prompt).toMatch(/- brief\.pdf \(document\): \.luseen\/plans\/plan-1\/attachments\/brief\.pdf/);
      expect(prompt).toMatch(/- mock\.png \(image\): \.luseen\/plans\/plan-1\/attachments\/mock\.png/);
    },
    SLOW,
  );

  it(
    "TC-PLAN-028: --task asks where the task goes, unless --roadmap is given",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [says("A."), says("B."), says("C.")] });
      selectMock.mockResolvedValueOnce(1);
      typing("Lock it", "/cancel");
      await plan(root, harness, { task: true });
      const where = menuAt(0) as { choices: { name: string }[] };
      expect(where.choices.map((choice) => choice.name)).toEqual([
        "Standalone, in no roadmap",
        "Roadmap #1: Launch [planned]",
      ]);
      selectMock.mockResolvedValueOnce(null);
      typing("Lock it", "/cancel");
      await plan(root, harness, { task: true });
      typing("Lock it", "/cancel");
      await plan(root, harness, { task: true, roadmap: 1 });
      const prompts = harness.calls().map((call) => call.prompt);
      expect(prompts[0]).toContain("SINGLE task for roadmap 1");
      expect(prompts[1]).toContain("SINGLE STANDALONE task");
      expect(prompts[2]).toContain("SINGLE task for roadmap 1");
      expect(selectMock).toHaveBeenCalledTimes(2);
    },
    SLOW,
  );
});

describe("luseen plan: the PM's Claude session", () => {
  it(
    "TC-PLAN-007, TC-PLAN-026: one persistent session with the PM's tools and its own planning server, never write tools",
    async () => {
      const root = project();
      const file = tasksDatabaseFile(path.join(root, ".luseen"));
      const contents = readFileSync(file);
      const harness = agentHarness({
        rules: [says("Who is it for?"), says("Got it."), proposing("Here.", roadmapProposal())],
      });
      selectMock.mockResolvedValueOnce("new");
      typing("A portal", "Patients", "Go on");
      inputMock.mockImplementationOnce(() => {
        expect(readFileSync(file).equals(contents)).toBe(true);
        return Promise.resolve("/approve");
      });
      await plan(root, harness);
      const calls = harness.calls();
      const session = await only(root);
      const id = session.claudeSessionId ?? "";
      expect(calls[0]?.args).toEqual(expect.arrayContaining(["--session-id", id]));
      for (const call of calls.slice(1)) expect(call.args).toEqual(expect.arrayContaining(["--resume", id]));
      for (const call of calls) {
        const tools = call.args.slice(call.args.indexOf("--tools") + 1, call.args.indexOf("--allowedTools"));
        expect(tools).toEqual(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
        const allowed = call.args.slice(
          call.args.indexOf("--allowedTools") + 1,
          call.args.indexOf("--disallowedTools"),
        );
        expect(allowed.filter((tool) => tool.startsWith("mcp__"))).toEqual([
          "mcp__luseen__plan_status",
          "mcp__luseen__plan_suggest",
          "mcp__luseen__plan_propose",
        ]);
        for (const forbidden of ["Write", "Edit", "Bash", "--no-session-persistence"])
          expect(call.args).not.toContain(forbidden);
        expect(call.args).toEqual(
          expect.arrayContaining(["--permission-mode", "dontAsk", "--safe-mode", "--strict-mcp-config"]),
        );
        const config = JSON.parse(call.args[call.args.indexOf("--mcp-config") + 1] ?? "{}") as {
          mcpServers: { luseen: { args: string[] } };
        };
        expect(config.mcpServers.luseen.args.slice(1)).toEqual(["mcp", "--plan", session.id, "-C", root]);
      }
    },
    SLOW,
  );

  it(
    "TC-PLAN-008: later turns send only the user's new message and its attachments",
    async () => {
      const root = project();
      writeProject(root, { "mock.png": "png", "brief.docx": "not really a docx" });
      const harness = agentHarness({ rules: [says("Noted."), says("Noted.")] });
      typing("Add exports @mock.png", "Also @brief.docx", "/cancel");
      await plan(root, harness, { roadmap: 1 });
      const [first, second] = harness.calls().map((call) => call.prompt);
      expect(first).toContain("# Plan the work as the PM");
      expect(first).toContain("EXTEND roadmap 1");
      expect(first).toContain('"dependsOn"');
      expect(first).toContain("- mock.png (image): .luseen/plans/plan-1/attachments/mock.png");
      expect(second).toBe(
        "Also\n\nAttached (new in this message):\n- brief.docx (document): .luseen/plans/plan-1/attachments/brief.docx.md",
      );
    },
    SLOW,
  );

  it(
    "TC-PLAN-010: suggestions and sources are shown, an empty line isn't sent, and a number sends that suggestion",
    async () => {
      const root = project();
      const suggest = {
        name: "plan_suggest",
        input: { suggestions: ["Web", "Mobile"], sources: [{ title: "HHS HIPAA", url: "https://www.hhs.gov/hipaa" }] },
      };
      const harness = agentHarness({ rules: [says("Which platform?", { tools: [suggest] }), says("Mobile it is.")] });
      typing("A portal", "", "2", "/cancel");
      await plan(root, harness, { roadmap: 1 });
      for (const part of [
        "PM › Which platform?",
        "  1. Web",
        "  2. Mobile",
        "HHS HIPAA (https://www.hhs.gov/hipaa)",
        "Write a message or attach a file.",
      ]) {
        expect(harness.output.err, part).toContain(part);
      }
      expect(harness.calls()).toHaveLength(2);
      expect(harness.calls()[1]?.prompt).toBe("Mobile");
    },
    SLOW,
  );

  it(
    "TC-PLAN-012: a proposal that fails the checks goes back to the PM in the same turn, unseen",
    async () => {
      const root = project(false);
      const cyclic = roadmapProposal({
        milestones: [{ title: "M", goal: "", tasks: [planned("A", ["B"]), planned("B", ["A"])] }],
      });
      const harness = agentHarness({
        rules: [
          says("Here is the plan", {
            tools: [
              { name: "plan_propose", input: { proposal: cyclic } },
              { name: "plan_propose", input: { proposal: roadmapProposal() } },
            ],
          }),
        ],
      });
      selectMock.mockResolvedValueOnce("new");
      typing("A portal", "/cancel");
      await plan(root, harness);
      const [rejected, accepted] = toolResults(harness);
      expect(rejected?.result.isError).toBe(true);
      expect(rejected?.result.content[0]?.text).toContain("The dependencies make a cycle: A -> B -> A.");
      expect(accepted?.result.isError).toBe(false);
      expect(harness.output.err).toContain("Roadmap: Launch");
      expect(harness.output.err).not.toContain("[A]");
    },
    SLOW,
  );

  it(
    "TC-PLAN-013, TC-PLAN-014: an empty turn gets one nudge; a second ends the run and keeps the session",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [says(""), says("Hello.")] });
      typing("A portal", "/cancel");
      await plan(root, harness, { roadmap: 1 });
      expect(harness.calls()[1]?.prompt).toContain("Your last turn ended without a reply to the user.");
      expect(harness.output.err).toContain("PM › Hello.");

      const second = project();
      const silent = agentHarness({ rules: [says(""), says("")] });
      typing("A portal");
      const error = await plan(second, silent, { roadmap: 1 }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AgentSessionError);
      expect(exitCodeFor(error)).toBe(4);
      const session = await only(second);
      expect(session.status).toBe("open");
      expect((error as Error).message).toContain(`luseen plan --resume ${session.id}`);
      expect((error as Error).message).toContain(`claude --resume ${session.claudeSessionId ?? ""}`);
      const store = openStore(second);
      expect(store.listRoadmaps()).toHaveLength(1);
      store.close();
    },
    SLOW,
  );
});

describe("luseen plan: proposals", () => {
  it(
    "TC-PLAN-015, TC-PLAN-017: an approved new roadmap is shown, then saved in order with dependencies",
    async () => {
      const root = project(false);
      writeProject(root, { "mock.png": "png" });
      const harness = agentHarness({ rules: [proposing("Ready", roadmapProposal())] });
      selectMock.mockResolvedValueOnce("new");
      typing("A portal @mock.png", "/approve");
      await plan(root, harness);
      for (const part of [
        "PM › Ready",
        "Roadmap: Launch",
        "Milestone 1: First",
        "spec: auth",
        "spec: new spec (needs a)",
        "Which email provider?",
        "/approve to save it, /cancel to drop it, or reply to change it.",
      ]) {
        expect(harness.output.err, part).toContain(part);
      }
      expect(harness.output.out).toBe("Saved roadmap #1. Run it with: luseen auto --roadmap 1\n");
      const store = openStore(root);
      expect(store.listMilestones().map((item) => item.title)).toEqual(["First", "Second"]);
      expect(store.listTasks(true).map((task) => [task.title, task.status, task.dependsOn])).toEqual([
        ["Task a", "open", []],
        ["Task b", "open", [1]],
        ["Task c", "open", [1, 2]],
      ]);
      store.close();
      const session = await only(root);
      expect(session.status).toBe("approved");
      expect(existsSync(path.join(root, ".luseen/plans/plan-1/attachments"))).toBe(false);
      expect(existsSync(session.transcriptPath ?? "")).toBe(true);
    },
    SLOW,
  );

  it(
    "TC-PLAN-016: a reply refines the proposal in the same session, and the new one replaces it",
    async () => {
      const root = project(false);
      writeProject(root, { "notes.md": "notes" });
      const harness = agentHarness({
        rules: [proposing("First.", roadmapProposal()), proposing("Second.", roadmapProposal({ openQuestions: [] }))],
      });
      selectMock.mockResolvedValueOnce("new");
      typing("A portal", "split task 2 @notes.md", "/approve");
      await plan(root, harness);
      const [first, second] = harness.calls();
      expect(second?.args).toEqual(
        expect.arrayContaining(["--resume", first?.args[first.args.indexOf("--session-id") + 1] ?? ""]),
      );
      expect(second?.prompt.startsWith("split task 2\n")).toBe(true);
      expect(second?.prompt).toContain("- notes.md (document)");
      expect((await only(root)).status).toBe("approved");
    },
    SLOW,
  );

  it(
    "TC-PLAN-018: extending a roadmap adds milestones after its own",
    async () => {
      const root = project();
      const extension = roadmapProposal({
        roadmap: null,
        milestones: [{ title: "Three", goal: "", tasks: [planned("z", [1])] }],
      });
      const harness = agentHarness({ rules: [proposing("Ready", extension)] });
      typing("More", "/approve");
      await plan(root, harness, { roadmap: 1 });
      const store = openStore(root);
      expect(store.listRoadmaps()).toHaveLength(1);
      expect(store.listMilestones().map((item) => [item.title, item.position])).toEqual([
        ["One", 1],
        ["Two", 2],
        ["Three", 3],
      ]);
      store.close();
    },
    SLOW,
  );

  it(
    "TC-PLAN-019: a plan that can't be saved saves nothing, is shown again, and keeps the session open",
    async () => {
      const root = project(false);
      const store = openStore(root);
      for (let id = 1; id <= 9; id += 1) store.addTask({ title: `T${id}` });
      store.close();
      const proposal = roadmapProposal({
        milestones: [{ title: "M", goal: "", tasks: [planned("a"), planned("b", [9])] }],
      });
      const harness = agentHarness({ rules: [proposing("Ready", proposal)] });
      selectMock.mockResolvedValueOnce("new");
      typing("A portal");
      inputMock.mockImplementationOnce(() => {
        const removing = openStore(root);
        removing.removeTask(9);
        removing.close();
        return Promise.resolve("/approve");
      });
      const error = await plan(root, harness).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UsageError);
      expect(exitCodeFor(error)).not.toBe(0);
      expect(harness.output.err).toContain("Couldn't save the approved plan");
      expect(harness.output.err).toContain("Roadmap: Launch");
      const after = openStore(root);
      expect(after.listRoadmaps()).toEqual([]);
      expect(after.listTasks(true)).toHaveLength(8);
      after.close();
      expect((await only(root)).status).toBe("open");
    },
    SLOW,
  );

  it(
    "TC-PLAN-020: cancel saves nothing, closes the session, and deletes its attachments",
    async () => {
      const root = project();
      writeProject(root, { "mock.png": "png" });
      const before = readFileSync(tasksDatabaseFile(path.join(root, ".luseen")));
      const harness = agentHarness({ rules: [proposing("Ready", roadmapProposal({ roadmap: null }))] });
      typing("@mock.png", "/cancel");
      await plan(root, harness, { roadmap: 1 });
      expect(harness.output.out).toBe("Cancelled. Nothing was saved.\n");
      expect(readFileSync(tasksDatabaseFile(path.join(root, ".luseen"))).equals(before)).toBe(true);
      const session = await only(root);
      expect(session.status).toBe("cancelled");
      expect(existsSync(path.join(root, ".luseen/plans/plan-1/attachments"))).toBe(false);
      expect(existsSync(session.transcriptPath ?? "")).toBe(true);
    },
    SLOW,
  );

  it(
    "TC-PLAN-034, TC-PLAN-036: an approved task is saved in its milestone or standalone, with the right next step",
    async () => {
      const root = project();
      const harness = agentHarness({
        rules: [proposing("Ready", taskProposal(2, [1])), proposing("Ready", taskProposal(null))],
      });
      typing("Lock it", "/approve");
      await plan(root, harness, { task: true, roadmap: 1 });
      expect(harness.output.err).toContain("Where: milestone #2 of roadmap #1");
      expect(harness.output.err).toContain("Depends on: #1");
      expect(harness.output.out).toBe("Saved task #3. It runs with its roadmap: luseen auto --roadmap 1\n");
      selectMock.mockResolvedValueOnce(null);
      typing("Lock it", "/approve");
      await plan(root, harness, { task: true });
      expect(harness.output.out).toContain("Saved task #4. It's standalone, so luseen auto doesn't run it.");
      expect(harness.output.out.split("\n")[1]).not.toContain("luseen auto --");
      const store = openStore(root);
      expect(store.getTask(3)).toMatchObject({ milestoneId: 2, status: "open", dependsOn: [1], spec: null });
      expect(store.getTask(4)?.milestoneId).toBeNull();
      store.close();
    },
    SLOW,
  );

  it(
    "TC-PLAN-035: a task that fails to save leaves nothing behind",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [proposing("Ready", taskProposal(null, [1]))] });
      selectMock.mockResolvedValueOnce(null);
      typing("Lock it");
      inputMock.mockImplementationOnce(() => {
        const removing = openStore(root);
        removing.removeTask(1);
        removing.close();
        return Promise.resolve("/approve");
      });
      await expect(plan(root, harness, { task: true })).rejects.toThrow(UsageError);
      const store = openStore(root);
      expect(store.listTasks(true).map((task) => task.id)).toEqual([2]);
      store.close();
    },
    SLOW,
  );

  it(
    "TC-PLAN-031: task mode takes an image alone, nudges an empty turn, takes feedback, and cancels",
    async () => {
      const root = project();
      writeProject(root, { "mock.png": "png" });
      const harness = agentHarness({
        rules: [says("What should it do?"), says(""), proposing("Ready", taskProposal(null)), says("Smaller then.")],
      });
      selectMock.mockResolvedValueOnce(null);
      typing("Lock it", "@mock.png", "smaller scope", "/cancel");
      await plan(root, harness, { task: true });
      const prompts = harness.calls().map((call) => call.prompt);
      expect(prompts[1]).toContain("- mock.png (image)");
      expect(prompts[2]).toContain("Your last turn ended without a reply");
      expect(prompts[3]).toBe("smaller scope");
      expect((await only(root)).status).toBe("cancelled");
    },
    SLOW,
  );
});

describe("luseen plan: attachments", () => {
  it(
    "TC-PLAN-039: refused files name the reason, start no turn, and lose nothing",
    async () => {
      const root = project();
      writeProject(root, {
        "song.mp3": "x",
        "big.png": "x".repeat(6 * 1024 * 1024),
        "mock.png": "png",
        "brief.pdf": "%PDF",
        "notes.md": "n",
        "data.csv": "a,b",
      });
      const many = Array.from({ length: 11 }, (_, index) => `f${index}.md`);
      writeProject(root, Object.fromEntries(many.map((name) => [name, "x"])));
      const harness = agentHarness({ rules: [says("Noted."), says("Got them.")] });
      typing(
        "Start",
        "@song.mp3",
        "@big.png",
        many.map((name) => `@${name}`).join(" "),
        "@missing.png",
        "@mock.png @brief.pdf @notes.md @data.csv",
        "/cancel",
      );
      await plan(root, harness, { roadmap: 1 });
      for (const part of [
        "song.mp3 can't be attached",
        "big.png is too large",
        "at most 10 files",
        "missing.png can't be read.",
      ]) {
        expect(harness.output.err, part).toContain(part);
      }
      expect(harness.calls()).toHaveLength(2);
      expect((await only(root)).attachments.map((item) => item.name)).toEqual([
        "mock.png",
        "brief.pdf",
        "notes.md",
        "data.csv",
      ]);
    },
    SLOW,
  );

  it(
    "TC-PLAN-042: copies get unique names, originals are untouched, and a DOCX gets redacted text",
    async () => {
      const root = project();
      writeProject(root, { "a/notes.md": "first", "b/notes.md": "second" });
      writeFileSync(
        path.join(root, "brief.docx"),
        makeDocx([{ text: "Target: clinics sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }]),
      );
      const before = statSync(path.join(root, "a/notes.md")).mtimeMs;
      const harness = agentHarness({ rules: [says("Noted.")] });
      const folder = path.join(root, ".luseen/plans/plan-1/attachments");
      typing("@brief.docx @a/notes.md @b/notes.md");
      inputMock.mockImplementationOnce(() => {
        expect(readdirSync(folder).sort()).toEqual(["brief.docx", "brief.docx.md", "notes-2.md", "notes.md"]);
        expect(readFileSync(path.join(folder, "notes.md"), "utf8")).toBe("first");
        expect(readFileSync(path.join(folder, "notes-2.md"), "utf8")).toBe("second");
        const text = readFileSync(path.join(folder, "brief.docx.md"), "utf8");
        expect(text).toContain("Target: clinics");
        expect(text).not.toContain("sk-ant-api03");
        return Promise.resolve("/cancel");
      });
      await plan(root, harness, { roadmap: 1 });
      expect(harness.calls()[0]?.prompt).toContain(
        "- brief.docx (document): .luseen/plans/plan-1/attachments/brief.docx.md",
      );
      expect(existsSync(folder)).toBe(false);
      expect(statSync(path.join(root, "a/notes.md")).mtimeMs).toBe(before);
      expect(readFileSync(path.join(root, ".luseen/plans/.gitignore"), "utf8")).toBe("*\n");
    },
    SLOW,
  );

  it(
    'TC-PLAN-044: @"quoted paths", /attach, numbers and continued lines',
    async () => {
      const root = project();
      writeProject(root, { "docs/my brief.pdf": "%PDF", "notes.md": "n" });
      const suggest = { name: "plan_suggest", input: { suggestions: ["Web"] } };
      const harness = agentHarness({
        rules: [
          says("Hi.", { tools: [suggest] }),
          says("A.", { tools: [suggest] }),
          says("B.", { tools: [suggest] }),
          says("C."),
          says("D."),
          says("E."),
        ],
      });
      typing(
        "Start",
        'look @"docs/my brief.pdf"',
        "/attach notes.md",
        "1",
        "first \\",
        "second",
        "/propose",
        "/cancel",
      );
      await plan(root, harness, { roadmap: 1 });
      const prompts = harness.calls().map((call) => call.prompt);
      expect(prompts[1]?.startsWith("look\n")).toBe(true);
      expect(prompts[1]).toContain("- my brief.pdf (document)");
      expect(prompts[2]).toMatch(/^Attached \(new in this message\):\n- notes\.md/);
      expect(prompts[3]).toBe("Web");
      expect(prompts[4]).toBe("first\nsecond");
      expect(prompts[5]).toContain("Propose now from what you know");
    },
    SLOW,
  );
});

describe("luseen plan: stopping and resuming", () => {
  it(
    "TC-PLAN-021: stopping a turn ends the PM, keeps the session, and resuming asks the PM to answer",
    async () => {
      const root = project(false);
      const pids = path.join(makeTempFolder(), "pids");
      const harness = agentHarness({
        rules: [says("Hello."), { hang: true }, says("Answered.")],
        env: { FAKE_CLAUDE_PIDS: pids },
      });
      selectMock.mockResolvedValueOnce("new");
      typing("A portal", "Patients");
      const running = plan(root, harness).catch((caught: unknown) => caught);
      await vi.waitFor(async () => {
        expect(existsSync(pids) && readFileSync(pids, "utf8").trim().split("\n").length === 2).toBe(true);
        expect(await isWritten(root, "Patients")).toBe(true);
      }, SPAWN_WAIT);
      harness.controller.abort();
      const error = await running;
      expect(error).toBeInstanceOf(CancelledError);
      expect(exitCodeFor(error)).toBe(130);
      const pid = Number(readFileSync(pids, "utf8").trim().split("\n")[1]);
      await vi.waitFor(() => {
        expect(() => process.kill(pid, 0)).toThrow();
      }, SPAWN_WAIT);
      const session = await only(root);
      expect(harness.output.err).toContain(`luseen plan --resume ${session.id}`);
      expect(session).toMatchObject({ status: "open", isAwaitingReply: true, holder: null });
      expect(existsSync(path.join(root, ".luseen/tasks.db"))).toBe(false);

      const again = agentHarness({ rules: [says("Answered.")], env: { HOME: harness.environment.HOME } });
      typing("/cancel");
      await plan(root, again, { resume: session.id });
      expect(again.calls()[0]?.args).toEqual(expect.arrayContaining(["--resume", session.claudeSessionId ?? ""]));
      // FR-PLAN-014: Claude Code wrote "Patients" before the stop, so it isn't repeated.
      expect(again.calls()[0]?.prompt).toBe(answerLastMessage(null));
    },
    SLOW,
  );

  it(
    "TC-PLAN-022: a run stops after 40 PM turns, keeping the session",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [{ message: "And?", times: 0 }] });
      typing(...Array.from({ length: 41 }, (_, index) => `answer ${index}`));
      const error = await plan(root, harness, { roadmap: 1 }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AgentSessionError);
      expect(exitCodeFor(error)).toBe(4);
      expect(String(error)).toContain("40 PM turns");
      expect(String(error)).toContain("luseen plan --resume plan-1");
      expect(harness.calls()).toHaveLength(40);
      expect((await only(root)).status).toBe("open");
    },
    SLOW * 3,
  );

  it(
    "TC-PLAN-023: a plan usage limit stops the run with its reset time and both resume commands",
    async () => {
      const root = project();
      const resetsAt = 1794532800;
      const limitEvent = {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt,
          unifiedWindows: { five_hour: { utilization: 1, resetsAt, status: "rejected" } },
        },
      };
      const harness = agentHarness({
        rules: [
          says("Who pays?"),
          { events: [limitEvent], exitCode: 1, message: "You've hit your session limit · resets 4am" },
        ],
      });
      typing("A shop", "Shoppers");
      const error = await plan(root, harness, { roadmap: 1 }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AgentSessionError);
      expect(exitCodeFor(error)).toBe(4);
      const message = (error as Error).message;
      expect(message).toContain("Claude's usage limit is reached.");
      expect(message).toContain(`It resets ${new Date(resetsAt * 1000).toISOString()}.`);
      expect(message).toContain("luseen plan --resume plan-1");
      expect(message).toContain("claude --resume");
      expect(harness.calls()).toHaveLength(2);
    },
    SLOW,
  );

  it(
    "TC-PLAN-024: a PM turn is stopped at the timeout",
    async () => {
      const root = project(false);
      const harness = agentHarness({ rules: [{ hang: true }] });
      selectMock.mockResolvedValueOnce("new");
      typing("A portal");
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const running = plan(root, harness, { timeoutMinutes: 1 }).catch((caught: unknown) => caught);
      await vi.waitFor(() => {
        expect(harness.calls()).toHaveLength(1);
      }, SPAWN_WAIT);
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      const error = await running;
      expect(error).toBeInstanceOf(AgentSessionError);
      expect(String(error)).toContain("timed out");
    },
    SLOW,
  );

  it(
    "TC-PLAN-046: the record holds metadata only, and every change is a whole file",
    async () => {
      const root = project();
      const suggest = {
        name: "plan_suggest",
        input: { suggestions: ["Yes"], sources: [{ title: "Doc", url: "https://a.example" }] },
      };
      const harness = agentHarness({
        rules: [says("Is that all?", { tools: [suggest] }), proposing("Ready", roadmapProposal({ roadmap: null }))],
      });
      typing("A secret plan sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", "Yes");
      inputMock.mockImplementationOnce(async () => {
        const file = path.join(root, ".luseen/plans/plan-1/session.json");
        const saved = JSON.parse(readFileSync(file, "utf8")) as PlanSession;
        expect(saved).toMatchObject({
          id: "plan-1",
          target: { kind: "extend-roadmap", roadmapId: 1 },
          status: "open",
          holder: { place: "terminal" },
        });
        expect(saved.proposal?.kind).toBe("roadmap");
        expect(saved.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(readFileSync(file, "utf8")).not.toContain("sk-ant-api03");
        expect(readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
        return Promise.resolve("/cancel");
      });
      await plan(root, harness, { roadmap: 1 });
      expect(harness.output.err).toMatch(
        /Planning session plan-1\. Continue it later with: luseen plan --resume plan-1 {2}or {2}claude --resume [0-9a-f-]{36}/,
      );
    },
    SLOW,
  );

  it(
    "TC-PLAN-047: --resume lists open sessions, shows the history, and continues each as it was",
    async () => {
      const root = project();
      const harness = agentHarness({
        rules: [proposing("Ready", roadmapProposal({ roadmap: null })), says("Hi."), says("")],
      });
      typing("First idea");
      inputMock.mockImplementationOnce(() => Promise.reject(new CancelledError("Cancelled.")));
      await plan(root, harness, { roadmap: 1 }).catch(() => undefined);
      typing("Second idea");
      inputMock.mockImplementationOnce(() => Promise.reject(new CancelledError("Cancelled.")));
      await plan(root, harness, { roadmap: 1 }).catch(() => undefined);
      await openPlanStore(root).update("plan-2", (session) => ({
        save: { ...session, isAwaitingReply: true },
        value: undefined,
      }));

      const resumed = agentHarness({ rules: [says("Answered.")], env: { HOME: harness.environment.HOME } });
      selectMock.mockImplementationOnce((config) =>
        Promise.resolve(
          (config as unknown as { choices: { value: PlanSession }[] }).choices.find(
            (choice) => choice.value.id === "plan-1",
          )?.value,
        ),
      );
      typing("/cancel");
      await plan(root, resumed, { resume: true });
      const list = menuAt(0) as { choices: { name: string }[] };
      expect(list.choices).toHaveLength(2);
      expect(list.choices.map((choice) => choice.name).join("\n")).toContain('"First idea"');
      expect(list.choices.map((choice) => choice.name).join("\n")).toContain("a terminal (luseen plan)");
      expect(resumed.output.err).toContain("You › First idea");
      expect(resumed.output.err).toContain("PM › Ready");
      expect(resumed.output.err).toContain("Extending roadmap #1"); // the waiting proposal, shown again
      expect(resumed.calls()).toEqual([]);

      typing("/cancel");
      await plan(root, resumed, { resume: "plan-2" });
      expect(resumed.calls()[0]?.prompt).toBe("Your last turn was stopped. Answer my last message.");
      await expect(plan(root, resumed, { resume: "plan-1" })).rejects.toThrow("no open planning session plan-1");
      await expect(plan(root, resumed, { resume: "plan-9" })).rejects.toThrow("no open planning session plan-9");
      await expect(plan(project(), resumed, { resume: true })).rejects.toThrow(
        "There's no open planning session to resume.",
      );
    },
    SLOW,
  );

  it(
    "TC-PLAN-048: a waiting proposal that depends on a removed task goes back to the PM",
    async () => {
      const root = project();
      const harness = agentHarness({
        rules: [
          proposing(
            "Ready",
            roadmapProposal({ roadmap: null, milestones: [{ title: "M", goal: "", tasks: [planned("z", [2])] }] }),
          ),
          says("Fixed."),
        ],
      });
      typing("More");
      inputMock.mockImplementationOnce(() => Promise.reject(new CancelledError("Cancelled.")));
      await plan(root, harness, { roadmap: 1 }).catch(() => undefined);
      const store = openStore(root);
      store.removeTask(2);
      store.close();
      const resumed = agentHarness({ rules: [says("Fixed.")], env: { HOME: harness.environment.HOME } });
      typing("/cancel");
      await plan(root, resumed, { resume: "plan-1" });
      expect(resumed.calls()[0]?.prompt).toContain("depends on task 2, which doesn't exist");
    },
    SLOW,
  );

  it(
    "TC-PLAN-049: a session held by a live process can't be driven, and a dead holder is taken over",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [says("Hi.")] });
      typing("Idea");
      inputMock.mockImplementationOnce(() => Promise.reject(new CancelledError("Cancelled.")));
      await plan(root, harness, { roadmap: 1 }).catch(() => undefined);
      const records = openPlanStore(root);
      // This test's own process stands in for a live terminal holding the session.
      await records.update("plan-1", (session) => ({
        save: { ...session, holder: { place: "terminal", pid: process.ppid } },
        value: undefined,
      }));
      await expect(plan(root, harness, { resume: "plan-1" })).rejects.toThrow("is open in a terminal (luseen plan)");
      await records.update("plan-1", (session) => ({
        save: { ...session, holder: { place: "gui", pid: 999_999 } },
        value: undefined,
      }));
      typing("/cancel");
      await plan(root, harness, { resume: "plan-1" });
      expect((await only(root)).status).toBe("cancelled");
    },
    SLOW,
  );

  it(
    "TC-PLAN-063: both ways to continue are shown at the start and when stopped",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [says("Hi.")] });
      typing("Idea");
      inputMock.mockImplementationOnce(() => Promise.reject(new CancelledError("Cancelled.")));
      await plan(root, harness, { roadmap: 1 }).catch(() => undefined);
      const session = await only(root);
      const both = `luseen plan --resume ${session.id}  or  claude --resume ${session.claudeSessionId ?? ""}`;
      expect(harness.output.err.split(both).length - 1).toBe(2);
    },
    SLOW,
  );

  it(
    "TC-PLAN-066: a session approved elsewhere ends the terminal chat cleanly, with no turn after it",
    async () => {
      const root = project();
      const harness = agentHarness({
        rules: [proposing("Ready", roadmapProposal({ roadmap: null })), says("Never sent.")],
      });
      typing("More");
      inputMock.mockImplementationOnce(async () => {
        // The user approves it from the GUI's Needs you while this terminal holds the session (FR-PLAN-032).
        const { approveProposal } = await import("../../src/application/planning-session.js");
        const { decisionPorts } = await import("../../src/cli/planning-ports.js");
        await approveProposal(decisionPorts(root), "plan-1");
        return "and one more thing";
      });
      await plan(root, harness, { roadmap: 1 });
      expect(harness.calls()).toHaveLength(1);
      expect(harness.output.out).toContain("Planning session plan-1 was approved elsewhere. Saved roadmap #1");
      expect((await only(root)).status).toBe("approved");
    },
    SLOW,
  );

  it(
    "TC-PLAN-031: a whole reply of up to 8,000 characters is shown again on resume",
    async () => {
      const root = project();
      const long = `${"word ".repeat(1_500)}END`;
      const harness = agentHarness({ rules: [says(long)] });
      typing("Idea");
      inputMock.mockImplementationOnce(() => Promise.reject(new CancelledError("Cancelled.")));
      await plan(root, harness, { roadmap: 1 }).catch(() => undefined);
      const resumed = agentHarness({ env: { HOME: harness.environment.HOME } });
      typing("/cancel");
      await plan(root, resumed, { resume: "plan-1" });
      expect(resumed.output.err).toContain("word END");
    },
    SLOW,
  );

  it(
    "TC-PLAN-072: a resume stopped again asks the PM to answer, without repeating a message the transcript has",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [says("Hello."), { hang: true }] });
      typing("A portal", "Patients");
      const first = plan(root, harness, { roadmap: 1 }).catch((caught: unknown) => caught);
      await vi.waitFor(async () => {
        expect(harness.calls()).toHaveLength(2);
        expect(await isWritten(root, "Patients")).toBe(true);
      }, SPAWN_WAIT);
      harness.controller.abort();
      await first;
      // FR-PLAN-014: Claude Code wrote "Patients" before the first stop, so no resume repeats it.
      const expected = answerLastMessage(null);
      for (let stop = 0; stop < 2; stop += 1) {
        const again = agentHarness({ rules: [{ hang: true }], env: { HOME: harness.environment.HOME } });
        const running = plan(root, again, { resume: "plan-1" }).catch((caught: unknown) => caught);
        await vi.waitFor(() => {
          expect(again.calls()).toHaveLength(1);
        }, SPAWN_WAIT);
        again.controller.abort();
        await running;
        expect(again.calls()[0]?.prompt).toBe(expected);
      }
      expect((await only(root)).unansweredMessage).toBe("Patients");
    },
    SLOW,
  );
});
