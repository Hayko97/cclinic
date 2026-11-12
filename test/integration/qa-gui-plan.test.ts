/// <reference lib="dom" />
/** QA for D5, Plan with the PM in the GUI: edge cases beyond gui-plan.test.ts (spec: gui FR-GUI-023 to FR-GUI-026). */
import { chmodSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { input, select } from "@inquirer/prompts";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import type { PlanView } from "../../src/application/gui-planning.js";
import { runPlanCommand } from "../../src/cli/plan-command.js";
import { PLAN_LIMITS } from "../../src/core/constants/agents.js";
import type { RoadmapProposal, TaskProposal } from "../../src/core/planning.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";
import { openStream, sendTo, startTestGui, type TestGui } from "../support/gui.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn(), input: vi.fn() }));

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
const extension: RoadmapProposal = {
  roadmap: null,
  milestones: [{ title: "Two", goal: "More", tasks: [planned("z")] }],
  openQuestions: [],
};
const taskProposal = (milestoneId: number | null): TaskProposal => ({
  task: { title: "Refund button", description: "Let shoppers ask for a refund", spec: null, dependsOn: [1] },
  milestoneId,
  openQuestions: [],
});

const asking = (question: string) => ({ questions: [question], proposal: null });
const proposing = (proposal: unknown) => ({ questions: [], proposal });
const pmRules = (...replies: unknown[]): FakeClaudeRule[] => replies.map((output) => ({ output, cost: 0.01 }));

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

function snapshot(root: string) {
  const store = openTaskStore(path.join(root, ".cclinic"), "read");
  try {
    return {
      roadmaps: store?.listRoadmaps().map((roadmap) => roadmap.title) ?? [],
      tasks: store?.listTasks(true).map((task) => ({ id: task.id, title: task.title })) ?? [],
    };
  } finally {
    store?.close();
  }
}

async function startGui(root: string, rules: FakeClaudeRule[], env: NodeJS.ProcessEnv = {}) {
  const harness = agentHarness({ rules, env });
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

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidsIn = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : [];

const NEW_ROADMAP = { target: { kind: "new-roadmap" }, model: "sonnet", effort: "low", maxBudgetUsd: 1 };

describe("QA D5: targets and the CLI's defaults", () => {
  it("FR-GUI-023: extending roadmap 1 saves its new milestone into roadmap 1, and nothing new is a roadmap", async () => {
    const root = project();
    const { gui } = await startGui(root, pmRules(proposing(extension)));
    expect(
      (await post(gui, "/api/plan", { target: { kind: "extend-roadmap", roadmapId: 1 }, maxBudgetUsd: 1 })).status,
    ).toBe(201);
    const review = await waitForStep(gui, "review");
    expect(review.target).toEqual({ kind: "extend-roadmap", roadmapId: 1 });
    expect(snapshot(root).tasks).toHaveLength(2);
    await post(gui, "/api/plan/review", { choice: "approve" });
    const saved = await waitForStep(gui, "saved");
    expect(saved.message).toContain("roadmap #1");
    expect(snapshot(root).roadmaps).toEqual(["Launch"]);
    const store = openTaskStore(path.join(root, ".cclinic"), "read");
    const milestones = store?.listRoadmaps()[0];
    store?.close();
    expect(milestones).toBeDefined();
    expect(snapshot(root).tasks.map((task) => task.title)).toEqual(["Task x", "Task y", "Task z"]);
  }, 60_000);

  it("FR-GUI-023: a standalone task (--task with no roadmap) is saved as the CLI saves it", async () => {
    const root = project();
    const { gui } = await startGui(root, pmRules(proposing(taskProposal(null))));
    expect((await post(gui, "/api/plan", { target: { kind: "task", roadmapId: null } })).status).toBe(201);
    const review = await waitForStep(gui, "review");
    expect(review.proposal).toContain("Refund button");
    await post(gui, "/api/plan/review", { choice: "approve" });
    const saved = await waitForStep(gui, "saved");
    expect(saved.message).toMatch(/^Saved task #3\. It's standalone/);
    expect(snapshot(root).tasks.at(-1)).toEqual({ id: 3, title: "Refund button" });
  }, 60_000);

  it("FR-GUI-023: with no options, the GUI sends the PM the same arguments as cclinic plan with its defaults", async () => {
    const root = project();
    const { gui, harness } = await startGui(root, pmRules(asking("Who pays?")));
    expect((await post(gui, "/api/plan", { target: { kind: "task", roadmapId: 1 } })).status).toBe(201);
    await waitForStep(gui, "question");

    const cli = agentHarness({ rules: pmRules(asking("Who pays?")) });
    vi.mocked(input).mockRejectedValueOnce(new Error("stop here"));
    // Commander's defaults for `cclinic plan --task --roadmap 1`.
    await runPlanCommand(
      { dir: root, task: true, roadmap: 1, maxBudgetUsd: PLAN_LIMITS.maxBudgetUsd, timeoutMinutes: 30 },
      cli.context,
    ).catch(() => undefined);
    const withoutIds = (args: readonly string[]) =>
      args.map((arg) => arg.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "ID"));
    const guiArgs = withoutIds(harness.calls()[0]?.args ?? []);
    expect(guiArgs).toEqual(withoutIds(cli.calls()[0]?.args ?? []));
    expect(guiArgs.join(" ")).toContain(`--max-budget-usd ${PLAN_LIMITS.maxBudgetUsd}`);
    expect(harness.calls()[0]?.prompt).toBe(cli.calls()[0]?.prompt);
    expect(vi.mocked(select)).not.toHaveBeenCalled();
  }, 60_000);
});

describe("QA D5: refusals and out-of-turn requests", () => {
  it("FR-GUI-024: refine with empty or blank feedback is refused, and the proposal stays waiting", async () => {
    const root = project();
    const { gui, harness } = await startGui(root, pmRules(proposing(roadmapProposal)));
    await post(gui, "/api/plan", NEW_ROADMAP);
    await waitForStep(gui, "review");
    for (const feedback of [undefined, "", "   \n "]) {
      const reply = await post(gui, "/api/plan/review", { choice: "refine", feedback });
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body)).toEqual({ error: "Type your feedback for the PM." });
    }
    expect((await planOf(gui))?.step).toBe("review");
    expect(harness.calls()).toHaveLength(1);
    // An answer while a proposal (not a question) waits is refused too.
    const answer = await post(gui, "/api/plan/answer", { text: "Hi" });
    expect(answer.status).toBe(409);
    expect(JSON.parse(answer.body)).toEqual({ error: "No question is waiting." });
    expect((await post(gui, "/api/plan/review", { choice: "maybe" })).status).toBe(400);
    expect((await planOf(gui))?.step).toBe("review");
  }, 60_000);

  it("FR-GUI-024: an empty answer is refused, and a review while a question waits is refused", async () => {
    const root = project();
    const { gui } = await startGui(root, pmRules(asking("Who pays?")));
    await post(gui, "/api/plan", NEW_ROADMAP);
    await waitForStep(gui, "question");
    const empty = await post(gui, "/api/plan/answer", { text: "  " });
    expect(empty.status).toBe(400);
    expect(JSON.parse(empty.body)).toEqual({ error: "Type an answer for the PM." });
    const review = await post(gui, "/api/plan/review", { choice: "approve" });
    expect(review.status).toBe(409);
    expect(JSON.parse(review.body)).toEqual({ error: "No proposal is waiting." });
    expect(await planOf(gui)).toMatchObject({ step: "question", question: "Who pays?" });
    expect(snapshot(root).roadmaps).toEqual(["Launch"]);
  }, 60_000);

  it("FR-GUI-026: two Plans started at the same moment: exactly one starts", async () => {
    const root = project();
    const { gui, harness } = await startGui(root, pmRules(asking("Who pays?"), asking("Again?")));
    const replies = await Promise.all([post(gui, "/api/plan", NEW_ROADMAP), post(gui, "/api/plan", NEW_ROADMAP)]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
    await waitForStep(gui, "question");
    expect(harness.calls()).toHaveLength(1);
  }, 60_000);

  it("FR-GUI-023: bodies Plan refuses get 400 with a message, start no PM and save nothing", async () => {
    const root = project();
    const { gui, harness } = await startGui(root, pmRules(asking("Who pays?")));
    const bodies: unknown[] = [
      {},
      { target: { kind: "nope" } },
      { target: { kind: "extend-roadmap" } },
      { target: { kind: "task", roadmapId: 0 } },
      { target: { kind: "new-roadmap" }, maxBudgetUsd: -1 },
      { target: { kind: "new-roadmap" }, maxBudgetUsd: "1" },
      { target: { kind: "new-roadmap" }, timeoutMinutes: 0 },
      { target: { kind: "new-roadmap" }, model: "x".repeat(5000) },
      { target: { kind: "new-roadmap" }, extra: true },
      { target: { kind: "new-roadmap", title: "Launch 2" } },
      [],
      "text",
    ];
    for (const body of bodies) {
      const reply = await post(gui, "/api/plan", body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect((JSON.parse(reply.body) as { error: string }).error.length).toBeGreaterThan(0);
    }
    expect(await planOf(gui)).toBeNull();
    expect(harness.calls()).toHaveLength(0);
    expect(snapshot(root).roadmaps).toEqual(["Launch"]);
  }, 60_000);

  it("FR-GUI-026: a refused body while a session waits gets 400 and leaves the session as it was", async () => {
    const root = project();
    const { gui, harness } = await startGui(root, pmRules(asking("Who pays?")));
    await post(gui, "/api/plan", NEW_ROADMAP);
    await waitForStep(gui, "question");
    expect((await post(gui, "/api/plan", { target: { kind: "new-roadmap" }, maxBudgetUsd: 0 })).status).toBe(400);
    const valid = await post(gui, "/api/plan", NEW_ROADMAP);
    expect(valid.status).toBe(409);
    expect(await planOf(gui)).toMatchObject({ step: "question", question: "Who pays?" });
    expect(harness.calls()).toHaveLength(1);
  }, 60_000);
});

describe("QA D5: nothing saved unless approved", () => {
  it("FR-GUI-025: cancel while the PM is thinking stops the PM's process and saves nothing; a new Plan can start", async () => {
    const root = project();
    const pids = path.join(makeTempFolder(), "pids");
    const { gui } = await startGui(root, [{ hang: true }, { output: asking("Who pays?") }], {
      FAKE_CLAUDE_PIDS: pids,
    });
    await post(gui, "/api/plan", NEW_ROADMAP);
    const pid = await vi.waitFor(() => {
      const [first] = pidsIn(pids);
      if (first === undefined) throw new Error("no PM yet");
      return first;
    }, WAIT);
    expect((await planOf(gui))?.step).toBe("thinking");
    expect((await post(gui, "/api/plan/cancel")).status).toBe(200);
    expect(await waitForStep(gui, "cancelled")).toMatchObject({ message: "Cancelled. Nothing was saved." });
    await vi.waitFor(() => {
      expect(isAlive(pid)).toBe(false);
    }, WAIT);
    expect(snapshot(root).roadmaps).toEqual(["Launch"]);
    expect((await post(gui, "/api/plan/cancel")).status).toBe(409);
    expect((await post(gui, "/api/plan", NEW_ROADMAP)).status).toBe(201);
    await waitForStep(gui, "question");
  }, 60_000);

  it("FR-GUI-025: the GUI stopping while the PM is thinking stops the PM's process and saves nothing", async () => {
    const root = project();
    const pids = path.join(makeTempFolder(), "pids");
    const { gui } = await startGui(root, [{ hang: true }], { FAKE_CLAUDE_PIDS: pids });
    await post(gui, "/api/plan", NEW_ROADMAP);
    const pid = await vi.waitFor(() => {
      const [first] = pidsIn(pids);
      if (first === undefined) throw new Error("no PM yet");
      return first;
    }, WAIT);
    await gui.stop();
    running.splice(running.indexOf(gui), 1);
    await vi.waitFor(() => {
      expect(isAlive(pid)).toBe(false);
    }, WAIT);
    expect(snapshot(root).roadmaps).toEqual(["Launch"]);
  }, 60_000);

  it("FR-GUI-025: the GUI stopping while a question waits ends cleanly and saves nothing", async () => {
    const root = project();
    const { gui } = await startGui(root, pmRules(asking("Who pays?")));
    await post(gui, "/api/plan", NEW_ROADMAP);
    await waitForStep(gui, "question");
    await gui.stop();
    running.splice(running.indexOf(gui), 1);
    expect(snapshot(root).roadmaps).toEqual(["Launch"]);
  }, 60_000);

  it("FR-GUI-025: a save that fails saves nothing, keeps the proposal shown, and lets a new Plan start", async () => {
    const root = project();
    const { gui } = await startGui(root, pmRules(proposing(roadmapProposal), asking("Again?")));
    await post(gui, "/api/plan", NEW_ROADMAP);
    const review = await waitForStep(gui, "review");
    const db = path.join(root, ".cclinic/tasks.db");
    const before = readFileSync(db);
    chmodSync(db, 0o444);
    try {
      expect((await post(gui, "/api/plan/review", { choice: "approve" })).status).toBe(200);
      const failed = await waitForStep(gui, "failed");
      expect(failed.message).toMatch(/^Nothing was saved: /);
      expect(failed.proposal).toBe(review.proposal);
    } finally {
      chmodSync(db, 0o644);
    }
    expect(readFileSync(db).equals(before)).toBe(true);
    expect(snapshot(root).roadmaps).toEqual(["Launch"]);
    expect((await post(gui, "/api/plan", NEW_ROADMAP)).status).toBe(201);
  }, 60_000);

  it("FR-GUI-025: a PM whose reply never becomes valid ends failed, saving nothing", async () => {
    const root = project();
    const { gui } = await startGui(root, [{ output: { nonsense: true }, times: 0 }]);
    await post(gui, "/api/plan", NEW_ROADMAP);
    const failed = await waitForStep(gui, "failed");
    expect(failed.message).not.toBe("");
    expect(failed.question).toBeNull();
    expect(snapshot(root).roadmaps).toEqual(["Launch"]);
  }, 60_000);
});

describe("QA D5: secrets in what the PM says (FR-GUI-011)", () => {
  const SECRET = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

  it("FR-GUI-011: a secret in the PM's question and proposal reaches the browser redacted", async () => {
    const root = project();
    const leaky: RoadmapProposal = {
      ...roadmapProposal,
      milestones: [{ title: "Cards", goal: `Use key ${SECRET}`, tasks: [planned("a")] }],
    };
    const { gui } = await startGui(root, pmRules(asking(`Is ${SECRET} your key?`), proposing(leaky)));
    const stream = openStream(gui, "/api/plan/events");
    await post(gui, "/api/plan", NEW_ROADMAP);
    const question = await waitForStep(gui, "question");
    await post(gui, "/api/plan/answer", { text: "No" });
    const review = await waitForStep(gui, "review");
    stream.close();
    expect(question.question).not.toContain(SECRET);
    expect(review.proposal).not.toContain(SECRET);
    expect(JSON.stringify(stream.events)).not.toContain(SECRET);
  }, 60_000);

  it("FR-GUI-011, FR-GUI-025: a failed save's kept proposal reaches the browser redacted", async () => {
    const root = project();
    const leaky: RoadmapProposal = {
      ...roadmapProposal,
      milestones: [{ title: "Cards", goal: `Use key ${SECRET}`, tasks: [planned("a")] }],
    };
    const { gui } = await startGui(root, pmRules(proposing(leaky)));
    const stream = openStream(gui, "/api/plan/events");
    await post(gui, "/api/plan", NEW_ROADMAP);
    await waitForStep(gui, "review");
    const db = path.join(root, ".cclinic/tasks.db");
    chmodSync(db, 0o444);
    try {
      await post(gui, "/api/plan/review", { choice: "approve" });
      const failed = await waitForStep(gui, "failed");
      expect(failed.proposal).toContain("Use key");
      expect(failed.proposal).not.toContain(SECRET);
      expect(failed.message).not.toContain(SECRET);
    } finally {
      chmodSync(db, 0o644);
    }
    stream.close();
    expect(JSON.stringify(stream.events)).not.toContain(SECRET);
  }, 60_000);
});

describe("QA D5: Plan in the browser", () => {
  async function openPage(gui: TestGui, viewport = { width: 1280, height: 900 }, colorScheme?: "light" | "dark") {
    const context = await browser.newContext({ viewport, ...(colorScheme === undefined ? {} : { colorScheme }) });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
    await page.locator('[data-key="task-1"]').waitFor();
    return page;
  }

  it("FR-GUI-024: HTML in the PM's question and proposal is shown as text, not run", async () => {
    const root = project();
    const html = '<img src=x onerror="window.pwned=1"><b>bold</b>';
    const { gui } = await startGui(
      root,
      pmRules(
        asking(html),
        proposing({
          ...roadmapProposal,
          roadmap: { title: html, goal: "g" },
        }),
      ),
    );
    const page = await openPage(gui);
    await post(gui, "/api/plan", NEW_ROADMAP);
    await waitForStep(gui, "question");
    await page.locator("#needs-you").click();
    await page.locator("#needs-list .needs-item", { hasText: "The PM" }).locator("button").click();
    const dialog = page.locator("#plan-dialog");
    expect(await dialog.locator(".plan-question-text").textContent()).toBe(html);
    expect(await dialog.locator("img, b").count()).toBe(0);
    await dialog.locator("#plan-answer").fill("Shoppers");
    await dialog.locator('.plan-question button[type="submit"]').click();
    await expect.poll(() => dialog.locator(".plan-proposal").textContent(), WAIT).toContain(html);
    expect(await dialog.locator("img, b").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
  }, 60_000);

  it("FR-GUI-024: refine with empty feedback shows the refusal in the dialog; with feedback the new proposal shows", async () => {
    const root = project();
    const { gui, harness } = await startGui(root, pmRules(proposing(roadmapProposal), proposing(roadmapProposal)));
    const page = await openPage(gui);
    await page.locator("#plan-open").click();
    const dialog = page.locator("#plan-dialog");
    await dialog.locator("#plan-start").click();
    await expect.poll(() => dialog.locator(".plan-proposal").count(), WAIT).toBe(1);
    await dialog.getByRole("button", { name: "Refine" }).click();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("plan-feedback");
    await dialog.getByRole("button", { name: "Send feedback" }).click();
    await expect.poll(() => dialog.locator("#plan-error").textContent()).toBe("Type your feedback for the PM.");
    await dialog.locator("#plan-feedback").fill("Split task b");
    await dialog.getByRole("button", { name: "Send feedback" }).click();
    await vi.waitFor(() => {
      expect(harness.calls()).toHaveLength(2);
    }, WAIT);
    expect(harness.calls()[1]?.prompt).toContain("Split task b");
    await expect.poll(() => dialog.getByRole("button", { name: "Approve and save" }).count(), WAIT).toBe(1);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(() => dialog.locator(".plan-ended").textContent(), WAIT).toContain("Nothing was saved");
    expect(snapshot(root).roadmaps).toEqual(["Launch"]);
  }, 60_000);

  it("FR-GUI-026: two tabs follow the same session; an answer in one moves both, and a reload at the proposal shows it", async () => {
    const root = project();
    const { gui } = await startGui(root, pmRules(asking("Who pays?"), proposing(roadmapProposal)));
    const one = await openPage(gui);
    const two = await openPage(gui);
    await one.locator("#plan-open").click();
    await one.locator("#plan-dialog #plan-start").click();
    await expect.poll(() => one.locator("#plan-dialog .plan-question-text").textContent(), WAIT).toBe("Who pays?");
    await expect.poll(() => two.locator("#needs-count").textContent(), WAIT).toBe("1");
    await two.locator("#needs-you").click();
    await two.locator("#needs-list .needs-item", { hasText: "The PM" }).locator("button").click();
    expect(await two.locator("#plan-dialog .plan-question-text").textContent()).toBe("Who pays?");
    await two.locator("#plan-answer").fill("Shoppers");
    await two.locator('#plan-dialog .plan-question button[type="submit"]').click();
    await expect.poll(() => one.locator("#plan-dialog .plan-proposal").textContent(), WAIT).toContain("Checkout");
    await expect.poll(() => two.locator("#plan-dialog .plan-proposal").textContent(), WAIT).toContain("Checkout");
    await two.reload();
    await two.locator('[data-key="task-1"]').waitFor();
    await expect.poll(() => two.locator("#needs-count").textContent(), WAIT).toBe("1");
    await two.locator("#needs-you").click();
    await two.locator("#needs-list .needs-item", { hasText: "The PM" }).locator("button").click();
    expect(await two.locator("#plan-dialog .plan-proposal").textContent()).toContain("Checkout");
    // Starting from the other tab while it's going is refused in the dialog.
    expect(await two.locator("#plan-form").isHidden()).toBe(true);
  }, 60_000);

  it("FR-GUI-024 at 768 px: a very long question and proposal don't scroll the page sideways", async () => {
    const root = project();
    const long = "Averyveryverylongwordwithoutanyspacesatall".repeat(8);
    const { gui } = await startGui(
      root,
      pmRules(
        asking(`${long} ${"word ".repeat(400)}`),
        proposing({
          ...roadmapProposal,
          roadmap: { title: `Checkout ${long.slice(0, 180)}`, goal: long },
          milestones: [
            {
              title: long.slice(0, 190),
              goal: long,
              tasks: Array.from({ length: 30 }, (_, at) => ({
                ...planned(`k${at}`),
                title: `T${at} ${long.slice(0, 180)}`,
                description: long,
              })),
            },
          ],
        }),
      ),
    );
    const page = await openPage(gui, { width: 768, height: 900 });
    await page.locator("#plan-open").click();
    const dialog = page.locator("#plan-dialog");
    await dialog.locator("#plan-start").click();
    await expect.poll(() => dialog.locator(".plan-question-text").count(), WAIT).toBe(1);
    const sideways = () =>
      page.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        dialog: (() => {
          const node = document.getElementById("plan-dialog");
          return node === null ? 0 : node.scrollWidth - node.clientWidth;
        })(),
        box: document.getElementById("plan-dialog")?.getBoundingClientRect().right ?? 0,
      }));
    let measured = await sideways();
    expect(measured.page).toBeLessThanOrEqual(768);
    expect(measured.dialog).toBe(0);
    expect(measured.box).toBeLessThanOrEqual(768);
    await dialog.locator("#plan-answer").fill("Shoppers");
    await dialog.locator('.plan-question button[type="submit"]').click();
    await expect.poll(() => dialog.locator(".plan-proposal").count(), WAIT).toBe(1);
    measured = await sideways();
    expect(measured.page).toBeLessThanOrEqual(768);
    expect(measured.dialog).toBe(0);
    expect(await dialog.locator(".plan-proposal").evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
    // The action buttons are in view without scrolling sideways.
    const approve = await dialog.getByRole("button", { name: "Approve and save" }).boundingBox();
    expect((approve?.x ?? 0) + (approve?.width ?? 0)).toBeLessThanOrEqual(768);
  }, 60_000);

  it("FR-GUI-064: the Plan dialog works by keyboard: focus starts inside, Tab stays inside with an outline, Escape closes", async () => {
    const root = project();
    const { gui } = await startGui(root, pmRules(asking("Who pays?")));
    const page = await openPage(gui);
    await page.locator("#plan-open").focus();
    await page.keyboard.press("Enter");
    const dialog = page.locator("#plan-dialog");
    await expect.poll(() => dialog.evaluate((node) => (node as HTMLDialogElement).open)).toBe(true);
    const focus = () =>
      page.evaluate(() => {
        const node = document.activeElement;
        if (node === null) return { inside: false, outlined: false, name: "none" };
        const style = getComputedStyle(node);
        return {
          inside: node.closest("#plan-dialog") !== null,
          outlined: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2,
          name: `${node.tagName.toLowerCase()}#${node.id}[${node.getAttribute("name") ?? ""}]`,
        };
      });
    expect(await focus()).toMatchObject({ inside: true });
    const seen: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press("Tab");
      const now = await focus();
      // A modal dialog lets Tab leave to the browser's own controls (the body is then focused); never to the page.
      if (now.name.startsWith("body")) continue;
      expect(now).toMatchObject({ inside: true, outlined: true });
      seen.push(now.name);
    }
    expect(seen).toEqual(expect.arrayContaining(["input#[maxBudgetUsd]", "button#plan-start[]"]));
    // Start by keyboard: focus the start button and press Enter.
    await page.locator("#plan-start").focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => dialog.locator(".plan-question-text").textContent(), WAIT).toBe("Who pays?");
    await page.locator("#plan-answer").focus();
    await page.keyboard.type("Shoppers");
    await page.keyboard.press("Tab");
    expect((await focus()).inside).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => dialog.evaluate((node) => (node as HTMLDialogElement).open)).toBe(false);
    // Closing the dialog doesn't end the session; Needs you still counts it.
    expect((await planOf(gui))?.step).toBe("question");
    await expect.poll(() => page.locator("#needs-count").textContent()).toBe("1");
  }, 60_000);

  for (const theme of ["light", "dark"] as const)
    it(`FR-GUI-064: in the ${theme} theme every text in the Plan dialog is at least 4.5:1 (form, question, proposal, failure)`, async () => {
      const root = project();
      const { gui } = await startGui(root, [
        { output: asking("Who pays?") },
        { output: proposing(roadmapProposal) },
        { exitCode: 1, message: "The model is overloaded." },
      ]);
      const page = await openPage(gui, { width: 1280, height: 900 }, theme);
      const dialog = page.locator("#plan-dialog");
      const low: string[] = [];
      await page.locator("#plan-open").click();
      await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)));
      low.push(...(await lowContrast(page, 4.5)));
      await dialog.locator("#plan-start").click();
      await expect.poll(() => dialog.locator(".plan-question-text").count(), WAIT).toBe(1);
      low.push(...(await lowContrast(page, 4.5)));
      await dialog.locator("#plan-answer").fill("x");
      await dialog.locator('.plan-question button[type="submit"]').click();
      await expect.poll(() => dialog.locator(".plan-proposal").count(), WAIT).toBe(1);
      low.push(...(await lowContrast(page, 4.5)));
      await dialog.getByRole("button", { name: "Refine" }).click();
      await dialog.getByRole("button", { name: "Send feedback" }).click();
      await expect.poll(() => dialog.locator("#plan-error").textContent()).not.toBe("");
      low.push(...(await lowContrast(page, 4.5)));
      await dialog.locator("#plan-feedback").fill("more");
      await dialog.getByRole("button", { name: "Send feedback" }).click();
      await expect.poll(() => dialog.locator(".plan-ended").count(), WAIT).toBe(1);
      low.push(...(await lowContrast(page, 4.5)));
      expect([...new Set(low)]).toEqual([]);
    }, 60_000);

  it("FR-GUI-023: the roadmap panel's Extend with the PM opens Plan for that roadmap", async () => {
    const root = project();
    const { gui } = await startGui(root, []);
    const page = await openPage(gui);
    await page.locator('[data-frame="roadmap-1"] button[data-action="open-roadmap"]').click();
    await page.locator("#panel-body").getByRole("button", { name: "Extend with the PM" }).click();
    expect(await page.locator("#plan-target").textContent()).toBe("More milestones and tasks for roadmap #1.");
    await page.locator("#plan-dialog [data-plan-close]").click();
    await page.locator("#panel-body").getByRole("button", { name: "Plan a task" }).click();
    expect(await page.locator("#plan-target").textContent()).toBe("One task in roadmap #1.");
  }, 60_000);

  describe("QA D5 run 2: What to plan (FR-GUI-023, standalone task from New roadmap)", () => {
    const what = (page: Page) => page.locator('#plan-dialog select[name="what"]');
    const target = (page: Page) => page.locator("#plan-target").textContent();

    it("switching back and forth keeps the shown target and the started target in step", async () => {
      const root = project();
      const { gui, harness } = await startGui(root, pmRules(asking("Which?")));
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      expect(await page.locator("#plan-what").isVisible()).toBe(true);
      expect(await what(page).inputValue()).toBe("new-roadmap");
      expect(await target(page)).toBe("A new roadmap.");
      for (const [value, text] of [
        ["task", "One standalone task."],
        ["new-roadmap", "A new roadmap."],
        ["task", "One standalone task."],
        ["new-roadmap", "A new roadmap."],
        ["task", "One standalone task."],
      ] as const) {
        await what(page).selectOption(value);
        expect(await target(page)).toBe(text);
      }
      await page.locator("#plan-start").click();
      const plan = await waitForStep(gui, "question");
      expect(plan.target).toEqual({ kind: "task", roadmapId: null });
      expect(harness.calls()[0]?.prompt).not.toContain("roadmap #");
      // While the session shows, the form, and so the choice, is hidden.
      expect(await page.locator("#plan-what").isVisible()).toBe(false);
      expect(await page.locator("#plan-form").isVisible()).toBe(false);
      expect(await target(page)).toBe("One standalone task.");
      // Reopening from New roadmap while it waits shows the session, not the form.
      await page.locator("#plan-dialog [data-plan-close]").evaluate((node) => node.closest("dialog")?.close());
      await page.locator("#plan-open").click();
      expect(await page.locator("#plan-what").isVisible()).toBe(false);
      expect(await page.locator(".plan-question-text").textContent()).toBe("Which?");
      await page.getByRole("button", { name: "Cancel planning" }).click();
      await waitForStep(gui, "cancelled");
    }, 60_000);

    it("reopening resets the choice to A new roadmap, after Close, Escape, and a frame's Plan a task", async () => {
      const root = project();
      const { gui } = await startGui(root, []);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await what(page).selectOption("task");
      await page.locator("#plan-dialog [data-plan-close]").click();
      await page.locator("#plan-open").click();
      expect(await what(page).inputValue()).toBe("new-roadmap");
      expect(await target(page)).toBe("A new roadmap.");
      await what(page).selectOption("task");
      await page.keyboard.press("Escape");
      await expect.poll(() => page.locator("#plan-dialog").evaluate((d) => (d as HTMLDialogElement).open)).toBe(false);
      await page.locator("#plan-open").click();
      expect(await what(page).inputValue()).toBe("new-roadmap");
      expect(await target(page)).toBe("A new roadmap.");
      await what(page).selectOption("task");
      await page.locator("#plan-dialog [data-plan-close]").click();
      await page.locator('[data-frame="roadmap-1"] button[data-action="plan-task"]').click();
      expect(await target(page)).toBe("One task in roadmap #1.");
      expect(await page.locator("#plan-what").isVisible()).toBe(false);
      await page.locator("#plan-dialog [data-plan-close]").click();
      await page.locator("#plan-open").click();
      expect(await page.locator("#plan-what").isVisible()).toBe(true);
      expect(await what(page).inputValue()).toBe("new-roadmap");
      expect(await target(page)).toBe("A new roadmap.");
    }, 60_000);

    it("after a standalone session ends, New roadmap shows a fresh form with A new roadmap", async () => {
      const root = project();
      const task = {
        task: { title: "Lock accounts", description: "x", spec: null, dependsOn: [] },
        milestoneId: null,
        openQuestions: [],
      };
      const { gui } = await startGui(root, pmRules(proposing(task)));
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await what(page).selectOption("task");
      await page.locator("#plan-start").click();
      const dialog = page.locator("#plan-dialog");
      await expect.poll(() => dialog.locator(".plan-proposal").count(), WAIT).toBe(1);
      await dialog.getByRole("button", { name: "Approve and save" }).click();
      await expect.poll(() => dialog.locator(".plan-ended").count(), WAIT).toBe(1);
      await dialog.locator(".plan-ended").getByRole("button", { name: "Close" }).click();
      await page.locator("#plan-open").click();
      expect(await page.locator("#plan-form").isVisible()).toBe(true);
      expect(await what(page).inputValue()).toBe("new-roadmap");
      expect(await target(page)).toBe("A new roadmap.");
      expect(snapshot(root).roadmaps).toEqual(["Launch"]);
    }, 60_000);

    it("the choice is reached and changed by keyboard, with a visible outline", async () => {
      const root = project();
      const { gui } = await startGui(root, []);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      let reached = false;
      for (let step = 0; step < 10 && !reached; step += 1) {
        reached = await page.evaluate(() => document.activeElement?.getAttribute("name") === "what");
        if (!reached) await page.keyboard.press("Tab");
      }
      expect(reached).toBe(true);
      const outline = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement as Element);
        return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
      });
      expect(outline).toBe(true);
      // Type-ahead on a closed select works on every platform (macOS opens a popup on the arrow keys).
      await page.keyboard.press("o");
      await expect.poll(() => what(page).inputValue()).toBe("task");
      await expect.poll(() => target(page)).toBe("One standalone task.");
      await page.waitForTimeout(1100);
      await page.keyboard.press("a");
      await expect.poll(() => target(page)).toBe("A new roadmap.");
    }, 60_000);

    it("at 768 px the choice fits in the dialog and nothing scrolls sideways", async () => {
      const root = project();
      const { gui } = await startGui(root, []);
      const page = await openPage(gui, { width: 768, height: 900 });
      await page.locator("#plan-open").click();
      await what(page).selectOption("task");
      const fit = await page.evaluate(() => {
        const dialog = document.getElementById("plan-dialog");
        const select = document.querySelector('#plan-dialog select[name="what"]');
        if (dialog === null || select === null) return null;
        const outer = dialog.getBoundingClientRect();
        const box = select.getBoundingClientRect();
        return {
          inside: box.left >= outer.left && box.right <= outer.right,
          pageScroll: document.documentElement.scrollWidth <= window.innerWidth,
          dialogScroll: dialog.scrollWidth <= dialog.clientWidth,
        };
      });
      expect(fit).toEqual({ inside: true, pageScroll: true, dialogScroll: true });
    }, 60_000);
  });
});

/** The WCAG contrast of each visible text against the first opaque background behind it (as in gui-page.test.ts). */
const lowContrast = (page: Page, minimum: number) =>
  page.evaluate((least) => {
    const rgba = (value: string) => {
      const [r = 0, g = 0, b = 0, a = 1] = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return { r, g, b, a };
    };
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) =>
      [r, g, b]
        .map((c) => c / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0);
    const backOf = (node: Element) => {
      for (let at: Element | null = node; at !== null; at = at.parentElement) {
        const style = getComputedStyle(at);
        if (style.backgroundImage !== "none") return undefined;
        const colour = rgba(style.backgroundColor);
        if (colour.a >= 0.99) return colour;
      }
      return rgba(getComputedStyle(document.body).backgroundColor);
    };
    const low: string[] = [];
    for (const node of document.querySelectorAll("#plan-dialog *")) {
      const own = [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent?.trim() !== "");
      if (!own || node.closest("[hidden], dialog:not([open])") !== null) continue;
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) < 1) continue;
      const box = node.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const back = backOf(node);
      if (back === undefined) continue;
      const fore = rgba(style.color);
      const [a, b] = [lum(fore), lum(back)];
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < least)
        low.push(
          `${node.tagName.toLowerCase()}.${node.className} "${node.textContent.trim().slice(0, 30)}": ${ratio.toFixed(2)}`,
        );
    }
    return low;
  }, minimum);
