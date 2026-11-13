/// <reference lib="dom" />
/** QA: Claude plan limits instead of dollars (automated-mode FR-AUTO-025, 041; roadmap-planning FR-PLAN-015; gui FR-GUI-083, 084). */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { input, select } from "@inquirer/prompts";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { limitsFile, readPlanLimits, savePlanLimits } from "../../src/adapters/config/limits-store.js";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import type { JobProcess } from "../../src/application/gui-jobs.js";
import { runAutoCommand, type AutoOptions } from "../../src/cli/auto-command.js";
import { runPlanCommand } from "../../src/cli/plan-command.js";
import type { RunState } from "../../src/core/automation.js";
import { AUTO_REQUIRED_SKILLS } from "../../src/core/constants/agents.js";
import { CANVAS_POLL_MS } from "../../src/core/constants/gui.js";
import { exitCodeFor } from "../../src/core/errors.js";
import { isLimitReached, limitsFromEvent, type PlanLimits } from "../../src/core/limits.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";
import { startTestGui, type TestGui } from "../support/gui.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn(), input: vi.fn() }));
const selectMock = vi.mocked(select);
const inputMock = vi.mocked(input);

const isTty = process.stdin.isTTY;
beforeEach(() => {
  process.stdin.isTTY = false;
});
afterEach(() => {
  process.stdin.isTTY = isTty;
  vi.resetAllMocks();
});

/** What Claude Code 2.1.322 really emitted. */
const REAL_EVENT = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1794532800,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "org_level_disabled",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.01, resetsAt: 1794532800, status: "allowed" },
      seven_day: { utilization: 0.32, resetsAt: 1794927600, status: "allowed" },
    },
  },
  uuid: "00000000-0000-4000-8000-000000000000",
  session_id: "11111111-1111-4111-8111-111111111111",
};
const RESETS_AT = 1794532800;
const RESETS_ISO = new Date(RESETS_AT * 1000).toISOString();
const rejectedEvent = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "rejected",
    resetsAt: RESETS_AT,
    unifiedWindows: { five_hour: { utilization: 1, resetsAt: RESETS_AT, status: "rejected" } },
  },
};

describe("QA: reading the limits", () => {
  const now = new Date("2026-11-13T10:00:00Z");

  it("reads Claude Code 2.1.322's real event and keeps nothing about the account", () => {
    const limits = limitsFromEvent(REAL_EVENT, now);
    expect(limits).toEqual({
      version: 1,
      readAt: now.toISOString(),
      status: "allowed",
      resetsAt: RESETS_ISO,
      session: { used: 0.01, resetsAt: RESETS_ISO, status: "allowed" },
      week: { used: 0.32, resetsAt: new Date(1794927600 * 1000).toISOString(), status: "allowed" },
    });
    expect(JSON.stringify(limits)).not.toMatch(/overage|session_id|uuid|org_level/);
    expect(isLimitReached(limits as PlanLimits)).toBe(false);
  });

  it("treats allowed_warning as allowed and rejected as reached; partial and odd windows are lenient", () => {
    const of = (info: object) => limitsFromEvent({ type: "rate_limit_event", rate_limit_info: info }, now);
    expect(isLimitReached(of({ status: "allowed_warning" }) as PlanLimits)).toBe(false);
    expect(isLimitReached(of({ status: "rejected" }) as PlanLimits)).toBe(true);
    const weekOnly = of({ status: "allowed", unifiedWindows: { seven_day: { utilization: 0.5 } } });
    expect(weekOnly?.session).toBeNull();
    expect(weekOnly?.week).toEqual({ used: 0.5, resetsAt: null, status: "allowed" });
    const odd = of({
      status: "allowed",
      unifiedWindows: { five_hour: { utilization: 1.7 }, seven_day: { utilization: -1 } },
    });
    expect(odd?.session?.used).toBe(1);
    expect(odd?.week?.used).toBe(0);
    expect(of({ status: "allowed", unifiedWindows: { five_hour: { utilization: "x" } } })).toBeUndefined();
    expect(limitsFromEvent({ type: "result" }, now)).toBeUndefined();
    expect(limitsFromEvent(null, now)).toBeUndefined();
  });

  it("limits.json: saved atomically next to config.json; unreadable, garbage, partial or newer files read as none", async () => {
    const home = makeTempFolder();
    const environment = { HOME: home, XDG_CONFIG_HOME: path.join(home, "cfg") };
    expect(limitsFile(environment)).toBe(path.join(home, "cfg", "cclinic", "limits.json"));
    expect(await readPlanLimits(environment)).toBeNull();
    const limits = limitsFromEvent(REAL_EVENT, now) as PlanLimits;
    await savePlanLimits(environment, limits);
    expect(readdirSync(path.join(home, "cfg", "cclinic"))).toEqual(["limits.json"]);
    expect(await readPlanLimits(environment)).toEqual(limits);
    const file = limitsFile(environment);
    for (const text of [
      "",
      "garbage{",
      "null",
      "[]",
      JSON.stringify({ ...limits, week: undefined }),
      JSON.stringify({ ...limits, version: 2 }),
      JSON.stringify({ ...limits, extra: 1 }),
    ]) {
      writeFileSync(file, text);
      expect(await readPlanLimits(environment)).toBeNull();
    }
  });
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function repository(): string {
  const root = makeTempFolder();
  writeProject(root, {
    "README.md": "# App\n",
    ".cclinic/sdd/README.md": "# Specs\n",
    ...Object.fromEntries(AUTO_REQUIRED_SKILLS.map((skill) => [`.claude/skills/${skill}/SKILL.md`, `# ${skill}\n`])),
  });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "dev@example.com");
  git(root, "config", "user.name", "Dev");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  return root;
}

function roadmap(root: string, keys: string[]) {
  const store = openTaskStore(path.join(root, ".cclinic"), "create");
  if (store === undefined) throw new Error("No store");
  store.savePlan({
    roadmap: { title: "Launch", goal: "Ship" },
    milestones: [
      {
        title: "M1",
        goal: "Start",
        tasks: keys.map((key) => ({ key, title: `Task ${key}`, description: "", spec: null, dependsOn: [] })),
      },
    ],
  });
  store.close();
}

function happyRules(taskIds: readonly number[], overrides: FakeClaudeRule[] = []): FakeClaudeRule[] {
  return [
    ...overrides,
    ...taskIds.flatMap((id): FakeClaudeRule[] => [
      {
        match: `developer agent.*Task #${id}:.*## Stage: spec`,
        times: 0,
        write: { [`.cclinic/sdd/specs/t${id}.md`]: `# t${id}\n` },
      },
      {
        match: `developer agent.*Task #${id}:.*## Stage: (implement|fix)`,
        times: 0,
        write: { [`src/t${id}.txt`]: `task ${id}\n` },
      },
    ]),
    { match: "QA agent", times: 0, output: { result: "pass", failures: [], summary: "ok" } },
    { match: "reviewing a spec change", times: 0, output: { verdict: "approve", feedback: "" } },
    {
      match: "reviewing finished work",
      times: 0,
      output: { verdict: "approve", feedback: "", requirementIds: ["FR-CORE-001"] },
    },
  ];
}

async function auto(root: string, harness: ReturnType<typeof agentHarness>, options: Partial<AutoOptions> = {}) {
  return runAutoCommand(
    { dir: root, roadmap: 1, developers: 1, timeoutMinutes: 30, yes: true, model: "haiku", effort: "low", ...options },
    harness.context,
  );
}

function runState(root: string): RunState {
  const folder = path.join(root, ".cclinic/auto");
  const [runId] = readdirSync(folder).filter((name) => name !== ".lock");
  return JSON.parse(readFileSync(path.join(folder, runId ?? "", "run.json"), "utf8")) as RunState;
}
function report(root: string): string {
  const folder = path.join(root, ".cclinic/auto");
  const [runId] = readdirSync(folder).filter((name) => name !== ".lock");
  return readFileSync(path.join(folder, runId ?? "", "report.md"), "utf8");
}

describe("limits.json saves", () => {
  it("FR-AUTO-041: saves made at the same time leave one whole file, holding the newest report", async () => {
    const home = makeTempFolder();
    const environment = { HOME: home, XDG_CONFIG_HOME: path.join(home, "cfg") };
    const base = limitsFromEvent(REAL_EVENT, new Date()) as PlanLimits;
    const reports = Array.from({ length: 20 }, (_, index) => ({
      ...base,
      readAt: new Date(index * 1000).toISOString(),
    }));
    await Promise.all(reports.map((limits) => savePlanLimits(environment, limits)));
    expect(readdirSync(path.join(home, "cfg", "cclinic"))).toEqual(["limits.json"]);
    expect(await readPlanLimits(environment)).toEqual(reports.at(-1));
  });
});

describe("QA: a plain HTTP 429 isn't a usage limit", () => {
  it("FR-AUTO-025: a 429 with an allowed rate_limit_event fails the round, which is retried, and the run completes", async () => {
    const root = repository();
    roadmap(root, ["a"]);
    const throttled: FakeClaudeRule = {
      match: "reviewing a spec change",
      times: 1,
      events: [REAL_EVENT],
      exitCode: 1,
      apiErrorStatus: 429,
      message: "API Error: 429 rate_limit_error",
    };
    const harness = agentHarness({ rules: happyRules([1], [throttled]) });
    expect(await auto(root, harness)).toBe(0);
    const state = runState(root);
    expect(state.outcome).toBe("completed");
    expect(state.limitResetsAt).toBeNull();
    expect(state.tasks[0]?.status).toBe("done");
    expect(state.tasks[0]?.rounds.specReviews).toBe(2);
    expect(harness.calls().filter((call) => call.prompt.includes("reviewing a spec change"))).toHaveLength(2);
  });

  it("FR-AUTO-025: a 429 ending with Claude Code's bare 'hit your limit' message is a usage limit", async () => {
    const root = repository();
    roadmap(root, ["a"]);
    const limit: FakeClaudeRule = {
      match: "developer agent",
      times: 1,
      exitCode: 1,
      apiErrorStatus: 429,
      message: "You've hit your limit · resets 4am",
    };
    const harness = agentHarness({ rules: happyRules([1], [limit]) });
    expect(await auto(root, harness)).toBe(1);
    const state = runState(root);
    expect(state.outcome).toBe("limit-reached");
    expect(state.tasks[0]?.status).toBe("open");
    expect(harness.calls()).toHaveLength(1);
  });
});

describe("QA: auto at a plan usage limit", () => {
  it("the call that hit the limit isn't a rejected round: the task isn't blocked or retried, and --json shows the reset and no cost", async () => {
    const root = repository();
    roadmap(root, ["a", "b"]);
    const limit: FakeClaudeRule = {
      match: "reviewing a spec change",
      times: 1,
      events: [rejectedEvent],
      exitCode: 1,
      message: "You've hit your session limit · resets 4am",
    };
    const harness = agentHarness({ rules: happyRules([1, 2], [limit]) });
    expect(await auto(root, harness, { json: true })).toBe(1);
    const state = runState(root);
    expect(state.outcome).toBe("limit-reached");
    expect(state.limitResetsAt).toBe(RESETS_ISO);
    expect(state.tasks.map((task) => task.status)).toEqual(["open", "open"]);
    expect(state.tasks[0]?.reason).toContain("usage limit");
    expect(state).toMatchObject({ developers: 1, model: "haiku", effort: "low", timeoutMinutes: 30 });
    expect(state).not.toHaveProperty("budgetUsd");
    expect(harness.calls().filter((call) => call.prompt.includes("reviewing a spec change"))).toHaveLength(1);
    const json = JSON.parse(harness.output.out) as Record<string, unknown>;
    expect(json).toMatchObject({ outcome: "limit-reached", limitResetsAt: RESETS_ISO });
    expect(JSON.stringify(json)).not.toMatch(/cost|budget|\$/i);
    expect(report(root)).not.toMatch(/\$|cost|budget/i);
  });

  it("only Claude's usage-limit message (no event): limit-reached, with the reset 'later'", async () => {
    const root = repository();
    roadmap(root, ["a"]);
    const limit: FakeClaudeRule = {
      match: "developer agent",
      times: 1,
      exitCode: 1,
      message: "You've hit your weekly limit · resets Nov 20",
    };
    const harness = agentHarness({ rules: happyRules([1], [limit]) });
    expect(await auto(root, harness)).toBe(1);
    const state = runState(root);
    expect(state.outcome).toBe("limit-reached");
    expect(state.limitResetsAt).toBeNull();
    expect(state.tasks[0]?.status).toBe("open");
    expect(harness.calls()).toHaveLength(1);
    expect(report(root)).toContain("resets later");
  });

  it("with 2 developers, the other agent finishes, nothing new starts, and its task goes back to open", async () => {
    const root = repository();
    roadmap(root, ["a", "b"]);
    const slow: FakeClaudeRule = {
      match: "developer agent.*Task #1:.*## Stage: spec",
      times: 1,
      delayMs: 1500,
      write: { ".cclinic/sdd/specs/t1.md": "# t1\n" },
    };
    const limit: FakeClaudeRule = {
      match: "developer agent.*Task #2:",
      times: 1,
      events: [rejectedEvent],
      exitCode: 1,
      message: "You've hit your session limit · resets 4am",
    };
    const harness = agentHarness({ rules: happyRules([1, 2], [slow, limit]) });
    expect(await auto(root, harness, { developers: 2 })).toBe(1);
    const state = runState(root);
    expect(state.outcome).toBe("limit-reached");
    expect(state.tasks.map((task) => task.status)).toEqual(["open", "open"]);
    expect(harness.calls()).toHaveLength(2);
    const store = openTaskStore(path.join(root, ".cclinic"), "create");
    expect(store?.listTasks(true).map((task) => task.status)).toEqual(["open", "open"]);
    store?.close();
  });

  it("FR-AUTO-025: a rate_limit_event that isn't allowed stops new agents even if that call itself succeeded", async () => {
    const root = repository();
    roadmap(root, ["a"]);
    const limit: FakeClaudeRule = {
      match: "developer agent.*## Stage: spec",
      times: 1,
      events: [rejectedEvent],
      write: { ".cclinic/sdd/specs/t1.md": "# t1\n" },
    };
    const harness = agentHarness({ rules: happyRules([1], [limit]) });
    const code = await auto(root, harness);
    expect({ code, outcome: runState(root).outcome, calls: harness.calls().length }).toEqual({
      code: 1,
      outcome: "limit-reached",
      calls: 1,
    });
    const state = runState(root);
    expect(state.limitResetsAt).toBe(RESETS_ISO);
    expect(state.tasks.map((task) => task.status)).toEqual(["open"]);
    expect(state.tasks[0]?.rounds).toEqual({ specReviews: 1, qaRuns: 0, implementationReviews: 0 });
    const store = openTaskStore(path.join(root, ".cclinic"), "create");
    expect(store?.listTasks(true).map((task) => task.status)).toEqual(["open"]);
    store?.close();
  });

  it("FR-AUTO-025: the last call succeeds while reporting a rejected limit, with every task done: completed, exit 0, no continue advice", async () => {
    const root = repository();
    roadmap(root, ["a"]);
    const lastCall: FakeClaudeRule = {
      match: "reviewing finished work",
      times: 1,
      events: [rejectedEvent],
      output: { verdict: "approve", feedback: "", requirementIds: ["FR-CORE-001"] },
    };
    const harness = agentHarness({ rules: happyRules([1], [lastCall]) });
    expect(await auto(root, harness, { json: true })).toBe(0);
    const state = runState(root);
    expect(state.outcome).toBe("completed");
    expect(state.tasks.map((task) => task.status)).toEqual(["done"]);
    expect(harness.calls().filter((call) => call.prompt.includes("reviewing finished work"))).toHaveLength(1);
    const json = JSON.parse(harness.output.out) as Record<string, unknown>;
    expect(json.outcome).toBe("completed");
    expect(json).not.toHaveProperty("limitResetsAt");
    expect(report(root)).toContain("- Outcome: completed");
    expect(report(root)).not.toMatch(/continue|usage limit/i);
    const store = openTaskStore(path.join(root, ".cclinic"), "create");
    expect(store?.listTasks(true).map((task) => task.status)).toEqual(["done"]);
    store?.close();
  });

  it("FR-AUTO-025: a rejected limit on the last call of one task with another task left: limit-reached, the other stays open", async () => {
    const root = repository();
    roadmap(root, ["a", "b"]);
    const lastCall: FakeClaudeRule = {
      match: "reviewing finished work",
      times: 1,
      events: [rejectedEvent],
      output: { verdict: "approve", feedback: "", requirementIds: ["FR-CORE-001"] },
    };
    const harness = agentHarness({ rules: happyRules([1, 2], [lastCall]) });
    expect(await auto(root, harness)).toBe(1);
    const state = runState(root);
    expect(state.outcome).toBe("limit-reached");
    expect(state.tasks.map((task) => task.status)).toEqual(["done", "open"]);
    expect(harness.calls().some((call) => call.prompt.includes("Task #2:"))).toBe(false);
    expect(report(root)).toContain("continue the run then");
  });

  it("FR-AUTO-041: limits.json keeps only the windows from the real event", async () => {
    const root = repository();
    roadmap(root, ["a"]);
    const harness = agentHarness({ rules: happyRules([1]).map((rule) => ({ ...rule, events: [REAL_EVENT] })) });
    expect(await auto(root, harness)).toBe(0);
    const saved = JSON.parse(readFileSync(limitsFile(harness.environment), "utf8")) as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual(["readAt", "resetsAt", "session", "status", "version", "week"]);
    expect(JSON.stringify(saved)).not.toMatch(/overage|session_id|uuid|Task/);
  });
});

describe("QA: plan at a plan usage limit", () => {
  const questions = (text: string) => ({ questions: [text], proposal: null });

  function project(): string {
    const root = makeTempFolder();
    writeProject(root, { ".cclinic/sdd/overview.md": "# Overview\n", ".cclinic/sdd/README.md": "# Specs\n" });
    roadmap(root, ["x"]);
    return root;
  }

  it("FR-PLAN-015: names the reset time from the rate_limit_event even when Claude's message doesn't, and saves the limits", async () => {
    process.stdin.isTTY = true;
    const root = project();
    const harness = agentHarness({
      rules: [
        { output: questions("Who pays?"), events: [REAL_EVENT] },
        { events: [rejectedEvent], exitCode: 1, message: "API Error: 429 rate_limit_error" },
      ],
    });
    selectMock.mockResolvedValueOnce("new");
    inputMock.mockResolvedValueOnce("Shoppers");
    const error = await runPlanCommand(
      { dir: root, timeoutMinutes: 30, model: "haiku", effort: "low" },
      harness.context,
    ).catch((caught: unknown) => caught);
    expect(exitCodeFor(error)).toBe(4);
    expect(existsSync(limitsFile(harness.environment))).toBe(true);
    expect((error as Error).message).toBe(
      `The PM stopped: Claude's usage limit is reached. It resets ${RESETS_ISO}. Nothing was saved. Plan again once it resets.`,
    );
  });
});

// GUI ------------------------------------------------------------------------------------------------------------

let browser: Browser;
const guis: TestGui[] = [];
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});
afterEach(async () => {
  await Promise.all(browser.contexts().map((context) => context.close()));
  await Promise.all(guis.splice(0).map((gui) => gui.stop()));
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
const PLAN = { status: "plan", roadmapId: 1, plan: "Roadmap #1: Payments", runnable: [2], blocked: [] };

function scriptedJobs() {
  const started: string[][] = [];
  const startJob = (args: readonly string[]): JobProcess => {
    started.push([...args]);
    let exit: ((code: number) => void) | undefined;
    let print: ((stream: "stdout" | "stderr", chunk: string) => void) | undefined;
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

/** Roadmap 1 with task 1 done and task 2 as given, and one run.json written as given (raw, to allow old shapes). */
function guiProject(run: Record<string, unknown>, task2Status = "open") {
  const root = makeTempFolder();
  mkdirSync(path.join(root, ".cclinic/sdd"), { recursive: true });
  const store = openTaskStore(path.join(root, ".cclinic"), "create");
  if (store === undefined) throw new Error("No store");
  store.savePlan({
    roadmap: { title: "Payments", goal: "Card checkout" },
    milestones: [
      {
        title: "Cards",
        goal: "Pay",
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
  if (task2Status !== "open") store.setStatus(2, task2Status as "in-progress" | "blocked");
  store.close();
  const runId = "20261112-150000";
  const folder = path.join(root, ".cclinic/auto", runId);
  mkdirSync(path.join(folder, "sessions"), { recursive: true });
  writeFileSync(
    path.join(folder, "run.json"),
    JSON.stringify({
      runId,
      roadmapId: 1,
      roadmapTitle: "Payments",
      runBranch: `cclinic/auto/${runId}/run`,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      finishedAt: new Date(Date.now() - 1_800_000).toISOString(),
      outcome: "interrupted",
      spentUsd: 3.4,
      developers: 3,
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
      ...run,
    }),
  );
  writeFileSync(path.join(folder, "report.md"), "# Report\n");
  const home = makeTempFolder();
  const config = path.join(home, "config");
  mkdirSync(path.join(config, "cclinic"), { recursive: true });
  return { root, home, config };
}

async function openGui(
  setup: ReturnType<typeof guiProject>,
  view: { width?: number; timezoneId?: string; locale?: string } = {},
): Promise<{ page: Page; jobs: ReturnType<typeof scriptedJobs> }> {
  const jobs = scriptedJobs();
  const gui = await startTestGui(
    setup.root,
    {},
    { startJob: jobs.startJob, every: () => () => undefined },
    { HOME: setup.home, XDG_CONFIG_HOME: setup.config },
  );
  guis.push(gui);
  const context = await browser.newContext({
    viewport: { width: view.width ?? 1280, height: 900 },
    ...(view.timezoneId === undefined ? {} : { timezoneId: view.timezoneId }),
    ...(view.locale === undefined ? {} : { locale: view.locale }),
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
  await page.locator('[data-key="task-1"]').waitFor();
  return { page, jobs };
}

const limitsPath = (config: string) => path.join(config, "cclinic", "limits.json");
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const limits = (change: Partial<PlanLimits> = {}): PlanLimits => ({
  version: 1,
  readAt: new Date(Date.now() - 60_000).toISOString(),
  status: "allowed",
  resetsAt: inHours(2),
  session: { used: 0.25, resetsAt: inHours(2), status: "allowed" },
  week: { used: 0.85, resetsAt: inHours(72), status: "allowed" },
  ...change,
});

async function continueAndRun(page: Page, jobs: ReturnType<typeof scriptedJobs>) {
  await page.locator('[data-frame="roadmap-1"] [data-action="continue-run"]').click();
  const dialog = page.locator("#auto-dialog");
  await expect.poll(() => dialog.locator('select[name="model"] option').count()).toBeGreaterThan(1);
  await dialog.locator("#auto-show-plan").click();
  await expect.poll(() => dialog.locator("#auto-start").isVisible()).toBe(true);
  await dialog.locator("#auto-start").click();
  await vi.waitFor(() => {
    expect(jobs.started.some((args) => args.includes("--yes"))).toBe(true);
  });
  return {
    preview: jobs.started.find((args) => args.includes("--dry-run")),
    run: jobs.started.find((args) => args.includes("--yes")),
  };
}

describe("QA: GUI limits and Continue", () => {
  it("an old run.json (budgetUsd, no model) still shows with no dollars, and Continue uses its developers with defaults", async () => {
    const setup = guiProject({ budgetUsd: 20 });
    const { page, jobs } = await openGui(setup);
    expect(await page.evaluate(() => /\$\d/.test(document.body.innerText))).toBe(false);
    const { preview, run } = await continueAndRun(page, jobs);
    expect(preview).toEqual(["auto", "--roadmap=1", "--developers=3", "--dry-run", "--json"]);
    expect(run).toEqual(["auto", "--roadmap=1", "--developers=3", "--yes", "--json"]);
    await page.locator('[data-frame="roadmap-1"] [data-action="open-roadmap"]').click();
    await page.locator("#panel-body .past-runs").waitFor();
    expect(await page.evaluate(() => /\$\d/.test(document.body.innerText))).toBe(false);
  });

  it("FR-GUI-084: Continue keeps the saved model even when it isn't in the model list", async () => {
    const setup = guiProject({ model: "opus", effort: "low", timeoutMinutes: 20 });
    const { page, jobs } = await openGui(setup);
    const { run } = await continueAndRun(page, jobs);
    expect(run).toContain("--model=opus");
  });

  it("an old budget-reached run offers Run with AI, not Continue", async () => {
    const { page } = await openGui(guiProject({ outcome: "budget-reached", budgetUsd: 5 }));
    const frame = page.locator('[data-frame="roadmap-1"]');
    expect(await frame.locator('[data-action="run-ai"]').count()).toBe(1);
    expect(await frame.locator('[data-action="continue-run"]').count()).toBe(0);
  });

  it("FR-GUI-084: only open or blocked tasks left (one in progress) offers no Continue", async () => {
    const { page } = await openGui(guiProject({}, "in-progress"));
    expect(await page.locator('[data-frame="roadmap-1"] [data-action="continue-run"]').count()).toBe(0);
  });

  it("FR-GUI-084: a blocked task left (no open one) still offers Continue, since a run takes blocked tasks", async () => {
    const { page } = await openGui(guiProject({}, "blocked"));
    expect(await page.locator('[data-frame="roadmap-1"] [data-action="continue-run"]').count()).toBe(1);
  });

  it("garbage limits.json: the canvas loads and the top bar shows no limits", async () => {
    const setup = guiProject({ outcome: "completed" });
    writeFileSync(limitsPath(setup.config), "{garbage");
    const { page } = await openGui(setup);
    expect(await page.locator("#limits").textContent()).toBe("");
  });

  it("limits.json that is a folder: the canvas still loads with no limits", async () => {
    const setup = guiProject({ outcome: "completed" });
    mkdirSync(limitsPath(setup.config));
    const { page } = await openGui(setup);
    expect(await page.locator("#limits").textContent()).toBe("");
  });

  it("768 px with a reached limit and both windows: the top bar fits and nothing scrolls sideways", async () => {
    const setup = guiProject({ outcome: "limit-reached", limitResetsAt: inHours(30) });
    writeFileSync(
      limitsPath(setup.config),
      JSON.stringify(
        limits({
          status: "rejected",
          resetsAt: inHours(30),
          session: { used: 1, resetsAt: inHours(30), status: "rejected" },
          week: { used: 0.99, resetsAt: inHours(150), status: "allowed" },
        }),
      ),
    );
    const { page } = await openGui(setup, { width: 768, locale: "de-DE" });
    await expect.poll(() => page.locator("#limits .is-reached").count()).toBe(1);
    const sizes = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      bar: document.querySelector("#limits")?.getBoundingClientRect().right ?? 0,
    }));
    expect(sizes.doc).toBeLessThanOrEqual(768);
    expect(sizes.bar).toBeLessThanOrEqual(768);
  });

  it("reset times follow the viewer's time zone; one more than a day away names the day", async () => {
    const setup = guiProject({ outcome: "completed" });
    const at = new Date(Date.now() + 30 * 3_600_000);
    writeFileSync(
      limitsPath(setup.config),
      JSON.stringify(limits({ session: { used: 0.1, resetsAt: at.toISOString(), status: "allowed" } })),
    );
    const { page } = await openGui(setup, { timezoneId: "Asia/Tokyo", locale: "en-US" });
    const expected = at.toLocaleString("en-US", {
      timeZone: "Asia/Tokyo",
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
    await expect
      .poll(() => page.locator('[data-limit="session"]').textContent())
      .toBe(`Session 10 % · resets ${expected}`);
  });
});

describe("QA: a window resets while the page is open", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("FR-GUI-083: the server's canvas tick re-renders a reached session as reset once its time passes, with no reload", async () => {
    const setup = guiProject({ outcome: "completed" });
    const sessionReset = inHours(1);
    writeFileSync(
      limitsPath(setup.config),
      JSON.stringify(
        limits({
          status: "rejected",
          resetsAt: sessionReset,
          session: { used: 1, resetsAt: sessionReset, status: "rejected" },
          week: { used: 0.5, resetsAt: inHours(72), status: "allowed" },
        }),
      ),
    );
    const ticks: (() => Promise<void>)[] = [];
    const jobs = scriptedJobs();
    const gui = await startTestGui(
      setup.root,
      {},
      {
        startJob: jobs.startJob,
        every: (ms, run) => {
          if (ms === CANVAS_POLL_MS) ticks.push(run);
          return () => undefined;
        },
      },
      { HOME: setup.home, XDG_CONFIG_HOME: setup.config },
    );
    guis.push(gui);
    const page = await (await browser.newContext({ locale: "en-US" })).newPage();
    await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
    await page.locator('[data-key="task-1"]').waitFor();
    const bar = page.locator("#limits");
    await expect.poll(() => bar.locator(".is-reached").textContent()).toMatch(/^Limit reached · resets /);
    expect(await bar.locator('[data-limit="session"]').textContent()).toMatch(/^Session 100 % · resets /);
    expect(ticks.length).toBeGreaterThan(0);

    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(sessionReset) + 60_000 });
    await Promise.all(ticks.map((tick) => tick()));
    vi.useRealTimers();

    const expected = new Date(sessionReset).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" });
    await expect.poll(() => bar.locator('[data-limit="session"]').textContent()).toBe(`Session · reset at ${expected}`);
    expect(await bar.locator(".is-reached").count()).toBe(0);
    expect(await bar.locator('[data-limit="session"]').getAttribute("class")).toBe("limit");
    expect(await bar.locator('[data-limit="week"]').textContent()).toMatch(/^Week 50 % · resets /);
  });
});
