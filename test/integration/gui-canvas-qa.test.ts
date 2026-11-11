/** QA checks for stage C1 of the gui spec, beyond the implementer's tests. */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import type { CanvasView, Layout } from "../../src/core/canvas.js";
import { beginChange, linkSession, stateKey } from "../../src/core/workflow.js";
import { readOverview } from "../../src/cli/tasks-command.js";
import { makeTempFolder } from "../support/helpers.js";
import { openStream, sendTo, startTestGui, type TestGui } from "../support/gui.js";

const running: TestGui[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((gui) => gui.stop()));
});

function project(): string {
  const root = makeTempFolder();
  const store = openTaskStore(path.join(root, ".cclinic"), "create");
  if (store === undefined) throw new Error("No store");
  store.savePlan({
    roadmap: { title: "Payments", goal: "Card checkout" },
    milestones: [
      {
        title: "Cards",
        goal: "Pay by card",
        tasks: [
          { key: "a", title: "A", description: "first", spec: null, dependsOn: [] },
          { key: "b", title: "B", description: "", spec: "auth", dependsOn: ["a"] },
        ],
      },
      {
        title: "Refunds",
        goal: "Pay back",
        tasks: [{ key: "c", title: "C", description: "", spec: null, dependsOn: ["b"] }],
      },
    ],
  });
  store.addTask({ title: "Loose", dependsOn: [] });
  store.close();
  return root;
}

async function start(root: string): Promise<TestGui> {
  const gui = await startTestGui(root);
  running.push(gui);
  return gui;
}

describe("QA: canvas data", () => {
  it("TC-GUI-027: the canvas's roadmaps, milestones and tasks equal what cclinic tasks roadmap --json shows", async () => {
    const root = project();
    const gui = await start(root);
    const { canvas } = JSON.parse((await sendTo(gui, "GET", "/api/canvas")).body) as { canvas: CanvasView };
    const store = openTaskStore(path.join(root, ".cclinic"), "read");
    const overview = readOverview(store);
    store?.close();
    expect(
      canvas.roadmaps.map((roadmap) => ({
        id: roadmap.id,
        title: roadmap.title,
        goal: roadmap.goal,
        status: roadmap.status,
        milestones: roadmap.milestones.map((milestone) => [milestone.id, milestone.title, milestone.taskIds]),
      })),
    ).toEqual(
      overview.roadmaps.map((roadmap) => ({
        id: roadmap.id,
        title: roadmap.title,
        goal: roadmap.goal,
        status: roadmap.status,
        milestones: roadmap.milestones.map((milestone) => [
          milestone.id,
          milestone.title,
          milestone.tasks.map((task) => task.id),
        ]),
      })),
    );
    const fields = (task: {
      id: number;
      title: string;
      description: string | null;
      status: string;
      spec: string | null;
      milestoneId: number | null;
      dependsOn: readonly number[];
    }) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      spec: task.spec,
      milestoneId: task.milestoneId,
      dependsOn: task.dependsOn,
    });
    const listed = [...overview.roadmaps.flatMap((r) => r.milestones.flatMap((m) => m.tasks)), ...overview.unassigned];
    expect(canvas.tasks.map(fields)).toEqual(listed.map(fields));
    expect(canvas.unassigned).toEqual(overview.unassigned.map((task) => task.id));
  });
});

describe("QA: redaction on the canvas", () => {
  it("TC-GUI-016: a change's reason on the canvas is redacted", async () => {
    const root = project();
    const state = beginChange(
      { changeType: "feature", spec: "auth", taskId: 1 },
      { key: stateKey(1, "main"), approverMode: "user", now: new Date().toISOString() },
    );
    await openWorkflowStore(root).save({ ...state, reason: "blocked by sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123" });
    const gui = await start(root);
    expect((await sendTo(gui, "GET", "/api/canvas")).body).not.toContain("sk-ant-api03-abcdefghijklmnop");
  });
});

describe("QA: sessions on the canvas (run 2)", () => {
  it("TC-GUI-054: a task's sessions come newest first, a live agent first, and its step is the task's step", async () => {
    const root = project();
    const runId = "20261111-120000";
    const folder = path.join(root, ".cclinic/auto", runId);
    mkdirSync(path.join(folder, "sessions"), { recursive: true });
    const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    writeFileSync(
      path.join(folder, "run.json"),
      JSON.stringify({
        runId,
        roadmapId: 1,
        roadmapTitle: "Payments",
        runBranch: `cclinic/auto/${runId}/run`,
        startedAt: at(3_600_000),
        finishedAt: null,
        outcome: null,
        budgetUsd: 10,
        spentUsd: 1,
        developers: 1,
        tasks: [
          {
            taskId: 2,
            title: "B",
            dependsOn: [],
            status: "running",
            branch: null,
            rounds: { specReviews: 0, qaRuns: 0, implementationReviews: 0 },
            costUsd: 1,
            reason: null,
            requirementIds: [],
          },
        ],
        skippedInProgress: [],
      }),
    );
    const session = (sessionId: string, role: string, step: string, startedAgo: number, endedAgo: number | null) => ({
      sessionId,
      taskId: 2,
      role,
      step,
      cwd: root,
      transcriptPath: `/nowhere/${sessionId}.jsonl`,
      startedAt: at(startedAgo),
      endedAt: endedAgo === null ? null : at(endedAgo),
      exitCode: endedAgo === null ? null : 0,
    });
    const live = "aaaaaaaa-0000-4000-8000-000000000001";
    const ended = "aaaaaaaa-0000-4000-8000-000000000002";
    // The live developer started long before the QA session that ended a moment ago.
    writeFileSync(
      path.join(folder, "sessions", `${live}.json`),
      JSON.stringify(session(live, "developer", "implement", 3_000_000, null)),
    );
    writeFileSync(
      path.join(folder, "sessions", `${ended}.json`),
      JSON.stringify(session(ended, "qa", "qa-1", 200_000, 10_000)),
    );
    writeFileSync(path.join(root, ".cclinic/auto/.lock"), JSON.stringify({ pid: process.pid, runId }));
    const gui = await start(root);
    const { canvas } = JSON.parse((await sendTo(gui, "GET", "/api/canvas")).body) as { canvas: CanvasView };
    const task = canvas.tasks.find((item) => item.id === 2);
    expect(task?.sessions.map((item) => [item.id, item.isLive])).toEqual([
      [live, true],
      [ended, false],
    ]);
    expect(task?.step).toBe("implement");
    for (const item of task?.sessions ?? []) {
      expect(Date.parse(item.startedAt)).not.toBeNaN();
      expect(Date.parse(item.lastActivityAt)).not.toBeNaN();
    }
  });

  it("TC-GUI-057, TC-GUI-115: a transcript that shrank is sent again whole, as a transcript event", async () => {
    const root = project();
    const home = makeTempFolder();
    const file = path.join(home, ".claude/projects/p/mine.jsonl");
    mkdirSync(path.dirname(file), { recursive: true });
    const line = (text: string) => `${JSON.stringify({ type: "user", message: { content: text } })}\n`;
    writeFileSync(file, line("one") + line("two") + line("three"));
    const state = beginChange(
      { changeType: "feature", spec: "auth", taskId: 1 },
      { key: stateKey(1, "main"), approverMode: "user", now: new Date().toISOString() },
    );
    await openWorkflowStore(root).save(
      linkSession(state, { sessionId: "mine", transcriptPath: file }, new Date().toISOString()),
    );
    const checks = new Set<() => Promise<void>>();
    const gui = await startTestGui(
      root,
      {},
      {
        every: (_ms, run) => {
          checks.add(run);
          return () => checks.delete(run);
        },
      },
      { HOME: home },
    );
    running.push(gui);
    const stream = openStream(gui, "/api/sessions/mine/events");
    const texts = (name: string) =>
      stream.events
        .filter((item) => item.event === name)
        .map((item) => (item.data as { entries: { text: string }[] }).entries.map((entry) => entry.text));
    await vi.waitFor(() => {
      expect(texts("transcript")).toEqual([["one", "two", "three"]]);
    });
    writeFileSync(file, line("short"));
    await Promise.all([...checks].map((check) => check()));
    await vi.waitFor(() => {
      expect(texts("transcript")).toEqual([["one", "two", "three"], ["short"]]);
    });
    expect(texts("entries")).toEqual([]);
    stream.close();
  });
});

/** QA run 3: the four fixes from code review. */
function manualClock() {
  const checks = new Set<() => Promise<void>>();
  return {
    every: (_ms: number, run: () => Promise<void>) => {
      checks.add(run);
      return () => checks.delete(run);
    },
    tick: async () => {
      await Promise.all([...checks].map((check) => check()));
    },
  };
}

const layoutOf = (root: string) =>
  JSON.parse(readFileSync(path.join(root, ".cclinic/gui/layout.json"), "utf8")) as Layout;

async function canvasOf(gui: TestGui): Promise<{ canvas: CanvasView; layout: Layout }> {
  return JSON.parse((await sendTo(gui, "GET", "/api/canvas")).body) as { canvas: CanvasView; layout: Layout };
}

async function saveBranchChange(root: string, branch: string, status: "open" | "stopped" | "done", at: number) {
  const state = beginChange(
    { changeType: "feature", spec: "auth" },
    { key: stateKey(null, branch), approverMode: "user", now: new Date(at).toISOString() },
  );
  await openWorkflowStore(root).save(
    status === "done" ? { ...state, step: "done", status, isCommitted: true } : { ...state, status },
  );
}

describe("QA run 3: saved positions survive an incomplete read (FR-GUI-075)", () => {
  it("TC-GUI-031: Tidy up while tasks.db can't be read keeps every task's saved position, and pruning resumes once it's readable", async () => {
    const root = project();
    await saveBranchChange(root, "fix-x", "open", Date.parse("2026-11-11T10:00:00.000Z"));
    const gui = await start(root);
    const saved: Layout = {
      version: 1,
      frames: { "roadmap-1": { x: 5, y: 5 }, changes: { x: 900, y: 0 } },
      cards: { "task-1": { x: 1, y: 1 }, "task-4": { x: 4, y: 4 }, "change-branch-fix-x": { x: 7, y: 7 } },
    };
    expect((await sendTo(gui, "PUT", "/api/layout", saved)).status).toBe(200);
    const database = path.join(root, ".cclinic/tasks.db");
    const bytes = readFileSync(database);
    writeFileSync(database, "not a database");
    // Its roadmap frame isn't on the canvas while the database can't be read.
    expect((await sendTo(gui, "POST", "/api/layout/tidy", { frame: "roadmap-1" })).status).toBe(404);
    expect(layoutOf(root)).toEqual(saved);
    const tidy = await sendTo(gui, "POST", "/api/layout/tidy", { frame: "changes" });
    expect(tidy.status).toBe(200);
    expect(layoutOf(root)).toEqual({
      version: 1,
      frames: { "roadmap-1": { x: 5, y: 5 } },
      cards: { "task-1": { x: 1, y: 1 }, "task-4": { x: 4, y: 4 } },
    });
    // Readable again, with task 4 removed: its position goes with the next save, the others stay.
    writeFileSync(database, bytes);
    const store = openTaskStore(path.join(root, ".cclinic"), "update");
    store?.removeTask(4);
    store?.close();
    expect((await sendTo(gui, "PUT", "/api/layout", saved)).status).toBe(200);
    expect(layoutOf(root)).toEqual({
      ...saved,
      cards: { "task-1": { x: 1, y: 1 }, "change-branch-fix-x": { x: 7, y: 7 } },
    });
  });

  it("TC-GUI-031: a damaged workflow state keeps its change's saved position; once fixed and then removed, the position goes", async () => {
    const root = project();
    await saveBranchChange(root, "fix-x", "open", Date.parse("2026-11-11T10:00:00.000Z"));
    const gui = await start(root);
    const saved: Layout = {
      version: 1,
      frames: { changes: { x: 900, y: 0 } },
      cards: { "task-1": { x: 1, y: 1 }, "change-branch-fix-x": { x: 7, y: 7 } },
    };
    await sendTo(gui, "PUT", "/api/layout", saved);
    const file = path.join(root, ".cclinic/workflow/branch-fix-x.json");
    const text = readFileSync(file, "utf8");
    writeFileSync(file, "{broken");
    const during = await canvasOf(gui);
    expect(during.canvas.problems).toHaveLength(1);
    expect(during.canvas.changes).toEqual([]);
    expect((await sendTo(gui, "PUT", "/api/layout", saved)).status).toBe(200);
    expect(layoutOf(root)).toEqual(saved);
    writeFileSync(file, text);
    expect((await canvasOf(gui)).canvas.changes.map((change) => change.key)).toEqual(["branch-fix-x"]);
    rmSync(file);
    expect((await sendTo(gui, "PUT", "/api/layout", saved)).status).toBe(200);
    expect(layoutOf(root)).toEqual({ version: 1, frames: {}, cards: { "task-1": { x: 1, y: 1 } } });
  });
});

function runState(runId: string, finishedAt: string | null, costUsd: number) {
  return {
    runId,
    roadmapId: 1,
    roadmapTitle: "Payments",
    runBranch: `cclinic/auto/${runId}/run`,
    startedAt: "2026-11-11T10:00:00.000Z",
    finishedAt,
    outcome: finishedAt === null ? null : "done",
    budgetUsd: 10,
    spentUsd: costUsd,
    developers: 1,
    tasks: [
      {
        taskId: 1,
        title: "A",
        dependsOn: [],
        status: finishedAt === null ? "running" : "done",
        branch: null,
        rounds: { specReviews: 0, qaRuns: 0, implementationReviews: 0 },
        costUsd,
        reason: null,
        requirementIds: [],
      },
    ],
    skippedInProgress: [],
  };
}

const agentId = (index: number) => `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, "0")}`;

function agentSession(index: number, ended: boolean) {
  return {
    sessionId: agentId(index),
    taskId: 1,
    role: "developer",
    step: "implement-1",
    cwd: "/w",
    transcriptPath: "/nowhere/x.jsonl",
    startedAt: "2026-11-11T10:00:00.000Z",
    endedAt: ended ? "2026-11-11T10:05:00.000Z" : null,
    exitCode: ended ? 0 : null,
  };
}

function writeRunFiles(root: string, runId: string, state: string, sessions: Record<string, string> = {}) {
  const folder = path.join(root, ".cclinic/auto", runId);
  mkdirSync(path.join(folder, "sessions"), { recursive: true });
  writeFileSync(path.join(folder, "run.json"), state);
  for (const [name, text] of Object.entries(sessions)) writeFileSync(path.join(folder, "sessions", name), text);
}

describe("QA run 3: every run is read, and finished ones are kept (FR-GUI-068, FR-GUI-077)", () => {
  it("TC-GUI-054: a damaged run that's later fixed shows with its sessions and cost, and its problem goes", async () => {
    const root = project();
    const runId = "20261101-090000";
    writeRunFiles(root, runId, "{broken");
    const gui = await start(root);
    const before = (await canvasOf(gui)).canvas;
    expect(before.problems).toEqual([`The state of automated run ${runId} isn't readable.`]);
    expect(before.tasks.find((task) => task.id === 1)?.costUsd).toBe(0);
    writeRunFiles(root, runId, JSON.stringify(runState(runId, "2026-11-01T10:00:00.000Z", 0.75)), {
      [`${agentId(1)}.json`]: JSON.stringify(agentSession(1, true)),
    });
    const after = (await canvasOf(gui)).canvas;
    expect(after.problems).toEqual([]);
    const task = after.tasks.find((item) => item.id === 1);
    expect(task?.costUsd).toBeCloseTo(0.75);
    expect(task?.sessions.map((session) => session.id)).toEqual([agentId(1)]);
  });

  it("TC-GUI-054: a damaged session file of a finished run is read again, and shows once it's fixed", async () => {
    const root = project();
    const runId = "20261101-090000";
    const name = `${agentId(2)}.json`;
    writeRunFiles(root, runId, JSON.stringify(runState(runId, "2026-11-01T10:00:00.000Z", 0.5)), {
      [`${agentId(1)}.json`]: JSON.stringify(agentSession(1, true)),
      [name]: "{broken",
    });
    const gui = await start(root);
    const before = (await canvasOf(gui)).canvas;
    expect(before.problems).toHaveLength(1);
    expect(before.tasks.find((task) => task.id === 1)?.sessions.map((session) => session.id)).toEqual([agentId(1)]);
    writeFileSync(path.join(root, ".cclinic/auto", runId, "sessions", name), JSON.stringify(agentSession(2, true)));
    const after = (await canvasOf(gui)).canvas;
    expect(after.problems).toEqual([]);
    expect(new Set(after.tasks.find((task) => task.id === 1)?.sessions.map((session) => session.id))).toEqual(
      new Set([agentId(1), agentId(2)]),
    );
  });

  it("TC-GUI-102, TC-GUI-103: a live run that finishes shows as finished at the next check, with its ended agent and final cost", async () => {
    const root = project();
    const runId = "20261111-100000";
    const lock = path.join(root, ".cclinic/auto/.lock");
    writeRunFiles(root, runId, JSON.stringify(runState(runId, null, 0.2)), {
      [`${agentId(1)}.json`]: JSON.stringify(agentSession(1, false)),
    });
    writeFileSync(lock, JSON.stringify({ pid: process.pid, runId }));
    const clock = manualClock();
    const gui = await startTestGui(root, {}, { every: clock.every });
    running.push(gui);
    const stream = openStream(gui, "/api/canvas/events");
    const canvases = () =>
      stream.events
        .filter((item) => item.event === "canvas")
        .map((item) => (item.data as { canvas: CanvasView }).canvas);
    await vi.waitFor(() => {
      expect(canvases()).toHaveLength(1);
    });
    const live = canvases()[0];
    expect(live?.roadmaps[0]).toMatchObject({ mode: "ai", runId });
    expect(live?.tasks.find((task) => task.id === 1)?.sessions.map((session) => session.isLive)).toEqual([true]);
    // The run saves its finished state while it still holds the lock, then lets go.
    writeRunFiles(root, runId, JSON.stringify(runState(runId, "2026-11-11T11:00:00.000Z", 0.9)), {
      [`${agentId(1)}.json`]: JSON.stringify(agentSession(1, true)),
    });
    await clock.tick();
    rmSync(lock);
    await clock.tick();
    // Events arrive over HTTP after the check, so wait for the one without the run.
    await vi.waitFor(() => {
      expect(canvases().at(-1)?.roadmaps[0]?.mode).toBeNull();
    });
    const finished = canvases().at(-1);
    expect(finished?.roadmaps[0]).toMatchObject({ mode: null, runId: null });
    const task = finished?.tasks.find((item) => item.id === 1);
    expect(task?.mode).toBeNull();
    expect(task?.costUsd).toBeCloseTo(0.9);
    expect(task?.sessions.map((session) => session.isLive)).toEqual([false]);
    // Kept now: checks with nothing new send nothing, which a change made after them proves.
    const count = canvases().length;
    await clock.tick();
    await clock.tick();
    const store = openTaskStore(path.join(root, ".cclinic"), "update");
    store?.addTask({ title: "Later", dependsOn: [] });
    store?.close();
    await clock.tick();
    await vi.waitFor(() => {
      expect(
        canvases()
          .at(-1)
          ?.tasks.some((item) => item.title === "Later"),
      ).toBe(true);
    });
    expect(canvases()).toHaveLength(count + 1);
    expect(
      canvases()
        .at(-1)
        ?.tasks.find((item) => item.id === 1)?.costUsd,
    ).toBeCloseTo(0.9);
    stream.close();
  });

  it("TC-GUI-054: a run that ended without finishing is read again each time, so a later fix to it shows", async () => {
    const root = project();
    const runId = "20261101-090000";
    writeRunFiles(root, runId, JSON.stringify(runState(runId, null, 0.1)));
    const gui = await start(root);
    expect((await canvasOf(gui)).canvas.tasks.find((task) => task.id === 1)?.costUsd).toBeCloseTo(0.1);
    writeRunFiles(root, runId, JSON.stringify(runState(runId, "2026-11-01T10:00:00.000Z", 0.4)));
    expect((await canvasOf(gui)).canvas.tasks.find((task) => task.id === 1)?.costUsd).toBeCloseTo(0.4);
  });
});

describe("QA run 3: every branch-keyed change is listed (FR-GUI-037)", () => {
  it("TC-GUI-051: open and stopped changes come first, newest first, then done ones, newest first; task changes aren't listed", async () => {
    const root = project();
    const at = (minute: number) => Date.parse(`2026-11-11T10:${String(minute).padStart(2, "0")}:00.000Z`);
    await saveBranchChange(root, "done-old", "done", at(1));
    await saveBranchChange(root, "open-old", "open", at(2));
    await saveBranchChange(root, "stopped-mid", "stopped", at(3));
    await saveBranchChange(root, "open-new", "open", at(4));
    await saveBranchChange(root, "done-new", "done", at(5));
    const task = beginChange(
      { changeType: "feature", spec: "auth", taskId: 1 },
      { key: stateKey(1, "main"), approverMode: "user", now: new Date(at(6)).toISOString() },
    );
    await openWorkflowStore(root).save(task);
    const gui = await start(root);
    const { canvas, layout } = await canvasOf(gui);
    expect(canvas.changes.map((change) => [change.key, change.status])).toEqual([
      ["branch-open-new", "open"],
      ["branch-stopped-mid", "stopped"],
      ["branch-open-old", "open"],
      ["branch-done-new", "done"],
      ["branch-done-old", "done"],
    ]);
    // Each one gets a card in the Changes frame.
    for (const change of canvas.changes) expect(layout.cards).toHaveProperty(`change-${change.key}`);
  });
});

describe("QA run 3: a transcript that can't be read is a problem, not missing (FR-GUI-041, FR-GUI-042)", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "TC-GUI-056: a projects folder that can't be read sends a problem event, not missing",
    async () => {
      const root = project();
      const home = makeTempFolder();
      const projects = path.join(home, ".claude/projects");
      const locked = path.join(projects, "locked");
      mkdirSync(locked, { recursive: true });
      const state = beginChange(
        { changeType: "feature", spec: "auth", taskId: 1 },
        { key: stateKey(1, "main"), approverMode: "user", now: new Date().toISOString() },
      );
      // The recorded file isn't there, so the session's file is looked for in every project folder.
      await openWorkflowStore(root).save(
        linkSession(
          state,
          { sessionId: "mine", transcriptPath: path.join(projects, "gone/mine.jsonl") },
          new Date().toISOString(),
        ),
      );
      chmodSync(locked, 0o000);
      try {
        const clock = manualClock();
        const gui = await startTestGui(root, {}, { every: clock.every }, { HOME: home });
        running.push(gui);
        const stream = openStream(gui, "/api/sessions/mine/events");
        await vi.waitFor(() => {
          expect(stream.events.map((item) => item.event)).toEqual(["problem"]);
        });
        expect(JSON.stringify(stream.events)).toContain("EACCES");
        // Said once while it lasts; once readable, the transcript found there is sent.
        await clock.tick();
        await clock.tick();
        chmodSync(locked, 0o700);
        writeFileSync(
          path.join(locked, "mine.jsonl"),
          `${JSON.stringify({ type: "user", message: { content: "hello" } })}\n`,
        );
        await clock.tick();
        await vi.waitFor(() => {
          expect(stream.events.map((item) => item.event)).toEqual(["problem", "transcript"]);
        });
        stream.close();
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );
});
