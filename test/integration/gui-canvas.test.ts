/** The canvas API: roadmaps, tasks, modes, sessions, transcripts and the layout (spec: gui, stage C1). */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openTaskStore, type TaskStore } from "../../src/adapters/storage/task-store.js";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import type { AgentSession, RunState } from "../../src/core/automation.js";
import type { CanvasView, Layout } from "../../src/core/canvas.js";
import { beginChange, linkSession, stateKey } from "../../src/core/workflow.js";
import { makeTempFolder } from "../support/helpers.js";
import { openStream, sendTo, startTestGui, type TestGui } from "../support/gui.js";

const RUN_ID = "20261111-110000";
const AGENT_1 = "7c1e0000-0000-4000-8000-000000000001";
const AGENT_2 = "7c1e0000-0000-4000-8000-000000000002";
const running: TestGui[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((gui) => gui.stop()));
});

/** Stands in for the GUI's polling timer, so a test decides when the next check happens: no real clock. */
function manualClock() {
  const checks = new Set<() => Promise<void>>();
  return {
    every: (_ms: number, run: () => Promise<void>) => {
      checks.add(run);
      return () => checks.delete(run);
    },
    /** One check of everything polling, finished before it returns. */
    tick: async () => {
      await Promise.all([...checks].map((check) => check()));
    },
  };
}

async function start(root: string, environment: NodeJS.ProcessEnv = {}, clock = manualClock()): Promise<TestGui> {
  const gui = await startTestGui(root, {}, { every: clock.every }, environment);
  running.push(gui);
  return gui;
}

function openStore(root: string): TaskStore {
  const store = openTaskStore(path.join(root, ".luseen"), "create");
  if (store === undefined) throw new Error("No store");
  return store;
}

const planned = (key: string, dependsOn: string[] = [], spec: string | null = null) => ({
  key,
  title: `Task ${key}`,
  description: "",
  spec,
  dependsOn,
});

/** Roadmap 1 "Payments" with tasks 1 and 2 (2 after 1), and roadmap 2 "Onboarding" with task 3. */
function project(): string {
  const root = makeTempFolder();
  const store = openStore(root);
  store.savePlan({
    roadmap: { title: "Payments", goal: "Card checkout" },
    milestones: [{ title: "Cards", goal: "Pay by card", tasks: [planned("a"), planned("b", ["a"], "auth")] }],
  });
  store.savePlan({
    roadmap: { title: "Onboarding", goal: "First run" },
    milestones: [{ title: "Sign-up", goal: "Join", tasks: [planned("c")] }],
  });
  store.close();
  return root;
}

function writeRun(root: string, roadmapId: number, runningTasks: number[], sessions: AgentSession[], isLive = true) {
  const folder = path.join(root, ".luseen/auto", RUN_ID);
  const state: RunState = {
    runId: RUN_ID,
    roadmapId,
    roadmapTitle: "Payments",
    runBranch: `luseen/auto/${RUN_ID}/run`,
    startedAt: new Date(Date.now() - 600_000).toISOString(),
    finishedAt: null,
    outcome: null,
    model: "haiku",
    effort: "low",
    timeoutMinutes: 30,
    limitResetsAt: null,
    spentUsd: 3.4,
    developers: 2,
    tasks: runningTasks.map((taskId) => ({
      taskId,
      title: `Task ${taskId}`,
      dependsOn: [],
      status: "running",
      branch: null,
      rounds: { specReviews: 1, qaRuns: 1, implementationReviews: 0 },
      costUsd: 1.3,
      reason: null,
      requirementIds: [],
    })),
    skippedInProgress: [],
  };
  mkdirSync(path.join(folder, "sessions"), { recursive: true });
  writeFileSync(path.join(folder, "run.json"), JSON.stringify(state));
  for (const session of sessions)
    writeFileSync(path.join(folder, "sessions", `${session.sessionId}.json`), JSON.stringify(session));
  if (isLive) writeFileSync(path.join(root, ".luseen/auto/.lock"), JSON.stringify({ pid: process.pid, runId: RUN_ID }));
}

function agentSession(id: string, taskId: number, transcriptPath: string, ended: boolean): AgentSession {
  return {
    sessionId: id,
    taskId,
    role: "qa",
    step: "qa-1",
    cwd: "/w",
    transcriptPath,
    startedAt: new Date(Date.now() - 300_000).toISOString(),
    endedAt: ended ? new Date(Date.now() - 100_000).toISOString() : null,
    exitCode: ended ? 0 : null,
    costUsd: null,
  };
}

async function saveChange(
  root: string,
  taskId: number | null,
  sessions: { id: string; path: string }[] = [],
  branch = "main",
) {
  let state = beginChange(
    { changeType: "feature", spec: "auth", ...(taskId === null ? {} : { taskId }) },
    { key: stateKey(taskId, branch), approverMode: "user", now: new Date().toISOString() },
  );
  for (const session of sessions)
    state = linkSession(state, { sessionId: session.id, transcriptPath: session.path }, new Date().toISOString());
  await openWorkflowStore(root).save(state);
}

const TRANSCRIPT = [
  { type: "user", message: { content: "Test task 2" } },
  {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Running tests." },
        { type: "tool_use", name: "Bash", input: { command: "npm test" } },
      ],
    },
  },
  { type: "user", message: { content: [{ type: "tool_result", content: "14 passed" }] } },
]
  .map((line) => JSON.stringify(line))
  .join("\n");

function transcript(home: string, folder: string, id: string, text = `${TRANSCRIPT}\n`): string {
  const file = path.join(home, ".claude/projects", folder, `${id}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

async function canvasOf(gui: TestGui): Promise<{ canvas: CanvasView; layout: Layout }> {
  return JSON.parse((await sendTo(gui, "GET", "/api/canvas")).body) as { canvas: CanvasView; layout: Layout };
}

const taskOf = (canvas: CanvasView, id: number) => canvas.tasks.find((task) => task.id === id);

describe("canvas data", () => {
  it("TC-GUI-027: the canvas holds every roadmap, milestone and task from the database, and the run holding a task", async () => {
    const root = project();
    writeRun(root, 1, [1], []);
    const gui = await start(root);
    const { canvas } = await canvasOf(gui);
    expect(canvas.roadmaps.map((roadmap) => [roadmap.id, roadmap.title, roadmap.total])).toEqual([
      [1, "Payments", 2],
      [2, "Onboarding", 1],
    ]);
    expect(canvas.roadmaps[0]?.milestones.map((milestone) => [milestone.title, milestone.taskIds])).toEqual([
      ["Cards", [1, 2]],
    ]);
    expect(taskOf(canvas, 2)).toMatchObject({
      title: "Task b",
      spec: "auth",
      dependsOn: [1],
      waitingOn: [1],
      roadmapId: 1,
    });
    expect(taskOf(canvas, 1)?.runId).toBe(RUN_ID);
    expect(taskOf(canvas, 3)?.runId).toBeNull();
  });

  it("TC-GUI-016: secrets in roadmap, milestone and task text are redacted on the canvas", async () => {
    const root = makeTempFolder();
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const store = openStore(root);
    store.savePlan({
      roadmap: { title: `Rotate ${key}`, goal: `Goal ${key}` },
      milestones: [
        {
          title: `M ${key}`,
          goal: `G ${key}`,
          tasks: [{ ...planned("a"), title: `T ${key}`, description: `D ${key}` }],
        },
      ],
    });
    store.close();
    // Written by hand, as an older version or another tool could: the GUI still redacts what it sends.
    const state = beginChange(
      { changeType: "feature", spec: "auth", taskId: 1 },
      { key: stateKey(1, "main"), approverMode: "user", now: new Date().toISOString() },
    );
    const pending = {
      kind: "gate",
      gate: "G1",
      step: null,
      reason: null,
      question: `Approve ${key}?`,
      answers: ["approve"],
      answer: null,
      notes: null,
    };
    mkdirSync(path.join(root, ".luseen/workflow"), { recursive: true });
    writeFileSync(
      path.join(root, ".luseen/workflow/task-1.json"),
      JSON.stringify({ ...state, reason: `Why ${key}`, pending }),
    );
    const reply = await sendTo(await start(root), "GET", "/api/canvas");
    expect(reply.body).toContain("pendingQuestion");
    expect(reply.body).not.toContain(key);
    expect(reply.body).toContain("[REDACTED:anthropic-key]");
  });

  it("TC-GUI-027: a damaged run is reported as a problem, and the rest of the canvas still works", async () => {
    const root = project();
    mkdirSync(path.join(root, ".luseen/auto", RUN_ID), { recursive: true });
    writeFileSync(path.join(root, ".luseen/auto", RUN_ID, "run.json"), "{broken");
    const { canvas } = await canvasOf(await start(root));
    expect(canvas.problems).toHaveLength(1);
    expect(canvas.tasks).toHaveLength(3);
  });

  it("TC-GUI-030: there's no route that creates a roadmap or milestone", async () => {
    const gui = await start(project());
    for (const route of ["/api/roadmaps", "/api/roadmap", "/api/milestones", "/api/milestone"])
      expect((await sendTo(gui, "POST", route, { title: "x" })).status).toBe(404);
    // Plan creates a roadmap only from a proposal the user approves, so a roadmap's fields start nothing.
    expect((await sendTo(gui, "POST", "/api/plan", { title: "x" })).status).toBe(400);
    expect(JSON.parse((await sendTo(gui, "GET", "/api/plan")).body)).toMatchObject({
      plan: { open: null, sessions: [], turn: null, notice: null },
    });
    for (const command of ["roadmap-add", "milestone-add"])
      expect((await sendTo(gui, "POST", "/api/jobs", { command, title: "x" })).status).toBe(400);
  });

  it("TC-GUI-031: changes made elsewhere reach an open canvas stream at the next check, and a removed task's saved position goes", async () => {
    const root = project();
    const clock = manualClock();
    const gui = await start(root, {}, clock);
    await sendTo(gui, "PUT", "/api/layout", { version: 1, frames: {}, cards: { "task-3": { x: 5, y: 5 } } });
    const stream = openStream(gui, "/api/canvas/events");
    const payloads = () =>
      stream.events
        .filter((item) => item.event === "canvas")
        .map((item) => item.data as { canvas: CanvasView; layout: Layout });
    await vi.waitFor(() => {
      expect(payloads()).toHaveLength(1);
    });
    const store = openStore(root);
    store.setStatus(2, "done");
    const added = store.addTask({ title: "Task X", dependsOn: [] });
    store.removeTask(3);
    store.close();
    // One check, which the GUI makes every second: well within FR-GUI-022's 2 seconds.
    await clock.tick();
    await vi.waitFor(() => {
      expect(payloads()).toHaveLength(2);
    });
    const latest = payloads()[1];
    expect(latest?.canvas.tasks.find((task) => task.id === 2)?.status).toBe("done");
    expect(latest?.layout.cards[`task-${added.id}`]).toBeDefined();
    expect(latest?.layout.cards["task-3"]).toBeUndefined();
    stream.close();
  });

  it("TC-GUI-031: a removed task's saved position leaves layout.json with the next save, by PUT or by Tidy up", async () => {
    const root = project();
    const gui = await start(root);
    const layoutFile = path.join(root, ".luseen/gui/layout.json");
    const stale = {
      version: 1,
      frames: { "roadmap-2": { x: 9, y: 9 } },
      cards: { "task-1": { x: 1, y: 1 }, "task-3": { x: 3, y: 3 } },
    };
    await sendTo(gui, "PUT", "/api/layout", stale);
    const store = openStore(root);
    store.removeTask(3);
    store.close();
    // A page that last updated before the removal still sends the old position.
    await sendTo(gui, "PUT", "/api/layout", stale);
    expect((JSON.parse(readFileSync(layoutFile, "utf8")) as Layout).cards).toEqual({ "task-1": { x: 1, y: 1 } });
    writeFileSync(layoutFile, JSON.stringify(stale));
    expect((await sendTo(gui, "POST", "/api/layout/tidy", { frame: "roadmap-1" })).status).toBe(200);
    const tidied = JSON.parse(readFileSync(layoutFile, "utf8")) as Layout;
    expect(tidied.cards["task-3"]).toBeUndefined();
    expect(tidied.frames["roadmap-2"]).toEqual({ x: 9, y: 9 });
  });

  it("TC-GUI-031: saved positions survive a save made while the task database can't be read", async () => {
    const root = project();
    const gui = await start(root);
    const layoutFile = path.join(root, ".luseen/gui/layout.json");
    const saved = {
      version: 1,
      frames: { "roadmap-1": { x: 5, y: 5 } },
      cards: { "task-1": { x: 1, y: 1 }, "task-3": { x: 3, y: 3 } },
    };
    await sendTo(gui, "PUT", "/api/layout", saved);
    writeFileSync(path.join(root, ".luseen/tasks.db"), "not a database");
    const reply = await sendTo(gui, "PUT", "/api/layout", {
      ...saved,
      cards: { ...saved.cards, "task-1": { x: 2, y: 2 } },
    });
    expect(reply.status).toBe(200);
    expect(JSON.parse(readFileSync(layoutFile, "utf8"))).toEqual({
      ...saved,
      cards: { "task-1": { x: 2, y: 2 }, "task-3": { x: 3, y: 3 } },
    });
  });

  it("TC-GUI-031: while the task database can't be read, the saved positions are kept, and a move keeps them", async () => {
    const root = project();
    const gui = await start(root);
    const saved = { version: 1, frames: {}, cards: { "task-1": { x: 40, y: 200 }, "task-3": { x: 40, y: 300 } } };
    await sendTo(gui, "PUT", "/api/layout", saved);
    writeFileSync(path.join(root, ".luseen/tasks.db"), "not a database");
    const { canvas } = JSON.parse((await sendTo(gui, "GET", "/api/canvas")).body) as { canvas: CanvasView };
    expect(canvas.problems).not.toEqual([]);
    expect((JSON.parse(readFileSync(path.join(root, ".luseen/gui/layout.json"), "utf8")) as Layout).cards).toEqual(
      saved.cards,
    );
    // A page sends only what it moved; what it couldn't see stays saved.
    await sendTo(gui, "PUT", "/api/layout", { version: 1, frames: { changes: { x: 9, y: 9 } }, cards: {} });
    expect((JSON.parse(readFileSync(path.join(root, ".luseen/gui/layout.json"), "utf8")) as Layout).cards).toEqual(
      saved.cards,
    );
  });

  it("TC-GUI-099: a move saved from one tab doesn't undo a move saved from another", async () => {
    const root = project();
    const gui = await start(root);
    await sendTo(gui, "PUT", "/api/layout", { version: 1, frames: {}, cards: { "task-1": { x: 40, y: 200 } } });
    await sendTo(gui, "PUT", "/api/layout", { version: 1, frames: {}, cards: { "task-3": { x: 40, y: 300 } } });
    expect((JSON.parse(readFileSync(path.join(root, ".luseen/gui/layout.json"), "utf8")) as Layout).cards).toEqual({
      "task-1": { x: 40, y: 200 },
      "task-3": { x: 40, y: 300 },
    });
  });

  it("TC-GUI-101: Tidy up with nothing saved pins no other frame", async () => {
    const root = project();
    const gui = await start(root);
    expect((await sendTo(gui, "POST", "/api/layout/tidy", { frame: "roadmap-1" })).status).toBe(200);
    expect(JSON.parse(readFileSync(path.join(root, ".luseen/gui/layout.json"), "utf8"))).toEqual({
      version: 1,
      frames: {},
      cards: {},
    });
  });

  it("TC-GUI-031: while an agent is live, a check with no change sends nothing", async () => {
    const root = project();
    writeRun(root, 1, [1], [agentSession(AGENT_1, 1, "/nowhere/a.jsonl", false)]);
    const clock = manualClock();
    const gui = await start(root, {}, clock);
    const stream = openStream(gui, "/api/canvas/events");
    const canvases = () => stream.events.filter((item) => item.event === "canvas");
    await vi.waitFor(() => {
      expect(canvases()).toHaveLength(1);
    });
    await clock.tick();
    await clock.tick();
    // A change after the quiet checks proves they ran and sent nothing.
    const store = openStore(root);
    store.setStatus(2, "done");
    store.close();
    await clock.tick();
    await vi.waitFor(() => {
      expect(canvases()).toHaveLength(2);
    });
    stream.close();
  });

  it("TC-GUI-051: a task's change shows on its card, and a change keyed by branch is listed on its own", async () => {
    const root = project();
    await saveChange(root, 2);
    // A finished change keyed by a branch still shows, after the open one (FR-GUI-037).
    const done = beginChange(
      { changeType: "bug", spec: "auth" },
      { key: stateKey(null, "fix-y"), approverMode: "user", now: new Date(Date.now() + 60_000).toISOString() },
    );
    await openWorkflowStore(root).save({ ...done, step: "done", status: "done", isCommitted: true });
    await saveChange(root, null, [], "fix-x");
    const { canvas } = await canvasOf(await start(root));
    expect(taskOf(canvas, 2)?.change).toMatchObject({ key: "task-2", spec: "auth", step: "spec", status: "open" });
    expect(canvas.changes.map((change) => [change.key, change.status])).toEqual([
      ["branch-fix-x", "open"],
      ["branch-fix-y", "done"],
    ]);
  });

  it("TC-GUI-102: a roadmap in a live run and a task worked on by hand show their modes at the same time", async () => {
    const root = project();
    writeRun(root, 1, [1], []);
    await saveChange(root, 3);
    const { canvas } = await canvasOf(await start(root));
    expect(canvas.roadmaps.map((roadmap) => roadmap.mode)).toEqual(["ai", null]);
    expect(canvas.roadmaps[0]).toMatchObject({ runId: RUN_ID });
    expect(JSON.stringify(canvas)).not.toMatch(/spentUsd|budgetUsd|costUsd/);
    expect([taskOf(canvas, 1)?.mode, taskOf(canvas, 2)?.mode, taskOf(canvas, 3)?.mode]).toEqual(["ai", null, "manual"]);
  });

  it("TC-GUI-051: a damaged workflow state is reported, and every other change and session still shows", async () => {
    const root = project();
    await saveChange(root, null, [], "fix-x");
    await saveChange(root, 3, [{ id: "mine", path: "/nowhere/mine.jsonl" }]);
    writeFileSync(path.join(root, ".luseen/workflow/task-9.json"), "{broken");
    const gui = await start(root);
    const { canvas } = await canvasOf(gui);
    expect(canvas.problems).toHaveLength(1);
    expect(canvas.changes.map((change) => change.key)).toEqual(["branch-fix-x"]);
    expect(taskOf(canvas, 3)?.mode).toBe("manual");
    expect((await sendTo(gui, "GET", "/api/sessions/mine")).status).toBe(200);
  });
});

describe("sessions and transcripts", () => {
  it("TC-GUI-054: a task lists its agents' sessions and the user's own", async () => {
    const root = project();
    const home = makeTempFolder();
    writeRun(
      root,
      1,
      [2],
      [
        agentSession(AGENT_1, 2, transcript(home, "w", AGENT_1), true),
        agentSession(AGENT_2, 2, transcript(home, "w", AGENT_2), false),
      ],
    );
    await saveChange(root, 2, [{ id: "mine", path: transcript(home, "p", "mine") }]);
    const { canvas } = await canvasOf(await start(root, { HOME: home }));
    expect(
      taskOf(canvas, 2)
        ?.sessions.map((session) => [session.id, session.source, session.isLive])
        .sort(),
    ).toEqual([
      [AGENT_1, "agent", false],
      [AGENT_2, "agent", true],
      ["mine", "interactive", true],
    ]);
  });

  it("TC-GUI-055: a session's transcript shows messages, tool calls and results in order", async () => {
    const root = project();
    const home = makeTempFolder();
    await saveChange(root, 2, [{ id: "mine", path: transcript(home, "p", "mine") }]);
    const gui = await start(root, { HOME: home });
    const reply = JSON.parse((await sendTo(gui, "GET", "/api/sessions/mine")).body) as {
      transcript: { status: string; entries: { kind: string; text: string; tool: string | null }[]; skipped: number };
    };
    expect(reply.transcript.status).toBe("found");
    expect(reply.transcript.entries.map((entry) => [entry.kind, entry.tool, entry.text])).toEqual([
      ["user", null, "Test task 2"],
      ["assistant", null, "Running tests."],
      ["tool-call", "Bash", '{"command":"npm test"}'],
      ["tool-result", null, "14 passed"],
    ]);
    expect(reply.transcript.skipped).toBe(0);
    expect((await sendTo(gui, "GET", "/api/sessions/unknown")).status).toBe(404);
  });

  it("TC-GUI-056: only transcripts in Claude Code's projects folder are read, with the session-ID fallback", async () => {
    const root = project();
    const home = makeTempFolder();
    const elsewhere = path.join(home, "outside.jsonl");
    writeFileSync(elsewhere, `${TRANSCRIPT}\n`);
    const notJsonl = path.join(home, ".claude/projects/p/notes.txt");
    mkdirSync(path.dirname(notJsonl), { recursive: true });
    writeFileSync(notJsonl, `${TRANSCRIPT}\n`);
    transcript(home, "shortened-folder-name-1a2b", "moved");
    const folderNamed = path.join(home, ".claude/projects/p/folder.jsonl");
    mkdirSync(folderNamed, { recursive: true });
    const linked = path.join(home, ".claude/projects/p/linked.jsonl");
    symlinkSync(notJsonl, linked);
    await saveChange(root, 2, [
      { id: "system", path: "/etc/passwd" },
      { id: "outside", path: elsewhere },
      { id: "not-jsonl", path: notJsonl },
      { id: "folder", path: folderNamed },
      { id: "linked", path: linked },
      { id: "moved", path: path.join(home, ".claude/projects/very-long-original-folder/moved.jsonl") },
    ]);
    const gui = await start(root, { HOME: home });
    const statusOf = async (id: string) =>
      (JSON.parse((await sendTo(gui, "GET", `/api/sessions/${id}`)).body) as { transcript: { status: string } })
        .transcript.status;
    expect(await statusOf("system")).toBe("refused");
    expect(await statusOf("outside")).toBe("refused");
    expect(await statusOf("not-jsonl")).toBe("refused");
    expect(await statusOf("folder")).toBe("refused");
    expect(await statusOf("linked")).toBe("refused");
    expect(await statusOf("moved")).toBe("found");
  });

  it("TC-GUI-056: with CLAUDE_CONFIG_DIR set, transcripts are read only from under it", async () => {
    const root = project();
    const home = makeTempFolder();
    const config = makeTempFolder();
    const inside = path.join(config, "projects/q/inside.jsonl");
    mkdirSync(path.dirname(inside), { recursive: true });
    writeFileSync(inside, `${TRANSCRIPT}\n`);
    await saveChange(root, 2, [
      { id: "inside", path: inside },
      { id: "home", path: transcript(home, "p", "home") },
    ]);
    const gui = await start(root, { HOME: home, CLAUDE_CONFIG_DIR: config });
    const statusOf = async (id: string) =>
      (JSON.parse((await sendTo(gui, "GET", `/api/sessions/${id}`)).body) as { transcript: { status: string } })
        .transcript.status;
    expect(await statusOf("inside")).toBe("found");
    expect(await statusOf("home")).toBe("refused");
  });

  it("TC-GUI-057, TC-GUI-115: an open session stream gets new lines once at the next check, and starts again if the file is replaced", async () => {
    const root = project();
    const home = makeTempFolder();
    const file = transcript(home, "p", "mine");
    await saveChange(root, 2, [{ id: "mine", path: file }]);
    const clock = manualClock();
    const gui = await start(root, { HOME: home }, clock);
    const stream = openStream(gui, "/api/sessions/mine/events");
    const texts = (name: string) =>
      stream.events
        .filter((item) => item.event === name)
        .map((item) => (item.data as { entries: { text: string }[] }).entries.map((entry) => entry.text));
    await vi.waitFor(() => {
      expect(texts("transcript")).toHaveLength(1);
    });
    const line = (text: string) => `${JSON.stringify({ type: "assistant", message: { content: text } })}\n`;
    appendFileSync(file, `${line("One")}${line("Two")}`);
    await clock.tick();
    await vi.waitFor(() => {
      expect(texts("entries")).toEqual([["One", "Two"]]);
    });
    // Replaced by a new file: the stream starts it again instead of reading on from the old place.
    const replacement = `${file}.new`;
    writeFileSync(replacement, `${line("Fresh")}${TRANSCRIPT}\n`);
    renameSync(replacement, file);
    await clock.tick();
    await vi.waitFor(() => {
      expect(texts("transcript")).toHaveLength(2);
    });
    expect(texts("transcript")[1]?.[0]).toBe("Fresh");
    stream.close();
  });

  it("TC-GUI-059: a session whose transcript was deleted says so, and the canvas still works", async () => {
    const root = project();
    const home = makeTempFolder();
    const file = transcript(home, "p", "gone");
    await saveChange(root, 2, [{ id: "gone", path: file }]);
    rmSync(file);
    const gui = await start(root, { HOME: home });
    expect((await canvasOf(gui)).canvas.tasks).toHaveLength(3);
    const reply = JSON.parse((await sendTo(gui, "GET", "/api/sessions/gone")).body) as {
      transcript: { status: string };
    };
    expect(reply.transcript.status).toBe("missing");
  });

  it("TC-GUI-060: nothing can be sent to a session", async () => {
    const root = project();
    const home = makeTempFolder();
    const file = transcript(home, "p", "mine");
    await saveChange(root, 2, [{ id: "mine", path: file }]);
    const gui = await start(root, { HOME: home });
    for (const method of ["POST", "PUT", "DELETE", "PATCH"])
      for (const route of ["/api/sessions/mine", "/api/sessions/mine/events", "/api/sessions/mine/input"])
        expect(
          (await sendTo(gui, method, route, method === "DELETE" ? undefined : { text: "hi" })).status,
          `${method} ${route}`,
        ).toBe(404);
    expect(readFileSync(file, "utf8")).toBe(`${TRANSCRIPT}\n`);
  });
});

describe("layout", () => {
  it("TC-GUI-099: a saved layout is served again after a restart, and the task database isn't touched", async () => {
    const root = project();
    const before = readFileSync(path.join(root, ".luseen/tasks.db"));
    const gui = await start(root);
    const layout = { version: 1, frames: { "roadmap-1": { x: 400, y: 60 } }, cards: { "task-2": { x: 30, y: 300 } } };
    expect((await sendTo(gui, "PUT", "/api/layout", layout)).status).toBe(200);
    await gui.stop();
    running.splice(running.indexOf(gui), 1);
    const again = await start(root);
    const served = (await canvasOf(again)).layout;
    expect(served.frames["roadmap-1"]).toEqual({ x: 400, y: 60 });
    expect(served.cards["task-2"]).toEqual({ x: 30, y: 300 });
    expect(served.cards["task-1"]).toBeDefined();
    expect(readFileSync(path.join(root, ".luseen/tasks.db")).equals(before)).toBe(true);
  });

  it("TC-GUI-099: a layout that isn't the saved shape is refused and nothing is written", async () => {
    const root = project();
    const gui = await start(root);
    for (const body of [
      { version: 2, frames: {}, cards: {} },
      { version: 1, frames: { "../x": { x: 1, y: 1 } }, cards: {} },
      { version: 1, frames: {}, cards: { "task-1": { x: 1e9, y: 0 } } },
    ])
      expect((await sendTo(gui, "PUT", "/api/layout", body)).status).toBe(400);
    expect(() => readFileSync(path.join(root, ".luseen/gui/layout.json"))).toThrow();
  });

  it("TC-GUI-099: layouts saved at the same moment all succeed, and the file holds one whole layout", async () => {
    const root = project();
    const gui = await start(root);
    const layouts = Array.from({ length: 20 }, (_, index) => ({
      version: 1,
      frames: { "roadmap-1": { x: index, y: 0 } },
      cards: {},
    }));
    const replies = await Promise.all(layouts.map((layout) => sendTo(gui, "PUT", "/api/layout", layout)));
    expect(replies.map((reply) => reply.status)).toEqual(layouts.map(() => 200));
    const saved = JSON.parse(readFileSync(path.join(root, ".luseen/gui/layout.json"), "utf8")) as Layout;
    expect(layouts.some((layout) => layout.frames["roadmap-1"].x === saved.frames["roadmap-1"]?.x)).toBe(true);
  });

  it("TC-GUI-101: Tidy up resets one frame's saved positions and keeps the others'", async () => {
    const root = project();
    const gui = await start(root);
    await sendTo(gui, "PUT", "/api/layout", {
      version: 1,
      frames: { "roadmap-1": { x: 900, y: 400 }, "roadmap-2": { x: 50, y: 700 } },
      cards: { "task-1": { x: 70, y: 600 }, "task-3": { x: 33, y: 44 } },
    });
    expect((await sendTo(gui, "POST", "/api/layout/tidy", { frame: "roadmap-1" })).status).toBe(200);
    const { layout } = await canvasOf(gui);
    expect(layout.frames["roadmap-2"]).toEqual({ x: 50, y: 700 });
    expect(layout.cards["task-3"]).toEqual({ x: 33, y: 44 });
    expect(layout.frames["roadmap-1"]).not.toEqual({ x: 900, y: 400 });
    expect(layout.cards["task-1"]).not.toEqual({ x: 70, y: 600 });
    expect((await sendTo(gui, "POST", "/api/layout/tidy", { frame: "../x" })).status).toBe(400);
    expect((await sendTo(gui, "POST", "/api/layout/tidy", { frame: "roadmap-99" })).status).toBe(404);
  });
});
