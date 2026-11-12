import { describe, expect, it } from "vitest";
import type { AgentSession, RunState } from "./automation.js";
import {
  buildCanvas,
  cardOrder,
  frameWidths,
  nextStep,
  parseTranscriptLine,
  resolveLayout,
  tidyFrame,
  type CanvasSources,
} from "./canvas.js";
import { LAYOUT } from "./constants/gui.js";
import type { Roadmap, Task } from "./tasks.js";
import { beginChange, linkSession, stateKey, type WorkflowState } from "./workflow.js";

const NOW = new Date("2026-11-11T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function task(id: number, milestoneId: number | null, change: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    description: null,
    status: "open",
    milestoneId,
    spec: null,
    dependsOn: [],
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(60),
    ...change,
  };
}

function roadmap(id: number, milestones: { id: number; tasks: Task[] }[]): Roadmap {
  return {
    id,
    title: `Roadmap ${id}`,
    goal: null,
    createdAt: minutesAgo(60),
    status: "in-progress",
    milestones: milestones.map((milestone, position) => ({
      id: milestone.id,
      roadmapId: id,
      title: `M${milestone.id}`,
      goal: null,
      position,
      createdAt: minutesAgo(60),
      tasks: milestone.tasks,
    })),
  };
}

function run(roadmapId: number, taskIds: number[], sessions: AgentSession[], isLive = true) {
  const state: RunState = {
    runId: "20261111-110000",
    roadmapId,
    roadmapTitle: `Roadmap ${roadmapId}`,
    runBranch: "cclinic/auto/20261111-110000/run",
    startedAt: minutesAgo(30),
    finishedAt: null,
    outcome: null,
    budgetUsd: 10,
    spentUsd: 3.4,
    developers: 2,
    tasks: taskIds.map((taskId) => ({
      taskId,
      title: `Task ${taskId}`,
      dependsOn: [],
      status: "running",
      branch: null,
      rounds: { specReviews: 0, qaRuns: 0, implementationReviews: 0 },
      costUsd: 1.3,
      reason: null,
      requirementIds: [],
    })),
    skippedInProgress: [],
  };
  return { state, sessions, isLive, pid: isLive ? 4242 : null };
}

function agent(taskId: number, role: AgentSession["role"], step: string, started: number, ended: number | null) {
  return {
    sessionId: `${role}-${step}`,
    taskId,
    role,
    step,
    cwd: "/w",
    transcriptPath: `/home/.claude/projects/w/${role}-${step}.jsonl`,
    startedAt: minutesAgo(started),
    endedAt: ended === null ? null : minutesAgo(ended),
    exitCode: ended === null ? null : 0,
    costUsd: null,
  };
}

function change(taskId: number | null, branch = "main"): WorkflowState {
  return beginChange(
    { changeType: "feature", spec: "refunds", ...(taskId === null ? {} : { taskId }) },
    { key: stateKey(taskId, branch), approverMode: "user", now: minutesAgo(20) },
  );
}

const sources = (change: Partial<CanvasSources>): CanvasSources => ({
  overview: { roadmaps: [], unassigned: [] },
  runs: [],
  workflows: [],
  problems: [],
  ...change,
});

describe("next step and card order", () => {
  const withRoadmap = (tasks: Task[]) =>
    buildCanvas(sources({ overview: { roadmaps: [roadmap(1, [{ id: 1, tasks }])], unassigned: [] } }), NOW);

  it("TC-GUI-073: suggests Generate, Plan a roadmap, Run with AI, then Open its roadmap, in that order", () => {
    expect(nextStep(buildCanvas(sources({}), NOW), false)).toEqual({ kind: "generate" });
    expect(nextStep(buildCanvas(sources({}), NOW), true)).toEqual({ kind: "plan" });
    expect(nextStep(withRoadmap([task(1, 1), task(2, 1, { status: "done" })]), true)).toEqual({
      kind: "run",
      roadmapId: 1,
    });
    const running = buildCanvas(
      sources({
        overview: { roadmaps: [roadmap(1, [{ id: 1, tasks: [task(1, 1)] }])], unassigned: [] },
        runs: [run(1, [1], [])],
      }),
      NOW,
    );
    expect(nextStep(running, true)).toEqual({ kind: "open-run", roadmapId: 1, runId: "20261111-110000" });
  });

  it("TC-GUI-073: suggests nothing once every roadmap is done and no run is going", () => {
    expect(nextStep(withRoadmap([task(1, 1, { status: "done" })]), true)).toBeNull();
  });

  it("TC-GUI-106: cards are ordered frame by frame, column by column, each task after the ones it depends on", () => {
    const view = buildCanvas(
      sources({
        overview: {
          roadmaps: [
            roadmap(1, [
              { id: 1, tasks: [task(3, 1, { dependsOn: [2] }), task(2, 1)] },
              { id: 2, tasks: [task(4, 2)] },
            ]),
          ],
          unassigned: [task(5, null)],
        },
      }),
      NOW,
    );
    expect(cardOrder(view)).toEqual(["task-2", "task-3", "task-4", "task-5"]);
  });
});

describe("canvas model", () => {
  it("TC-GUI-102: a roadmap in a live run and a task worked on by hand each show their own mode", () => {
    const view = buildCanvas(
      sources({
        overview: {
          roadmaps: [
            roadmap(1, [{ id: 1, tasks: [task(6, 1, { status: "in-progress" }), task(7, 1)] }]),
            roadmap(2, [{ id: 2, tasks: [task(12, 2)] }]),
          ],
          unassigned: [],
        },
        runs: [run(1, [6], [agent(6, "qa", "qa-2", 5, null)])],
        workflows: [{ ...change(12), step: "implement" }],
      }),
      NOW,
    );
    expect(view.roadmaps[0]).toMatchObject({
      mode: "ai",
      runId: "20261111-110000",
      spentUsd: 3.4,
      budgetUsd: 10,
      done: 0,
      total: 2,
    });
    expect(view.roadmaps[1]).toMatchObject({ mode: null, runId: null });
    const byId = new Map(view.tasks.map((item) => [item.id, item]));
    expect(byId.get(6)).toMatchObject({ mode: "ai", runId: "20261111-110000", step: "qa-2" });
    expect(byId.get(7)).toMatchObject({ mode: null });
    expect(byId.get(12)).toMatchObject({ mode: "manual", step: "implement" });
  });

  it("TC-GUI-102: a task in a live run shows the step of its live agent, listed first, not one that has ended", () => {
    const view = buildCanvas(
      sources({
        overview: {
          roadmaps: [roadmap(1, [{ id: 1, tasks: [task(1, 1, { status: "in-progress" })] }])],
          unassigned: [],
        },
        runs: [run(1, [1], [agent(1, "developer", "implement-1", 10, 5), agent(1, "qa", "qa-1", 10, null)])],
      }),
      NOW,
    );
    expect(view.tasks[0]?.step).toBe("qa-1");
    expect(view.tasks[0]?.sessions.map((session) => session.step)).toEqual(["qa-1", "implement-1"]);
  });

  it("TC-GUI-103: agents working now and before, from run sessions and interactive sessions", () => {
    let state = change(6);
    state = linkSession(state, { sessionId: "recent", transcriptPath: "/t/recent.jsonl" }, minutesAgo(2));
    state = linkSession(state, { sessionId: "older", transcriptPath: "/t/older.jsonl" }, minutesAgo(9));
    const view = buildCanvas(
      sources({
        overview: { roadmaps: [roadmap(1, [{ id: 1, tasks: [task(6, 1)] }])], unassigned: [] },
        runs: [run(1, [6], [agent(6, "qa", "qa-1", 3, null), agent(6, "developer", "implement-1", 20, 10)])],
        workflows: [state],
      }),
      NOW,
    );
    const sessions = view.tasks[0]?.sessions ?? [];
    expect(sessions.filter((item) => item.isLive).map((item) => [item.role, item.id])).toEqual([
      ["you", "recent"],
      ["qa", "qa-qa-1"],
    ]);
    expect(sessions.filter((item) => !item.isLive).map((item) => [item.role, item.step, item.lastActivityAt])).toEqual([
      ["you", "spec", minutesAgo(9)],
      ["developer", "implement-1", minutesAgo(10)],
    ]);
  });

  it("TC-GUI-054: a task's sessions are listed newest first, with source, start, last activity and live status", () => {
    const state = linkSession(change(2), { sessionId: "mine", transcriptPath: "/t/mine.jsonl" }, minutesAgo(1));
    const view = buildCanvas(
      sources({
        overview: { roadmaps: [roadmap(1, [{ id: 1, tasks: [task(2, 1, { spec: "auth" })] }])], unassigned: [] },
        runs: [run(1, [], [agent(2, "developer", "spec-1", 40, 30), agent(2, "pm", "spec-review-1", 29, 25)], false)],
        workflows: [state],
      }),
      NOW,
    );
    expect(view.tasks[0]?.sessions.map((item) => [item.id, item.source, item.isLive])).toEqual([
      ["mine", "interactive", true],
      ["pm-spec-review-1", "agent", false],
      ["developer-spec-1", "agent", false],
    ]);
    expect(view.tasks[0]?.sessions[1]).toMatchObject({ startedAt: minutesAgo(29), lastActivityAt: minutesAgo(25) });
  });

  it("TC-GUI-051: a task's change shows on its card, and a change keyed by branch gets its own card", () => {
    const pending = {
      ...change(2),
      pending: {
        kind: "gate" as const,
        gate: "G1" as const,
        step: null,
        reason: null,
        question: "Approve?",
        answers: ["approve"],
        answer: null,
        notes: null,
      },
    };
    const view = buildCanvas(
      sources({
        overview: { roadmaps: [], unassigned: [task(2, null), task(3, null, { dependsOn: [2] })] },
        workflows: [pending, change(null, "fix-x")],
      }),
      NOW,
    );
    expect(view.tasks[0]).toMatchObject({
      needsYou: true,
      change: {
        spec: "refunds",
        step: "spec",
        status: "open",
        qaRuns: 0,
        reviews: 0,
        decisions: 0,
        skips: 0,
        reason: null,
        pendingQuestion: "Approve?",
      },
    });
    expect(view.tasks[1]?.waitingOn).toEqual([2]);
    expect(view.changes.map((item) => item.key)).toEqual(["branch-fix-x"]);
  });
});

describe("transcript lines", () => {
  it("TC-GUI-058: messages and tool calls come back; invalid and unknown lines are skipped and counted", () => {
    const lines = [
      JSON.stringify({ type: "mode", mode: "default" }),
      JSON.stringify({ type: "user", timestamp: "t1", message: { role: "user", content: "Run the tests" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "Running them." },
            { type: "tool_use", name: "Bash", input: { command: "npm test" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: [{ type: "text", text: "14 passed" }] }] },
      }),
      "{not json",
      JSON.stringify({ type: "something-new", data: 1 }),
      JSON.stringify({ type: "user", message: { content: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" } }),
    ];
    const parsed = lines.map(parseTranscriptLine);
    expect(parsed.filter((item) => item.isSkipped)).toHaveLength(2);
    expect(parsed.flatMap((item) => item.entries).map((entry) => [entry.kind, entry.tool, entry.text])).toEqual([
      ["user", null, "Run the tests"],
      ["assistant", null, "Running them."],
      ["tool-call", "Bash", '{"command":"npm test"}'],
      ["tool-result", null, "14 passed"],
      ["user", null, "key [REDACTED:anthropic-key]"],
    ]);
  });
});

describe("layout", () => {
  const view = buildCanvas(
    sources({
      overview: {
        roadmaps: [
          roadmap(1, [
            { id: 1, tasks: [task(3, 1, { dependsOn: [2] }), task(2, 1)] },
            { id: 2, tasks: [task(4, 2)] },
          ]),
          roadmap(2, [{ id: 3, tasks: [task(6, 3, { dependsOn: [5] }), task(5, 3)] }]),
        ],
        unassigned: [task(9, null)],
      },
    }),
    NOW,
  );

  it("TC-GUI-100: frames don't overlap, cards sit in their milestone's column, and a task is below the ones it depends on", () => {
    const layout = resolveLayout(view, undefined);
    const first = layout.frames["roadmap-1"];
    const second = layout.frames["roadmap-2"];
    expect(first?.x).toBe(0);
    expect(second?.x).toBeGreaterThan((first?.x ?? 0) + 2 * LAYOUT.cardWidth);
    expect(layout.cards["task-2"]?.x).toBe(layout.cards["task-3"]?.x);
    expect(layout.cards["task-4"]?.x).toBeGreaterThan(layout.cards["task-2"]?.x ?? 0);
    expect(layout.cards["task-3"]?.y).toBeGreaterThan(layout.cards["task-2"]?.y ?? 0);
    expect(layout.cards["task-6"]?.y).toBeGreaterThan(layout.cards["task-5"]?.y ?? 0);
    expect(layout.frames["unassigned"]).toBeDefined();
  });

  it("TC-GUI-100: a frame placed automatically never lands on a frame placed by hand", () => {
    const layout = resolveLayout(view, { version: 1, frames: { "roadmap-1": { x: 300, y: 0 } }, cards: {} });
    const width = (key: string) =>
      (key === "roadmap-1" ? 2 : 1) * (LAYOUT.cardWidth + LAYOUT.columnGap) + 2 * LAYOUT.framePadding;
    const spans = Object.entries(layout.frames).map(([key, point]) => [point.x, point.x + width(key)] as const);
    for (const [index, [start, end]] of spans.entries())
      for (const [otherStart, otherEnd] of spans.slice(index + 1))
        expect(end <= otherStart || otherEnd <= start).toBe(true);
  });

  it("TC-GUI-100: each frame's width is its columns' width, the same the layout spaces frames by", () => {
    const widths = frameWidths(view);
    expect(widths["roadmap-1"]).toBe(2 * LAYOUT.framePadding + 2 * (LAYOUT.cardWidth + LAYOUT.columnGap));
    expect(widths["unassigned"]).toBe(2 * LAYOUT.framePadding + LAYOUT.cardWidth + LAYOUT.columnGap);
    const layout = resolveLayout(view, undefined);
    expect(layout.frames["roadmap-2"]?.x).toBe((widths["roadmap-1"] ?? 0) + LAYOUT.frameGap);
  });

  it("TC-GUI-031: a saved position wins, a new task gets an automatic one, and a removed task's saved one is dropped", () => {
    const saved = {
      version: 1 as const,
      frames: { "roadmap-1": { x: 500, y: 40 }, "roadmap-99": { x: 1, y: 1 } },
      cards: { "task-2": { x: 7, y: 8 }, "task-99": { x: 1, y: 1 } },
    };
    const layout = resolveLayout(view, saved);
    expect(layout.frames["roadmap-1"]).toEqual({ x: 500, y: 40 });
    expect(layout.cards["task-2"]).toEqual({ x: 7, y: 8 });
    expect(layout.cards["task-4"]).toBeDefined();
    expect(layout.frames["roadmap-99"]).toBeUndefined();
    expect(layout.cards["task-99"]).toBeUndefined();
  });

  it("TC-GUI-101: Tidy up forgets one frame's saved positions and keeps the others'", () => {
    const saved = {
      version: 1 as const,
      frames: { "roadmap-1": { x: 500, y: 40 }, "roadmap-2": { x: 900, y: 0 } },
      cards: { "task-2": { x: 7, y: 8 }, "task-5": { x: 9, y: 9 } },
    };
    const tidied = tidyFrame(view, saved, "roadmap-1");
    expect(tidied.frames).toEqual({ "roadmap-2": { x: 900, y: 0 } });
    expect(tidied.cards).toEqual({ "task-5": { x: 9, y: 9 } });
    expect(tidyFrame(view, saved, "roadmap-42")).toBe(saved);
  });
});
