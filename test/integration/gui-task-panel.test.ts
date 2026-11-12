/// <reference lib="dom" />
/** The task panel's depth: workflow steps, live agents, following output, search, filter and folding (spec: gui). */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import type { JobProcess } from "../../src/application/gui-jobs.js";
import type { AgentSession, RunState } from "../../src/core/automation.js";
import type { CanvasView } from "../../src/core/canvas.js";
import { makeTempFolder } from "../support/helpers.js";
import { sendTo, startTestGui, type TestGui } from "../support/gui.js";

const RUN_ID = "20261112-110000";
const QA_SESSION = "9a000000-0000-4000-8000-000000000004";
const QUIET_SESSION = "9a000000-0000-4000-8000-000000000005";
const LONG_COMMAND = `npm test -- ${"x".repeat(200)}`;

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

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const toolUse = (name: string, input: unknown) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, input }] },
});
const toolResult = (content: string) => ({ type: "user", message: { content: [{ type: "tool_result", content }] } });

/** Roadmap 1 "Payments" with tasks 1 to 5, of which 4 and 5 are done. */
function project(): string {
  const root = makeTempFolder();
  mkdirSync(path.join(root, ".cclinic/sdd"), { recursive: true });
  const store = openTaskStore(path.join(root, ".cclinic"), "create");
  if (store === undefined) throw new Error("No store");
  store.savePlan({
    roadmap: { title: "Payments", goal: "Card checkout" },
    milestones: [
      {
        title: "Cards",
        goal: "Pay by card",
        tasks: ["a", "b", "c", "d", "e"].map((key) => ({
          key,
          title: `Task ${key}`,
          description: "",
          spec: null,
          dependsOn: [],
        })),
      },
    ],
  });
  store.setStatus(4, "done");
  store.setStatus(5, "done");
  store.close();
  return root;
}

function session(
  id: string,
  taskId: number,
  step: string,
  startedMinutesAgo: number,
  end: number | null,
  file: string,
) {
  return {
    sessionId: id,
    taskId,
    role: (step.startsWith("qa") ? "qa" : step.includes("review") ? "pm" : "developer") as AgentSession["role"],
    step,
    cwd: "/w",
    transcriptPath: file,
    startedAt: minutesAgo(startedMinutesAgo),
    endedAt: end === null ? null : minutesAgo(end),
    exitCode: end === null ? null : 0,
    costUsd: end === null ? null : 0.25,
  } satisfies AgentSession;
}

/**
 * A live run of roadmap 1 with $3.40 of $10 spent: task 2 has done its spec, spec review and implementation and is
 * in QA, and task 3 is in its spec, with a transcript last written 6 minutes ago and no tool call.
 */
function withRun(root: string, home: string, transcript: readonly unknown[]): void {
  const projects = path.join(home, ".claude/projects/w");
  mkdirSync(projects, { recursive: true });
  const file = (id: string) => path.join(projects, `${id}.jsonl`);
  writeFileSync(file(QA_SESSION), transcript.map((line) => JSON.stringify(line)).join("\n") + "\n");
  writeFileSync(file(QUIET_SESSION), `${JSON.stringify({ type: "user", message: { content: "Write the spec" } })}\n`);
  const sixMinutesAgo = new Date(Date.now() - 6 * 60_000 - 5_000);
  utimesSync(file(QUIET_SESSION), sixMinutesAgo, sixMinutesAgo);
  const sessions = [
    session("9a000000-0000-4000-8000-000000000001", 2, "spec-1", 40, 35, file("spec")),
    session("9a000000-0000-4000-8000-000000000002", 2, "spec-review-1", 35, 30, file("review")),
    session("9a000000-0000-4000-8000-000000000003", 2, "implement-1", 30, 10, file("implement")),
    session(QA_SESSION, 2, "qa-1", 10, null, file(QA_SESSION)),
    session(QUIET_SESSION, 3, "spec-1", 20, null, file(QUIET_SESSION)),
  ];
  const state: RunState = {
    runId: RUN_ID,
    roadmapId: 1,
    roadmapTitle: "Payments",
    runBranch: `cclinic/auto/${RUN_ID}/run`,
    startedAt: minutesAgo(45),
    finishedAt: null,
    outcome: null,
    budgetUsd: 10,
    spentUsd: 3.4,
    developers: 2,
    tasks: [2, 3].map((taskId) => ({
      taskId,
      title: `Task ${taskId}`,
      dependsOn: [],
      status: "running",
      branch: null,
      rounds: { specReviews: 1, qaRuns: 1, implementationReviews: 0 },
      costUsd: 0.75,
      reason: null,
      requirementIds: [],
    })),
    skippedInProgress: [],
  };
  const folder = path.join(root, ".cclinic/auto", RUN_ID);
  mkdirSync(path.join(folder, "sessions"), { recursive: true });
  writeFileSync(path.join(folder, "run.json"), JSON.stringify(state));
  for (const item of sessions)
    writeFileSync(path.join(folder, "sessions", `${item.sessionId}.json`), JSON.stringify(item));
  writeFileSync(path.join(root, ".cclinic/auto/.lock"), JSON.stringify({ pid: process.pid, runId: RUN_ID }));
}

const QA_TRANSCRIPT = [
  { type: "user", message: { content: "Test task 2" } },
  toolUse("Bash", { command: "npm test" }),
  toolResult(Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n")),
  { type: "assistant", message: { content: [{ type: "text", text: "One test failed, running it again." }] } },
  toolUse("Bash", { command: LONG_COMMAND }),
];

/** A job the test writes lines to, one call at a time. */
function heldJob() {
  let output: ((stream: "stdout" | "stderr", chunk: string) => void) | undefined;
  let written = 0;
  // Each job ends when the GUI stops it, as a real one would. Setup starts its own jobs too.
  const startJob = (args: readonly string[]): JobProcess => {
    let exit: ((code: number) => void) | undefined;
    return {
      onOutput: (listener) => {
        if (args[0] === "doctor") output = listener;
      },
      onExit: (listener) => {
        exit = listener;
      },
      signal: () => exit?.(130),
    };
  };
  const write = (count: number) => {
    for (let index = 0; index < count; index += 1) {
      written += 1;
      output?.("stdout", `output line ${written}\n`);
    }
  };
  return { startJob, write };
}

async function open(
  options: { transcript?: readonly unknown[]; startJob?: (args: readonly string[]) => JobProcess } = {},
): Promise<{ gui: TestGui; page: Page }> {
  const root = project();
  const home = makeTempFolder();
  withRun(root, home, options.transcript ?? QA_TRANSCRIPT);
  const gui = await startTestGui(
    root,
    {},
    { every: () => () => undefined, ...(options.startJob === undefined ? {} : { startJob: options.startJob }) },
    { HOME: home },
  );
  running.push(gui);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
  await page.locator('[data-key="task-1"]').waitFor();
  return { gui, page };
}

describe("task panel: steps and live agents", () => {
  it("TC-GUI-122: the canvas data gives a live session's newest tool call, cut to 80 characters", async () => {
    const root = project();
    const home = makeTempFolder();
    withRun(root, home, QA_TRANSCRIPT);
    const gui = await startTestGui(root, {}, { every: () => () => undefined }, { HOME: home });
    running.push(gui);
    const { canvas } = JSON.parse((await sendTo(gui, "GET", "/api/canvas")).body) as { canvas: CanvasView };
    const sessions = canvas.tasks.flatMap((task) => task.sessions);
    const qa = sessions.find((item) => item.id === QA_SESSION);
    expect(qa?.currentTool?.name).toBe("Bash");
    expect(qa?.currentTool?.input).toHaveLength(80);
    expect(qa?.currentTool?.input.startsWith(`{"command":"npm test -- xxx`)).toBe(true);
    expect(qa?.quietMinutes).toBeNull();
    const quiet = sessions.find((item) => item.id === QUIET_SESSION);
    expect(quiet).toMatchObject({ currentTool: null, quietMinutes: 6 });
    expect(sessions.filter((item) => !item.isLive).every((item) => item.currentTool === null)).toBe(true);
  });

  it("TC-GUI-078, TC-GUI-123: the frame and the panel show the run's progress, time and budget", async () => {
    const { page } = await open();
    const frame = page.locator('[data-frame="roadmap-1"]');
    await expect.poll(() => frame.locator(".progress").textContent()).toBe("2 / 5 done");
    expect(await frame.locator(".run-progress").textContent()).toMatch(
      /^Running for 4[5-6]m \d\ds\$3\.40 of \$10\.00$/,
    );
    const bar = frame.locator(".run-progress progress");
    expect([await bar.getAttribute("value"), await bar.getAttribute("max")]).toEqual(["3.4", "10"]);

    await page.locator('[data-key="task-2"]').click();
    const run = page.locator(".run-section");
    expect(await run.locator("h3").textContent()).toBe(`Run ${RUN_ID}`);
    expect(await run.locator("p").textContent()).toBe("2 / 5 tasks done in Payments");
    expect(await run.locator(".budget").textContent()).toBe("$3.40 of $10.00");
  });

  it("TC-GUI-123: the Steps section lists the rounds in order, and the running one shows a timer and its tool", async () => {
    const { page } = await open();
    await page.locator('[data-key="task-2"]').click();
    const rows = page.locator(".steps > li");
    await expect
      .poll(() => rows.locator(".step-name").allTextContents())
      .toEqual(["Spec 1", "Spec review 1", "Implement 1", "QA 1", "Merge"]);
    expect(await rows.locator(".step-status").allTextContents()).toEqual([
      "Passed",
      "Passed",
      "Passed",
      "Running",
      "Not started",
    ]);
    expect(await rows.nth(2).locator(".step-time").textContent()).toBe("20m 00s");
    expect(await rows.nth(2).locator(".step-cost").textContent()).toBe("$0.25");
    const qa = rows.nth(3);
    const timer = qa.locator(".timer");
    const first = await timer.textContent();
    expect(first).toMatch(/^10m 0\ds$/);
    await expect.poll(() => timer.textContent(), { timeout: 3_000 }).not.toBe(first);
    expect(await qa.locator(".tool-name").textContent()).toBe("Bash");
    expect(await qa.locator(".step-tool code").textContent()).toHaveLength(80);
    expect(await qa.locator(".step-stalled").count()).toBe(0);
    expect(await page.locator(".steps + p").textContent()).toBe("Total cost $0.75");
  });

  it("TC-GUI-079: a running step whose transcript has been quiet for the stall time says so", async () => {
    const { page } = await open();
    await page.locator('[data-key="task-3"]').click();
    const running = page.locator(".steps > li.step-running");
    await expect.poll(() => running.locator(".step-stalled").textContent()).toBe("No activity for 6 min");
    expect(await running.locator(".step-tool").count()).toBe(0);
  });
});

describe("following output, search, filter and folding", () => {
  it("TC-GUI-080: the follow state follows, pauses with new lines counted, and resumes with nothing lost", async () => {
    const { page } = await open();
    // Run as page text, so the module is imported by the browser, not by the test runner.
    const states = await page.evaluate(`(async () => {
      const { FOLLOWING, nextFollow } = await import("/assets/follow.js");
      const steps = [
        { type: "lines", count: 2 },
        { type: "away" },
        { type: "lines", count: 3 },
        { type: "away" },
        { type: "lines", count: 1 },
        { type: "bottom" },
      ];
      const seen = [];
      let state = FOLLOWING;
      for (const event of steps) {
        state = nextFollow(state, event);
        seen.push(state);
      }
      return seen;
    })()`);
    expect(states).toEqual([
      { isFollowing: true, buffered: 0 },
      { isFollowing: false, buffered: 0 },
      { isFollowing: false, buffered: 3 },
      { isFollowing: false, buffered: 3 },
      { isFollowing: false, buffered: 4 },
      { isFollowing: true, buffered: 0 },
    ]);
  });

  it("TC-GUI-081: scrolled up, output stays put and counts new lines; Jump to latest shows the newest and follows", async () => {
    const job = heldJob();
    const { page } = await open({ startJob: job.startJob });
    await page.locator('[data-view="setup"]').click();
    await page.locator("#run-doctor").click();
    const output = page.locator("#output");
    job.write(80);
    await expect.poll(() => output.locator(".line").count()).toBe(80);
    const atBottom = () => output.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight < 8);
    await expect.poll(atBottom).toBe(true);

    await output.evaluate((node) => {
      node.scrollTop = 0;
    });
    const jump = page.locator(".job-output .jump-latest");
    await expect.poll(() => jump.isVisible()).toBe(true);
    job.write(5);
    await expect.poll(() => jump.textContent()).toBe("Jump to latest (5 new)");
    expect(await output.evaluate((node) => node.scrollTop)).toBe(0);

    await jump.click();
    expect(await atBottom()).toBe(true);
    expect(await jump.isVisible()).toBe(false);
    job.write(1);
    await expect.poll(() => output.locator(".line").last().textContent()).toBe("output line 86\n");
    await expect.poll(atBottom).toBe(true);
  });

  it("TC-GUI-058: selecting text in a transcript pauses following", async () => {
    const { page } = await open();
    await page.locator('[data-key="task-2"]').click();
    const entries = page.locator("#transcript .entries");
    await expect.poll(() => entries.locator(".entry").count()).toBe(5);
    await entries.locator(".entry pre").first().selectText();
    await expect.poll(() => page.locator("#transcript .jump-latest").textContent()).toBe("Jump to latest (0 new)");
  });

  it("TC-GUI-082: a long tool result is folded, the filter shows only tool calls, and search marks the match", async () => {
    const { page } = await open();
    await page.locator('[data-key="task-2"]').click();
    const entries = page.locator("#transcript .entries > li");
    await expect.poll(() => entries.count()).toBe(5);

    const result = entries.nth(2);
    expect((await result.locator("pre").textContent())?.split("\n")).toHaveLength(20);
    const unfold = result.locator(".fold");
    expect(await unfold.textContent()).toBe("Show all 50 lines");
    await unfold.click();
    expect((await result.locator("pre").textContent())?.split("\n")).toHaveLength(50);
    expect(await result.locator(".fold").getAttribute("aria-expanded")).toBe("true");

    await page.locator("#transcript select").selectOption("tool-call");
    const shown = () =>
      page
        .locator("#transcript .entries > li:not([hidden])")
        .evaluateAll((items) => items.map((item) => item.dataset.kind));
    expect(await shown()).toEqual(["tool-call", "tool-call"]);

    await page.locator('#transcript input[type="search"]').fill("npm test");
    expect(await page.locator("#transcript .entries > li:not([hidden]) mark").allTextContents()).toEqual([
      "npm test",
      "npm test",
    ]);
    expect(await page.locator("#transcript .match-count").textContent()).toBe("2 matches");
    await page.locator('#transcript input[type="search"]').press("Enter");
    expect(await page.locator("#transcript .jump-latest").isVisible()).toBe(true);
  });

  it("TC-GUI-133: a search matching the folded part of a tool result shows it whole, and clearing it folds it again", async () => {
    const { page } = await open();
    await page.locator('[data-key="task-2"]').click();
    const result = page.locator("#transcript .entries > li").nth(2);
    await expect.poll(() => result.locator(".fold").textContent()).toBe("Show all 50 lines");
    const search = page.locator('#transcript input[type="search"]');
    await search.fill("line 45");
    expect((await result.locator("pre").textContent())?.split("\n")).toHaveLength(50);
    expect(await result.locator("mark").allTextContents()).toEqual(["line 45"]);
    expect(await result.locator(".fold").count()).toBe(0);
    expect(await page.locator("#transcript .match-count").textContent()).toBe("1 match");
    await search.fill("");
    expect((await result.locator("pre").textContent())?.split("\n")).toHaveLength(20);
    expect(await result.locator(".fold").textContent()).toBe("Show all 50 lines");
  });

  it("TC-GUI-059: the Jobs output can be searched", async () => {
    const job = heldJob();
    const { page } = await open({ startJob: job.startJob });
    await page.locator('[data-view="setup"]').click();
    await page.locator("#run-doctor").click();
    job.write(12);
    await expect.poll(() => page.locator("#output .line").count()).toBe(12);
    await page.locator('.job-output input[type="search"]').fill("line 1");
    expect(await page.locator("#output mark").count()).toBe(4);
    expect(await page.locator(".job-output .match-count").textContent()).toBe("4 matches");
  });
});
