/// <reference lib="dom" />
/** The Claude plan's limits instead of dollars, and Continue for a stopped run (spec: gui FR-GUI-083, FR-GUI-084). */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import type { JobProcess } from "../../src/application/gui-jobs.js";
import type { AgentSession, RunState } from "../../src/core/automation.js";
import type { PlanLimits } from "../../src/core/limits.js";
import { beginChange, stateKey } from "../../src/core/workflow.js";
import { makeTempFolder } from "../support/helpers.js";
import { startTestGui, type TestGui } from "../support/gui.js";

const STOPPED_RUN = "20261112-150000";
const DONE_RUN = "20261110-090000";

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

const MODELS = {
  status: "success",
  models: [
    { value: "sonnet", label: "Sonnet" },
    { value: "haiku", label: "Haiku" },
  ],
  efforts: [
    { value: "high", label: "High" },
    { value: "low", label: "Low" },
  ],
  current: { model: "sonnet", effort: "high" },
};
const PLAN = { status: "plan", roadmapId: 1, plan: "Roadmap #1: Payments\nDevelopers: 2", runnable: [2], blocked: [] };

/** Jobs that print the model list or a plan, recording their arguments; a confirmed run waits to be stopped. */
function scriptedJobs() {
  const started: string[][] = [];
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
        if (!isRun)
          void Promise.resolve().then(() => {
            print?.("stdout", `${JSON.stringify(args[0] === "model" ? MODELS : PLAN)}\n`);
            listener(0);
          });
      },
      signal: () => exit?.(130),
    };
  };
  return { started, startJob };
}

function runState(runId: string, change: Partial<RunState>): RunState {
  return {
    runId,
    roadmapId: 1,
    roadmapTitle: "Payments",
    runBranch: `luseen/auto/${runId}/run`,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    finishedAt: new Date(Date.now() - 1_800_000).toISOString(),
    outcome: "interrupted",
    spentUsd: 3.4,
    developers: 2,
    model: "haiku",
    effort: "low",
    timeoutMinutes: 20,
    limitResetsAt: null,
    tasks: [
      {
        taskId: 1,
        title: "Token",
        dependsOn: [],
        status: "done",
        branch: null,
        rounds: { specReviews: 1, qaRuns: 1, implementationReviews: 1 },
        costUsd: 1.25,
        reason: null,
        requirementIds: [],
      },
      {
        taskId: 2,
        title: "Charge",
        dependsOn: [],
        status: "open",
        branch: null,
        rounds: { specReviews: 1, qaRuns: 0, implementationReviews: 0 },
        costUsd: 2.15,
        reason: "The run was stopped.",
        requirementIds: [],
      },
    ],
    skippedInProgress: [],
    ...change,
  };
}

/** Roadmap 1 "Payments" with task 1 done and task 2 open, its newest run as given, and a config folder. */
async function project(newest: Partial<RunState>): Promise<{ root: string; config: string; home: string }> {
  const root = makeTempFolder();
  mkdirSync(path.join(root, ".luseen/sdd"), { recursive: true });
  const store = openTaskStore(path.join(root, ".luseen"), "create");
  if (store === undefined) throw new Error("No store");
  store.savePlan({
    roadmap: { title: "Payments", goal: "Card checkout" },
    milestones: [
      {
        title: "Cards",
        goal: "Pay by card",
        tasks: ["Token", "Charge"].map((title, index) => ({
          key: `t${index}`,
          title,
          description: "",
          spec: null,
          dependsOn: [],
        })),
      },
    ],
  });
  store.setStatus(1, "done");
  store.close();
  for (const state of [runState(DONE_RUN, { outcome: "completed" }), runState(STOPPED_RUN, newest)]) {
    const folder = path.join(root, ".luseen/auto", state.runId);
    mkdirSync(path.join(folder, "sessions"), { recursive: true });
    writeFileSync(path.join(folder, "run.json"), JSON.stringify(state));
    const session: AgentSession = {
      sessionId: `5e550000-0000-4000-8000-0000000000${state.runId === DONE_RUN ? "01" : "02"}`,
      taskId: 2,
      role: "qa",
      step: "qa-1",
      cwd: root,
      transcriptPath: "/none.jsonl",
      startedAt: state.startedAt,
      endedAt: state.finishedAt,
      exitCode: 0,
      costUsd: 0.75,
    };
    writeFileSync(path.join(folder, "sessions", `${session.sessionId}.json`), JSON.stringify(session));
  }
  const change = beginChange(
    { changeType: "feature", spec: "payments", taskId: 2 },
    { key: stateKey(2, "main"), approverMode: "user", now: new Date().toISOString() },
  );
  await openWorkflowStore(root).save({ ...change, costUsd: 1.2 });
  const home = makeTempFolder();
  const config = path.join(home, "config");
  mkdirSync(path.join(config, "luseen"), { recursive: true });
  return { root, config, home };
}

const limitsFile = (config: string) => path.join(config, "luseen", "limits.json");
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

function limits(change: Partial<PlanLimits> = {}): PlanLimits {
  return {
    version: 1,
    readAt: new Date(Date.now() - 120_000).toISOString(),
    status: "allowed",
    resetsAt: inHours(2),
    session: { used: 0.25, resetsAt: inHours(2), status: "allowed" },
    week: { used: 0.85, resetsAt: inHours(72), status: "allowed" },
    ...change,
  };
}

async function open(
  newest: Partial<RunState>,
  saved: PlanLimits | null,
): Promise<{ page: Page; jobs: ReturnType<typeof scriptedJobs>; config: string; gui: TestGui }> {
  const { root, config, home } = await project(newest);
  if (saved !== null) writeFileSync(limitsFile(config), JSON.stringify(saved));
  const jobs = scriptedJobs();
  const gui = await startTestGui(
    root,
    {},
    { startJob: jobs.startJob, every: () => () => undefined },
    { HOME: home, XDG_CONFIG_HOME: config },
  );
  running.push(gui);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
  await page.locator('[data-key="task-1"]').waitFor();
  return { page, jobs, config, gui };
}

describe("Claude plan limits instead of dollars", () => {
  it("TC-GUI-134: the top bar mirrors the session and weekly use, marks a high one, then a reached limit, then none", async () => {
    const { page, config } = await open({ outcome: "completed" }, limits());
    const bar = page.locator("#limits");
    await expect.poll(() => bar.locator('[data-limit="session"]').textContent()).toMatch(/^Session 25 % · resets /);
    expect(await bar.locator('[data-limit="week"]').textContent()).toMatch(/^Week 85 % · resets /);
    expect(await bar.locator('[data-limit="week"]').getAttribute("class")).toContain("is-high");
    expect(await bar.locator('[data-limit="session"]').getAttribute("class")).not.toContain("is-high");
    expect(await bar.locator(".limit-read").textContent()).toBe("as of 2 min ago");

    writeFileSync(
      limitsFile(config),
      JSON.stringify(limits({ status: "rejected", session: { used: 1, resetsAt: inHours(2), status: "rejected" } })),
    );
    await page.reload();
    await expect.poll(() => bar.locator(".is-reached").textContent()).toMatch(/^Limit reached · resets /);

    const past = new Date(Date.now() - 600_000).toISOString();
    writeFileSync(
      limitsFile(config),
      JSON.stringify(
        limits({ status: "rejected", resetsAt: past, session: { used: 1, resetsAt: past, status: "rejected" } }),
      ),
    );
    await page.reload();
    await expect.poll(() => bar.locator('[data-limit="session"]').textContent()).toMatch(/^Session · reset at /);
    expect(await bar.locator(".is-reached").count()).toBe(0);

    rmSync(limitsFile(config));
    await page.reload();
    await page.locator('[data-key="task-1"]').waitFor();
    expect(await bar.textContent()).toBe("");
  });

  it("TC-GUI-135: with costs in run.json, sessions and the workflow state, no screen shows a dollar amount", async () => {
    const { page } = await open({ outcome: "interrupted" }, limits());
    const dollars = () => page.evaluate(() => /\$\d/.test(document.body.innerText));
    expect(await dollars()).toBe(false);
    await page.locator('[data-key="task-2"]').click();
    await page.locator("#panel-body .steps").waitFor();
    expect(await dollars()).toBe(false);
    await page.locator('[data-frame="roadmap-1"] [data-action="open-roadmap"]').click();
    await page.locator("#panel-body .past-runs").waitFor();
    expect(await dollars()).toBe(false);
    await page.locator('[data-layout="list"]').click();
    expect(await dollars()).toBe(false);
  });

  it("TC-GUI-136: a stopped run's roadmap offers Continue, which plans and runs with that run's settings", async () => {
    const { page, jobs } = await open({ outcome: "interrupted" }, null);
    const frame = page.locator('[data-frame="roadmap-1"]');
    expect(await frame.locator('[data-action="run-ai"]').count()).toBe(0);
    await frame.locator('[data-action="continue-run"]').click();
    const dialog = page.locator("#auto-dialog");
    expect(await dialog.locator("#auto-title").textContent()).toBe("Continue the run");
    await expect.poll(() => dialog.locator('select[name="model"]').inputValue()).toBe("haiku");
    expect(await dialog.locator('select[name="effort"]').inputValue()).toBe("low");
    await dialog.locator("#auto-show-plan").click();
    await expect.poll(() => dialog.locator("#auto-start").isVisible()).toBe(true);
    await dialog.locator("#auto-start").click();
    await vi.waitFor(() => {
      expect(jobs.started.some((args) => args.includes("--yes"))).toBe(true);
    });
    const options = ["--roadmap=1", "--developers=2", "--model=haiku", "--effort=low", "--timeout-minutes=20"];
    const preview = jobs.started.find((args) => args.includes("--dry-run"));
    const run = jobs.started.find((args) => args.includes("--yes"));
    expect(preview).toEqual(["auto", ...options, "--dry-run", "--json"]);
    expect(run).toEqual(["auto", ...options, "--yes", "--json"]);
  });

  it("TC-GUI-136: a run that reached a plan limit offers Continue too, and one that completed offers Run with AI", async () => {
    const limited = await open({ outcome: "limit-reached", limitResetsAt: inHours(2) }, null);
    expect(await limited.page.locator('[data-frame="roadmap-1"] [data-action="continue-run"]').count()).toBe(1);
    await limited.page.locator('[data-frame="roadmap-1"] [data-action="open-roadmap"]').click();
    expect(await limited.page.locator(".past-runs").textContent()).toMatch(/limit-reached · resets /);
    const completed = await open({ outcome: "completed" }, null);
    expect(await completed.page.locator('[data-frame="roadmap-1"] [data-action="run-ai"]').count()).toBe(1);
    expect(await completed.page.locator('[data-frame="roadmap-1"] [data-action="continue-run"]').count()).toBe(0);
  });
});
