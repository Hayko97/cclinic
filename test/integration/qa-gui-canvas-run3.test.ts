/** QA run 3 for stage C1 of the gui spec: restarts, the run limit, concurrent layout saves and quiet streams. */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import type { AgentSession, RunState } from "../../src/core/automation.js";
import type { CanvasView, Layout } from "../../src/core/canvas.js";
import { TRANSCRIPT_MAX_READ_BYTES } from "../../src/core/constants/gui.js";
import { beginChange, linkSession, stateKey } from "../../src/core/workflow.js";
import { makeTempFolder } from "../support/helpers.js";
import { openStream, sendTo, startTestGui, type TestGui } from "../support/gui.js";

const running: TestGui[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((gui) => gui.stop()));
});

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

async function start(root: string, environment: NodeJS.ProcessEnv = {}, clock = manualClock()): Promise<TestGui> {
  const gui = await startTestGui(root, {}, { every: clock.every }, environment);
  running.push(gui);
  return gui;
}

/** Roadmap 1 with tasks 1 and 2, and roadmap 2 with task 3. */
function project(): string {
  const root = makeTempFolder();
  const store = openTaskStore(path.join(root, ".cclinic"), "create");
  if (store === undefined) throw new Error("No store");
  const task = (key: string) => ({ key, title: `Task ${key}`, description: "", spec: null, dependsOn: [] });
  store.savePlan({
    roadmap: { title: "One", goal: "" },
    milestones: [{ title: "M", goal: "", tasks: [task("a"), task("b")] }],
  });
  store.savePlan({ roadmap: { title: "Two", goal: "" }, milestones: [{ title: "N", goal: "", tasks: [task("c")] }] });
  store.close();
  return root;
}

const uuid = (index: number) => `7c1e0000-0000-4000-8000-${String(index).padStart(12, "0")}`;

function runState(runId: string): RunState {
  return {
    runId,
    roadmapId: 1,
    roadmapTitle: "One",
    runBranch: `cclinic/auto/${runId}/run`,
    startedAt: "2026-11-11T10:00:00.000Z",
    finishedAt: null,
    outcome: null,
    budgetUsd: 10,
    spentUsd: 1,
    developers: 1,
    tasks: [
      {
        taskId: 1,
        title: "Task a",
        dependsOn: [],
        status: "running",
        branch: null,
        rounds: { specReviews: 0, qaRuns: 0, implementationReviews: 0 },
        costUsd: 0.5,
        reason: null,
        requirementIds: [],
      },
    ],
    skippedInProgress: [],
  };
}

function agent(index: number, transcriptPath: string, ended: boolean): AgentSession {
  return {
    sessionId: uuid(index),
    taskId: 1,
    role: "developer",
    step: "implement-1",
    cwd: "/w",
    transcriptPath,
    startedAt: "2026-11-11T10:00:00.000Z",
    endedAt: ended ? "2026-11-11T10:05:00.000Z" : null,
    exitCode: ended ? 0 : null,
    costUsd: null,
  };
}

function writeRun(root: string, runId: string, sessions: AgentSession[], text?: string) {
  const folder = path.join(root, ".cclinic/auto", runId);
  mkdirSync(path.join(folder, "sessions"), { recursive: true });
  writeFileSync(path.join(folder, "run.json"), text ?? JSON.stringify(runState(runId)));
  for (const session of sessions)
    writeFileSync(path.join(folder, "sessions", `${session.sessionId}.json`), JSON.stringify(session));
}

function liveLock(root: string, runId: string) {
  writeFileSync(path.join(root, ".cclinic/auto/.lock"), JSON.stringify({ pid: process.pid, runId }));
}

const userLine = (text: string) => `${JSON.stringify({ type: "user", message: { content: text } })}\n`;
const layoutFile = (root: string) => path.join(root, ".cclinic/gui/layout.json");

async function canvasOf(gui: TestGui): Promise<{ canvas: CanvasView; layout: Layout }> {
  return JSON.parse((await sendTo(gui, "GET", "/api/canvas")).body) as { canvas: CanvasView; layout: Layout };
}

interface TranscriptEvent {
  readonly entries: { readonly text: string }[];
  readonly isTruncated: boolean;
}

describe("QA run 3: canvas server", () => {
  it("TC-GUI-115: a transcript that grows by more than the read limit between checks restarts from its newest part", async () => {
    const root = project();
    const home = makeTempFolder();
    const file = path.join(home, ".claude/projects/w", `${uuid(1)}.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, userLine("OLD-1") + userLine("OLD-2"));
    writeRun(root, "20261111-100000", [agent(1, file, false)]);
    liveLock(root, "20261111-100000");
    const clock = manualClock();
    const gui = await start(root, { HOME: home }, clock);
    const stream = openStream(gui, `/api/sessions/${uuid(1)}/events`);
    await vi.waitFor(() => {
      expect(stream.events).toHaveLength(1);
    });
    expect((stream.events[0]?.data as TranscriptEvent).entries.map((entry) => entry.text)).toEqual(["OLD-1", "OLD-2"]);
    const filler = userLine("F".repeat(1_000));
    appendFileSync(file, filler.repeat(Math.ceil((TRANSCRIPT_MAX_READ_BYTES + 1_048_576) / filler.length)));
    appendFileSync(file, userLine("NEWEST"));
    await clock.tick();
    await vi.waitFor(() => {
      expect(stream.events).toHaveLength(2);
    });
    const restart = stream.events[1];
    expect(restart?.event).toBe("transcript");
    const data = restart?.data as TranscriptEvent;
    expect(data.isTruncated).toBe(true);
    expect(data.entries.at(-1)?.text).toBe("NEWEST");
    expect(data.entries.some((entry) => entry.text.startsWith("OLD"))).toBe(false);
    appendFileSync(file, userLine("AFTER"));
    await clock.tick();
    await vi.waitFor(() => {
      expect(stream.events).toHaveLength(3);
    });
    expect(stream.events[2]?.event).toBe("entries");
    expect((stream.events[2]?.data as TranscriptEvent).entries.map((entry) => entry.text)).toEqual(["AFTER"]);
    stream.close();
  });

  it("TC-GUI-031: with a live agent and a live interactive session, checks with no change send nothing", async () => {
    const root = project();
    writeRun(root, "20261111-100000", [agent(1, "/nowhere/a.jsonl", false), agent(2, "/nowhere/b.jsonl", true)]);
    liveLock(root, "20261111-100000");
    const now = new Date().toISOString();
    const state = linkSession(
      beginChange(
        { changeType: "feature", spec: "auth", taskId: 3 },
        { key: stateKey(3, "main"), approverMode: "user", now },
      ),
      { sessionId: "mine", transcriptPath: "/nowhere/m.jsonl" },
      now,
    );
    await openWorkflowStore(root).save(state);
    const clock = manualClock();
    const gui = await start(root, {}, clock);
    const stream = openStream(gui, "/api/canvas/events");
    await vi.waitFor(() => {
      expect(stream.events).toHaveLength(1);
    });
    const first = stream.events[0]?.data as { canvas: CanvasView };
    expect(first.canvas.tasks.find((task) => task.id === 1)?.sessions.map((session) => session.id)).toEqual([
      uuid(1),
      uuid(2),
    ]);
    expect(first.canvas.tasks.find((task) => task.id === 3)?.sessions[0]?.isLive).toBe(true);
    for (let check = 0; check < 5; check += 1) await clock.tick();
    expect(stream.events.map((item) => item.event)).toEqual(["canvas"]);
    writeRun(root, "20261111-100000", [agent(3, "/nowhere/c.jsonl", false)]);
    await clock.tick();
    await vi.waitFor(() => {
      expect(stream.events).toHaveLength(2);
    });
    stream.close();
  });

  it("TC-GUI-054: every run is read for a task's sessions and cost, a removed run goes, and a damaged run is a problem", async () => {
    const root = project();
    const ids = Array.from({ length: 25 }, (_, index) => `20261111-1000${String(index).padStart(2, "0")}`);
    // Three more in the newest second: `-10` is newer than `-9`, which a text sort would get wrong.
    ids.push("20261111-100024-2", "20261111-100024-9", "20261111-100024-10");
    const live = "20261111-100000";
    ids.forEach((id, index) => {
      const finished = { ...runState(id), finishedAt: id === live ? null : "2026-11-11T11:00:00.000Z" };
      writeRun(root, id, [agent(index + 1, "/nowhere/x.jsonl", true)], JSON.stringify(finished));
    });
    writeRun(root, "20261111-100023", [], "{broken");
    liveLock(root, live);
    const gui = await start(root);
    const readable = ids.filter((id) => id !== "20261111-100023");
    const first = (await canvasOf(gui)).canvas;
    const task = first.tasks.find((item) => item.id === 1);
    expect(new Set(task?.sessions.map((session) => session.runId))).toEqual(new Set(readable));
    expect(task?.costUsd).toBeCloseTo(0.5 * readable.length);
    expect(first.problems).toEqual(["The state of automated run 20261111-100023 isn't readable."]);
    expect(first.roadmaps[0]).toMatchObject({ mode: "ai", runId: live });
    // A finished run read before is still dropped once its folder is removed.
    rmSync(path.join(root, ".cclinic/auto", "20261111-100005"), { recursive: true });
    const after = (await canvasOf(gui)).canvas.tasks.find((item) => item.id === 1);
    expect(after?.sessions.map((session) => session.runId)).not.toContain("20261111-100005");
    expect(after?.costUsd).toBeCloseTo(0.5 * (readable.length - 1));
  });

  it("TC-GUI-099, TC-GUI-101: layout saves and Tidy up at the same moment all succeed, and leave one whole layout", async () => {
    const root = project();
    const gui = await start(root);
    const layouts = Array.from({ length: 30 }, (_, index) => ({
      version: 1,
      frames: { "roadmap-1": { x: index, y: index }, "roadmap-2": { x: 2_000 + index, y: 0 } },
      cards: { "task-1": { x: index, y: 1 }, "task-3": { x: index, y: 3 } },
    }));
    const replies = await Promise.all([
      ...layouts.map((layout) => sendTo(gui, "PUT", "/api/layout", layout)),
      sendTo(gui, "POST", "/api/layout/tidy", { frame: "roadmap-2" }),
      sendTo(gui, "POST", "/api/layout/tidy", { frame: "roadmap-1" }),
    ]);
    expect(replies.map((reply) => reply.status)).toEqual(replies.map(() => 200));
    expect((JSON.parse(readFileSync(layoutFile(root), "utf8")) as Layout).version).toBe(1);
    expect(readdirSync(path.dirname(layoutFile(root))).sort()).toEqual([".gitignore", "gui.lock", "layout.json"]);
    await sendTo(gui, "PUT", "/api/layout", layouts[7]);
    await sendTo(gui, "POST", "/api/layout/tidy", { frame: "roadmap-2" });
    expect(JSON.parse(readFileSync(layoutFile(root), "utf8"))).toEqual({
      version: 1,
      frames: { "roadmap-1": { x: 7, y: 7 } },
      cards: { "task-1": { x: 7, y: 1 } },
    });
  });

  it("TC-GUI-101: Tidy up on Unassigned or Changes when the canvas has no such frame is 404, and writes nothing", async () => {
    const root = project();
    const gui = await start(root);
    for (const frame of ["unassigned", "changes", "roadmap-3"])
      expect([frame, (await sendTo(gui, "POST", "/api/layout/tidy", { frame })).status]).toEqual([frame, 404]);
    expect(existsSync(layoutFile(root))).toBe(false);
  });
});
