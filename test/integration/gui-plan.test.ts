/// <reference lib="dom" />
/** Plan with the PM from the GUI: the same session as `cclinic plan`, answered from the browser (spec: gui, D5). */
import path from "node:path";
import { input, select } from "@inquirer/prompts";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import type { PlanView } from "../../src/application/gui-planning.js";
import { runPlanCommand } from "../../src/cli/plan-command.js";
import type { RoadmapProposal } from "../../src/core/planning.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";
import { openStream, sendTo, startTestGui, type TestGui } from "../support/gui.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn(), input: vi.fn() }));

/** Starting the fake `claude` can take a few seconds when the machine is busy. */
const WAIT = { timeout: 20_000, interval: 100 };

let browser: Browser;
const running: TestGui[] = [];
const isTty = process.stdin.isTTY;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

beforeEach(() => {
  process.stdin.isTTY = true;
});

afterEach(async () => {
  process.stdin.isTTY = isTty;
  vi.resetAllMocks();
  await Promise.all(browser.contexts().map((context) => context.close()));
  await Promise.all(running.splice(0).map((gui) => gui.stop()));
});

const planned = (key: string, dependsOn: string[] = []) => ({
  key,
  title: `Task ${key}`,
  description: `About ${key}`,
  spec: null,
  dependsOn,
});

const roadmapProposal: RoadmapProposal = {
  roadmap: { title: "Checkout", goal: "Pay online" },
  milestones: [{ title: "Cards", goal: "Pay by card", tasks: [planned("a"), planned("b", ["a"])] }],
  openQuestions: [],
};

const asking = (question: string) => ({ questions: [question], proposal: null });
const proposing = (proposal: unknown) => ({ questions: [], proposal });
const pmRules = (...replies: unknown[]): FakeClaudeRule[] => replies.map((output) => ({ output, cost: 0.01 }));

/** A project with documents, and roadmap 1 "Launch" with tasks 1 and 2. */
function project(): string {
  const root = makeTempFolder();
  writeProject(root, { ".cclinic/sdd/overview.md": "# Overview\n", ".cclinic/sdd/README.md": "# Specs\n" });
  const store = openTaskStore(path.join(root, ".cclinic"), "create");
  if (store === undefined) throw new Error("No store");
  store.savePlan({
    roadmap: { title: "Launch", goal: "Ship" },
    milestones: [{ title: "One", goal: "", tasks: [planned("x"), planned("y")] }],
  });
  store.close();
  return root;
}

function roadmapTitles(root: string): string[] {
  const store = openTaskStore(path.join(root, ".cclinic"), "read");
  try {
    return store?.listRoadmaps().map((roadmap) => roadmap.title) ?? [];
  } finally {
    store?.close();
  }
}

async function startGui(root: string, rules: FakeClaudeRule[]) {
  const harness = agentHarness({ rules });
  const gui = await startTestGui(root, {}, { every: () => () => undefined }, harness.environment);
  running.push(gui);
  return { gui, harness };
}

const post = (gui: TestGui, route: string, body: unknown = {}) => sendTo(gui, "POST", route, body);
const planOf = async (gui: TestGui) =>
  (JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as { plan: PlanView | null }).plan;

async function waitForStep(gui: TestGui, step: PlanView["step"]): Promise<PlanView> {
  return vi.waitFor(async () => {
    const plan = await planOf(gui);
    if (plan?.step !== step) throw new Error(`at ${plan?.step ?? "nothing"}, not ${step}`);
    return plan;
  }, WAIT);
}

const NEW_ROADMAP = { target: { kind: "new-roadmap" }, model: "sonnet", effort: "low" };

describe("Plan through the API", () => {
  it("TC-GUI-032: Plan starts the same session as cclinic plan, and the PM's question reaches the browser", async () => {
    const root = project();
    const { gui, harness } = await startGui(root, pmRules(asking("Who pays?")));
    const stream = openStream(gui, "/api/plan/events");
    expect((await post(gui, "/api/plan", NEW_ROADMAP)).status).toBe(201);
    await waitForStep(gui, "question");
    await vi.waitFor(() => {
      const last = stream.events.filter((event) => event.event === "plan").at(-1)?.data as { plan: PlanView };
      expect(last.plan).toMatchObject({ step: "question", question: "Who pays?", target: { kind: "new-roadmap" } });
    }, WAIT);
    stream.close();

    // The CLI, with the same choices, sends the PM the same arguments.
    const cli = agentHarness({ rules: pmRules(asking("Who pays?")) });
    vi.mocked(select).mockResolvedValueOnce("new");
    vi.mocked(input).mockRejectedValueOnce(new Error("stop here"));
    await runPlanCommand({ dir: root, timeoutMinutes: 30, model: "sonnet", effort: "low" }, cli.context).catch(
      () => undefined,
    );
    const withoutIds = (args: readonly string[]) =>
      args.map((arg) => arg.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "ID"));
    expect(withoutIds(harness.calls()[0]?.args ?? [])).toEqual(withoutIds(cli.calls()[0]?.args ?? []));
    expect(harness.calls()[0]?.prompt).toBe(cli.calls()[0]?.prompt);
  }, 60_000);

  it("TC-GUI-033, TC-GUI-034: the answer and the feedback reach the PM, the proposal shows in full, and approve saves", async () => {
    const root = project();
    const { gui, harness } = await startGui(
      root,
      pmRules(asking("Who pays?"), proposing(roadmapProposal), proposing(roadmapProposal)),
    );
    await post(gui, "/api/plan", NEW_ROADMAP);
    await waitForStep(gui, "question");
    expect((await post(gui, "/api/plan/answer", { text: "Shoppers, by card" })).status).toBe(200);
    const first = await waitForStep(gui, "review");
    expect(first.proposal).toContain("Checkout");
    expect(first.proposal).toContain("Task b");
    expect(harness.calls()[1]?.prompt).toContain("Shoppers, by card");

    expect((await post(gui, "/api/plan/review", { choice: "refine", feedback: "Split task b" })).status).toBe(200);
    const second = await waitForStep(gui, "review");
    expect(second.proposal).toContain("Checkout");
    expect(harness.calls()[2]?.prompt).toContain("Split task b");
    expect(roadmapTitles(root)).toEqual(["Launch"]);

    expect((await post(gui, "/api/plan/review", { choice: "approve" })).status).toBe(200);
    const saved = await waitForStep(gui, "saved");
    expect(saved.message).toBe("Saved roadmap #2. Run it with: cclinic auto --roadmap 2");
    expect(roadmapTitles(root)).toEqual(["Launch", "Checkout"]);
    const store = openTaskStore(path.join(root, ".cclinic"), "read");
    const tasks = store?.listTasks(true).filter((task) => task.title === "Task a" || task.title === "Task b") ?? [];
    store?.close();
    expect(tasks.find((task) => task.title === "Task b")?.dependsOn).toEqual([
      tasks.find((task) => task.title === "Task a")?.id,
    ]);
  }, 60_000);

  it("TC-GUI-035: cancel, a stopped GUI and a failed PM call each save nothing", async () => {
    const cancelled = project();
    const one = await startGui(cancelled, pmRules(proposing(roadmapProposal)));
    await post(one.gui, "/api/plan", NEW_ROADMAP);
    await waitForStep(one.gui, "review");
    await post(one.gui, "/api/plan/review", { choice: "cancel" });
    expect(await waitForStep(one.gui, "cancelled")).toMatchObject({ message: "Cancelled. Nothing was saved." });
    expect(roadmapTitles(cancelled)).toEqual(["Launch"]);

    const stopped = project();
    const two = await startGui(stopped, pmRules(proposing(roadmapProposal)));
    await post(two.gui, "/api/plan", NEW_ROADMAP);
    await waitForStep(two.gui, "review");
    await two.gui.stop();
    running.splice(running.indexOf(two.gui), 1);
    expect(roadmapTitles(stopped)).toEqual(["Launch"]);

    const failed = project();
    const three = await startGui(failed, [{ exitCode: 1, message: "The model is overloaded." }]);
    await post(three.gui, "/api/plan", NEW_ROADMAP);
    const ended = await waitForStep(three.gui, "failed");
    expect(ended.message).toContain("Nothing was saved.");
    expect(roadmapTitles(failed)).toEqual(["Launch"]);
  }, 90_000);

  it("TC-GUI-036: a second Plan is refused while one waits, and a new client gets the waiting question", async () => {
    const root = project();
    const { gui } = await startGui(root, pmRules(asking("Who pays?")));
    await post(gui, "/api/plan", NEW_ROADMAP);
    await waitForStep(gui, "question");
    const second = await post(gui, "/api/plan", { target: { kind: "task", roadmapId: 1 } });
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body)).toEqual({
      error: "A planning session is already going. Finish or cancel it first.",
    });
    const late = openStream(gui, "/api/plan/events");
    await vi.waitFor(() => {
      expect((late.events[0]?.data as { plan: PlanView }).plan).toMatchObject({
        step: "question",
        question: "Who pays?",
      });
    });
    late.close();
    expect((await post(gui, "/api/plan/cancel")).status).toBe(200);
    await waitForStep(gui, "cancelled");
  }, 60_000);

  it("FR-GUI-023: what cclinic plan refuses is refused with its words, and answers out of turn are refused", async () => {
    const root = project();
    const { gui } = await startGui(root, pmRules(asking("Who pays?")));
    const missing = await post(gui, "/api/plan", { target: { kind: "task", roadmapId: 9 } });
    expect(missing.status).toBe(409);
    expect(JSON.parse(missing.body)).toEqual({
      error: "Roadmap 9 doesn't exist. See your roadmaps with: cclinic tasks roadmaps",
    });
    // FR-PLAN-001: the budget option is gone, so a request that sends one is refused.
    const budget = await post(gui, "/api/plan", { target: { kind: "new-roadmap" }, maxBudgetUsd: 1 });
    expect(budget.status).toBe(400);
    const timeout = await post(gui, "/api/plan", { target: { kind: "new-roadmap" }, timeoutMinutes: 0 });
    expect(timeout.status).toBe(400);
    expect((JSON.parse(timeout.body) as { error: string }).error).toContain("--timeout-minutes");
    expect((await post(gui, "/api/plan/answer", { text: "Hi" })).status).toBe(409);
    expect((await post(gui, "/api/plan/review", { choice: "approve" })).status).toBe(409);
    expect((await post(gui, "/api/plan/review", { choice: "refine" })).status).toBe(400);
    expect((await post(gui, "/api/plan/cancel")).status).toBe(409);
    expect(await planOf(gui)).toBeNull();
  });

  it("FR-GUI-023: a project with no documents is refused as cclinic plan refuses it", async () => {
    const root = makeTempFolder();
    writeProject(root, { "README.md": "# App\n" });
    const { gui } = await startGui(root, []);
    const reply = await post(gui, "/api/plan", { target: { kind: "new-roadmap" } });
    expect(reply.status).toBe(409);
    expect((JSON.parse(reply.body) as { error: string }).error).toMatch(/cclinic/);
  });
});

describe("Plan in the browser", () => {
  async function openPage(gui: TestGui): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
    await page.locator('[data-key="task-1"]').waitFor();
    return page;
  }

  it("TC-GUI-130: New roadmap starts Plan; the question is a form, Needs you counts it, and approving saves", async () => {
    const root = project();
    const { gui } = await startGui(root, pmRules(asking("Who pays?"), proposing(roadmapProposal)));
    const page = await openPage(gui);
    await page.locator("#plan-open").click();
    const dialog = page.locator("#plan-dialog");
    expect(await dialog.locator("#plan-target").textContent()).toBe("A new roadmap.");
    await dialog.locator("#plan-start").click();
    await expect.poll(() => dialog.locator(".plan-question-text").textContent(), WAIT).toBe("Who pays?");
    await expect.poll(() => page.locator("#needs-count").textContent()).toBe("1");
    await dialog.locator("#plan-answer").fill("Shoppers");
    await dialog.locator('.plan-question button[type="submit"]').click();
    await expect.poll(() => dialog.locator(".plan-proposal").textContent(), WAIT).toContain("Checkout");
    await dialog.getByRole("button", { name: "Approve and save" }).click();
    await expect.poll(() => dialog.locator(".plan-ended").textContent(), WAIT).toContain("Saved roadmap #2");
    await expect.poll(() => page.locator("#needs-count").textContent()).toBe("0");
    expect(roadmapTitles(root)).toEqual(["Launch", "Checkout"]);
  }, 60_000);

  it("TC-GUI-131: a page opened again shows the session at its current question, from Needs you", async () => {
    const root = project();
    const { gui } = await startGui(root, pmRules(asking("Who pays?")));
    await post(gui, "/api/plan", NEW_ROADMAP);
    await waitForStep(gui, "question");
    const page = await openPage(gui);
    await expect.poll(() => page.locator("#needs-count").textContent()).toBe("1");
    await page.locator("#needs-you").click();
    await page.locator("#needs-list .needs-item", { hasText: "The PM" }).locator("button").click();
    expect(await page.locator("#plan-dialog .plan-question-text").textContent()).toBe("Who pays?");
    await page.getByRole("button", { name: "Cancel planning" }).click();
    await expect.poll(() => page.locator("#plan-dialog .plan-ended").textContent(), WAIT).toContain("Cancelled");
  }, 60_000);

  it("TC-GUI-132: New roadmap also offers one standalone task, which is saved in no roadmap", async () => {
    const root = project();
    const task = {
      task: { title: "Lock accounts", description: "After 5 failures", spec: null, dependsOn: [] },
      milestoneId: null,
      openQuestions: [],
    };
    const { gui } = await startGui(root, pmRules(proposing(task)));
    const page = await openPage(gui);
    await page.locator("#plan-open").click();
    const dialog = page.locator("#plan-dialog");
    await dialog.locator('select[name="what"]').selectOption("task");
    expect(await dialog.locator("#plan-target").textContent()).toBe("One standalone task.");
    await dialog.locator("#plan-start").click();
    await expect.poll(() => dialog.locator(".plan-proposal").textContent(), WAIT).toContain("Lock accounts");
    await dialog.getByRole("button", { name: "Approve and save" }).click();
    await expect.poll(() => dialog.locator(".plan-ended").textContent(), WAIT).toContain("It's standalone");
    const store = openTaskStore(path.join(root, ".cclinic"), "read");
    const saved = store?.listTasks(true).find((item) => item.title === "Lock accounts");
    store?.close();
    expect(saved?.milestoneId).toBeNull();
  }, 60_000);

  it("TC-GUI-104: a frame's Plan a task, Run with AI and Open, and the canvas's New roadmap, open what they say", async () => {
    const root = project();
    const { gui } = await startGui(root, []);
    const page = await openPage(gui);
    const frame = page.locator('[data-frame="roadmap-1"]');
    await frame.locator('button[data-action="plan-task"]').click();
    expect(await page.locator("#plan-target").textContent()).toBe("One task in roadmap #1.");
    expect(await page.locator("#plan-what").isHidden()).toBe(true);
    await page.locator("#plan-dialog [data-plan-close]").click();
    await page.locator("#plan-open").click();
    expect(await page.locator("#plan-target").textContent()).toBe("A new roadmap.");
    await page.locator("#plan-dialog [data-plan-close]").click();
    await frame.locator('button[data-action="run-ai"]').click();
    expect(await page.locator("#auto-roadmap").textContent()).toBe("Roadmap #1: Launch");
    await page.locator("#auto-cancel").click();
    await frame.locator('button[data-action="open-roadmap"]').click();
    expect(await page.locator("#panel-title").textContent()).toBe("Roadmap #1");
  });
});
