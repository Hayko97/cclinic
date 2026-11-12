/// <reference lib="dom" />
/** Run with AI from the GUI: the plan, the run, Stop, and the roadmap panel's runs (spec: gui, stage D4). */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import type { JobProcess } from "../../src/application/gui-jobs.js";
import type { RunState } from "../../src/core/automation.js";
import type { CanvasView } from "../../src/core/canvas.js";
import { AUTO_REQUIRED_SKILLS } from "../../src/core/constants/agents.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";
import { openStream, sendTo, startTestGui, type TestGui } from "../support/gui.js";

const LIVE_RUN = "20261112-150000";
const OLD_RUN = "20261110-090000";
const OLDER_RUN = "20261109-090000";

let browser: Browser;
const running: TestGui[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  await Promise.all(browser.contexts().map((context) => context.close()));
  await Promise.all(running.splice(0).map((gui) => gui.stop()));
});

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

/** A committed project with documents and the skills agents need, and roadmap 1 "Launch" with tasks 1 and 2. */
function repository(): string {
  const root = makeTempFolder();
  writeProject(root, {
    "README.md": "# App\n",
    "src/shared.txt": "base\n",
    ".cclinic/sdd/README.md": "# Specs\n",
    ...Object.fromEntries(AUTO_REQUIRED_SKILLS.map((skill) => [`.claude/skills/${skill}/SKILL.md`, `# ${skill}\n`])),
  });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "dev@example.com");
  git(root, "config", "user.name", "Dev");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  const store = openTaskStore(path.join(root, ".cclinic"), "create");
  if (store === undefined) throw new Error("No store");
  store.savePlan({
    roadmap: { title: "Launch", goal: "Ship" },
    milestones: [
      {
        title: "M1",
        goal: "Start",
        tasks: [
          { key: "a", title: "Task a", description: "", spec: null, dependsOn: [] },
          { key: "b", title: "Task b", description: "", spec: null, dependsOn: ["a"] },
        ],
      },
    ],
  });
  store.close();
  return root;
}

/** A GUI whose jobs are real `cclinic` processes, with the fake `claude` on their PATH. */
async function startReal(root: string, rules: FakeClaudeRule[] = []): Promise<TestGui> {
  const harness = agentHarness({ rules });
  const gui = await startTestGui(root, {}, {}, harness.environment);
  running.push(gui);
  return gui;
}

/** Jobs that print `result` as their JSON line and exit with `code`, recording their arguments. */
function scriptedJobs(result: unknown, code = 0) {
  const started: string[][] = [];
  const signals: string[] = [];
  const startJob = (args: readonly string[]): JobProcess => {
    started.push([...args]);
    let print: ((stream: "stdout" | "stderr", chunk: string) => void) | undefined;
    let exit: ((code: number) => void) | undefined;
    const isRun = args[0] === "auto" && args.includes("--yes");
    return {
      onOutput: (listener) => {
        print = listener;
      },
      onExit: (listener) => {
        exit = listener;
        // A confirmed run keeps going until it's stopped; anything else answers at once.
        if (!isRun)
          void Promise.resolve().then(() => {
            print?.("stdout", `${JSON.stringify(result)}\n`);
            listener(code);
          });
      },
      signal: (name) => {
        signals.push(name);
        exit?.(130);
      },
    };
  };
  return { started, signals, startJob };
}

const PLAN = {
  status: "plan",
  roadmapId: 1,
  plan: "Roadmap #1: Launch\n  1. #1 Task a",
  runnable: [1, 2],
  blocked: [],
};

async function startScripted(root: string, jobs: ReturnType<typeof scriptedJobs>): Promise<TestGui> {
  const gui = await startTestGui(root, {}, { startJob: jobs.startJob, every: () => () => undefined });
  running.push(gui);
  return gui;
}

const postJob = (gui: TestGui, body: unknown) => sendTo(gui, "POST", "/api/jobs", body);

function runState(runId: string, change: Partial<RunState> = {}): RunState {
  return {
    runId,
    roadmapId: 1,
    roadmapTitle: "Launch",
    runBranch: `cclinic/auto/${runId}/run`,
    startedAt: new Date(Date.now() - 600_000).toISOString(),
    finishedAt: null,
    outcome: null,
    budgetUsd: 10,
    spentUsd: 3.4,
    developers: 2,
    tasks: [
      {
        taskId: 1,
        title: "Task a",
        dependsOn: [],
        status: "running",
        branch: `cclinic/auto/${runId}/task-1`,
        rounds: { specReviews: 1, qaRuns: 2, implementationReviews: 0 },
        costUsd: 1.25,
        reason: null,
        requirementIds: [],
      },
    ],
    skippedInProgress: [],
    ...change,
  };
}

function writeRun(root: string, state: RunState, files: { report?: string; logs?: Record<string, string> } = {}) {
  const folder = path.join(root, ".cclinic/auto", state.runId);
  mkdirSync(path.join(folder, "logs"), { recursive: true });
  writeFileSync(path.join(folder, "run.json"), JSON.stringify(state));
  if (files.report !== undefined) writeFileSync(path.join(folder, "report.md"), files.report);
  for (const [name, text] of Object.entries(files.logs ?? {})) writeFileSync(path.join(folder, "logs", name), text);
}

/** A live run of roadmap 1, held by this test's own process, and two finished runs. */
function withRuns(root: string): void {
  writeRun(root, runState(LIVE_RUN));
  writeFileSync(path.join(root, ".cclinic/auto/.lock"), JSON.stringify({ pid: process.pid, runId: LIVE_RUN }));
  const finished = { finishedAt: new Date().toISOString(), outcome: "completed" as const, spentUsd: 2 };
  writeRun(root, runState(OLD_RUN, finished), {
    report: "# Automated run\n\nOutcome: completed\n",
    logs: {
      "task-1-spec-1.txt": "Wrote the spec. Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n",
      "task-1-qa-1.txt": "QA passed.\n",
    },
  });
  writeRun(root, runState(OLDER_RUN, { ...finished, outcome: "partial" }), { report: "# Older\n" });
}

const canvasOf = async (gui: TestGui) =>
  (JSON.parse((await sendTo(gui, "GET", "/api/canvas")).body) as { canvas: CanvasView }).canvas;

describe("Run with AI through the API", () => {
  it("TC-GUI-037: a run without confirming gets the plan from a dry run, and no run starts", async () => {
    const jobs = scriptedJobs(PLAN);
    const gui = await startScripted(makeTempFolder(), jobs);
    const reply = await postJob(gui, { command: "auto", options: { roadmap: 1, maxBudgetUsd: 5, developers: 2 } });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ plan: PLAN });
    expect(jobs.started).toEqual([
      ["auto", "--roadmap=1", "--max-budget-usd=5", "--developers=2", "--dry-run", "--json"],
    ]);
  });

  it("TC-GUI-038: a confirmed run starts cclinic auto with the form's options and --yes --json", async () => {
    const jobs = scriptedJobs(PLAN);
    const gui = await startScripted(makeTempFolder(), jobs);
    const options = { roadmap: 1, maxBudgetUsd: 5, developers: 2, model: "haiku", effort: "low", timeoutMinutes: 10 };
    expect((await postJob(gui, { command: "auto", confirmed: true, options })).status).toBe(201);
    expect(jobs.started).toEqual([
      [
        "auto",
        "--roadmap=1",
        "--max-budget-usd=5",
        "--developers=2",
        "--model=haiku",
        "--effort=low",
        "--timeout-minutes=10",
        "--yes",
        "--json",
      ],
    ]);
    // Only one run at a time.
    const second = await postJob(gui, { command: "auto", confirmed: true, options });
    expect(second.status).toBe(409);
  });

  it("FR-GUI-027: values the CLI would refuse are refused in the CLI's words, and nothing starts", async () => {
    const jobs = scriptedJobs(PLAN);
    const gui = await startScripted(makeTempFolder(), jobs);
    const developers = await postJob(gui, { command: "auto", options: { roadmap: 1, maxBudgetUsd: 5, developers: 9 } });
    expect(developers.status).toBe(400);
    expect((JSON.parse(developers.body) as { error: string }).error).toBe(
      "option '--developers <n>' argument '9' is invalid. It must be a whole number from 1 to 8.",
    );
    const budget = await postJob(gui, { command: "auto", options: { roadmap: 1, maxBudgetUsd: 0 } });
    expect(budget.status).toBe(400);
    expect(jobs.started).toEqual([]);
  });

  it("TC-GUI-039: a run the CLI would refuse is refused with the CLI's reason", async () => {
    const root = repository();
    writeProject(root, { "src/shared.txt": "changed\n" });
    const gui = await startReal(root);
    const changed = await postJob(gui, { command: "auto", options: { roadmap: 1, maxBudgetUsd: 5 } });
    expect(changed.status).toBe(409);
    expect((JSON.parse(changed.body) as { error: string }).error).toMatch(/tracked|commit|changes/i);

    const locked = repository();
    mkdirSync(path.join(locked, ".cclinic/auto"), { recursive: true });
    writeFileSync(path.join(locked, ".cclinic/auto/.lock"), JSON.stringify({ pid: process.pid, runId: LIVE_RUN }));
    const lockedGui = await startReal(locked);
    const busy = await postJob(lockedGui, { command: "auto", options: { roadmap: 1, maxBudgetUsd: 5 } });
    expect(busy.status).toBe(409);
    expect((JSON.parse(busy.body) as { error: string }).error).toContain(`Automated run ${LIVE_RUN}`);
  });

  it("TC-GUI-042: Stop sends the GUI's run SIGINT, and the run ends interrupted with its task open again", async () => {
    const root = repository();
    const gui = await startReal(root, [{ match: "developer agent", hang: true, times: 0 }]);
    const options = { roadmap: 1, maxBudgetUsd: 5, developers: 1, model: "haiku", effort: "low" };
    expect((await postJob(gui, { command: "auto", options })).status).toBe(200);
    const started = JSON.parse((await postJob(gui, { command: "auto", confirmed: true, options })).body) as {
      job: { id: string };
    };
    const live = await vi.waitFor(
      async () => {
        const run = (await canvasOf(gui)).roadmaps[0]?.run;
        if (run?.tasks.some((task) => task.status === "running") !== true) throw new Error("not running yet");
        return run;
      },
      { timeout: 20_000, interval: 200 },
    );
    expect((await sendTo(gui, "POST", "/api/run/stop")).status).toBe(202);
    const ended = await vi.waitFor(
      async () => {
        const job = (
          JSON.parse((await sendTo(gui, "GET", `/api/jobs/${started.job.id}`)).body) as {
            job: { isRunning: boolean; exitCode: number | null };
          }
        ).job;
        if (job.isRunning) throw new Error("still running");
        return job;
      },
      { timeout: 20_000, interval: 200 },
    );
    expect(ended.exitCode).toBe(130);
    const state = JSON.parse(
      readFileSync(path.join(root, ".cclinic/auto", live.runId, "run.json"), "utf8"),
    ) as RunState;
    expect(state.outcome).toBe("interrupted");
    const store = openTaskStore(path.join(root, ".cclinic"), "read");
    expect(store?.getTask(1)?.status).toBe("open");
    store?.close();
  }, 60_000);

  it("TC-GUI-043: stopping a run started from a terminal is refused, naming the process to stop", async () => {
    const root = repository();
    withRuns(root);
    const gui = await startScripted(root, scriptedJobs(PLAN));
    const reply = await sendTo(gui, "POST", "/api/run/stop");
    expect(reply.status).toBe(409);
    expect(JSON.parse(reply.body)).toEqual({
      error: `Run ${LIVE_RUN} wasn't started from this GUI. Stop it with Ctrl+C in its terminal, or stop process ${process.pid}.`,
    });
  });

  it("TC-GUI-040: changes to a live run's run.json reach the canvas stream with statuses, rounds and cost", async () => {
    const root = repository();
    withRuns(root);
    const checks = new Set<() => Promise<void>>();
    const gui = await startTestGui(
      root,
      {},
      {
        every: (_ms, check) => {
          checks.add(check);
          return () => checks.delete(check);
        },
      },
    );
    running.push(gui);
    const stream = openStream(gui, "/api/canvas/events");
    await vi.waitFor(() => {
      if (stream.events.length === 0) throw new Error("no canvas yet");
    });
    const first = (stream.events[0]?.data as { canvas: CanvasView }).canvas.roadmaps[0]?.run;
    expect(first).toMatchObject({ runId: LIVE_RUN, spentUsd: 3.4, budgetUsd: 10, pid: process.pid });
    expect(first?.tasks[0]).toMatchObject({ taskId: 1, status: "running", costUsd: 1.25 });
    const updated = runState(LIVE_RUN, { spentUsd: 4.1 });
    writeRun(root, { ...updated, tasks: updated.tasks.map((task) => ({ ...task, status: "done", costUsd: 1.95 })) });
    await Promise.all([...checks].map((check) => check()));
    await vi.waitFor(() => {
      const last = (stream.events.at(-1)?.data as { canvas: CanvasView }).canvas.roadmaps[0]?.run;
      expect(last).toMatchObject({ spentUsd: 4.1 });
      expect(last?.tasks[0]).toMatchObject({ status: "done", costUsd: 1.95 });
    });
    stream.close();
  });

  it("TC-GUI-041: a run's agents show their role, and their new messages and tool calls arrive in order", async () => {
    const root = repository();
    const home = makeTempFolder();
    const folder = path.join(home, ".claude/projects/w");
    mkdirSync(folder, { recursive: true });
    const sessionId = "4a000000-0000-4000-8000-000000000001";
    const transcript = path.join(folder, `${sessionId}.jsonl`);
    const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
    writeFileSync(transcript, line({ type: "user", message: { content: "Test task 1" } }));
    writeRun(root, runState(LIVE_RUN));
    writeFileSync(path.join(root, ".cclinic/auto/.lock"), JSON.stringify({ pid: process.pid, runId: LIVE_RUN }));
    mkdirSync(path.join(root, ".cclinic/auto", LIVE_RUN, "sessions"), { recursive: true });
    writeFileSync(
      path.join(root, ".cclinic/auto", LIVE_RUN, "sessions", `${sessionId}.json`),
      JSON.stringify({
        sessionId,
        taskId: 1,
        role: "qa",
        step: "qa-1",
        cwd: root,
        transcriptPath: transcript,
        startedAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null,
        costUsd: null,
      }),
    );
    const checks = new Set<() => Promise<void>>();
    const gui = await startTestGui(
      root,
      {},
      {
        every: (_ms, check) => {
          checks.add(check);
          return () => checks.delete(check);
        },
      },
      { HOME: home },
    );
    running.push(gui);
    const session = (await canvasOf(gui)).tasks.find((task) => task.id === 1)?.sessions[0];
    expect(session).toMatchObject({ id: sessionId, role: "qa", step: "qa-1", isLive: true });
    const stream = openStream(gui, `/api/sessions/${sessionId}/events`);
    await vi.waitFor(() => {
      if (stream.events.length === 0) throw new Error("no transcript yet");
    });
    writeFileSync(
      transcript,
      line({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
      }) + line({ type: "assistant", message: { content: "All tests pass." } }),
      { flag: "a" },
    );
    await Promise.all([...checks].map((check) => check()));
    await vi.waitFor(() => {
      const added = stream.events
        .filter((event) => event.event === "entries")
        .flatMap((event) => (event.data as { entries: { kind: string; tool: string | null }[] }).entries);
      expect(added.map((entry) => [entry.kind, entry.tool])).toEqual([
        ["tool-call", "Bash"],
        ["assistant", null],
      ]);
    });
    stream.close();
  });

  it("TC-GUI-044: past runs are listed newest first, and a run's report and logs come back redacted", async () => {
    const root = repository();
    withRuns(root);
    const gui = await startScripted(root, scriptedJobs(PLAN));
    const roadmap = (await canvasOf(gui)).roadmaps[0];
    expect(roadmap?.pastRuns.map((run) => [run.runId, run.outcome])).toEqual([
      [OLD_RUN, "completed"],
      [OLDER_RUN, "partial"],
    ]);
    const files = JSON.parse((await sendTo(gui, "GET", `/api/runs/${OLD_RUN}`)).body) as {
      report: string;
      logs: { name: string; text: string }[];
    };
    expect(files.report).toContain("Outcome: completed");
    expect(files.logs.map((log) => log.name)).toEqual(["task-1-qa-1.txt", "task-1-spec-1.txt"]);
    expect(JSON.stringify(files)).not.toContain("sk-ant-api03-abcdefghijklmnop");
    expect((await sendTo(gui, "GET", "/api/runs/20991231-000000")).status).toBe(404);
    // A report that can't be read is reported with its name, not shown as missing.
    const report = path.join(root, ".cclinic/auto", OLDER_RUN, "report.md");
    chmodSync(report, 0o000);
    const unreadable = await sendTo(gui, "GET", `/api/runs/${OLDER_RUN}`);
    chmodSync(report, 0o644);
    expect(unreadable.status).toBe(409);
    expect((JSON.parse(unreadable.body) as { error: string }).error).toContain("report.md can't be read");
    expect((await sendTo(gui, "GET", "/api/runs/..")).status).toBe(404);
  });
});

describe("Run with AI and the roadmap panel in the browser", () => {
  async function openPage(gui: TestGui): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
    await page.locator('[data-key="task-1"]').waitFor();
    return page;
  }

  it("TC-GUI-128: Run with AI shows the plan before anything starts, starts the run, and Stop ends it", async () => {
    const root = repository();
    const gui = await startReal(root, [{ match: "developer agent", hang: true, times: 0 }]);
    const page = await openPage(gui);
    const frame = page.locator('[data-frame="roadmap-1"]');
    await frame.locator('button[data-action="run-ai"]').click();
    const dialog = page.locator("#auto-dialog");
    expect(await dialog.locator("#auto-roadmap").textContent()).toBe("Roadmap #1: Launch");
    await dialog.locator('input[name="maxBudgetUsd"]').fill("5");
    await dialog.locator('input[name="developers"]').fill("1");
    await dialog.locator("#auto-show-plan").click();
    await expect
      .poll(() => dialog.locator("#auto-plan").textContent(), { timeout: 15_000 })
      .toContain("Roadmap #1: Launch");
    expect(existsSync(path.join(root, ".cclinic/auto/.lock"))).toBe(false);
    await dialog.locator("#auto-start").click();
    await expect.poll(() => frame.locator('button[data-action="stop-run"]').count(), { timeout: 20_000 }).toBe(1);
    expect(await frame.locator(".run-progress").textContent()).toContain("of $5.00");
    await frame.locator('button[data-action="stop-run"]').click();
    // FR-GUI-061: stopping asks first, naming the run and its effect.
    expect(await page.locator("#confirm-message").textContent()).toContain("Its tasks in progress go back to open");
    await page.locator("#confirm-ok").click();
    await expect.poll(() => frame.locator('button[data-action="run-ai"]').count(), { timeout: 20_000 }).toBe(1);
    const [runId] = (await canvasOf(gui)).roadmaps[0]?.pastRuns.map((run) => run.runId) ?? [];
    const state = JSON.parse(
      readFileSync(path.join(root, ".cclinic/auto", runId ?? "", "run.json"), "utf8"),
    ) as RunState;
    expect(state.outcome).toBe("interrupted");
  }, 60_000);

  it("TC-GUI-128: a run the CLI refuses shows its reason in the form, and a changed form needs a new plan", async () => {
    const root = repository();
    writeProject(root, { "src/shared.txt": "changed\n" });
    const gui = await startReal(root);
    const page = await openPage(gui);
    await page.locator('[data-frame="roadmap-1"] button[data-action="run-ai"]').click();
    const dialog = page.locator("#auto-dialog");
    await dialog.locator('input[name="maxBudgetUsd"]').fill("5");
    await dialog.locator("#auto-show-plan").click();
    await expect.poll(() => dialog.locator("#auto-error").textContent(), { timeout: 15_000 }).not.toBe("");
    expect(await dialog.locator("#auto-start").isHidden()).toBe(true);
  }, 30_000);

  it("TC-GUI-129: Open shows the roadmap panel with its tasks, the live run and the past runs with their files", async () => {
    const root = repository();
    withRuns(root);
    const gui = await startScripted(root, scriptedJobs(PLAN));
    const page = await openPage(gui);
    await page.locator('[data-frame="roadmap-1"] button[data-action="open-roadmap"]').click();
    expect(await page.locator("#panel-title").textContent()).toBe("Roadmap #1");
    const panel = page.locator("#panel-body");
    expect(await panel.locator(".milestone h4").allTextContents()).toEqual(["M1"]);
    expect(await panel.locator(".milestone li").allTextContents()).toEqual([
      "#1 Task a · Open · in run " + LIVE_RUN,
      "#2 Task b · Open · after #1",
    ]);
    const run = panel.locator(".run-section");
    expect(await run.locator("h3").textContent()).toBe(`Run ${LIVE_RUN}`);
    expect(await run.locator(".budget").textContent()).toBe("$3.40 of $10.00");
    expect(await run.locator('[data-run-task="1"]').textContent()).toContain("1 spec · 2 QA · 0 review");
    expect(await panel.locator('button[data-action="stop-run"]').count()).toBe(1);

    const past = panel.locator(".past-runs > li");
    expect(await past.locator("button").allTextContents()).toEqual([
      `${OLD_RUN} · completed · $2.00 of $10.00`,
      `${OLDER_RUN} · partial · $2.00 of $10.00`,
    ]);
    await past.first().locator("button").click();
    await expect.poll(() => panel.locator(".run-report").textContent()).toContain("Outcome: completed");
    expect(await panel.locator(".run-log summary").allTextContents()).toEqual(["task-1-qa-1.txt", "task-1-spec-1.txt"]);
    expect(await panel.textContent()).not.toContain("sk-ant-api03-abcdefghijklmnop");
  });
});
