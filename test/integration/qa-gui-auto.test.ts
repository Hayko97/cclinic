/// <reference lib="dom" />
/** QA for stage D4, Run with AI: edge cases of the dry run, the plan form, Stop, and a run's files (spec: gui). */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import type { JobProcess } from "../../src/application/gui-jobs.js";
import type { RunState } from "../../src/core/automation.js";
import type { CanvasView } from "../../src/core/canvas.js";
import { AUTO_REQUIRED_SKILLS, RUN_FILE_MAX_CHARS } from "../../src/core/constants/agents.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";
import { sendTo, startTestGui, type TestGui } from "../support/gui.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const LIVE_RUN = "20261112-150000";
const OLD_RUN = "20261110-090000";

let browser: Browser;
const running: TestGui[] = [];
const locked: string[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  for (const folder of locked.splice(0)) chmodSync(folder, 0o755);
  await Promise.all(browser.contexts().map((context) => context.close()));
  await Promise.all(running.splice(0).map((gui) => gui.stop()));
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** A committed, ready project with roadmap 1 "Launch" (tasks 1, 2 after 1), and roadmap 2 "Later" (task 3). */
function repository(title = "Launch"): string {
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
    roadmap: { title, goal: "Ship" },
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
  store.savePlan({
    roadmap: { title: "Later", goal: "More" },
    milestones: [
      {
        title: "M2",
        goal: "Next",
        tasks: [{ key: "c", title: "Task c", description: "", spec: null, dependsOn: [] }],
      },
    ],
  });
  store.close();
  return root;
}

function changeStore(root: string, change: (store: NonNullable<ReturnType<typeof openTaskStore>>) => void): void {
  const store = openTaskStore(path.join(root, ".cclinic"), "update");
  if (store === undefined) throw new Error("No store");
  change(store);
  store.close();
}

/** Runs the real `cclinic` program, with the fake `claude` first on PATH and no terminal. */
function cli(root: string, harness: ReturnType<typeof agentHarness>, ...args: string[]) {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "bin/cclinic.js"), ...args], {
    cwd: root,
    env: harness.environment,
    encoding: "utf8",
    timeout: 30_000,
    input: "",
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

async function startReal(root: string, rules: FakeClaudeRule[] = []): Promise<TestGui> {
  const harness = agentHarness({ rules });
  const gui = await startTestGui(root, {}, {}, harness.environment);
  running.push(gui);
  return gui;
}

const postJob = (gui: TestGui, body: unknown) => sendTo(gui, "POST", "/api/jobs", body);
const canvasOf = async (gui: TestGui) =>
  (JSON.parse((await sendTo(gui, "GET", "/api/canvas")).body) as { canvas: CanvasView }).canvas;
const errorOf = (body: string) => (JSON.parse(body) as { error: string }).error;

function runState(runId: string, change: Partial<RunState> = {}): RunState {
  return {
    runId,
    roadmapId: 1,
    roadmapTitle: "Launch",
    runBranch: `cclinic/auto/${runId}/run`,
    startedAt: new Date(Date.now() - 600_000).toISOString(),
    finishedAt: null,
    outcome: null,
    model: "haiku",
    effort: "low",
    timeoutMinutes: 30,
    limitResetsAt: null,
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

const finished = { finishedAt: new Date().toISOString(), outcome: "completed" as const, spentUsd: 2 };

/** Jobs whose dry run answers only when `release` is called; anything else answers with the plan at once. */
function heldJobs(planFor: (args: readonly string[]) => unknown) {
  const started: string[][] = [];
  const held: (() => void)[] = [];
  const startJob = (args: readonly string[]): JobProcess => {
    started.push([...args]);
    let print: ((stream: "stdout" | "stderr", chunk: string) => void) | undefined;
    let exit: ((code: number) => void) | undefined;
    return {
      onOutput: (listener) => {
        print = listener;
      },
      onExit: (listener) => {
        exit = listener;
        const answer = () => {
          const result = args[0] === "model" ? MODELS : planFor(args);
          print?.("stdout", `${JSON.stringify(result)}\n`);
          listener(0);
        };
        if (args.includes("--dry-run")) held.push(answer);
        else if (!args.includes("--yes")) void Promise.resolve().then(answer);
      },
      signal: () => exit?.(130),
    };
  };
  return { started, held, startJob };
}

const MODELS = {
  models: [{ value: "haiku", label: "Haiku" }],
  efforts: [
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
  ],
  current: { model: "haiku", effort: "low" },
};

function planOf(args: readonly string[]) {
  const developers = args.find((arg) => arg.startsWith("--developers="))?.split("=")[1] ?? "2";
  return {
    status: "plan",
    roadmapId: 1,
    plan: `Roadmap #1: Launch\nDevelopers: ${developers}\n\nTasks in run order:\n  #1 Task a`,
    runnable: [1, 2],
    blocked: [],
  };
}

async function openPage(gui: TestGui, viewport = { width: 1280, height: 900 }, theme?: "dark"): Promise<Page> {
  const context = await browser.newContext({ viewport, colorScheme: theme ?? "light" });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
  await page.locator('[data-key="task-1"]').waitFor();
  return page;
}

describe("QA: cclinic auto --dry-run as a program", () => {
  it("TC-AUTO-061: text output is the plan, exit 0, no prompt, no claude, and nothing created", () => {
    const root = repository();
    const harness = agentHarness();
    const branches = git(root, "branch", "--list");
    const status = git(root, "status", "--porcelain", "--ignored");
    const text = cli(root, harness, "auto", "--roadmap", "1", "--dry-run");
    expect(text.code, text.err).toBe(0);
    expect(text.out).toContain("Roadmap #1: Launch");
    expect(text.out).toContain("Tasks in run order:\n  #1 Task a\n  #2 Task b (after #1)");
    expect(text.out).not.toMatch(/\{"status"/);
    const json = cli(root, harness, "auto", "--roadmap", "1", "--dry-run", "--json");
    expect(json.code, json.err).toBe(0);
    const lines = json.out.trim().split("\n");
    expect(lines).toHaveLength(1);
    const result = JSON.parse(lines[0] ?? "") as { plan: string; runnable: number[]; blocked: number[] };
    expect(result.runnable).toEqual([1, 2]);
    expect(result.blocked).toEqual([]);
    // The same plan, apart from the run ID in the branch name, which is made from the time.
    const withoutRunId = (plan: string) => plan.replace(/\d{8}-\d{6}(-\d+)?/g, "<run>");
    expect(withoutRunId(text.out.trim())).toBe(withoutRunId(result.plan));
    expect(harness.calls()).toEqual([]);
    expect(existsSync(path.join(root, ".cclinic/auto"))).toBe(false);
    expect(git(root, "branch", "--list")).toBe(branches);
    expect(git(root, "status", "--porcelain", "--ignored")).toBe(status);
  });

  it("FR-AUTO-040: tasks that can't run are listed as blocked in the JSON and the plan", () => {
    const root = repository();
    // Task 2 waits on task 3, which is in roadmap 2 and so not in this run.
    changeStore(root, (store) => store.addDependency(2, 3));
    const harness = agentHarness();
    const json = cli(root, harness, "auto", "--roadmap", "1", "--dry-run", "--json");
    expect(json.code, json.err).toBe(0);
    const result = JSON.parse(json.out) as { plan: string; runnable: number[]; blocked: number[] };
    expect(result.runnable).toEqual([1]);
    expect(result.blocked).toEqual([2]);
    expect(result.plan).toContain("Won't run:\n  #2: Blocked by task #3");
  });

  it("FR-AUTO-040: a roadmap with no open tasks is refused with exit 2, and as JSON with the message", () => {
    const root = repository();
    changeStore(root, (store) => {
      store.setStatus(1, "done");
      store.setStatus(2, "done");
    });
    const harness = agentHarness();
    const text = cli(root, harness, "auto", "--roadmap", "1", "--dry-run");
    expect(text.code).toBe(2);
    expect(text.err).toContain("Roadmap 1 has no open or blocked tasks to run.");
    expect(existsSync(path.join(root, ".cclinic/auto"))).toBe(false);
  });

  it("FR-AUTO-040, TC-AUTO-064: a dry run needs no budget, refuses the removed --max-budget-usd, and never opens a menu", () => {
    const root = repository();
    const harness = agentHarness();
    const result = cli(root, harness, "auto", "--roadmap", "1", "--dry-run");
    expect(result.code).toBe(0);
    expect(result.out).toContain("Roadmap #1:");
    const removed = cli(root, harness, "auto", "--roadmap", "1", "--max-budget-usd", "5", "--dry-run");
    expect(removed.code).toBe(2);
    expect(removed.err).toContain("--max-budget-usd");
    expect(existsSync(path.join(root, ".cclinic/auto"))).toBe(false);
  });
});

describe("QA: Run with AI through the API", () => {
  it("TC-GUI-037: the plan from the real CLI is the text cclinic auto prints, and nothing starts", async () => {
    const root = repository();
    const gui = await startReal(root);
    const reply = await postJob(gui, { command: "auto", options: { roadmap: 1, developers: 2 } });
    expect(reply.status, reply.body).toBe(200);
    const { plan } = JSON.parse(reply.body) as { plan: { plan: string; runnable: number[] } };
    const printed = cli(root, agentHarness(), "auto", "--roadmap", "1", "--developers", "2", "--dry-run");
    const withoutRunId = (text: string) => text.replace(/\d{8}-\d{6}(-\d+)?/g, "<run>");
    expect(withoutRunId(plan.plan)).toBe(withoutRunId(printed.out.trim()));
    expect(plan.runnable).toEqual([1, 2]);
    expect(existsSync(path.join(root, ".cclinic/auto"))).toBe(false);
    const jobs = JSON.parse((await sendTo(gui, "GET", "/api/jobs")).body) as { jobs: { kind: string }[] };
    expect(jobs.jobs.map((job) => job.kind)).toEqual(["auto-preview"]);
  });

  it("FR-GUI-028: a roadmap with no open tasks is refused with the CLI's reason", async () => {
    const root = repository();
    changeStore(root, (store) => {
      store.setStatus(1, "done");
      store.setStatus(2, "done");
    });
    const gui = await startReal(root);
    const reply = await postJob(gui, { command: "auto", options: { roadmap: 1 } });
    expect(reply.status).toBe(409);
    expect(errorOf(reply.body)).toBe("Roadmap 1 has no open or blocked tasks to run.");
  });

  it("FR-GUI-027: the plan lists the tasks already blocked", async () => {
    const root = repository();
    changeStore(root, (store) => store.addDependency(2, 3));
    const gui = await startReal(root);
    const reply = await postJob(gui, { command: "auto", options: { roadmap: 1 } });
    expect(reply.status, reply.body).toBe(200);
    const { plan } = JSON.parse(reply.body) as { plan: { plan: string; blocked: number[] } };
    expect(plan.blocked).toEqual([2]);
    expect(plan.plan).toContain("Won't run:");
  });

  it("TC-GUI-042: Stop pressed twice sends one SIGINT and the run ends 130, then Stop says no run is going", async () => {
    const root = repository();
    const gui = await startReal(root, [{ match: "developer agent", hang: true, times: 0 }]);
    const options = { roadmap: 1, developers: 1, model: "haiku", effort: "low" };
    const started = JSON.parse((await postJob(gui, { command: "auto", confirmed: true, options })).body) as {
      job: { id: string };
    };
    await vi.waitFor(
      async () => {
        const run = (await canvasOf(gui)).roadmaps[0]?.run;
        if (run?.tasks.some((task) => task.status === "running") !== true) throw new Error("not running yet");
      },
      { timeout: 20_000, interval: 200 },
    );
    expect((await sendTo(gui, "POST", "/api/run/stop")).status).toBe(202);
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
    const after = await sendTo(gui, "POST", "/api/run/stop");
    expect(after.status).toBe(409);
    expect(errorOf(after.body)).toBe("No automated run is going.");
  }, 60_000);

  it("FR-GUI-005: the GUI stopping while its run goes stops the run as Ctrl+C does", async () => {
    const root = repository();
    const gui = await startReal(root, [{ match: "developer agent", hang: true, times: 0 }]);
    const options = { roadmap: 1, developers: 1, model: "haiku", effort: "low" };
    expect((await postJob(gui, { command: "auto", confirmed: true, options })).status).toBe(201);
    const runId = await vi.waitFor(
      async () => {
        const run = (await canvasOf(gui)).roadmaps[0]?.run;
        if (run?.tasks.some((task) => task.status === "running") !== true) throw new Error("not running yet");
        return run.runId;
      },
      { timeout: 20_000, interval: 200 },
    );
    await running.splice(running.indexOf(gui), 1)[0]?.stop();
    const state = JSON.parse(readFileSync(path.join(root, ".cclinic/auto", runId, "run.json"), "utf8")) as RunState;
    expect(state.outcome).toBe("interrupted");
    expect(existsSync(path.join(root, ".cclinic/auto/.lock"))).toBe(false);
    const store = openTaskStore(path.join(root, ".cclinic"), "read");
    expect(store?.getTask(1)?.status).toBe("open");
    store?.close();
  }, 60_000);

  it("FR-GUI-032: a run with no report and no logs folder shows a null report and no logs", async () => {
    const root = repository();
    const folder = path.join(root, ".cclinic/auto", OLD_RUN);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "run.json"), JSON.stringify(runState(OLD_RUN, finished)));
    const gui = await startReal(root);
    const reply = await sendTo(gui, "GET", `/api/runs/${OLD_RUN}`);
    expect(reply.status, reply.body).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ report: null, reportIsTruncated: false, logs: [] });
  });

  it("FR-GUI-032: a huge log shows only its newest part, marked; a short one isn't marked", async () => {
    const root = repository();
    const huge = `${"old line\n".repeat(RUN_FILE_MAX_CHARS / 9 + 1000)}THE LAST LINE\n`;
    writeRun(root, runState(OLD_RUN, finished), { report: "# Report\n", logs: { "a.txt": huge, "b.txt": "short\n" } });
    const gui = await startReal(root);
    const files = JSON.parse((await sendTo(gui, "GET", `/api/runs/${OLD_RUN}`)).body) as {
      logs: { name: string; text: string; isTruncated: boolean }[];
    };
    const [a, b] = files.logs;
    expect(a?.isTruncated).toBe(true);
    // Its newest part, starting at a whole line.
    expect(a?.text.length).toBeLessThanOrEqual(RUN_FILE_MAX_CHARS);
    expect(a?.text.startsWith("old line\n")).toBe(true);
    expect(a?.text.endsWith("THE LAST LINE\n")).toBe(true);
    expect(b).toEqual({ name: "b.txt", text: "short\n", isTruncated: false });
  });

  it("FR-GUI-032: a huge report shows its newest part, and says it was cut", async () => {
    const root = repository();
    const huge = `# Report\n${"row\n".repeat(RUN_FILE_MAX_CHARS / 4 + 1000)}END OF REPORT\n`;
    writeRun(root, runState(OLD_RUN, finished), { report: huge });
    const gui = await startReal(root);
    const files = JSON.parse((await sendTo(gui, "GET", `/api/runs/${OLD_RUN}`)).body) as Record<string, unknown>;
    expect(String(files["report"]).endsWith("END OF REPORT\n")).toBe(true);
    // The logs say when they were cut; a cut report should say so too.
    expect(JSON.stringify(files)).toMatch(/reportIsTruncated|"isTruncated":true/);
  });

  it("FR-GUI-014: an unreadable logs folder or log file is reported, not a server error", async () => {
    const root = repository();
    writeRun(root, runState(OLD_RUN, finished), { report: "# R\n", logs: { "a.txt": "x\n" } });
    const logs = path.join(root, ".cclinic/auto", OLD_RUN, "logs");
    chmodSync(logs, 0o000);
    locked.push(logs);
    const gui = await startReal(root);
    const folder = await sendTo(gui, "GET", `/api/runs/${OLD_RUN}`);
    expect(folder.status).toBe(409);
    expect(errorOf(folder.body)).not.toBe("");
    chmodSync(logs, 0o755);
    chmodSync(path.join(logs, "a.txt"), 0o000);
    const file = await sendTo(gui, "GET", `/api/runs/${OLD_RUN}`);
    chmodSync(path.join(logs, "a.txt"), 0o644);
    expect(file.status, file.body).not.toBe(500);
  });

  it("FR-GUI-014: a folder inside the logs folder is skipped or reported, not a server error", async () => {
    const root = repository();
    writeRun(root, runState(OLD_RUN, finished), { report: "# R\n", logs: { "a.txt": "x\n" } });
    mkdirSync(path.join(root, ".cclinic/auto", OLD_RUN, "logs", "subfolder"));
    const gui = await startReal(root);
    const nested = await sendTo(gui, "GET", `/api/runs/${OLD_RUN}`);
    expect(nested.status, nested.body).not.toBe(500);
  });

  it("FR-GUI-032: run IDs that name other folders are refused and read nothing", async () => {
    const root = repository();
    writeRun(root, runState(OLD_RUN, finished), { report: "# R\n" });
    mkdirSync(path.join(root, ".cclinic/auto/20261111-000000"), { recursive: true });
    const gui = await startReal(root);
    for (const tricky of [
      `/api/runs/${OLD_RUN}/..`,
      `/api/runs/${OLD_RUN}%2F..%2F..`,
      "/api/runs/%2e%2e",
      `/api/runs/..%2F${OLD_RUN}`,
      `/api/runs/${OLD_RUN}-1234567`,
      "/api/runs/20261111-000000",
    ]) {
      expect((await sendTo(gui, "GET", tricky)).status, tricky).toBe(404);
    }
  });
});

describe("QA: Run with AI in the browser", () => {
  async function startHeld(root: string, jobs: ReturnType<typeof heldJobs>): Promise<TestGui> {
    const gui = await startTestGui(root, {}, { startJob: jobs.startJob, every: () => () => undefined });
    running.push(gui);
    return gui;
  }

  it("FR-GUI-027: changing the form after the plan hides Start until a new plan, and the run uses that plan", async () => {
    const root = repository();
    const jobs = heldJobs(planOf);
    const gui = await startHeld(root, jobs);
    const page = await openPage(gui);
    await page.locator('[data-frame="roadmap-1"] button[data-action="run-ai"]').click();
    const dialog = page.locator("#auto-dialog");
    await dialog.locator('input[name="developers"]').fill("1");
    await dialog.locator("#auto-show-plan").click();
    await vi.waitFor(() => {
      expect(jobs.held).toHaveLength(1);
    });
    jobs.held.shift()?.();
    await expect.poll(() => dialog.locator("#auto-plan").textContent()).toContain("Developers: 1");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("auto-start");
    await dialog.locator('input[name="developers"]').fill("3");
    expect(await dialog.locator("#auto-start").isHidden()).toBe(true);
    expect(await dialog.locator("#auto-plan").isHidden()).toBe(true);
    await dialog.locator('select[name="effort"]').selectOption({ index: 1 });
    await dialog.locator("#auto-show-plan").click();
    await vi.waitFor(() => {
      expect(jobs.held).toHaveLength(1);
    });
    jobs.held.shift()?.();
    await expect.poll(() => dialog.locator("#auto-plan").textContent()).toContain("Developers: 3");
    await dialog.locator("#auto-start").click();
    await expect.poll(() => dialog.isVisible()).toBe(false);
    const run = jobs.started.find((args) => args.includes("--yes"));
    expect(run).toContain("--developers=3");
    expect(run?.some((arg) => arg.startsWith("--effort="))).toBe(true);
  });

  it("FR-GUI-027: a choice changed while the plan is being made isn't run with the older plan's options", async () => {
    const root = repository();
    const jobs = heldJobs(planOf);
    const gui = await startHeld(root, jobs);
    const page = await openPage(gui);
    await page.locator('[data-frame="roadmap-1"] button[data-action="run-ai"]').click();
    const dialog = page.locator("#auto-dialog");
    await expect.poll(() => dialog.locator('select[name="effort"] option').count()).toBeGreaterThan(1);
    await dialog.locator("#auto-show-plan").click();
    await vi.waitFor(() => {
      expect(jobs.held).toHaveLength(1);
    });
    // The user picks a reasoning level before the plan arrives.
    await dialog.locator('select[name="effort"]').selectOption("high");
    jobs.held.shift()?.();
    await expect.poll(() => dialog.locator("#auto-show-plan").isDisabled()).toBe(false);
    // DEF-1: the older plan isn't shown, so Start isn't offered until a plan is made for what the form shows.
    expect(await dialog.locator("#auto-plan").isHidden()).toBe(true);
    expect(await dialog.locator("#auto-start").isHidden()).toBe(true);
    expect(await dialog.locator('select[name="effort"]').inputValue()).toBe("high");
    await dialog.locator("#auto-show-plan").click();
    await vi.waitFor(() => {
      expect(jobs.held).toHaveLength(1);
    });
    jobs.held.shift()?.();
    await expect.poll(() => dialog.locator("#auto-start").isVisible()).toBe(true);
    await dialog.locator("#auto-start").click();
    await expect.poll(() => dialog.isVisible()).toBe(false);
    expect(jobs.started.find((args) => args.includes("--yes"))).toContain("--effort=high");
  });

  it("FR-GUI-027: Cancel and Escape close the form, start nothing, and reopening needs a new plan", async () => {
    const root = repository();
    const jobs = heldJobs(planOf);
    const gui = await startHeld(root, jobs);
    const page = await openPage(gui);
    const runAi = page.locator('[data-frame="roadmap-1"] button[data-action="run-ai"]');
    await runAi.click();
    const dialog = page.locator("#auto-dialog");
    await dialog.locator("#auto-show-plan").click();
    await vi.waitFor(() => {
      expect(jobs.held).toHaveLength(1);
    });
    jobs.held.shift()?.();
    await expect.poll(() => dialog.locator("#auto-start").isVisible()).toBe(true);
    await dialog.locator("#auto-cancel").click();
    expect(await dialog.isVisible()).toBe(false);
    await runAi.click();
    expect(await dialog.locator('input[name="developers"]').inputValue()).toBe("");
    expect(await dialog.locator("#auto-start").isHidden()).toBe(true);
    expect(await dialog.locator("#auto-plan").isHidden()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await dialog.isVisible()).toBe(false);
    expect(jobs.started.filter((args) => args.includes("--yes"))).toEqual([]);
  });

  it("TC-GUI-067: the form and its plan with a long roadmap title don't scroll sideways at 768 px", async () => {
    const long = "Averyveryverylongwordwithoutanyspacesatall".repeat(6);
    const root = repository(long);
    const jobs = heldJobs(() => ({ ...planOf(["--developers=2"]), plan: `Roadmap #1: ${long}\n  #1 ${long}` }));
    const gui = await startHeld(root, jobs);
    const page = await openPage(gui, { width: 768, height: 900 });
    await page.locator('[data-frame="roadmap-1"] button[data-action="run-ai"]').click();
    const dialog = page.locator("#auto-dialog");
    await dialog.locator("#auto-show-plan").click();
    await vi.waitFor(() => {
      expect(jobs.held).toHaveLength(1);
    });
    jobs.held.shift()?.();
    await expect.poll(() => dialog.locator("#auto-plan").isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);
    const inner = await page.evaluate(() =>
      [...document.querySelectorAll("#auto-dialog, #auto-dialog *")]
        .filter((node) => node.scrollWidth - node.clientWidth > 0)
        .map((node) => `${node.tagName}#${node.id}: ${node.scrollWidth - node.clientWidth}`),
    );
    expect(inner).toEqual([]);
    expect((await dialog.boundingBox())?.width).toBeLessThanOrEqual(768);
  });

  it("FR-GUI-029: HTML and secrets in a live run's task titles and reasons show as plain, redacted text", async () => {
    const root = repository();
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const state = runState(LIVE_RUN);
    writeRun(root, {
      ...state,
      tasks: state.tasks.map((task) => ({
        ...task,
        title: `<img src=x onerror="window.pwned=1"> ${key}`,
        status: "blocked",
        reason: `<b>bold</b> failed with ${key}`,
      })),
    });
    writeFileSync(path.join(root, ".cclinic/auto/.lock"), JSON.stringify({ pid: process.pid, runId: LIVE_RUN }));
    const gui = await startReal(root);
    const page = await openPage(gui, { width: 1280, height: 900 }, "dark");
    await page.locator('[data-frame="roadmap-1"] button[data-action="open-roadmap"]').click();
    const task = page.locator('#panel-body [data-run-task="1"]');
    await task.waitFor();
    expect(await task.locator(".run-task-title").textContent()).toContain('<img src=x onerror="window.pwned=1">');
    expect(await task.locator(".run-reason").textContent()).toContain("<b>bold</b>");
    expect(await page.locator("#panel-body img, #panel-body b").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
    expect(await page.locator("#panel-body").textContent()).not.toContain(key);
  });

  it("FR-GUI-031: a terminal run's Stop names the PID; another roadmap's frame offers Run with AI, refused with the run", async () => {
    const root = repository();
    writeRun(root, runState(LIVE_RUN));
    writeFileSync(path.join(root, ".cclinic/auto/.lock"), JSON.stringify({ pid: process.pid, runId: LIVE_RUN }));
    const gui = await startReal(root);
    const page = await openPage(gui);
    const first = page.locator('[data-frame="roadmap-1"]');
    const second = page.locator('[data-frame="roadmap-2"]');
    expect(await second.locator('button[data-action="run-ai"]').count()).toBe(1);
    expect(await second.locator('button[data-action="stop-run"]').count()).toBe(0);
    await first.locator('button[data-action="stop-run"]').click();
    await page.locator("#confirm-ok").click();
    await expect.poll(() => page.locator("#notice").textContent()).toContain(`process ${process.pid}`);
    await second.locator('button[data-action="run-ai"]').click();
    const dialog = page.locator("#auto-dialog");
    expect(await dialog.locator("#auto-roadmap").textContent()).toBe("Roadmap #2: Later");
    await dialog.locator("#auto-show-plan").click();
    await expect
      .poll(() => dialog.locator("#auto-error").textContent(), { timeout: 15_000 })
      .toContain(`Automated run ${LIVE_RUN}`);
    expect(await dialog.locator("#auto-start").isHidden()).toBe(true);
  }, 30_000);

  it("FR-GUI-032: a past run opens and closes from the keyboard, and stays open across canvas updates", async () => {
    const root = repository();
    writeRun(root, runState(OLD_RUN, finished), { report: "# Report\n", logs: { "a.txt": "x\n" } });
    const gui = await startReal(root);
    const page = await openPage(gui);
    await page.locator('[data-frame="roadmap-1"] button[data-action="open-roadmap"]').click();
    const button = page.locator(`#panel-body [data-past-run="${OLD_RUN}"] > button`);
    await button.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("#panel-body .run-report").textContent()).toBe("# Report\n");
    expect(await button.getAttribute("aria-expanded")).toBe("true");
    // A change to the tasks makes a new canvas; the run stays open.
    changeStore(root, (store) => store.setStatus(2, "in-progress"));
    await expect
      .poll(() => page.locator("#panel-body .milestone li").nth(1).textContent(), { timeout: 10_000 })
      .toContain("In progress");
    expect(await page.locator("#panel-body .run-report").count()).toBe(1);
    await page.locator(`#panel-body [data-past-run="${OLD_RUN}"] > button`).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("#panel-body .run-report").count()).toBe(0);
    expect(await page.locator(`#panel-body [data-past-run="${OLD_RUN}"] > button`).getAttribute("aria-expanded")).toBe(
      "false",
    );
  }, 30_000);
});

describe("QA run 2: the run 1 fixes", () => {
  it("DEF-2: an unreadable log file is a 409 naming the file, not a 500", async () => {
    const root = repository();
    writeRun(root, runState(OLD_RUN, finished), { report: "# R\n", logs: { "a.txt": "x\n" } });
    const file = path.join(root, ".cclinic/auto", OLD_RUN, "logs", "a.txt");
    chmodSync(file, 0o000);
    locked.push(file);
    const gui = await startReal(root);
    const reply = await sendTo(gui, "GET", `/api/runs/${OLD_RUN}`);
    expect(reply.status, reply.body).toBe(409);
    expect(errorOf(reply.body)).toContain("a.txt");
  });

  it("DEF-3: a folder inside logs/ isn't listed as a log, and the files still are", async () => {
    const root = repository();
    writeRun(root, runState(OLD_RUN, finished), { report: "# R\n", logs: { "a.txt": "x\n", "c.txt": "y\n" } });
    mkdirSync(path.join(root, ".cclinic/auto", OLD_RUN, "logs", "b-folder"));
    const gui = await startReal(root);
    const reply = await sendTo(gui, "GET", `/api/runs/${OLD_RUN}`);
    expect(reply.status, reply.body).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({
      report: "# R\n",
      reportIsTruncated: false,
      logs: [
        { name: "a.txt", text: "x\n", isTruncated: false },
        { name: "c.txt", text: "y\n", isTruncated: false },
      ],
    });
  });

  it("DEF-4: a huge report is cut to its newest whole lines and marked; a short one isn't", async () => {
    const root = repository();
    const huge = `# Report\n${"row 12345\n".repeat(RUN_FILE_MAX_CHARS / 10 + 1000)}END OF REPORT\n`;
    writeRun(root, runState(OLD_RUN, finished), { report: huge });
    const gui = await startReal(root);
    const files = JSON.parse((await sendTo(gui, "GET", `/api/runs/${OLD_RUN}`)).body) as {
      report: string;
      reportIsTruncated: boolean;
    };
    expect(files.reportIsTruncated).toBe(true);
    expect(files.report.length).toBeLessThanOrEqual(RUN_FILE_MAX_CHARS);
    expect(files.report.startsWith("row 12345\n")).toBe(true);
    expect(files.report.endsWith("END OF REPORT\n")).toBe(true);
    expect(files.report).not.toContain("# Report");
  });

  it("DEF-4: the panel says when only the newest part of a report or log is shown, and not for short ones", async () => {
    const root = repository();
    const huge = `${"row 12345\n".repeat(RUN_FILE_MAX_CHARS / 10 + 1000)}END\n`;
    writeRun(root, runState(OLD_RUN, finished), { report: huge, logs: { "a.txt": huge, "b.txt": "short\n" } });
    const gui = await startReal(root);
    const page = await openPage(gui);
    await page.locator('[data-frame="roadmap-1"] button[data-action="open-roadmap"]').click();
    await page.locator(`#panel-body [data-past-run="${OLD_RUN}"] > button`).click();
    await expect
      .poll(() => page.locator("#panel-body").textContent())
      .toContain("Only the newest part of this report is shown.");
    const text = (await page.locator("#panel-body").textContent()) ?? "";
    expect(text.split("Only the newest part of this log is shown.")).toHaveLength(2);
  }, 30_000);

  it("DEF-4: a short report isn't marked in the panel", async () => {
    const root = repository();
    writeRun(root, runState(OLD_RUN, finished), { report: "# Report\n", logs: { "a.txt": "x\n" } });
    const gui = await startReal(root);
    const page = await openPage(gui);
    await page.locator('[data-frame="roadmap-1"] button[data-action="open-roadmap"]').click();
    await page.locator(`#panel-body [data-past-run="${OLD_RUN}"] > button`).click();
    await expect.poll(() => page.locator("#panel-body .run-report").textContent()).toBe("# Report\n");
    expect(await page.locator("#panel-body").textContent()).not.toContain("Only the newest part");
  }, 30_000);
});

describe("QA run 3: the code-review fixes", () => {
  it("TC-AUTO-062: a bare --model or --effort on a dry run with no terminal opens no menu and shows the plan", () => {
    const root = repository();
    const harness = agentHarness();
    for (const flags of [["--model"], ["--effort"], ["--model", "--effort"]]) {
      const result = cli(root, harness, "auto", "--roadmap", "1", "--dry-run", ...flags);
      expect(result.code, `${flags.join(" ")}: ${result.err}`).toBe(0);
      expect(result.out).toContain("Roadmap #1: Launch");
    }
    expect(harness.calls()).toEqual([]);
    expect(existsSync(path.join(root, ".cclinic/auto"))).toBe(false);
  });

  it("TC-AUTO-062: a dry run refuses a wrong --model, --effort or CCLINIC_EFFORT with exit 2, creating nothing", () => {
    const root = repository();
    const harness = agentHarness();
    const base = ["auto", "--roadmap", "1", "--dry-run"];
    const model = cli(root, harness, ...base, "--model", "not-a-model");
    expect(model.code).toBe(2);
    expect(model.err).toContain("--model");
    const effort = cli(root, harness, ...base, "--effort", "huge");
    expect(effort.code).toBe(2);
    expect(effort.err).toContain("--effort");
    const env = cli(root, agentHarness({ env: { CCLINIC_EFFORT: "huge" } }), ...base, "--json");
    expect(env.code).toBe(2);
    expect(env.out + env.err).toContain("CCLINIC_EFFORT");
    expect(existsSync(path.join(root, ".cclinic/auto"))).toBe(false);
  });

  it("FR-GUI-032: runs with a -2 or 6-digit suffix open; the files are 409 when run.json or report.md can't be read", async () => {
    const root = repository();
    writeRun(root, runState(`${OLD_RUN}-2`, finished), { report: "# Second\n" });
    writeRun(root, runState(`${OLD_RUN}-123456`, finished), { report: "# Many\n" });
    writeRun(root, runState("20261109-090000", finished), { report: "# Locked\n" });
    const gui = await startReal(root);
    const second = await sendTo(gui, "GET", `/api/runs/${OLD_RUN}-2`);
    expect(second.status, second.body).toBe(200);
    expect((JSON.parse(second.body) as { report: string }).report).toBe("# Second\n");
    expect((await sendTo(gui, "GET", `/api/runs/${OLD_RUN}-123456`)).status).toBe(200);
    const canvas = JSON.stringify(await canvasOf(gui));
    expect(canvas).toContain(`${OLD_RUN}-2`);
    expect(canvas).toContain(`${OLD_RUN}-123456`);

    const folder = path.join(root, ".cclinic/auto/20261109-090000");
    chmodSync(path.join(folder, "report.md"), 0o000);
    const report = await sendTo(gui, "GET", "/api/runs/20261109-090000");
    chmodSync(path.join(folder, "report.md"), 0o644);
    expect(report.status, report.body).toBe(409);
    expect(errorOf(report.body)).toContain("report.md");
    chmodSync(path.join(folder, "run.json"), 0o000);
    const state = await sendTo(gui, "GET", "/api/runs/20261109-090000");
    chmodSync(path.join(folder, "run.json"), 0o644);
    expect(state.status, state.body).not.toBe(500);
    expect(state.status).not.toBe(200);
  });

  it("FR-MCP-012 / FR-AUTO-010: a live run with a -2 suffix still holds its task, and lists newest first", async () => {
    const { findRunHoldingTask, createRunLister } = await import("../../src/adapters/storage/run-store.js");
    const root = repository();
    const live = `${OLD_RUN}-2`;
    writeRun(root, runState(live));
    writeRun(root, runState(`${OLD_RUN}-10`, finished));
    writeRun(root, runState(OLD_RUN, finished));
    writeFileSync(path.join(root, ".cclinic/auto/.lock"), JSON.stringify({ pid: process.pid, runId: live }));
    expect(await findRunHoldingTask(root, 1)).toBe(live);
    expect(await findRunHoldingTask(root, 2)).toBeUndefined();
    const listing = await createRunLister(root)();
    expect(listing.runs.map((run) => run.state.runId)).toEqual([`${OLD_RUN}-10`, live, OLD_RUN]);
    expect(listing.runs.map((run) => run.pid)).toEqual([null, process.pid, null]);
  });
});
