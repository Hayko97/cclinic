/// <reference lib="dom" />
/** The GUI's page in a headless browser: the canvas, its panel and the List (spec: gui, stage C2). */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import type { JobProcess } from "../../src/application/gui-jobs.js";
import type { Layout } from "../../src/core/canvas.js";
import { beginChange, linkSession, stateKey } from "../../src/core/workflow.js";
import { makeTempFolder } from "../support/helpers.js";
import { startTestGui, type TestGui } from "../support/gui.js";

const SESSION_LIVE = "5e550000-0000-4000-8000-000000000001";
const SESSION_OLD = "5e550000-0000-4000-8000-000000000002";
const WIDE = { width: 1280, height: 900 };

let browser: Browser;
const running: TestGui[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  // Each test's pages go with it, so the shared browser doesn't slow down as the file runs.
  await Promise.all(browser.contexts().map((context) => context.close()));
  await Promise.all(running.splice(0).map((gui) => gui.stop()));
});

const planned = (key: string, dependsOn: string[] = [], extra: { spec?: string; description?: string } = {}) => ({
  key,
  title: `Task ${key}`,
  description: extra.description ?? "",
  spec: extra.spec ?? null,
  dependsOn,
});

/**
 * Roadmap 1 "Payments": milestone "Cards" with tasks 1, 2 (after 1) and 3 (after 2), milestone "Refunds" with
 * task 4. Roadmap 2 "Onboarding" with task 5 (after 1). Task 6 has no milestone. Task 1 is done.
 */
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
          planned("a"),
          planned("b", ["a"], { spec: "refunds", description: "One\nTwo\nThree\nFour" }),
          planned("c", ["b"]),
        ],
      },
      { title: "Refunds", goal: "Pay back", tasks: [planned("d")] },
    ],
  });
  store.savePlan({
    roadmap: { title: "Onboarding", goal: "First run" },
    milestones: [{ title: "Sign-up", goal: "Join", tasks: [planned("e")] }],
  });
  store.addTask({ title: "Loose", dependsOn: [] });
  store.addDependency(5, 1);
  store.setStatus(1, "done");
  store.close();
  return root;
}

/** Task 2 has two of your sessions: one seen just now (live) and one an hour ago, each with a transcript. */
async function withSessions(root: string, home: string): Promise<void> {
  const line = (type: string, text: string) => `${JSON.stringify({ type, message: { content: text } })}\n`;
  const folder = path.join(home, ".claude/projects/p");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, `${SESSION_LIVE}.jsonl`),
    line("user", "live question") + line("assistant", "live answer"),
  );
  writeFileSync(path.join(folder, `${SESSION_OLD}.jsonl`), line("user", "old question"));
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  let state = beginChange(
    { changeType: "feature", spec: "refunds", taskId: 2 },
    { key: stateKey(2, "main"), approverMode: "user", now: hourAgo },
  );
  state = linkSession(
    state,
    { sessionId: SESSION_OLD, transcriptPath: path.join(folder, `${SESSION_OLD}.jsonl`) },
    hourAgo,
  );
  state = linkSession(
    state,
    { sessionId: SESSION_LIVE, transcriptPath: path.join(folder, `${SESSION_LIVE}.jsonl`) },
    new Date().toISOString(),
  );
  await openWorkflowStore(root).save(state);
  const branch = beginChange(
    { changeType: "bug", spec: "auth" },
    { key: stateKey(null, "fix-x"), approverMode: "user", now: new Date().toISOString() },
  );
  await openWorkflowStore(root).save(branch);
}

/** Jobs that end at once with exit 0, recording what they were asked to run. */
function fakeJobs() {
  const started: string[][] = [];
  const startJob = (args: readonly string[]): JobProcess => {
    started.push([...args]);
    return {
      onOutput: () => undefined,
      onExit: (listener) => {
        void Promise.resolve().then(() => {
          listener(0);
        });
      },
      signal: () => undefined,
    };
  };
  return { started, startJob };
}

interface Opened {
  readonly gui: TestGui;
  readonly page: Page;
  readonly root: string;
  readonly started: string[][];
}

async function open(
  options: {
    root?: string;
    home?: string;
    viewport?: { width: number; height: number };
    withSessions?: boolean;
    every?: (ms: number, run: () => Promise<void>) => () => void;
    startJob?: (args: readonly string[]) => JobProcess;
    waitFor?: string;
  } = {},
): Promise<Opened> {
  const root = options.root ?? project();
  const home = options.home ?? makeTempFolder();
  if (options.withSessions === true) await withSessions(root, home);
  const jobs = fakeJobs();
  // No timer runs: the page gets the canvas when it connects, and nothing polls after that.
  const gui = await startTestGui(
    root,
    {},
    { startJob: options.startJob ?? jobs.startJob, every: options.every ?? (() => () => undefined) },
    { HOME: home },
  );
  running.push(gui);
  const context = await browser.newContext({ viewport: options.viewport ?? WIDE });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
  await page.locator(options.waitFor ?? '[data-key="task-1"]').waitFor();
  return { gui, page, root, started: jobs.started };
}

const layoutFile = (root: string) => path.join(root, ".cclinic/gui/layout.json");
const savedLayout = (root: string) => JSON.parse(readFileSync(layoutFile(root), "utf8")) as Layout;

async function centre(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} isn't shown`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(page: Page, selector: string, dx: number, dy: number): Promise<void> {
  const from = await centre(page, selector);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
  await page.mouse.up();
}

describe("canvas page", () => {
  it("TC-GUI-092: the canvas is the start screen, with a frame per roadmap, milestone columns, Unassigned and Changes", async () => {
    const { page } = await open({ withSessions: true });
    expect(await page.locator("#view-canvas").isVisible()).toBe(true);
    const frames = page.locator(".frame");
    expect(await frames.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-frame")))).toEqual([
      "roadmap-1",
      "roadmap-2",
      "unassigned",
      "changes",
    ]);
    const first = page.locator('[data-frame="roadmap-1"]');
    expect(await first.locator("h2").textContent()).toBe("Payments");
    expect(await first.locator(".frame-goal").textContent()).toBe("Card checkout");
    expect(await first.locator(".progress").textContent()).toBe("1 / 4 done");
    expect(await first.locator(".column-label span").allTextContents()).toEqual(["Cards", "Refunds"]);
    expect(await page.locator('[data-frame="unassigned"] h2').textContent()).toBe("Unassigned tasks");
    expect(await page.locator('[data-frame="unassigned"] [data-key="task-6"]').count()).toBe(1);
    expect(await page.locator('[data-frame="changes"] h2').textContent()).toBe("Changes without a task");
    expect(await page.locator('[data-frame="changes"] [data-key="change-branch-fix-x"]').count()).toBe(1);
  });

  it("TC-GUI-093: a task card shows its ID, title, 2 description lines, status, spec, step, mode, sessions and cost", async () => {
    const { page } = await open({ withSessions: true });
    const card = page.locator('[data-key="task-2"]');
    expect(await card.locator(".card-id").textContent()).toBe("#2");
    expect(await card.locator(".card-title").textContent()).toBe("Task b");
    expect(await card.locator(".status").textContent()).toBe("Open");
    expect(await card.locator(".spec").textContent()).toBe("refunds");
    expect(await card.locator(".step").textContent()).toBe("spec");
    expect(await card.locator(".mode").textContent()).toBe("Manual");
    expect(await card.locator(".agents").textContent()).toBe("You");
    expect(await card.locator(".sessions").textContent()).toBe("2 sessions");
    expect(await card.locator(".sessions .live-dot").count()).toBe(1);
    expect(await card.locator(".cost").textContent()).toBe("$0.00");
    // Only 2 lines of the description are shown.
    const lines = await card
      .locator(".card-description")
      .evaluate((node) => Math.round(node.clientHeight / parseFloat(getComputedStyle(node).lineHeight)));
    expect(lines).toBe(2);
    expect(await card.getAttribute("aria-label")).toBe("Task #2: Task b. Open, Manual");
  });

  it("TC-GUI-094: arrows go from the task depended on, solid once it's done, also across frames; selecting highlights", async () => {
    const { page } = await open();
    const arrows = await page
      .locator("path.arrow")
      .evaluateAll((nodes) =>
        nodes.map((node) => [node.dataset.from, node.dataset.to, node.classList.contains("is-done")]),
      );
    expect(arrows).toEqual(
      expect.arrayContaining([
        ["1", "2", true],
        ["2", "3", false],
        ["1", "5", true],
      ]),
    );
    expect(arrows).toHaveLength(3);
    await page.locator('[data-key="task-2"]').click();
    expect(
      await page.locator(".task-card.is-linked").evaluateAll((nodes) => nodes.map((node) => node.dataset.task)),
    ).toEqual(["1", "2", "3"]);
    expect(
      await page.locator("path.arrow.is-linked").evaluateAll((nodes) => nodes.map((node) => node.dataset.to)),
    ).toEqual(["2", "3"]);
    expect(await page.locator("#board").evaluate((node) => node.classList.contains("has-selection"))).toBe(true);
  });

  it("TC-GUI-096: a panel showing an ended session follows a session that goes live, unless the user picked one", async () => {
    const root = project();
    const home = makeTempFolder();
    const folder = path.join(home, ".claude/projects/p");
    mkdirSync(folder, { recursive: true });
    const line = (text: string) => `${JSON.stringify({ type: "user", message: { content: text } })}\n`;
    writeFileSync(path.join(folder, `${SESSION_OLD}.jsonl`), line("old question"));
    writeFileSync(path.join(folder, `${SESSION_LIVE}.jsonl`), line("live question"));
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const ended = linkSession(
      beginChange(
        { changeType: "feature", spec: "refunds", taskId: 3 },
        { key: stateKey(3, "main"), approverMode: "user", now: hourAgo },
      ),
      { sessionId: SESSION_OLD, transcriptPath: path.join(folder, `${SESSION_OLD}.jsonl`) },
      hourAgo,
    );
    await openWorkflowStore(root).save(ended);
    const clock = manualClock();
    const { page } = await open({ root, home, every: clock.every });
    await countCanvasMessages(page);
    await page.locator('[data-key="task-3"]').click();
    const entries = page.locator("#transcript .entries pre");
    await expect.poll(() => entries.allTextContents()).toEqual(["old question"]);
    const before = await canvasMessages(page);
    await openWorkflowStore(root).save(
      linkSession(
        ended,
        { sessionId: SESSION_LIVE, transcriptPath: path.join(folder, `${SESSION_LIVE}.jsonl`) },
        new Date().toISOString(),
      ),
    );
    await clock.tick();
    await expect.poll(() => canvasMessages(page)).toBeGreaterThan(before);
    await expect.poll(() => entries.allTextContents()).toEqual(["live question"]);
    // A session the user picks stays shown.
    await page.locator(`button[data-session="${SESSION_OLD}"]`).click();
    await expect.poll(() => entries.allTextContents()).toEqual(["old question"]);
    const next = await canvasMessages(page);
    await updateFromTerminal(page, root, clock, (store) => store.setStatus(3, "in-progress"));
    expect(await canvasMessages(page)).toBeGreaterThan(next);
    expect(await entries.allTextContents()).toEqual(["old question"]);
  });

  it("TC-GUI-096: a card opens its panel on the live transcript, a session opens its own, and no sessions is said", async () => {
    const { page } = await open({ withSessions: true });
    await page.locator('[data-key="task-2"]').click();
    const entries = page.locator("#transcript .entries pre");
    await expect.poll(() => entries.allTextContents()).toEqual(["live question", "live answer"]);
    expect(await page.locator("#panel-title").textContent()).toBe("Task #2");
    await page.locator(`button[data-session="${SESSION_OLD}"]`).click();
    await expect.poll(() => entries.allTextContents()).toEqual(["old question"]);
    expect(await page.locator(`button[data-session="${SESSION_OLD}"]`).getAttribute("aria-pressed")).toBe("true");
    await page.locator('[data-key="task-4"]').click();
    expect(await page.locator("#panel-title").textContent()).toBe("Task #4");
    expect(await page.locator('[data-testid="no-sessions"]').textContent()).toBe(
      "No Claude Code sessions for this task yet.",
    );
  });

  it("TC-GUI-097: zoom stops at 200 % and 25 %, around the pointer, and 0 fits every frame", async () => {
    const { page } = await open();
    const area = await centre(page, "#canvas-area");
    await page.mouse.move(area.x, area.y);
    const level = page.locator("#zoom-level");
    // The point under the pointer stays under it while zooming.
    const before = await page.locator("#board").evaluate((node) => node.style.transform);
    for (let step = 0; step < 20; step += 1) {
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -100);
      await page.keyboard.up("Control");
    }
    expect(await level.textContent()).toBe("200 %");
    expect(await page.locator("#board").evaluate((node) => node.style.transform)).not.toBe(before);
    for (let step = 0; step < 20; step += 1) await page.keyboard.press("-");
    expect(await level.textContent()).toBe("25 %");
    await page.keyboard.press("0");
    const view = await page.locator("#canvas-area").boundingBox();
    for (const key of ["roadmap-1", "roadmap-2", "unassigned"]) {
      const box = await page.locator(`[data-frame="${key}"]`).boundingBox();
      expect(box !== null && view !== null).toBe(true);
      if (box === null || view === null) return;
      expect(box.x).toBeGreaterThanOrEqual(view.x);
      expect(box.y).toBeGreaterThanOrEqual(view.y);
      expect(box.x + box.width).toBeLessThanOrEqual(view.x + view.width);
      expect(box.y + box.height).toBeLessThanOrEqual(view.y + view.height);
    }
  });

  it("TC-GUI-098: a card moves within its frame, snaps back when dropped outside it, a frame moves with its cards", async () => {
    const { page, root } = await open();
    const database = readFileSync(path.join(root, ".cclinic/tasks.db"));
    const scale = await page
      .locator("#board")
      .evaluate((node) => Number(/scale\(([\d.]+)\)/.exec(node.style.transform)?.[1] ?? "1"));
    const before = (await page.locator('[data-key="task-3"]').boundingBox()) ?? { x: 0, y: 0 };
    await drag(page, '[data-key="task-3"]', 0, 60 * scale);
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-3"]?.y).toBeGreaterThan(400);
    });
    const moved = savedLayout(root).cards["task-3"];
    // Dropped on roadmap 2's frame, it goes back to where it was.
    const target = await centre(page, '[data-frame="roadmap-2"]');
    const from = await centre(page, '[data-key="task-3"]');
    await drag(page, '[data-key="task-3"]', target.x - from.x, target.y - from.y);
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-3"]).toEqual(moved);
    });
    const after = (await page.locator('[data-key="task-3"]').boundingBox()) ?? { x: 0, y: 0 };
    expect(after.x).toBeCloseTo(before.x, 0);
    // The frame moves with its cards.
    const card = (await page.locator('[data-key="task-1"]').boundingBox()) ?? { x: 0, y: 0 };
    await drag(page, '[data-frame="roadmap-1"] .frame-head h2', 100, 50);
    await vi.waitFor(() => {
      expect(savedLayout(root).frames["roadmap-1"]).toBeDefined();
    });
    const cardAfter = (await page.locator('[data-key="task-1"]').boundingBox()) ?? { x: 0, y: 0 };
    expect(cardAfter.x - card.x).toBeCloseTo(100, 0);
    expect(cardAfter.y - card.y).toBeCloseTo(50, 0);
    expect(readFileSync(path.join(root, ".cclinic/tasks.db")).equals(database)).toBe(true);
  });

  it("TC-GUI-098: nothing is written while dragging, only once the drag ends", async () => {
    const { page, root } = await open();
    const from = await centre(page, '[data-key="task-4"]');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 10, from.y + 40, { steps: 5 });
    await page.mouse.move(from.x + 20, from.y + 80, { steps: 5 });
    expect(() => readFileSync(layoutFile(root))).toThrow();
    await page.mouse.up();
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-4"]).toBeDefined();
    });
  });

  it("TC-GUI-099: a saved layout is restored after a reload and in a second browser", async () => {
    const { page, root, gui } = await open();
    await drag(page, '[data-key="task-4"]', 0, 80);
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-4"]).toBeDefined();
    });
    const saved = savedLayout(root).cards["task-4"];
    const positionIn = async (other: Page) => {
      await other.locator('[data-key="task-4"]').waitFor();
      return other.locator('[data-key="task-4"]').evaluate((node) => ({
        x: parseFloat(node.style.left),
        y: parseFloat(node.style.top),
      }));
    };
    await page.reload();
    expect(await positionIn(page)).toEqual(saved);
    const second = await (await browser.newContext({ viewport: WIDE })).newPage();
    await second.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
    expect(await positionIn(second)).toEqual(saved);
  });

  it("TC-GUI-101: Tidy up asks first; cancel changes nothing, confirm puts the frame's cards back in place", async () => {
    const { page, root } = await open();
    await drag(page, '[data-key="task-4"]', 0, 80);
    await drag(page, '[data-key="task-5"]', 0, 80);
    await vi.waitFor(() => {
      expect(Object.keys(savedLayout(root).cards).sort()).toEqual(["task-4", "task-5"]);
    });
    const tidy = page.locator('[data-frame="roadmap-1"] [data-action="tidy"]');
    await tidy.click();
    expect(await page.locator("#confirm").isVisible()).toBe(true);
    await page.locator('#confirm button[value="cancel"]').click();
    expect(Object.keys(savedLayout(root).cards).sort()).toEqual(["task-4", "task-5"]);
    await tidy.click();
    await page.locator("#confirm-ok").click();
    await vi.waitFor(() => {
      expect(Object.keys(savedLayout(root).cards)).toEqual(["task-5"]);
    });
    expect(await page.locator('[data-key="task-4"]').evaluate((node) => node.style.top)).toBe("96px");
  });
});

describe("tasks from the page", () => {
  it("TC-GUI-029: removing a task asks first; cancel runs nothing, confirm runs cclinic tasks remove", async () => {
    const { page, started } = await open();
    await page.locator('[data-key="task-3"]').click();
    await page.locator("#panel-body button.danger", { hasText: "Remove" }).click();
    expect(await page.locator("#confirm-message").textContent()).toBe('Remove task #3 "Task c"?');
    await page.locator('#confirm button[value="cancel"]').click();
    expect(started).toEqual([]);
    await page.locator("#panel-body button.danger", { hasText: "Remove" }).click();
    await page.locator("#confirm-ok").click();
    await vi.waitFor(() => {
      expect(started).toEqual([["tasks", "remove", "3", "--json"]]);
    });
  });

  it("TC-GUI-028: the page adds a task, depends it, starts it and marks it done through cclinic tasks", async () => {
    const { page, started } = await open();
    await page.locator("#add-task-open").click();
    await page.locator('input[name="title"]').fill("New one");
    await page.locator('input[name="dependsOn"]').fill("1, 2");
    await page.locator('#add-task-form button[type="submit"]').click();
    await vi.waitFor(() => {
      expect(started).toContainEqual(["tasks", "add", "--title=New one", "--depends-on=1", "--depends-on=2", "--json"]);
    });
    await page.locator('[data-key="task-4"]').click();
    await page.locator('#panel-body input[type="number"]').fill("6");
    await page.locator("#panel-body button", { hasText: "Add dependency" }).click();
    await page.locator("#panel-body button", { hasText: "Start" }).click();
    await page.locator("#panel-body button", { hasText: "Mark done" }).click();
    await vi.waitFor(() => {
      expect(started.slice(1)).toEqual([
        ["tasks", "depend", "4", "--on=6", "--json"],
        ["tasks", "start", "4", "--json"],
        ["tasks", "done", "4", "--json"],
      ]);
    });
  });
});

describe("list and layout", () => {
  it("TC-GUI-075: the List shows milestones and tasks, links dependencies, marks waiting, and is remembered", async () => {
    const { page } = await open();
    await page.locator('[data-layout="list"]').click();
    expect(await page.locator("#list").isVisible()).toBe(true);
    expect(await page.locator(".list-roadmap h2").first().textContent()).toBe("Payments · 1 / 4 done");
    expect(await page.locator(".list-milestone h3").allTextContents()).toEqual(["Cards", "Refunds", "Sign-up"]);
    const row = page.locator('tr[data-task="3"]');
    expect(await row.locator("td").nth(1).textContent()).toBe("Open");
    expect(await row.locator("button", { hasText: "after #2" }).count()).toBe(1);
    expect(await row.getAttribute("class")).toBe("is-waiting");
    // Waiting on #2 shows on the canvas too.
    expect(await page.locator('[data-key="task-3"] .waiting').textContent()).toBe("Waiting on #2");
    await row.locator("button", { hasText: "after #2" }).click();
    expect(await page.locator("#panel-title").textContent()).toBe("Task #2");
    await page.reload();
    await page.locator('tr[data-task="3"]').waitFor();
    expect(await page.locator("#canvas-area").isVisible()).toBe(false);
  });

  it("TC-GUI-067: at 1280 px the panel opens beside the canvas and Escape closes it; at 768 px it's full width", async () => {
    const { page, gui } = await open();
    expect(await page.locator(".rail button").allTextContents()).toEqual(["Canvas", "Setup", "Jobs"]);
    await page.locator('[data-key="task-2"]').click();
    const panel = page.locator("#panel");
    expect((await panel.boundingBox())?.width).toBeLessThan(WIDE.width / 2);
    await page.keyboard.press("Escape");
    expect(await panel.isVisible()).toBe(false);
    const narrow = await (await browser.newContext({ viewport: { width: 768, height: 900 } })).newPage();
    await narrow.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
    await narrow.locator('[data-key="task-2"]').click();
    expect((await narrow.locator("#panel").boundingBox())?.width).toBe(768);
    for (const view of ["canvas", "setup", "jobs"]) {
      await narrow.keyboard.press("Escape");
      await narrow.locator(`[data-view="${view}"]`).click();
      expect(await narrow.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);
    }
  });
});

/** Stands in for the GUI's polling timer, so a test decides when the next check happens: no real clock. */
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

function storeOf(root: string) {
  const store = openTaskStore(path.join(root, ".cclinic"), "create");
  if (store === undefined) throw new Error("No store");
  return store;
}

/** A job that prints the CLI's `--json` failure and exits 1, as `cclinic tasks` does when it refuses. */
function failingJob(message: string) {
  const started: string[][] = [];
  const startJob = (args: readonly string[]): JobProcess => {
    started.push([...args]);
    let output: ((stream: "stdout" | "stderr", chunk: string) => void) | undefined;
    return {
      onOutput: (listener) => {
        output = listener;
      },
      onExit: (listener) => {
        void Promise.resolve().then(() => {
          output?.("stderr", `${message}\n`);
          output?.("stdout", `${JSON.stringify({ status: "error", exitCode: 1, errorType: "UsageError", message })}\n`);
          listener(1);
        });
      },
      signal: () => undefined,
    };
  };
  return { started, startJob };
}

const viewOf = (page: Page) =>
  page.locator("#board").evaluate((node) => {
    const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(node.style.transform);
    return { x: Number(match?.[1]), y: Number(match?.[2]), scale: Number(match?.[3]) };
  });

describe("QA: tasks from the page", () => {
  it("TC-GUI-029: a dependency cycle is refused with the CLI's own message, and the panel stays as it was", async () => {
    const cycle = "Task 1 can't depend on task 3: it would make a cycle (#1 -> #3 -> #2 -> #1).";
    const jobs = failingJob(cycle);
    const { page, root } = await open({ startJob: jobs.startJob });
    const database = readFileSync(path.join(root, ".cclinic/tasks.db"));
    await page.locator('[data-key="task-1"]').click();
    await page.locator('#panel-body input[type="number"]').fill("3");
    await page.locator("#panel-body button", { hasText: "Add dependency" }).click();
    await expect.poll(() => page.locator("#notice").textContent()).toBe(cycle);
    expect(await page.locator("#notice").getAttribute("class")).toContain("error");
    expect(jobs.started).toEqual([["tasks", "depend", "1", "--on=3", "--json"]]);
    expect(await page.locator("#panel-title").textContent()).toBe("Task #1");
    expect(readFileSync(path.join(root, ".cclinic/tasks.db")).equals(database)).toBe(true);
  });

  it("TC-GUI-029: a refused add keeps its dialog open and shows the CLI's message in it", async () => {
    const jobs = failingJob("Task 99 doesn't exist.");
    const { page } = await open({ startJob: jobs.startJob });
    await page.locator("#add-task-open").click();
    await page.locator('input[name="title"]').fill("New one");
    await page.locator('input[name="dependsOn"]').fill("99");
    await page.locator('#add-task-form button[type="submit"]').click();
    await expect.poll(() => page.locator("#add-task-error").textContent()).toBe("Task 99 doesn't exist.");
    expect(await page.locator("#add-task").isVisible()).toBe(true);
  });

  it("TC-GUI-028: a dependency that isn't a task ID is refused with a message, and nothing runs", async () => {
    const { page, started } = await open();
    await page.locator("#add-task-open").click();
    await page.locator('input[name="title"]').fill("New one");
    await page.locator('input[name="dependsOn"]').fill("abc");
    await page.locator('#add-task-form button[type="submit"]').click();
    // The CLI's own message for `--depends-on abc` (`parseId`).
    await expect.poll(() => page.locator("#add-task-error").textContent()).toBe('"abc" isn\'t a valid task ID.');
    expect(await page.locator("#add-task").isVisible()).toBe(true);
    expect(started).toEqual([]);
  });

  it("TC-GUI-028: the panel removes a dependency through cclinic tasks undepend", async () => {
    const { page, started } = await open();
    await page.locator('[data-key="task-3"]').click();
    await page.locator('#panel-body button[aria-label="Remove the dependency on #2"]').click();
    await vi.waitFor(() => {
      expect(started).toEqual([["tasks", "undepend", "3", "--on=2", "--json"]]);
    });
  });

  it("TC-GUI-029: removing a milestone or a roadmap asks first; cancel runs nothing, confirm runs the remove", async () => {
    const { page, started } = await open();
    const milestone = page.locator('[aria-label="Remove milestone Refunds"]');
    await milestone.click();
    expect(await page.locator("#confirm-message").textContent()).toBe('Remove milestone "Refunds"?');
    await page.locator('#confirm button[value="cancel"]').click();
    const roadmap = page.locator('[data-frame="roadmap-2"] [data-action="remove-roadmap"]');
    await roadmap.click();
    expect(await page.locator("#confirm-message").textContent()).toBe(
      'Remove roadmap "Onboarding" and its milestones?',
    );
    await page.keyboard.press("Escape");
    expect(await page.locator("#confirm").isVisible()).toBe(false);
    expect(started).toEqual([]);
    await milestone.click();
    await page.locator("#confirm-ok").click();
    await vi.waitFor(() => {
      expect(started).toEqual([["tasks", "milestone", "remove", "2", "--json"]]);
    });
    await roadmap.click();
    await page.locator("#confirm-ok").click();
    await vi.waitFor(() => {
      expect(started.at(-1)).toEqual(["tasks", "roadmap", "remove", "2", "--json"]);
    });
  });

  it("TC-GUI-029: Escape while the remove dialog is open cancels it and keeps the panel open", async () => {
    const { page, started } = await open();
    await page.locator('[data-key="task-3"]').click();
    await page.locator("#panel-body button.danger", { hasText: "Remove" }).click();
    await page.keyboard.press("Escape");
    expect(await page.locator("#confirm").isVisible()).toBe(false);
    expect(await page.locator("#panel").isVisible()).toBe(true);
    expect(started).toEqual([]);
    await page.keyboard.press("Escape");
    expect(await page.locator("#panel").isVisible()).toBe(false);
  });

  it("TC-GUI-029: removing the task whose panel is open closes the panel, and its card goes", async () => {
    const clock = manualClock();
    const root = project();
    const startJob = (args: readonly string[]): JobProcess => ({
      onOutput: () => undefined,
      onExit: (listener) => {
        void Promise.resolve().then(() => {
          // What `cclinic tasks remove` would have done.
          if (args[1] === "remove") {
            const store = storeOf(root);
            store.removeTask(Number(args[2]));
            store.close();
          }
          listener(0);
        });
      },
      signal: () => undefined,
    });
    const { page } = await open({ root, every: clock.every, startJob });
    await page.locator('[data-key="task-3"]').click();
    await page.locator("#panel-body button.danger", { hasText: "Remove" }).click();
    await page.locator("#confirm-ok").click();
    await expect.poll(() => page.locator("#panel").isVisible()).toBe(false);
    await expect.poll(() => page.locator('[data-key="task-3"]').count()).toBe(0);
    expect(await page.locator('path.arrow[data-to="3"]').count()).toBe(0);
    expect(await page.locator("#notice").textContent()).toBe("Removed task #3.");
  });
});

describe("QA: live canvas, page side", () => {
  it("TC-GUI-031: changes made in the terminal reach the open page at the next check, without a reload", async () => {
    const clock = manualClock();
    const root = project();
    const { page } = await open({ root, every: clock.every });
    await drag(page, '[data-key="task-3"]', 0, 60);
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-3"]).toBeDefined();
    });
    const store = storeOf(root);
    store.setStatus(2, "done");
    store.addTask({ title: "Fresh", dependsOn: [] });
    store.removeTask(3);
    store.close();
    await clock.tick();
    await expect.poll(() => page.locator('[data-key="task-2"] .status').textContent()).toBe("Done");
    expect(await page.locator('[data-frame="unassigned"] [data-key="task-7"] .card-title').textContent()).toBe("Fresh");
    expect(await page.locator('[data-key="task-3"]').count()).toBe(0);
    expect(await page.locator('[data-frame="roadmap-1"] .progress').textContent()).toBe("2 / 3 done");
    // The next save leaves the removed task's position out.
    await drag(page, '[data-key="task-4"]', 0, 60);
    await vi.waitFor(() => {
      expect(Object.keys(savedLayout(root).cards)).toEqual(["task-4"]);
    });
  });

  it("TC-GUI-031: an open panel says when its task was removed in the terminal", async () => {
    const clock = manualClock();
    const root = project();
    const { page } = await open({ root, every: clock.every });
    await page.locator('[data-key="task-3"]').click();
    const store = storeOf(root);
    store.removeTask(3);
    store.close();
    await clock.tick();
    await expect.poll(() => page.locator("#panel-body").textContent()).toBe("Task #3 was removed.");
    expect(await page.locator("#board").evaluate((node) => node.classList.contains("has-selection"))).toBe(false);
  });

  it("TC-GUI-098: a canvas update that arrives during a drag doesn't move the dragged card, and shows once it ends", async () => {
    const clock = manualClock();
    const root = project();
    const { page } = await open({ root, every: clock.every });
    const from = await centre(page, '[data-key="task-4"]');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y + 30, { steps: 4 });
    const store = storeOf(root);
    store.setStatus(2, "done");
    store.close();
    await clock.tick();
    await page.mouse.move(from.x, from.y + 60, { steps: 4 });
    const during = await centre(page, '[data-key="task-4"]');
    expect(during.y).toBeCloseTo(from.y + 60, 0);
    expect(await page.locator('[data-key="task-2"] .status').textContent()).toBe("Open");
    await page.mouse.up();
    await expect.poll(() => page.locator('[data-key="task-2"] .status').textContent()).toBe("Done");
    const after = await centre(page, '[data-key="task-4"]');
    expect(after.y).toBeCloseTo(from.y + 60, 0);
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-4"]).toBeDefined();
    });
  });

  it("TC-GUI-102: a roadmap in a live run and a task worked on by hand show their own modes on the page", async () => {
    const root = project();
    const runId = "20261111-110000";
    const folder = path.join(root, ".cclinic/auto", runId);
    mkdirSync(path.join(folder, "sessions"), { recursive: true });
    writeFileSync(
      path.join(folder, "run.json"),
      JSON.stringify({
        runId,
        roadmapId: 1,
        roadmapTitle: "Payments",
        runBranch: `cclinic/auto/${runId}/run`,
        startedAt: new Date(Date.now() - 600_000).toISOString(),
        finishedAt: null,
        outcome: null,
        budgetUsd: 10,
        spentUsd: 3.4,
        developers: 2,
        tasks: [
          {
            taskId: 2,
            title: "Task b",
            dependsOn: [],
            status: "running",
            branch: null,
            rounds: { specReviews: 1, qaRuns: 1, implementationReviews: 0 },
            costUsd: 1.3,
            reason: null,
            requirementIds: [],
          },
        ],
        skippedInProgress: [],
      }),
    );
    writeFileSync(path.join(root, ".cclinic/auto/.lock"), JSON.stringify({ pid: process.pid, runId }));
    const manual = beginChange(
      { changeType: "feature", spec: "signup", taskId: 5 },
      { key: stateKey(5, "main"), approverMode: "user", now: new Date().toISOString() },
    );
    await openWorkflowStore(root).save(manual);
    const { page } = await open({ root });
    expect(await page.locator('[data-frame="roadmap-1"] .frame-meta .mode').textContent()).toBe(`AI run · ${runId}`);
    expect(await page.locator('[data-frame="roadmap-2"] .frame-meta .mode').count()).toBe(0);
    expect(await page.locator('[data-key="task-2"] .mode').textContent()).toBe("AI run");
    expect(await page.locator('[data-key="task-5"] .mode').textContent()).toBe("Manual");
    expect(await page.locator('[data-key="task-5"] .step').textContent()).toBe("spec");
    expect(await page.locator("#budget").textContent()).toBe("$3.40 of $10.00");
    await page.locator('[data-key="task-2"]').click();
    expect(await page.locator("#panel-body .details").textContent()).toContain(runId);
  });
});

describe("QA: canvas edge cases", () => {
  it("TC-GUI-092: titles holding HTML are shown as text on the canvas, the List, the panel and the confirm", async () => {
    const root = project();
    const store = storeOf(root);
    const evil = `<img src=x onerror="window.__xss=1"><b>bold</b>`;
    store.addTask({ title: evil, description: `<script>window.__xss=2</script>`, dependsOn: [] });
    store.close();
    const { page } = await open({ root });
    const card = page.locator('[data-key="task-7"]');
    expect(await card.locator(".card-title").textContent()).toBe(evil);
    await card.click();
    expect(await page.locator(".panel-task-title").textContent()).toBe(evil);
    await page.locator("#panel-body button.danger", { hasText: "Remove" }).click();
    expect(await page.locator("#confirm-message").textContent()).toBe(`Remove task #7 "${evil}"?`);
    await page.locator('#confirm button[value="cancel"]').click();
    await page.locator('[data-layout="list"]').click();
    expect(await page.locator('tr[data-task="7"] button').first().textContent()).toBe(`#7 ${evil}`);
    expect(await page.locator("img, b, #panel-body script, #board script").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  it("TC-GUI-092: an empty project says there's nothing yet, in both views, with no sideways scroll", async () => {
    const root = makeTempFolder();
    storeOf(root).close();
    const { page } = await open({ root, waitFor: "#canvas-empty:visible", viewport: { width: 768, height: 900 } });
    expect(await page.locator(".frame").count()).toBe(0);
    expect(await page.locator("#zoom-level").textContent()).toBe("100 %");
    await page.keyboard.press("0");
    await page.locator('[data-layout="list"]').click();
    expect(await page.locator("#list").textContent()).toBe(
      "There are no roadmaps or tasks yet. Add a task, or plan a roadmap.",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);
  });

  it("TC-GUI-092: a roadmap whose milestones were all removed still shows as a frame, and its tasks stay listed", async () => {
    const root = project();
    const store = storeOf(root);
    store.removeMilestone(3);
    store.close();
    const { page } = await open({ root });
    const frame = page.locator('[data-frame="roadmap-2"]');
    expect(await frame.locator("h2").textContent()).toBe("Onboarding");
    expect(await frame.locator(".card").count()).toBe(0);
    const box = await frame.boundingBox();
    expect(box !== null && box.width > 0 && box.height > 0).toBe(true);
    // Task 5 lost its milestone, so it's unassigned now.
    expect(await page.locator('[data-frame="unassigned"] [data-key="task-5"]').count()).toBe(1);
    await page.locator('[data-layout="list"]').click();
    expect(await page.locator(".list-roadmap h2").allTextContents()).toContain("Onboarding · 0 / 0 done");
  });

  it("TC-GUI-093: a very long title stays inside its card, and no screen scrolls sideways at 768 px", async () => {
    const root = project();
    const store = storeOf(root);
    const long = `${"Averyveryverylongwordwithoutanyspaces".repeat(8)} ${"and more words ".repeat(20)}`.trim();
    store.addTask({ title: long, description: "x".repeat(500), dependsOn: [] });
    store.close();
    const { page } = await open({ root, viewport: { width: 768, height: 900 } });
    const card = page.locator('[data-key="task-7"]');
    const sizes = await card.evaluate((node) => ({
      card: node.getBoundingClientRect(),
      title: node.querySelector(".card-title")?.getBoundingClientRect(),
      overflow: node.scrollWidth - node.clientWidth,
    }));
    expect(sizes.overflow).toBeLessThanOrEqual(0);
    expect(sizes.title?.right).toBeLessThanOrEqual(sizes.card.right + 0.5);
    await card.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);
    expect(await page.locator("#panel").evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");
    await page.locator('[data-layout="list"]').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);
  });

  it("TC-GUI-067: an unassigned task whose title is a long link doesn't make the List scroll sideways at 768 px", async () => {
    const root = project();
    const store = storeOf(root);
    store.addTask({ title: "Fix https://example.com/payments/refunds/partial-refund-callback-handler", dependsOn: [] });
    store.close();
    const { page } = await open({ root, viewport: { width: 768, height: 900 } });
    await page.locator('[data-layout="list"]').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);
  });

  it("TC-GUI-101: Tidy up works on the Unassigned and Changes frames too", async () => {
    const { page, root } = await open({ withSessions: true });
    await drag(page, '[data-key="task-6"]', 0, 60);
    await drag(page, '[data-key="change-branch-fix-x"]', 0, 60);
    await drag(page, '[data-key="task-4"]', 0, 60);
    await vi.waitFor(() => {
      expect(Object.keys(savedLayout(root).cards).sort()).toEqual(["change-branch-fix-x", "task-4", "task-6"]);
    });
    for (const frame of ["unassigned", "changes"]) {
      await page.locator(`[data-frame="${frame}"] [data-action="tidy"]`).click();
      await page.locator("#confirm-ok").click();
    }
    await vi.waitFor(() => {
      expect(Object.keys(savedLayout(root).cards)).toEqual(["task-4"]);
    });
    expect(await page.locator("#notice").textContent()).toBe("");
  });

  it("TC-GUI-096: a session whose transcript is missing, or outside Claude Code's folder, says so", async () => {
    const root = project();
    const home = makeTempFolder();
    const projects = path.join(home, ".claude/projects/p");
    mkdirSync(projects, { recursive: true });
    const outside = path.join(makeTempFolder(), `${SESSION_OLD}.jsonl`);
    writeFileSync(outside, `${JSON.stringify({ type: "user", message: { content: "secret" } })}\n`);
    const now = new Date().toISOString();
    let state = beginChange(
      { changeType: "feature", spec: "refunds", taskId: 2 },
      { key: stateKey(2, "main"), approverMode: "user", now },
    );
    state = linkSession(state, { sessionId: SESSION_OLD, transcriptPath: outside }, now);
    state = linkSession(
      state,
      { sessionId: SESSION_LIVE, transcriptPath: path.join(projects, `${SESSION_LIVE}.jsonl`) },
      now,
    );
    await openWorkflowStore(root).save(state);
    const { page } = await open({ root, home });
    await page.locator('[data-key="task-2"]').click();
    const note = page.locator("#transcript .transcript-note");
    await page.locator(`button[data-session="${SESSION_LIVE}"]`).click();
    await expect.poll(() => note.textContent()).toBe("The transcript file isn't there (yet).");
    await page.locator(`button[data-session="${SESSION_OLD}"]`).click();
    await expect
      .poll(() => note.textContent())
      .toBe("This transcript is outside Claude Code's projects folder, so it isn't shown.");
    expect(await page.locator("#transcript .entries li").count()).toBe(0);
  });
});

describe("QA: pan, zoom, drag and layout", () => {
  it("TC-GUI-097: Ctrl+wheel zooms around the pointer: the board point under it stays under it", async () => {
    const { page } = await open();
    const area = (await page.locator("#canvas-area").boundingBox()) ?? { x: 0, y: 0 };
    const pointer = { x: area.x + 200, y: area.y + 150 };
    await page.mouse.move(pointer.x, pointer.y);
    const before = await viewOf(page);
    const boardPoint = (view: { x: number; y: number; scale: number }) => ({
      x: (pointer.x - area.x - view.x) / view.scale,
      y: (pointer.y - area.y - view.y) / view.scale,
    });
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -100);
    await page.keyboard.up("Control");
    const after = await viewOf(page);
    expect(after.scale).toBeGreaterThan(before.scale);
    expect(boardPoint(after).x).toBeCloseTo(boardPoint(before).x, 1);
    expect(boardPoint(after).y).toBeCloseTo(boardPoint(before).y, 1);
    expect(await page.locator("#zoom-level").textContent()).toBe(`${Math.round(after.scale * 100)} %`);
  });

  it("TC-GUI-097: dragging empty space and the wheel pan the canvas; + and Fit zoom", async () => {
    const { page } = await open();
    const area = (await page.locator("#canvas-area").boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
    const empty = { x: area.x + area.width - 5, y: area.y + area.height - 5 };
    const before = await viewOf(page);
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.down();
    await page.mouse.move(empty.x - 50, empty.y - 30, { steps: 4 });
    await page.mouse.up();
    const panned = await viewOf(page);
    expect(panned.x - before.x).toBeCloseTo(-50, 0);
    expect(panned.y - before.y).toBeCloseTo(-30, 0);
    await page.mouse.wheel(0, 40);
    const wheeled = await viewOf(page);
    expect(wheeled.y - panned.y).toBeCloseTo(-40, 0);
    expect(wheeled.scale).toBe(panned.scale);
    await page.keyboard.press("+");
    expect((await viewOf(page)).scale).toBeCloseTo(panned.scale * 1.2, 3);
    await page.locator("#zoom-fit").click();
    expect(await viewOf(page)).toEqual(before);
  });

  it("TC-GUI-098: each drop saves the layout once, and a click saves nothing", async () => {
    const { page, root } = await open();
    const puts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT" && request.url().endsWith("/api/layout")) puts.push(request.url());
    });
    await page.locator('[data-key="task-4"]').click();
    await drag(page, '[data-key="task-4"]', 0, 60);
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-4"]).toBeDefined();
    });
    await drag(page, '[data-frame="roadmap-2"] .frame-head h2', 40, 0);
    await vi.waitFor(() => {
      expect(savedLayout(root).frames["roadmap-2"]).toBeDefined();
    });
    expect(puts).toHaveLength(2);
  });

  it("TC-GUI-099: a saved layout is where it was after the GUI restarts", async () => {
    const { page, root, gui } = await open();
    await drag(page, '[data-key="task-4"]', 0, 80);
    await drag(page, '[data-frame="roadmap-2"] .frame-head h2', 60, 40);
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-4"]).toBeDefined();
      expect(savedLayout(root).frames["roadmap-2"]).toBeDefined();
    });
    const saved = savedLayout(root);
    await page.context().close();
    await gui.stop();
    running.splice(running.indexOf(gui), 1);
    const again = await open({ root });
    const position = (selector: string) =>
      again.page
        .locator(selector)
        .evaluate((node) => ({ x: parseFloat(node.style.left), y: parseFloat(node.style.top) }));
    expect(await position('[data-key="task-4"]')).toEqual(saved.cards["task-4"]);
    expect(await position('[data-frame="roadmap-2"]')).toEqual(saved.frames["roadmap-2"]);
  });

  it("TC-GUI-067: the top bar shows the project's name and folder, the job count and the theme toggle", async () => {
    const { page, root } = await open();
    expect(await page.locator("#project-name").textContent()).toBe(path.basename(root));
    expect(await page.locator("#project-folder").textContent()).toBe(root);
    expect(await page.locator("#job-count").textContent()).toBe("No jobs running");
    const theme = page.locator("#theme");
    expect(await theme.textContent()).toBe("Theme: Auto");
    await theme.click();
    expect(await theme.textContent()).toBe("Theme: Light");
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    expect(page.url()).not.toContain("token");
  });
});

describe("QA: no diagram library", () => {
  it("TC-GUI-108: no diagram or canvas library is bundled or listed, and the canvas is SVG and HTML", () => {
    const folder = path.resolve("src/gui");
    const libraries =
      /\b(d3|jointjs|@joint|cytoscape|konva|fabric|reactflow|@xyflow|mermaid|vis-network|gojs|pixi|paper|elkjs|dagre|jsplumb|mxgraph|sigma)\b/i;
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, Record<string, string> | undefined>;
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    expect(names.filter((name) => libraries.test(name))).toEqual([]);
    for (const file of ["index.html", "app.js", "api.js", "canvas.js", "panel.js", "list.js", "jobs.js"]) {
      const text = readFileSync(path.join(folder, file), "utf8");
      expect(text).not.toMatch(/<canvas|getContext\(|from\s+["']https?:|import\s+["']https?:/);
      expect([...text.matchAll(/from\s+["']([^"']+)["']/g)].every((match) => match[1]?.startsWith("./"))).toBe(true);
    }
    expect(readFileSync(path.join(folder, "index.html"), "utf8")).toContain('<svg id="arrows"');
  });
});

/** A job that prints `text` on stdout and ends at once with exit 0. */
function chattyJobs(text: string) {
  const started: string[][] = [];
  const startJob = (args: readonly string[]): JobProcess => {
    started.push([...args]);
    let output: ((stream: "stdout" | "stderr", chunk: string) => void) | undefined;
    return {
      onOutput: (listener) => {
        output = listener;
      },
      onExit: (listener) => {
        void Promise.resolve().then(() => {
          output?.("stdout", `${text}\n`);
          listener(0);
        });
      },
      signal: () => undefined,
    };
  };
  return { started, startJob };
}

const NARROW = { width: 768, height: 900 };
const LONG_WORD = "Averyveryverylongwordwithoutanyspacesatall".repeat(6);
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);
/** How far any element under `selector` scrolls sideways inside itself. */
const innerSideways = (page: Page, selector: string) =>
  page.evaluate(
    (css) =>
      [...document.querySelectorAll(css)]
        .filter((node) => node.scrollWidth - node.clientWidth > 0 && getComputedStyle(node).overflowX !== "visible")
        .map((node) => `${node.tagName}.${node.className}#${node.id}: ${node.scrollWidth - node.clientWidth}`),
    selector,
  );

describe("QA run 2: no sideways scroll at 768 px", () => {
  /** One roadmap whose title, goal, milestone, task title, description and spec are long and unbroken. */
  function longProject(): string {
    const root = makeTempFolder();
    const store = storeOf(root);
    store.savePlan({
      roadmap: { title: `Roadmap ${LONG_WORD}`, goal: `Goal ${LONG_WORD}` },
      milestones: [
        {
          title: `Milestone ${LONG_WORD}`,
          goal: "g",
          tasks: [
            {
              key: "a",
              title: `Task ${LONG_WORD}`,
              description: LONG_WORD,
              spec: `spec-${"x".repeat(120)}`,
              dependsOn: [],
            },
          ],
        },
      ],
    });
    store.close();
    return root;
  }

  it("TC-GUI-067: long roadmap, milestone and spec text keep the canvas and the List within 768 px", async () => {
    const { page } = await open({ root: longProject(), viewport: NARROW });
    expect(await sideways(page)).toBeLessThanOrEqual(NARROW.width);
    await page.locator('[data-layout="list"]').click();
    expect(await sideways(page)).toBeLessThanOrEqual(NARROW.width);
    // The List's tables don't scroll sideways inside their own box either.
    expect(await innerSideways(page, "#list, #list *")).toEqual([]);
  });

  it("TC-GUI-067: the panel of a task with a long unbroken title and description doesn't scroll sideways at 768 px", async () => {
    const { page } = await open({ root: longProject(), viewport: NARROW });
    await page.locator('[data-key="task-1"]').click();
    expect(await sideways(page)).toBeLessThanOrEqual(NARROW.width);
    expect((await page.locator("#panel").boundingBox())?.width).toBe(NARROW.width);
    expect(await innerSideways(page, "#panel, #panel *")).toEqual([]);
  });

  const jobsScreen = async (title: string, output: string) => {
    const jobs = chattyJobs(output);
    const { page } = await open({ viewport: NARROW, startJob: jobs.startJob });
    await page.locator("#add-task-open").click();
    await page.locator('input[name="title"]').fill(title);
    await page.locator('#add-task-form button[type="submit"]').click();
    await vi.waitFor(() => {
      expect(jobs.started).toHaveLength(1);
    });
    await page.locator('[data-view="jobs"]').click();
    await page.locator("#job-list button").first().click();
    await expect.poll(() => page.locator("#output").textContent()).toContain(output);
    return page;
  };

  it("TC-GUI-067: the Jobs screen stays within 768 px with a long unbroken output line", async () => {
    const page = await jobsScreen("Short", `https://example.com/${"a".repeat(600)}`);
    expect(await sideways(page)).toBeLessThanOrEqual(NARROW.width);
  });

  it("TC-GUI-067: the Jobs screen and notice stay within 768 px after adding a task with a long unbroken title", async () => {
    const page = await jobsScreen(LONG_WORD.slice(0, 200), "done");
    expect(await sideways(page)).toBeLessThanOrEqual(NARROW.width);
    expect(await innerSideways(page, "main, main *")).toEqual([]);
  });

  it("TC-GUI-067: the notice after adding a task with a long unbroken title stays within 768 px", async () => {
    const { page, started } = await open({ viewport: NARROW });
    await page.locator("#add-task-open").click();
    await page.locator('input[name="title"]').fill(LONG_WORD.slice(0, 200));
    await page.locator('#add-task-form button[type="submit"]').click();
    await vi.waitFor(() => {
      expect(started).toHaveLength(1);
    });
    await expect.poll(() => page.locator("#notice").textContent()).toContain("Added");
    expect(await sideways(page)).toBeLessThanOrEqual(NARROW.width);
    expect(await innerSideways(page, "#notice")).toEqual([]);
  });

  it("TC-GUI-067: a long task title in the List wraps inside its table at 768 px (DEF-1)", async () => {
    const root = project();
    const store = storeOf(root);
    store.addTask({ title: LONG_WORD, dependsOn: [1, 2, 3, 4, 5] });
    store.close();
    const { page } = await open({ root, viewport: NARROW });
    await page.locator('[data-layout="list"]').click();
    expect(await sideways(page)).toBeLessThanOrEqual(NARROW.width);
    expect(await innerSideways(page, ".table-box")).toEqual([]);
  });
});

describe("QA run 2: Depends on in Add task", () => {
  const tryDependsOn = async (value: string) => {
    const { page, started } = await open();
    await page.locator("#add-task-open").click();
    await page.locator('input[name="title"]').fill("New one");
    await page.locator('input[name="dependsOn"]').fill(value);
    await page.locator('#add-task-form button[type="submit"]').click();
    return { page, started };
  };

  for (const value of ["0", "1.5", "-2", "00", "99999999999999999999", "1e3", "0x2", "2abc", "#3"]) {
    it(`TC-GUI-028: Depends on "${value}" is refused with a message, the dialog stays open, and nothing runs`, async () => {
      const { page, started } = await tryDependsOn(value);
      await expect.poll(() => page.locator("#add-task-error").textContent()).toBe(`"${value}" isn't a valid task ID.`);
      expect(await page.locator("#add-task").isVisible()).toBe(true);
      expect(started).toEqual([]);
    });
  }

  it('TC-GUI-028: Depends on "007" is task 7, as the CLI reads it', async () => {
    const { started } = await tryDependsOn("007");
    await vi.waitFor(() => {
      expect(started).toEqual([["tasks", "add", "--title=New one", "--depends-on=7", "--json"]]);
    });
  });

  it("TC-GUI-028: the first wrong ID among good ones is named, and nothing runs", async () => {
    const { page, started } = await tryDependsOn("1, 2, -3, x");
    await expect.poll(() => page.locator("#add-task-error").textContent()).toContain('"-3"');
    expect(started).toEqual([]);
  });

  it("TC-GUI-028: a fixed Depends on clears the message and adds the task", async () => {
    const { page, started } = await tryDependsOn("0");
    await expect.poll(() => page.locator("#add-task-error").textContent()).toContain('"0"');
    await page.locator('input[name="dependsOn"]').fill("2");
    await page.locator('#add-task-form button[type="submit"]').click();
    await vi.waitFor(() => {
      expect(started).toEqual([["tasks", "add", "--title=New one", "--depends-on=2", "--json"]]);
    });
    await expect.poll(() => page.locator("#add-task").isVisible()).toBe(false);
  });
});

describe("QA run 2: Add dependency in the panel", () => {
  for (const value of ["0", "1.5", "-2"]) {
    it(`TC-GUI-028: the panel's Add dependency with "${value}" runs nothing`, async () => {
      const { page, started } = await open();
      await page.locator('[data-key="task-4"]').click();
      await page.locator('#panel-body input[type="number"]').fill(value);
      await page.locator("#panel-body button", { hasText: "Add dependency" }).click();
      // The next valid action is the only one that runs, so the invalid one was dropped, not delayed.
      await page.locator("#panel-body button", { hasText: "Start" }).click();
      await vi.waitFor(() => {
        expect(started).toEqual([["tasks", "start", "4", "--json"]]);
      });
    });
  }

  it("TC-GUI-028: the panel's Add dependency with a huge number never asks the CLI for a rounded task ID", async () => {
    const { page, started } = await open();
    await page.locator('[data-key="task-4"]').click();
    await page.locator('#panel-body input[type="number"]').fill("99999999999999999999");
    await page.locator("#panel-body button", { hasText: "Add dependency" }).click();
    await page.locator("#panel-body button", { hasText: "Start" }).click();
    await vi.waitFor(() => {
      expect(started.at(-1)).toEqual(["tasks", "start", "4", "--json"]);
    });
    expect(started.some((args) => args[1] === "depend")).toBe(false);
  });
});

/**
 * Everything on the page that scrolls sideways, or sticks out past the window: the page itself, any element
 * that scrolls sideways inside its own box, and any element past the window's edge that no box clips (so the
 * body's `overflow-x: hidden` would cut it off). The canvas's board is clipped by its area, by design.
 */
const overflowAt = (page: Page) =>
  page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const name = (node: Element) => `${node.tagName.toLowerCase()}#${node.id}.${node.className}`;
    const scrollers: string[] = [];
    const outside: string[] = [];
    for (const node of document.querySelectorAll("body *")) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (["auto", "scroll"].includes(style.overflowX) && node.scrollWidth > node.clientWidth)
        scrollers.push(`${name(node)}: ${node.scrollWidth - node.clientWidth}px`);
      let clipped = false;
      for (let parent = node.parentElement; parent !== null && parent !== document.body; parent = parent.parentElement)
        if (getComputedStyle(parent).overflowX !== "visible") clipped = true;
      if (!clipped && (rect.right > width + 0.5 || rect.left < -0.5))
        outside.push(`${name(node)}: ${Math.round(rect.left)}..${Math.round(rect.right)}`);
    }
    return { page: Math.max(0, document.documentElement.scrollWidth - width), scrollers, outside };
  });
const NOTHING_SIDEWAYS = { page: 0, scrollers: [], outside: [] };

describe("QA run 3: every screen and dialog at 768 px, with long unbroken text", () => {
  const LONG = "Averyveryverylongwordwithoutanyspacesatall".repeat(6);

  /** Long unbroken text in a roadmap, a milestone, a task, a spec, a branch-keyed change and a transcript. */
  async function longEverywhere(): Promise<{ root: string; home: string }> {
    const root = project();
    const home = makeTempFolder();
    await withSessions(root, home);
    const store = storeOf(root);
    store.savePlan({
      roadmap: { title: `R${LONG}`, goal: `G${LONG}` },
      milestones: [
        {
          title: `M${LONG}`,
          goal: "g",
          tasks: [{ key: "x", title: `T${LONG}`, description: LONG, spec: `s${"x".repeat(150)}`, dependsOn: [] }],
        },
      ],
    });
    store.addTask({ title: `U${LONG}`, dependsOn: [1, 2, 3, 4, 5] });
    store.close();
    const change = beginChange(
      { changeType: "bug", spec: `s${"y".repeat(150)}` },
      { key: stateKey(null, `fix-${"z".repeat(150)}`), approverMode: "user", now: new Date().toISOString() },
    );
    await openWorkflowStore(root).save(change);
    const lines = [
      { type: "user", message: { content: `https://example.com/${"a".repeat(800)}` } },
      { type: "assistant", message: { content: [{ type: "text", text: LONG.repeat(3) }] } },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: `Tool${LONG}`, input: { path: "p".repeat(600) } }] },
      },
      { type: "user", message: { content: [{ type: "tool_result", content: "r".repeat(700) }] } },
    ];
    writeFileSync(
      path.join(home, ".claude/projects/p", `${SESSION_LIVE}.jsonl`),
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
    return { root, home };
  }

  it("TC-GUI-067: the canvas and the List with long text everywhere don't scroll sideways", async () => {
    const { page } = await open({ ...(await longEverywhere()), viewport: NARROW });
    expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
    await page.locator('[data-layout="list"]').click();
    expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
  });

  it("TC-GUI-067: the panel with a transcript of long unbroken lines and tool calls doesn't scroll sideways", async () => {
    const { page } = await open({ ...(await longEverywhere()), viewport: NARROW });
    await page.locator('[data-key="task-2"]').click();
    await expect.poll(() => page.locator("#transcript .entry").count()).toBe(4);
    expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
  });

  it("TC-GUI-067: the panels of a long-titled task, roadmap-less task and change don't scroll sideways", async () => {
    const { page } = await open({ ...(await longEverywhere()), viewport: NARROW });
    for (const key of ["task-7", "task-8"]) {
      await page.locator(`[data-key="${key}"]`).click();
      await expect.poll(() => page.locator("#panel").isVisible()).toBe(true);
      expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
      await page.keyboard.press("Escape");
    }
    await page.locator('[data-frame="changes"] [data-key^="change-"]').last().click();
    await expect.poll(() => page.locator("#panel").isVisible()).toBe(true);
    expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
  });

  it("TC-GUI-067: Setup, then Run doctor's Jobs screen with a long unbroken output, don't scroll sideways", async () => {
    const jobs = chattyJobs(`${LONG}\n${"b".repeat(900)}`);
    const { page } = await open({ viewport: NARROW, startJob: jobs.startJob });
    await page.locator('[data-view="setup"]').click();
    expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
    await page.locator("#run-doctor").click();
    await expect.poll(() => page.locator("#output").textContent()).toContain("b".repeat(900));
    expect(await page.locator("#view-jobs").isVisible()).toBe(true);
    expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
  });

  it("TC-GUI-067: the Add task dialog filled with long unbroken text, and its error, don't scroll sideways", async () => {
    const { page, started } = await open({ viewport: NARROW });
    await page.locator("#add-task-open").click();
    await page.locator('input[name="title"]').fill(LONG.slice(0, 200));
    await page.locator('textarea[name="description"]').fill(LONG);
    await page.locator('input[name="spec"]').fill(LONG);
    await page.locator('input[name="dependsOn"]').fill(`1, ${"9".repeat(300)}x`);
    await page.locator('#add-task-form button[type="submit"]').click();
    await expect.poll(() => page.locator("#add-task-error").textContent()).toContain("isn't a valid task ID.");
    expect(started).toEqual([]);
    expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
  });

  it("TC-GUI-067: a refused add with a long unbroken CLI message keeps the dialog and notice within 768 px", async () => {
    const jobs = failingJob(`Spec "${"q".repeat(400)}" doesn't exist.`);
    const { page } = await open({ viewport: NARROW, startJob: jobs.startJob });
    await page.locator("#add-task-open").click();
    await page.locator('input[name="title"]').fill("New one");
    await page.locator('#add-task-form button[type="submit"]').click();
    await expect.poll(() => page.locator("#add-task-error").textContent()).toContain("q".repeat(400));
    expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
    await page.locator("#add-task-cancel").click();
    expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
  });

  it("TC-GUI-067: the confirm dialog for a long-titled task and roadmap doesn't scroll sideways", async () => {
    const { page, started } = await open({ ...(await longEverywhere()), viewport: NARROW });
    await page.locator('[data-key="task-8"]').click();
    await page.locator("#panel-body button.danger", { hasText: "Remove" }).click();
    expect(await page.locator("#confirm-message").textContent()).toContain(`U${LONG}`);
    expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
    await page.locator('#confirm button[value="cancel"]').click();
    await page.keyboard.press("Escape");
    await page.locator('[data-frame="roadmap-3"] [data-action="remove-roadmap"]').click();
    expect(await page.locator("#confirm-message").textContent()).toContain(`R${LONG}`);
    expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
    await page.locator('#confirm button[value="cancel"]').click();
    expect(started).toEqual([]);
  });
});

describe("QA run 4: the remaining confirm dialogs at 768 px, with long unbroken text (DEF-5)", () => {
  const LONG = "Averyveryverylongwordwithoutanyspacesatall".repeat(6);

  it("TC-GUI-067: the remove-milestone and Tidy up confirms for long unbroken titles don't scroll sideways", async () => {
    const root = project();
    const store = storeOf(root);
    store.savePlan({
      roadmap: { title: `R${LONG}`, goal: "g" },
      milestones: [{ title: `M${LONG}`, goal: "g", tasks: [planned("x")] }],
    });
    store.close();
    const { page, started } = await open({ root, viewport: NARROW });
    await page.locator('[data-frame="roadmap-3"] [data-action="remove-milestone"]').click();
    expect(await page.locator("#confirm-message").textContent()).toContain(`M${LONG}`);
    expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
    await page.locator('#confirm button[value="cancel"]').click();
    await page.locator('[data-frame="roadmap-3"] [data-action="tidy"]').click();
    expect(await page.locator("#confirm-message").textContent()).toContain(`R${LONG}`);
    expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
    await page.keyboard.press("Escape");
    expect(await page.locator("#confirm").isVisible()).toBe(false);
    expect(started).toEqual([]);
  });
});

/** Jobs that keep running until the test lets them end, recording what they were asked to run. */
function heldJobs() {
  const started: string[][] = [];
  const exits: ((exitCode: number) => void)[] = [];
  const startJob = (args: readonly string[]): JobProcess => {
    started.push([...args]);
    let exit: ((exitCode: number) => void) | undefined;
    return {
      onOutput: () => undefined,
      onExit: (listener) => {
        exit = listener;
        exits.push(listener);
      },
      signal: () => {
        exit?.(130);
      },
    };
  };
  const release = () => {
    for (const exit of exits.splice(0)) exit(0);
  };
  return { started, startJob, release };
}

/** Counts the canvas messages the page has handled, so a test knows an update reached it: no real waits. */
async function countCanvasMessages(page: Page): Promise<void> {
  // Plain script text: it runs in the page, wrapping each "canvas" listener to count after it ran.
  await page.addInitScript({
    content: `
      window.canvasMessages = 0;
      const native = EventTarget.prototype.addEventListener;
      EventSource.prototype.addEventListener = function (type, listener, options) {
        if (type !== "canvas" || typeof listener !== "function") return native.call(this, type, listener, options);
        return native.call(this, type, (event) => {
          listener.call(this, event);
          window.canvasMessages += 1;
        }, options);
      };
    `,
  });
  await page.reload();
  await page.locator('[data-key="task-1"]').waitFor();
}

const canvasMessages = (page: Page) =>
  page.evaluate(() => (window as unknown as { canvasMessages: number }).canvasMessages);

/** Sends a change made in the terminal to the page, and returns once the page has handled it. */
async function updateFromTerminal(
  page: Page,
  root: string,
  clock: ReturnType<typeof manualClock>,
  change: (store: ReturnType<typeof storeOf>) => void,
): Promise<void> {
  const before = await canvasMessages(page);
  const store = storeOf(root);
  change(store);
  store.close();
  await clock.tick();
  await expect.poll(() => canvasMessages(page)).toBeGreaterThan(before);
}

const styleBox = (page: Page, selector: string) =>
  page.locator(selector).evaluate((node) => ({
    x: parseFloat(node.style.left),
    y: parseFloat(node.style.top),
    width: parseFloat(node.style.width),
    height: parseFloat(node.style.height),
  }));

const scaleOf = async (page: Page) => (await viewOf(page)).scale;

function layoutPuts(page: Page): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith("/api/layout"))
      bodies.push(JSON.parse(request.postData() ?? "{}") as Record<string, unknown>);
  });
  return bodies;
}

describe("QA C2a run 2: the task panel keeps its place", () => {
  it("TC-GUI-031: a change to the open task keeps the typed dependency and the focused button; a change elsewhere doesn't redraw", async () => {
    const clock = manualClock();
    const root = project();
    const { page } = await open({ root, every: clock.every });
    await countCanvasMessages(page);
    await page.locator('[data-key="task-4"]').click();
    const input = page.locator('#panel-body [data-focus="depend-on"]');
    await input.fill("5");
    await page.locator('#panel-body [data-focus="start"]').focus();
    await page.locator("#panel-body > div").evaluate((node) => (node.dataset.marker = "first"));
    // Only another task changes: the panel isn't drawn again.
    await updateFromTerminal(page, root, clock, (store) => store.setStatus(3, "in-progress"));
    expect(await page.locator('[data-key="task-3"] .status').textContent()).toBe("In progress");
    expect(await page.locator("#panel-body > div").getAttribute("data-marker")).toBe("first");
    expect(await input.inputValue()).toBe("5");
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.focus)).toBe("start");
    // The open task changes: the panel is drawn again, with the typed text and the focus kept.
    await updateFromTerminal(page, root, clock, (store) => store.addDependency(4, 2));
    expect(await page.locator("#panel-body > div").getAttribute("data-marker")).toBeNull();
    expect(await page.locator('#panel-body [data-focus="dependency-2"]').count()).toBe(1);
    expect(await page.locator('#panel-body [data-focus="depend-on"]').inputValue()).toBe("5");
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.focus)).toBe("start");
  });

  it("TC-GUI-031: with the dependency input focused, a change to the open task keeps the focus and the text", async () => {
    const clock = manualClock();
    const root = project();
    const { page } = await open({ root, every: clock.every });
    await countCanvasMessages(page);
    await page.locator('[data-key="task-4"]').click();
    const input = page.locator('#panel-body [data-focus="depend-on"]');
    await input.fill("12");
    await updateFromTerminal(page, root, clock, (store) => store.addDependency(4, 2));
    expect(await page.locator('#panel-body [data-focus="dependency-2"]').count()).toBe(1);
    expect(await input.inputValue()).toBe("12");
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.focus)).toBe("depend-on");
    await page.keyboard.type("3");
    expect(await input.inputValue()).toBe("123");
  });
});

describe("QA C2a run 2: a task action runs once", () => {
  it("TC-GUI-028: a double click on Start starts one job, and Start works again once it ends", async () => {
    const jobs = heldJobs();
    const { page } = await open({ startJob: jobs.startJob });
    const posts = layoutPuts(page);
    const jobPosts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/jobs")) jobPosts.push(request.url());
    });
    await page.locator('[data-key="task-4"]').click();
    await page.locator('#panel-body [data-focus="start"]').dblclick();
    await vi.waitFor(() => {
      expect(jobs.started).toEqual([["tasks", "start", "4", "--json"]]);
    });
    await page.locator('#panel-body [data-focus="start"]').click();
    jobs.release();
    await expect.poll(() => page.locator("#notice").textContent()).toBe("Started task #4.");
    expect(jobs.started).toHaveLength(1);
    expect(jobPosts).toHaveLength(1);
    await page.locator('#panel-body [data-focus="start"]').click();
    await vi.waitFor(() => {
      expect(jobs.started).toHaveLength(2);
    });
    jobs.release();
    expect(posts).toEqual([]);
  });

  it("TC-GUI-028: a double click on Add task's submit adds one task, and the button is disabled while it runs", async () => {
    const jobs = heldJobs();
    const { page } = await open({ startJob: jobs.startJob });
    await page.locator("#add-task-open").click();
    await page.locator('input[name="title"]').fill("Once");
    const submit = page.locator('#add-task-form button[type="submit"]');
    await submit.dblclick();
    await vi.waitFor(() => {
      expect(jobs.started).toEqual([["tasks", "add", "--title=Once", "--json"]]);
    });
    expect(await submit.isDisabled()).toBe(true);
    await page.locator('input[name="title"]').press("Enter");
    jobs.release();
    await expect.poll(() => page.locator("#add-task").isVisible()).toBe(false);
    expect(jobs.started).toHaveLength(1);
    expect(await submit.isDisabled()).toBe(false);
  });

  it("TC-GUI-049: the top bar's job count follows a job started from the panel, and from Add task", async () => {
    const jobs = heldJobs();
    const { page } = await open({ startJob: jobs.startJob });
    const count = page.locator("#job-count");
    expect(await count.textContent()).toBe("No jobs running");
    await page.locator('[data-key="task-4"]').click();
    await page.locator('#panel-body [data-focus="done"]').click();
    await expect.poll(() => count.textContent()).toBe("1 running");
    jobs.release();
    await expect.poll(() => count.textContent()).toBe("No jobs running");
    await page.locator("#add-task-open").click();
    await page.locator('input[name="title"]').fill("Counted");
    await page.locator('#add-task-form button[type="submit"]').click();
    await expect.poll(() => count.textContent()).toBe("1 running");
    jobs.release();
    await expect.poll(() => count.textContent()).toBe("No jobs running");
  });
});

describe("QA C2a run 2: frame width and drops", () => {
  it("TC-GUI-100: each frame is as wide as its columns, and frames side by side don't overlap", async () => {
    const { page } = await open();
    const roadmap1 = await styleBox(page, '[data-frame="roadmap-1"]');
    const roadmap2 = await styleBox(page, '[data-frame="roadmap-2"]');
    const unassigned = await styleBox(page, '[data-frame="unassigned"]');
    // 2 columns: 24 + 220 + 32 + 220 + 24; 1 column: 24 + 220 + 24.
    expect(roadmap1.width).toBe(520);
    expect(roadmap2.width).toBe(268);
    expect(unassigned.width).toBe(268);
    const [left, middle, right] = [roadmap1, roadmap2, unassigned].sort((a, b) => a.x - b.x);
    expect(middle?.x).toBeGreaterThanOrEqual((left?.x ?? 0) + (left?.width ?? 0));
    expect(right?.x).toBeGreaterThanOrEqual((middle?.x ?? 0) + (middle?.width ?? 0));
  });

  it("TC-GUI-098: a card dropped past its last column is pulled back to it, and one dropped past the left edge to the first", async () => {
    const { page, root } = await open();
    const scale = await scaleOf(page);
    const start4 = await styleBox(page, '[data-key="task-4"]');
    await drag(page, '[data-key="task-4"]', 100 * scale, 0);
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-4"]).toEqual({ x: 276, y: start4.y });
    });
    expect((await styleBox(page, '[data-key="task-4"]')).x).toBe(276);
    await drag(page, '[data-key="task-1"]', -60 * scale, 0);
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-1"]?.x).toBe(24);
    });
  });

  it("TC-GUI-098: a card dropped with its centre outside its frame goes back, and nothing is written", async () => {
    const { page, root } = await open();
    const puts = layoutPuts(page);
    const scale = await scaleOf(page);
    const before = await styleBox(page, '[data-key="task-4"]');
    await drag(page, '[data-key="task-4"]', 300 * scale, 0);
    expect(await styleBox(page, '[data-key="task-4"]')).toEqual(before);
    await drag(page, '[data-key="task-1"]', 0, -200 * scale);
    expect((await styleBox(page, '[data-key="task-1"]')).y).toBe(96);
    // A later drop that is saved shows the earlier ones sent nothing.
    await drag(page, '[data-key="task-4"]', 0, 40 * scale);
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-4"]).toBeDefined();
    });
    expect(puts).toHaveLength(1);
    expect(savedLayout(root).cards).toEqual({ "task-4": { x: before.x, y: before.y + 40 } });
  });

  it("TC-GUI-098: a frame grows downwards to hold a card dropped below its columns", async () => {
    const { page, root } = await open();
    const scale = await scaleOf(page);
    const frameBefore = await styleBox(page, '[data-frame="roadmap-1"]');
    const card = await styleBox(page, '[data-key="task-4"]');
    // Dropped just inside the bottom edge, again and again, so the frame keeps growing.
    const step = frameBefore.height - card.y - 140 / 2 - 10;
    await drag(page, '[data-key="task-4"]', 0, step * scale);
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-4"]?.y).toBe(Math.round(card.y + step));
    });
    const frameAfter = await styleBox(page, '[data-frame="roadmap-1"]');
    expect(frameAfter.height).toBe(card.y + step + 140 + 24);
    expect(frameAfter.width).toBe(frameBefore.width);
  });
});

describe("QA C2a run 2: saving only what moved", () => {
  it("TC-GUI-073: the page PUTs only the moved card or frame", async () => {
    const { page, root } = await open();
    const puts = layoutPuts(page);
    const scale = await scaleOf(page);
    await drag(page, '[data-key="task-4"]', 0, 40 * scale);
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-4"]).toBeDefined();
    });
    await drag(page, '[data-frame="roadmap-2"] .frame-head h2', 40, 0);
    await vi.waitFor(() => {
      expect(savedLayout(root).frames["roadmap-2"]).toBeDefined();
    });
    expect(puts.map((body) => [Object.keys(body.frames as object), Object.keys(body.cards as object)])).toEqual([
      [[], ["task-4"]],
      [["roadmap-2"], []],
    ]);
    expect(Object.keys(savedLayout(root).cards)).toEqual(["task-4"]);
  });

  it("TC-GUI-099: two tabs opened at once each save their own move, and neither undoes the other", async () => {
    const root = project();
    const first = await open({ root });
    const context = await browser.newContext({ viewport: WIDE });
    const second = await context.newPage();
    await second.goto(`http://127.0.0.1:${first.gui.port}/?token=${first.gui.token}`);
    await second.locator('[data-key="task-1"]').waitFor();
    await drag(first.page, '[data-key="task-4"]', 0, 40 * (await scaleOf(first.page)));
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-4"]).toBeDefined();
    });
    await drag(second, '[data-frame="roadmap-2"] .frame-head h2', 40, 0);
    await drag(second, '[data-key="task-5"]', 0, 40 * (await scaleOf(second)));
    await vi.waitFor(() => {
      expect(Object.keys(savedLayout(root).cards).sort()).toEqual(["task-4", "task-5"]);
      expect(Object.keys(savedLayout(root).frames)).toEqual(["roadmap-2"]);
    });
    await context.close();
  });

  it("TC-GUI-098: a canvas update that arrives while a save is on its way waits for it, and the drop doesn't jump back", async () => {
    const clock = manualClock();
    const root = project();
    const { page } = await open({ root, every: clock.every });
    await countCanvasMessages(page);
    let letSave: () => void = () => undefined;
    const saveHeld = new Promise<void>((resolve) => (letSave = resolve));
    await page.route("**/api/layout", async (route) => {
      if (route.request().method() === "PUT") await saveHeld;
      await route.continue();
    });
    const scale = await scaleOf(page);
    const before = await styleBox(page, '[data-key="task-4"]');
    await drag(page, '[data-key="task-4"]', 0, 40 * scale);
    await updateFromTerminal(page, root, clock, (store) => store.setStatus(2, "done"));
    expect(await page.locator('[data-key="task-2"] .status').textContent()).toBe("Open");
    expect((await styleBox(page, '[data-key="task-4"]')).y).toBe(before.y + 40);
    letSave();
    await expect.poll(() => page.locator('[data-key="task-2"] .status').textContent()).toBe("Done");
    expect((await styleBox(page, '[data-key="task-4"]')).y).toBe(before.y + 40);
    expect(savedLayout(root).cards["task-4"]).toEqual({ x: before.x, y: before.y + 40 });
  });

  it("TC-GUI-098: with two saves on their way, an update after the first ends doesn't put the second drop back", async () => {
    const clock = manualClock();
    const root = project();
    const { page } = await open({ root, every: clock.every });
    await countCanvasMessages(page);
    const held: (() => void)[] = [];
    await page.route("**/api/layout", async (route) => {
      if (route.request().method() === "PUT") await new Promise<void>((resolve) => held.push(resolve));
      await route.continue();
    });
    const scale = await scaleOf(page);
    const card1 = await styleBox(page, '[data-key="task-1"]');
    await drag(page, '[data-key="task-4"]', 0, 40 * scale);
    await drag(page, '[data-key="task-1"]', 0, 400 * scale);
    await vi.waitFor(() => {
      expect(held).toHaveLength(2);
    });
    held[0]?.();
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-4"]).toBeDefined();
    });
    await updateFromTerminal(page, root, clock, (store) => store.setStatus(2, "done"));
    expect((await styleBox(page, '[data-key="task-1"]')).y).toBe(card1.y + 400);
    held[1]?.();
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-1"]).toEqual({ x: card1.x, y: card1.y + 400 });
    });
    await expect.poll(() => page.locator('[data-key="task-2"] .status').textContent()).toBe("Done");
    expect((await styleBox(page, '[data-key="task-1"]')).y).toBe(card1.y + 400);
  });

  it("TC-GUI-098: a canvas update that arrives while a save fails is still shown once the save ends", async () => {
    const clock = manualClock();
    const root = project();
    const { page } = await open({ root, every: clock.every });
    await countCanvasMessages(page);
    let letSave: () => void = () => undefined;
    const saveHeld = new Promise<void>((resolve) => (letSave = resolve));
    await page.route("**/api/layout", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      await saveHeld;
      return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"disk full"}' });
    });
    await drag(page, '[data-key="task-4"]', 0, 40 * (await scaleOf(page)));
    await updateFromTerminal(page, root, clock, (store) => store.setStatus(2, "done"));
    letSave();
    await expect.poll(() => page.locator("#notice").textContent()).toBe("The layout wasn't saved: disk full");
    // Nothing else changes, so the next check sends nothing new.
    await clock.tick();
    await expect.poll(() => page.locator('[data-key="task-2"] .status').textContent()).toBe("Done");
  });

  for (const [what, selector] of [
    ["a card", '[data-key="task-4"]'],
    ["a frame's header", '[data-frame="roadmap-2"] .frame-head h2'],
  ] as const)
    it(`TC-GUI-098: from pointerdown on ${what}, updates wait until the press ends`, async () => {
      const clock = manualClock();
      const root = project();
      const { page } = await open({ root, every: clock.every });
      await countCanvasMessages(page);
      const at = await centre(page, selector);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await updateFromTerminal(page, root, clock, (store) => store.setStatus(2, "done"));
      expect(await page.locator('[data-key="task-2"] .status').textContent()).toBe("Open");
      await page.mouse.up();
      await expect.poll(() => page.locator('[data-key="task-2"] .status').textContent()).toBe("Done");
    });
});

describe("QA C2a run 2: a cancelled press", () => {
  const cancelPointer = (page: Page) =>
    page
      .locator("#canvas-area")
      .evaluate((node) => node.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true })));

  it("TC-GUI-098: pointercancel during a card drag puts it back, opens nothing and writes nothing", async () => {
    const clock = manualClock();
    const root = project();
    const { page } = await open({ root, every: clock.every });
    await countCanvasMessages(page);
    const puts = layoutPuts(page);
    const before = await styleBox(page, '[data-key="task-4"]');
    const at = await centre(page, '[data-key="task-4"]');
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x, at.y + 60, { steps: 4 });
    await updateFromTerminal(page, root, clock, (store) => store.setStatus(2, "done"));
    await cancelPointer(page);
    await page.mouse.up();
    expect(await styleBox(page, '[data-key="task-4"]')).toEqual(before);
    expect(await page.locator("#panel").isVisible()).toBe(false);
    expect(await page.locator('[data-key="task-2"] .status').textContent()).toBe("Done");
    expect(puts).toEqual([]);
    expect(() => readFileSync(layoutFile(root))).toThrow();
  });

  it("TC-GUI-098: pointercancel on a card press that didn't move opens nothing, and a frame drag goes back", async () => {
    const { page, root } = await open();
    const at = await centre(page, '[data-key="task-4"]');
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await cancelPointer(page);
    await page.mouse.up();
    expect(await page.locator("#panel").isVisible()).toBe(false);
    const frame = await styleBox(page, '[data-frame="roadmap-2"]');
    const head = await centre(page, '[data-frame="roadmap-2"] .frame-head h2');
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    await page.mouse.move(head.x + 80, head.y + 30, { steps: 4 });
    await cancelPointer(page);
    await page.mouse.up();
    expect(await styleBox(page, '[data-frame="roadmap-2"]')).toEqual(frame);
    expect(() => readFileSync(layoutFile(root))).toThrow();
  });

  it("TC-GUI-097: pointercancel during a pan puts the view back", async () => {
    const { page } = await open();
    const area = (await page.locator("#canvas-area").boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
    const empty = { x: area.x + area.width - 5, y: area.y + area.height - 5 };
    const before = await viewOf(page);
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.down();
    await page.mouse.move(empty.x - 50, empty.y - 30, { steps: 4 });
    await cancelPointer(page);
    await page.mouse.up();
    expect(await viewOf(page)).toEqual(before);
  });
});

describe("QA C2a run 2: keys, wheel and theme", () => {
  it("TC-GUI-097: +, - and 0 do nothing in the List, and the canvas is still sane when shown again", async () => {
    const { page } = await open();
    const before = await viewOf(page);
    await page.locator('[data-layout="list"]').click();
    for (const key of ["+", "-", "0", "=", "-", "+"]) await page.keyboard.press(key);
    await page.locator('[data-layout="canvas"]').click();
    expect(await viewOf(page)).toEqual(before);
    expect(await page.locator("#zoom-level").textContent()).toBe(`${Math.round(before.scale * 100)} %`);
  });

  it("TC-GUI-097: + and 0 do nothing on Setup and Jobs", async () => {
    const { page } = await open();
    const before = await viewOf(page);
    for (const view of ["setup", "jobs"]) {
      await page.locator(`[data-view="${view}"]`).click();
      for (const key of ["+", "0", "-"]) await page.keyboard.press(key);
    }
    await page.locator('[data-view="canvas"]').click();
    expect(await viewOf(page)).toEqual(before);
  });

  it("TC-GUI-097: a page opened on the List fits every frame in view the first time the Canvas is shown", async () => {
    const root = project();
    const first = await open({ root });
    await first.page.locator('[data-layout="list"]').click();
    await first.page.reload();
    await first.page.locator('tr[data-task="3"]').waitFor();
    expect(await first.page.locator("#canvas-area").isVisible()).toBe(false);
    await first.page.keyboard.press("0");
    await first.page.locator('[data-layout="canvas"]').click();
    const view = await viewOf(first.page);
    expect(Number.isFinite(view.x) && Number.isFinite(view.y)).toBe(true);
    expect(view.scale).toBeGreaterThanOrEqual(0.25);
    expect(view.scale).toBeLessThanOrEqual(2);
    const area = await first.page.locator("#canvas-area").boundingBox();
    for (const key of ["roadmap-1", "roadmap-2", "unassigned"]) {
      const box = await first.page.locator(`[data-frame="${key}"]`).boundingBox();
      expect(box !== null && area !== null).toBe(true);
      if (box === null || area === null) return;
      expect(box.x).toBeGreaterThanOrEqual(area.x);
      expect(box.y).toBeGreaterThanOrEqual(area.y);
      expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width);
      expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height);
    }
  });

  it("TC-GUI-097: a wheel step in lines pans by 16 px a line, and one in pixels by its pixels", async () => {
    const { page } = await open();
    const wheel = (deltaX: number, deltaY: number, deltaMode: number) =>
      page
        .locator("#canvas-area")
        .evaluate(
          (node, init) => node.dispatchEvent(new WheelEvent("wheel", { ...init, bubbles: true, cancelable: true })),
          { deltaX, deltaY, deltaMode },
        );
    const before = await viewOf(page);
    await wheel(2, 3, 1);
    const lines = await viewOf(page);
    expect(lines.x - before.x).toBeCloseTo(-32, 5);
    expect(lines.y - before.y).toBeCloseTo(-48, 5);
    expect(lines.scale).toBe(before.scale);
    await wheel(0, 10, 0);
    expect((await viewOf(page)).y - lines.y).toBeCloseTo(-10, 5);
  });

  it("TC-GUI-067: the theme toggle cycles Auto, Light, Dark and back even when the browser won't store it", async () => {
    const { page } = await open();
    await page.addInitScript(() => {
      const refuse = () => {
        throw new Error("storage refused");
      };
      Storage.prototype.getItem = refuse;
      Storage.prototype.setItem = refuse;
    });
    await page.reload();
    await page.locator('[data-key="task-1"]').waitFor();
    const theme = page.locator("#theme");
    const seen: [string | null, string | undefined][] = [];
    for (let click = 0; click < 4; click += 1) {
      seen.push([await theme.textContent(), await page.evaluate(() => document.documentElement.dataset.theme)]);
      await theme.click();
    }
    expect(seen).toEqual([
      ["Theme: Auto", undefined],
      ["Theme: Light", "light"],
      ["Theme: Dark", "dark"],
      ["Theme: Auto", undefined],
    ]);
  });

  it("TC-GUI-067: the chosen theme is remembered after a reload when the browser stores it", async () => {
    const { page } = await open();
    await page.locator("#theme").click();
    await page.locator("#theme").click();
    await page.reload();
    await page.locator('[data-key="task-1"]').waitFor();
    expect(await page.locator("#theme").textContent()).toBe("Theme: Dark");
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  });
});

/** Holds each layout PUT until the test lets it go, then lets it through or fails it. */
async function heldSaves(page: Page) {
  const held: ((outcome: "pass" | "fail") => void)[] = [];
  await page.route("**/api/layout", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const outcome = await new Promise<"pass" | "fail">((resolve) => held.push(resolve));
    if (outcome === "pass") return route.continue();
    return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"disk full"}' });
  });
  return held;
}

const statusOf = (page: Page, id: number) => page.locator(`[data-key="task-${id}"] .status`).textContent();

describe("QA C2a run 3: updates around layout saves (DEF-1)", () => {
  it("TC-GUI-098: two saves on their way, the first fails and the second works: the update shows once both end, and the second drop stays", async () => {
    const clock = manualClock();
    const root = project();
    const { page } = await open({ root, every: clock.every });
    await countCanvasMessages(page);
    const held = await heldSaves(page);
    const scale = await scaleOf(page);
    const card1 = await styleBox(page, '[data-key="task-1"]');
    await drag(page, '[data-key="task-4"]', 0, 40 * scale);
    await drag(page, '[data-key="task-1"]', 0, 400 * scale);
    await vi.waitFor(() => {
      expect(held).toHaveLength(2);
    });
    await updateFromTerminal(page, root, clock, (store) => store.setStatus(2, "done"));
    held[0]?.("fail");
    await expect.poll(() => page.locator("#notice").textContent()).toBe("The layout wasn't saved: disk full");
    expect(await statusOf(page, 2)).toBe("Open");
    held[1]?.("pass");
    await expect.poll(() => statusOf(page, 2)).toBe("Done");
    expect((await styleBox(page, '[data-key="task-1"]')).y).toBe(card1.y + 400);
    expect(savedLayout(root).cards["task-1"]).toEqual({ x: card1.x, y: card1.y + 400 });
  });

  it("TC-GUI-098: a drag that starts while a save is on its way: an update held through both is shown after the second save, and both drops stay", async () => {
    const clock = manualClock();
    const root = project();
    const { page } = await open({ root, every: clock.every });
    await countCanvasMessages(page);
    const held = await heldSaves(page);
    const scale = await scaleOf(page);
    const card4 = await styleBox(page, '[data-key="task-4"]');
    const card1 = await styleBox(page, '[data-key="task-1"]');
    await drag(page, '[data-key="task-4"]', 0, 40 * scale);
    await vi.waitFor(() => {
      expect(held).toHaveLength(1);
    });
    const at = await centre(page, '[data-key="task-1"]');
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x, at.y + 200 * scale, { steps: 4 });
    await updateFromTerminal(page, root, clock, (store) => store.setStatus(2, "done"));
    held[0]?.("pass");
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-4"]).toBeDefined();
    });
    expect(await statusOf(page, 2)).toBe("Open");
    await page.mouse.move(at.x, at.y + 400 * scale, { steps: 4 });
    await page.mouse.up();
    await vi.waitFor(() => {
      expect(held).toHaveLength(2);
    });
    expect(await statusOf(page, 2)).toBe("Open");
    held[1]?.("pass");
    await expect.poll(() => statusOf(page, 2)).toBe("Done");
    expect((await styleBox(page, '[data-key="task-1"]')).y).toBe(card1.y + 400);
    expect((await styleBox(page, '[data-key="task-4"]')).y).toBe(card4.y + 40);
  });

  it("TC-GUI-098: a press with no move while a save is on its way, released before the save ends: the update shows after it, and the drop stays", async () => {
    const clock = manualClock();
    const root = project();
    const { page } = await open({ root, every: clock.every });
    await countCanvasMessages(page);
    const held = await heldSaves(page);
    const card4 = await styleBox(page, '[data-key="task-4"]');
    await drag(page, '[data-key="task-4"]', 0, 40 * (await scaleOf(page)));
    await vi.waitFor(() => {
      expect(held).toHaveLength(1);
    });
    const at = await centre(page, '[data-key="task-1"]');
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await updateFromTerminal(page, root, clock, (store) => store.setStatus(2, "done"));
    await page.mouse.up();
    expect(await statusOf(page, 2)).toBe("Open");
    expect((await styleBox(page, '[data-key="task-4"]')).y).toBe(card4.y + 40);
    held[0]?.("pass");
    await expect.poll(() => statusOf(page, 2)).toBe("Done");
    expect((await styleBox(page, '[data-key="task-4"]')).y).toBe(card4.y + 40);
  });

  it("TC-GUI-098: a press with no move while a save is on its way, released after the save ends: the drop doesn't jump back", async () => {
    const clock = manualClock();
    const root = project();
    const { page } = await open({ root, every: clock.every });
    await countCanvasMessages(page);
    const held = await heldSaves(page);
    const card4 = await styleBox(page, '[data-key="task-4"]');
    await drag(page, '[data-key="task-4"]', 0, 40 * (await scaleOf(page)));
    await vi.waitFor(() => {
      expect(held).toHaveLength(1);
    });
    const at = await centre(page, '[data-key="task-1"]');
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    // Read by the server before the save reaches it, so it still has task 4 where it was.
    await updateFromTerminal(page, root, clock, (store) => store.setStatus(2, "done"));
    held[0]?.("pass");
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-4"]).toBeDefined();
    });
    await page.mouse.up();
    await expect.poll(() => statusOf(page, 2)).toBe("Done");
    expect((await styleBox(page, '[data-key="task-4"]')).y).toBe(card4.y + 40);
  });

  it("TC-GUI-098: when the read after a save fails, it says why, keeps the drop, and the next update still shows", async () => {
    const clock = manualClock();
    const root = project();
    const { page } = await open({ root, every: clock.every });
    await countCanvasMessages(page);
    const held = await heldSaves(page);
    let isCanvasDown = false;
    await page.route("**/api/canvas", (route) =>
      isCanvasDown
        ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"canvas unreadable"}' })
        : route.continue(),
    );
    const card4 = await styleBox(page, '[data-key="task-4"]');
    await drag(page, '[data-key="task-4"]', 0, 40 * (await scaleOf(page)));
    await vi.waitFor(() => {
      expect(held).toHaveLength(1);
    });
    await updateFromTerminal(page, root, clock, (store) => store.setStatus(2, "done"));
    isCanvasDown = true;
    held[0]?.("pass");
    await expect.poll(() => page.locator("#notice").textContent()).toBe("canvas unreadable");
    expect((await styleBox(page, '[data-key="task-4"]')).y).toBe(card4.y + 40);
    isCanvasDown = false;
    await updateFromTerminal(page, root, clock, (store) => store.setStatus(3, "done"));
    await expect.poll(() => statusOf(page, 3)).toBe("Done");
    expect(await statusOf(page, 2)).toBe("Done");
    expect((await styleBox(page, '[data-key="task-4"]')).y).toBe(card4.y + 40);
  });
});

describe("QA C2a run 3: small items", () => {
  it("TC-GUI-028: a second click on Start while it runs says it's already running", async () => {
    const jobs = heldJobs();
    const { page } = await open({ startJob: jobs.startJob });
    await page.locator('[data-key="task-4"]').click();
    await page.locator('#panel-body [data-focus="start"]').click();
    await vi.waitFor(() => {
      expect(jobs.started).toHaveLength(1);
    });
    await page.locator('#panel-body [data-focus="start"]').click();
    await expect.poll(() => page.locator("#notice").textContent()).toBe("That's already running.");
    expect(await page.locator("#notice").evaluate((node) => node.classList.contains("error"))).toBe(false);
    jobs.release();
    await expect.poll(() => page.locator("#notice").textContent()).toBe("Started task #4.");
    expect(jobs.started).toHaveLength(1);
  });

  for (const stored of ["purple", "", "System", "Dark"])
    it(`TC-GUI-067: an unrecognised stored theme "${stored}" falls back to Auto, and the toggle goes on to Light`, async () => {
      const { page } = await open();
      await page.evaluate((value) => {
        localStorage.setItem("cclinic.theme", value);
      }, stored);
      await page.reload();
      await page.locator('[data-key="task-1"]').waitFor();
      expect(await page.locator("#theme").textContent()).toBe("Theme: Auto");
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBeUndefined();
      await page.locator("#theme").click();
      expect(await page.locator("#theme").textContent()).toBe("Theme: Light");
      expect(await page.evaluate(() => localStorage.getItem("cclinic.theme"))).toBe("light");
    });

  it("TC-GUI-054 (exploratory): an unrecognised stored layout shows the Canvas with its button pressed", async () => {
    const { page } = await open();
    await page.evaluate(() => {
      localStorage.setItem("cclinic.layout", "grid");
    });
    await page.reload();
    await page.locator('[data-key="task-1"]').waitFor();
    expect(await page.locator("#canvas-area").isVisible()).toBe(true);
    expect(await page.locator('[data-layout="canvas"]').getAttribute("aria-pressed")).toBe("true");
  });
});

/** Opens the page in a context of its own, listening to the console and failed requests from the first load. */
async function openWatched(
  context: {
    colorScheme?: "light" | "dark";
    reducedMotion?: "reduce" | "no-preference";
    viewport?: { width: number; height: number };
  },
  options: { root?: string; withSessions?: boolean; startJob?: (args: readonly string[]) => JobProcess } = {},
) {
  const root = options.root ?? project();
  const home = makeTempFolder();
  if (options.withSessions === true) await withSessions(root, home);
  const jobs = fakeJobs();
  const gui = await startTestGui(
    root,
    {},
    { startJob: options.startJob ?? jobs.startJob, every: () => () => undefined },
    { HOME: home },
  );
  running.push(gui);
  const page = await (await browser.newContext({ viewport: WIDE, ...context })).newPage();
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  // A reload aborts the page's open event streams; that's the browser's doing, not a blocked request.
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText;
    if (reason !== "net::ERR_ABORTED") problems.push(`${request.url()}: ${reason}`);
  });
  await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
  await page.locator('[data-key="task-1"]').waitFor();
  return { gui, page, problems, root };
}

const ICON_BUTTONS = [
  ['[data-view="canvas"]', "Canvas"],
  ['[data-view="setup"]', "Setup"],
  ['[data-view="jobs"]', "Jobs"],
  ['[data-layout="canvas"]', "Canvas"],
  ['[data-layout="list"]', "List"],
  ["#add-task-open", "Add task"],
  ["#zoom-fit", "Fit"],
  ["#run-doctor", "Run doctor"],
] as const;

/** The WCAG contrast of each visible text against the first opaque background behind it. */
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
    for (const node of document.querySelectorAll("body *")) {
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

/** A project in a folder whose path is about 400 characters long (SQLite opens no longer path), with tasks 1 and 2 (after 1) and `more` tasks. */
function longFolderProject(more: number): string {
  const root = path.join(
    makeTempFolder(),
    ...Array.from({ length: 3 }, (_, at) => `${at}-${"deeply-nested-folder-name-".repeat(4)}`),
  );
  mkdirSync(root, { recursive: true });
  const store = storeOf(root);
  store.savePlan({
    roadmap: { title: "Payments", goal: "Card checkout" },
    milestones: [{ title: "Cards", goal: "Pay by card", tasks: [planned("a"), planned("b", ["a"])] }],
  });
  for (let index = 0; index < more; index += 1) store.addTask({ title: `Many ${index}`, dependsOn: [1] });
  store.close();
  return root;
}

describe("QA C2a run 4: the restyle", () => {
  it("FR-GUI-064 / TC-GUI-067: icons leave each button's accessible name and text as they were, and are hidden from screen readers", async () => {
    const { page } = await openWatched({});
    for (const [selector, name] of ICON_BUTTONS) {
      if (selector === "#run-doctor") await page.locator('[data-view="setup"]').click();
      const button = page.locator(selector);
      expect((await button.textContent())?.trim()).toBe(name);
      expect(await button.ariaSnapshot()).toBe(
        `- button "${name}"${selector.startsWith("[data-layout") ? (name === "Canvas" ? " [pressed]" : "") : ""}`,
      );
      expect(await button.locator("svg.icon").count()).toBe(1);
      expect(await button.locator("svg.icon").getAttribute("aria-hidden")).toBe("true");
    }
    // A redraw or a second visit to a place doesn't add a second icon.
    await page.locator('[data-view="canvas"]').click();
    await page.locator('[data-layout="list"]').click();
    await page.locator('[data-layout="canvas"]').click();
    expect(await page.locator("svg.icon").count()).toBe(ICON_BUTTONS.length);
  });

  it("FR-GUI-049: what the page hides stays hidden: Cancel job, problems, empty-canvas note, Setup, Jobs, panel, List", async () => {
    const { page } = await openWatched({});
    const hidden = ["#cancel-job", "#canvas-problems", "#canvas-empty", "#view-setup", "#view-jobs", "#panel", "#list"];
    for (const selector of hidden) expect(await page.locator(selector).isVisible(), selector).toBe(false);
    // Every element with the attribute is laid out as nothing, whatever its own display rule says.
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll("[hidden]")]
          .filter((node) => getComputedStyle(node).display !== "none")
          .map((node) => node.id),
      ),
    ).toEqual([]);
    await page.locator('[data-view="setup"]').click();
    await page.locator("#run-doctor").click();
    await expect.poll(() => page.locator("#output-title").textContent()).toMatch(/^cclinic doctor --json · /);
    await expect.poll(() => page.locator("#output-title").textContent()).not.toMatch(/Running/);
    expect(await page.locator("#cancel-job").isVisible()).toBe(false);
    await page.locator('[data-layout="list"]').evaluate((node: HTMLElement) => {
      node.click();
    });
    await page.locator('[data-view="canvas"]').click();
    expect(await page.locator("#canvas-tools").isVisible()).toBe(false);
    expect(await page.locator("#canvas-area").isVisible()).toBe(false);
  });

  for (const scheme of ["light", "dark"] as const)
    it(`FR-GUI-048: with the system in ${scheme}, nothing is blocked by the content security policy on any screen`, async () => {
      const { page, problems } = await openWatched({ colorScheme: scheme }, { withSessions: true });
      await page.locator('[data-key="task-2"]').click();
      await expect.poll(() => page.locator("#transcript .entries pre").count()).toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      await page.locator('[data-layout="list"]').click();
      await page.locator('[data-view="setup"]').click();
      await page.locator("#run-doctor").click();
      await page.locator("#theme").click();
      await page.locator("#theme").click();
      await page.locator("#add-task-open").evaluate((node: HTMLElement) => {
        node.click();
      });
      await page.reload();
      await page.locator('[data-layout="canvas"]').waitFor();
      expect(problems).toEqual([]);
    });

  it("TC-GUI-066: the dark tokens apply under a dark system, the light under a light one, and the toggle wins after a reload", async () => {
    const background = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const dark = await openWatched({ colorScheme: "dark" });
    expect(await background(dark.page)).toBe("rgb(12, 12, 15)");
    await dark.page.locator("#theme").click();
    expect(await dark.page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    expect(await background(dark.page)).toBe("rgb(250, 250, 250)");
    await dark.page.reload();
    await dark.page.locator('[data-key="task-1"]').waitFor();
    expect(await background(dark.page)).toBe("rgb(250, 250, 250)");

    const light = await openWatched({ colorScheme: "light" });
    expect(await background(light.page)).toBe("rgb(250, 250, 250)");
    await light.page.locator("#theme").click();
    await light.page.locator("#theme").click();
    await light.page.reload();
    await light.page.locator('[data-key="task-1"]').waitFor();
    expect(await light.page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    expect(await background(light.page)).toBe("rgb(12, 12, 15)");
    // The card text follows the theme too.
    expect(
      await light.page.locator('[data-key="task-2"] .card-title').evaluate((node) => getComputedStyle(node).color),
    ).toBe("rgb(236, 236, 241)");
  });

  it("TC-GUI-076: each task and roadmap status badge on the canvas and the List has its text and an icon", async () => {
    const root = project();
    const store = storeOf(root);
    store.setStatus(2, "in-progress");
    store.close();
    const { page } = await openWatched({}, { root, withSessions: true });
    const badges = (scope: string) =>
      page.locator(`${scope} .badge.status, ${scope} .badge.mode`).evaluateAll((nodes) =>
        nodes.map((node) => {
          const before = getComputedStyle(node, "::before");
          const drawn =
            before.content !== "none" &&
            before.display !== "none" &&
            (before.content !== '""' || parseFloat(before.borderTopWidth) > 0 || before.backgroundImage !== "none");
          return [node.getAttribute("class") ?? "", node.textContent.trim() !== "", drawn] as const;
        }),
      );
    const onCanvas = await badges("#frames");
    expect(onCanvas.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        "badge status status-done",
        "badge status status-in-progress",
        "badge status status-open",
      ]),
    );
    expect(onCanvas.filter(([, text, icon]) => !text || !icon)).toEqual([]);
    await page.locator('[data-layout="list"]').click();
    const inList = await badges("#list");
    expect(inList.length).toBeGreaterThanOrEqual(6);
    expect(inList.filter(([, text, icon]) => !text || !icon)).toEqual([]);
  });

  it("TC-GUI-076: a job's status on the Jobs screen has its text and an icon", async () => {
    const { page } = await openWatched({});
    await page.locator('[data-view="setup"]').click();
    await page.locator("#run-doctor").click();
    const job = page.locator("#job-list button").first();
    await expect.poll(() => job.textContent()).toMatch(/^cclinic doctor --json · /);
    const hasIcon = await job.evaluate(
      (node) =>
        node.querySelector("svg, .badge, [class*='status']") !== null ||
        getComputedStyle(node, "::before").content !== "none",
    );
    expect(hasIcon).toBe(true);
  });

  it("TC-GUI-076: each session's status, live and ended, has its text and an icon in the panel and the List", async () => {
    const { page } = await openWatched({}, { withSessions: true });
    await page.locator('[data-key="task-2"]').click();
    const sessions = await page
      .locator("#panel-body button.session")
      .evaluateAll((nodes) =>
        nodes.map((node) => [
          node.textContent.trim().split(" · ").at(-1),
          node.querySelector(".live-dot, .ended-dot")?.className,
        ]),
      );
    expect(sessions).toEqual(
      expect.arrayContaining([
        ["live", "live-dot"],
        ["ended", "ended-dot"],
      ]),
    );
    await page.keyboard.press("Escape");
    await page.locator('[data-layout="list"]').click();
    const cell = page.locator('#list tr[data-task="2"] td').last();
    expect(await cell.textContent()).toBe("2 · live");
    expect(await cell.locator(".live-dot").count()).toBe(1);
  });

  it("TC-GUI-076: a task whose sessions have all ended has the ended text and icon in the List", async () => {
    const root = project();
    const home = makeTempFolder();
    const folder = path.join(home, ".claude/projects/p");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      path.join(folder, `${SESSION_OLD}.jsonl`),
      `${JSON.stringify({ type: "user", message: { content: "q" } })}\n`,
    );
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const state = linkSession(
      beginChange(
        { changeType: "feature", spec: "refunds", taskId: 3 },
        { key: stateKey(3, "main"), approverMode: "user", now: hourAgo },
      ),
      { sessionId: SESSION_OLD, transcriptPath: path.join(folder, `${SESSION_OLD}.jsonl`) },
      hourAgo,
    );
    await openWorkflowStore(root).save(state);
    const { page } = await open({ root, home });
    await page.locator('[data-layout="list"]').click();
    const cell = page.locator('#list tr[data-task="3"] td').last();
    expect(await cell.locator(".ended-dot").count()).toBe(1);
    expect(await cell.textContent()).toBe("1 · ended");
  });

  it("TC-GUI-076: a task with no sessions shows 0 and no session icon in the List", async () => {
    const { page } = await openWatched({});
    await page.locator('[data-layout="list"]').click();
    const rows = page.locator("#list tr[data-task]");
    expect(await rows.count()).toBeGreaterThan(0);
    for (const row of await rows.all()) {
      const cell = row.locator("td").last();
      expect(await cell.textContent()).toBe("0");
      expect(await cell.locator(".live-dot, .ended-dot").count()).toBe(0);
    }
  });

  it("TC-GUI-076: the task panel's status has its text and an icon", async () => {
    const { page } = await openWatched({});
    await page.locator('[data-key="task-1"]').click();
    const status = page.locator("#panel-body .details dd").first();
    expect(await status.textContent()).toBe("Done");
    expect(
      await status.evaluate(
        (node) =>
          node.querySelector("svg, .badge.status") !== null || getComputedStyle(node, "::before").content !== "none",
      ),
    ).toBe(true);
  });

  for (const screen of ["canvas", "list", "panel", "setup", "jobs", "add-task", "confirm"] as const)
    it(`FR-GUI-049: at 768 px the ${screen} screen with a very long project folder and many tasks doesn't scroll sideways`, async () => {
      const root = longFolderProject(60);
      const { page } = await openWatched({ viewport: NARROW }, { root });
      expect(await page.locator("#project-folder").textContent()).toBe(root);
      if (screen === "list") await page.locator('[data-layout="list"]').click();
      // With 60 unassigned tasks, Fit at 25 % leaves the roadmap frames above the view (see DEF in the report),
      // so the task's panel is opened from the List; at 768 px it covers the whole width.
      const openTaskTwo = async () => {
        await page.locator('[data-layout="list"]').click();
        await page.locator('#list [data-task="2"] button.link').first().click();
        await page.locator("#panel").waitFor();
      };
      if (screen === "panel") await openTaskTwo();
      if (screen === "setup") await page.locator('[data-view="setup"]').click();
      if (screen === "jobs") {
        await page.locator('[data-view="setup"]').click();
        await page.locator("#run-doctor").click();
        await page.locator("#job-list button").first().waitFor();
      }
      if (screen === "add-task") await page.locator("#add-task-open").click();
      if (screen === "confirm") {
        await openTaskTwo();
        await page.locator("#panel-body button.danger").first().click();
        await page.locator("#confirm[open]").waitFor();
      }
      expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
      // Dialogs fit in the window.
      for (const dialog of await page.locator("dialog[open]").all()) {
        const box = await dialog.boundingBox();
        expect(box !== null && box.x >= 0 && box.x + box.width <= NARROW.width).toBe(true);
      }
    });

  it("TC-GUI-097 (exploratory): with 60 unassigned tasks, Fit leaves every frame at least partly in view", async () => {
    const { page } = await openWatched({ viewport: NARROW }, { root: longFolderProject(60) });
    await page.locator("#zoom-fit").click();
    const outOfView = await page.evaluate(() => {
      const area = document.getElementById("canvas-area")?.getBoundingClientRect();
      if (area === undefined) return ["no canvas"];
      return [...document.querySelectorAll(".frame")]
        .filter((frame) => {
          const box = frame.getBoundingClientRect();
          return box.bottom <= area.top || box.top >= area.bottom || box.right <= area.left || box.left >= area.right;
        })
        .map((frame) => frame.getAttribute("data-frame"));
    });
    expect(outOfView).toEqual([]);
  });

  it("FR-GUI-049: at 1280 px a very long project folder stays in the top bar and doesn't push the theme toggle off screen", async () => {
    const root = longFolderProject(0);
    const { page } = await openWatched({}, { root });
    expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
    const theme = await page.locator("#theme").boundingBox();
    expect(theme !== null && theme.x + theme.width <= WIDE.width).toBe(true);
    const bar = await page.locator(".top-bar").boundingBox();
    const folder = await page.locator("#project-folder").boundingBox();
    expect(bar !== null && folder !== null && folder.y + folder.height <= bar.y + bar.height + 0.5).toBe(true);
  });

  it("FR-GUI-049: at 768 px the top bar still shows the project's folder and the running job count", async () => {
    const { page } = await openWatched({ viewport: NARROW });
    expect(await page.locator("#project-name").isVisible()).toBe(true);
    expect(await page.locator("#project-folder").isVisible()).toBe(true);
    expect(await page.locator("#job-count").isVisible()).toBe(true);
  });

  it("FR-GUI-049: the notice isn't shown while empty, shows its text inside the window, and goes once cleared", async () => {
    const { page } = await openWatched({ viewport: NARROW });
    await page.clock.install();
    const notice = page.locator("#notice");
    expect(await notice.textContent()).toBe("");
    expect(await notice.isVisible()).toBe(false);
    await page.locator('[data-key="task-4"]').click();
    await page.locator('#panel-body [data-focus="start"]').click();
    await expect.poll(() => notice.textContent()).toBe("Started task #4.");
    expect(await notice.isVisible()).toBe(true);
    const box = await notice.boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= NARROW.width && box.y + box.height <= 900).toBe(true);
    await page.clock.runFor(8_000);
    await expect.poll(() => notice.textContent()).toBe("");
    expect(await notice.isVisible()).toBe(false);
  });

  it("TC-GUI-088: with reduced motion, the panel, dialogs and every screen run no animation or transition", async () => {
    const { page } = await openWatched({ reducedMotion: "reduce" });
    const moving = () =>
      page.evaluate(() => {
        const found = document
          .getAnimations()
          .map((animation) => ("animationName" in animation ? String(animation.animationName) : "transition"));
        for (const node of document.querySelectorAll("*")) {
          const style = getComputedStyle(node);
          if (
            style.animationName !== "none" ||
            style.transitionDuration.split(",").some((part) => parseFloat(part) > 0)
          )
            found.push(`${node.tagName.toLowerCase()}#${node.id}.${node.className}`);
        }
        return found;
      });
    await page.locator('[data-key="task-2"]').click();
    expect(await page.locator("#panel").evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
    expect(await moving()).toEqual([]);
    await page.locator("#panel-body button.danger").first().click();
    expect(await moving()).toEqual([]);
    await page.keyboard.press("Escape");
    await page.locator("#add-task-open").click();
    expect(await moving()).toEqual([]);
    await page.keyboard.press("Escape");
    for (const view of ["setup", "jobs", "canvas"]) {
      await page.locator(`[data-view="${view}"]`).click();
      await page.locator(`[data-view="${view}"]`).hover();
      expect(await moving()).toEqual([]);
    }
  });

  it("TC-GUI-088 (control): without reduced motion, the panel does animate, so the check above can see one", async () => {
    const { page } = await openWatched({ reducedMotion: "no-preference" });
    await page.locator('[data-key="task-2"]').click();
    expect(await page.locator("#panel").evaluate((node) => getComputedStyle(node).animationName)).toBe("panel-in");
  });

  it("TC-GUI-087: Tab reaches the page's controls, each with a visible focus outline", async () => {
    const { page } = await openWatched({});
    await page.locator('[data-key="task-2"]').click();
    const seen: string[] = [];
    const bare: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => {
        const node = document.activeElement;
        if (node === null || node === document.body) return undefined;
        const style = getComputedStyle(node);
        const outlined = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
        return { name: `${node.tagName.toLowerCase()}#${node.id}.${node.className}`, outlined };
      });
      if (focus === undefined) continue;
      seen.push(focus.name);
      if (!focus.outlined) bare.push(focus.name);
    }
    expect(seen.some((name) => name.startsWith("input"))).toBe(true);
    expect(bare).toEqual([]);
  });

  for (const theme of ["light", "dark"] as const)
    it(`TC-GUI-087: in the ${theme} theme every text on the canvas, panel, List, notices and dialogs is at least 4.5:1`, async () => {
      const { page } = await openWatched({ colorScheme: theme }, { withSessions: true });
      const low: string[] = [];
      low.push(...(await lowContrast(page, 4.5)));
      await page.locator('[data-key="task-2"]').click();
      await expect.poll(() => page.locator("#transcript .entries pre").count()).toBeGreaterThan(0);
      low.push(...(await lowContrast(page, 4.5)));
      await page.locator("#panel-body button.danger").first().click();
      low.push(...(await lowContrast(page, 4.5)));
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.locator('[data-layout="list"]').click();
      low.push(...(await lowContrast(page, 4.5)));
      await page.evaluate(() => {
        const notice = document.getElementById("notice");
        if (notice === null) return;
        notice.textContent = "The layout wasn't saved: disk full";
        notice.classList.add("error");
      });
      low.push(...(await lowContrast(page, 4.5)));
      expect([...new Set(low)]).toEqual([]);
    });
});

describe("QA C2a run 4: design tokens", () => {
  it("TC-GUI-065: colours, spacing, radius and font sizes are used only through the token custom properties, with no web fonts", () => {
    const css = readFileSync(path.join(import.meta.dirname, "../../src/gui/styles.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(css).not.toMatch(/@font-face|@import|url\(/);
    const declarations = [...css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)]
      .map(([, property = "", value = ""]) => [property, value.trim()] as const)
      .filter(([property]) => !property.startsWith("--"));
    const literalColour = /#[0-9a-f]{3,8}\b|\b(rgb|rgba|hsl|hsla)\(|\b(white|black)\b/i;
    const literalLength = /(^|[\s(,])-?\d*\.?\d+(px|rem|em)\b/;
    const offenders = (test: (property: string) => boolean, pattern: RegExp) =>
      declarations
        .filter(([property, value]) => test(property) && pattern.test(value.replace(/var\([^)]*\)/g, "")))
        .map(([property, value]) => `${property}: ${value}`);
    expect({
      colours: offenders(
        (property) => /color|background|border|fill|stroke|shadow|outline/.test(property),
        literalColour,
      ),
      fontSizes: offenders((property) => property === "font-size", literalLength),
      spacing: offenders((property) => /^(margin|padding|gap|row-gap|column-gap)/.test(property), literalLength),
      radius: offenders((property) => property.endsWith("radius"), literalLength),
    }).toEqual({ colours: [], fontSizes: [], spacing: [], radius: [] });
  });
});

describe("QA C2a run 5: the theme toggle and the 768 px top bar", () => {
  it("TC-GUI-087: with the system in light and the toggle set to dark, every text, the danger buttons and the error notice are at least 4.5:1", async () => {
    const { page } = await openWatched({ colorScheme: "light" }, { withSessions: true });
    await page.locator("#theme").click();
    await page.locator("#theme").click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    // The theme change runs colour transitions; measure the colours they end on.
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
    const low: string[] = [];
    low.push(...(await lowContrast(page, 4.5)));
    await page.locator('[data-key="task-2"]').click();
    await expect.poll(() => page.locator("#transcript .entries pre").count()).toBeGreaterThan(0);
    low.push(...(await lowContrast(page, 4.5)));
    await page.locator("#panel-body button.danger").first().click();
    low.push(...(await lowContrast(page, 4.5)));
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      const notice = document.getElementById("notice");
      if (notice === null) return;
      notice.textContent = "The layout wasn't saved: disk full";
      notice.classList.add("error");
    });
    low.push(...(await lowContrast(page, 4.5)));
    expect([...new Set(low)]).toEqual([]);
  });

  it("TC-GUI-066: the toggle's dark theme sets the same tokens as the system's dark theme", async () => {
    const tokens = (page: Page) =>
      page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const names = new Set<string>();
        for (const sheet of document.styleSheets)
          for (const rule of sheet.cssRules)
            if (rule instanceof CSSStyleRule) for (const name of rule.style) if (name.startsWith("--")) names.add(name);
        return Object.fromEntries([...names].sort().map((name) => [name, style.getPropertyValue(name).trim()]));
      });
    const system = await openWatched({ colorScheme: "dark" });
    const toggled = await openWatched({ colorScheme: "light" });
    await toggled.page.locator("#theme").click();
    await toggled.page.locator("#theme").click();
    expect(await toggled.page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    expect(await tokens(toggled.page)).toEqual(await tokens(system.page));
  });

  it("FR-GUI-049: at 768 px the top bar shows the folder, the job count and the budget, inside the window", async () => {
    const root = path.join(makeTempFolder(), "deeply-nested-folder-name-".repeat(8), "shop");
    mkdirSync(root, { recursive: true });
    const store = storeOf(root);
    store.addTask({ title: "One", dependsOn: [] });
    store.close();
    const { page } = await openWatched({ viewport: NARROW }, { root });
    await page.evaluate(() => {
      const budget = document.getElementById("budget");
      if (budget !== null) budget.textContent = "$12.34 of $50.00 · $1.00 of $5.00";
    });
    for (const selector of ["#project-name", "#project-folder", "#job-count", "#budget", "#theme"]) {
      const box = await page.locator(selector).boundingBox();
      expect(box !== null && box.width > 0 && box.x >= 0 && box.x + box.width <= NARROW.width, selector).toBe(true);
    }
    expect(await overflowAt(page)).toEqual(NOTHING_SIDEWAYS);
  });

  it("FR-GUI-049 (exploratory): at 768 px a long project name leaves part of the folder in view, and the name ends inside the window", async () => {
    const root = path.join(makeTempFolder(), "a-rather-long-project-folder-name-".repeat(3).slice(0, -1));
    mkdirSync(root, { recursive: true });
    const store = storeOf(root);
    store.addTask({ title: "One", dependsOn: [] });
    store.close();
    const { page } = await openWatched({ viewport: NARROW }, { root });
    const name = await page.locator("#project-name").boundingBox();
    const folder = await page.locator("#project-folder").boundingBox();
    expect(name !== null && name.x + name.width <= NARROW.width).toBe(true);
    expect(folder !== null && folder.width > 0 && folder.x + folder.width <= NARROW.width).toBe(true);
  });
});

describe("QA C2a run 6: frame widths from the server, and the panel's session", () => {
  /** Roadmap 1 with three milestones (tasks 1, 2, 3), roadmap 2 with task 4, task 5 unassigned, change `fix-y`. */
  async function wideProject(): Promise<string> {
    const root = makeTempFolder();
    const store = storeOf(root);
    store.savePlan({
      roadmap: { title: "Wide", goal: "Three columns" },
      milestones: [
        { title: "One", goal: "1", tasks: [planned("a")] },
        { title: "Two", goal: "2", tasks: [planned("b")] },
        { title: "Three", goal: "3", tasks: [planned("c")] },
      ],
    });
    store.savePlan({
      roadmap: { title: "Narrow", goal: "One column" },
      milestones: [{ title: "Only", goal: "1", tasks: [planned("d")] }],
    });
    store.addTask({ title: "Loose", dependsOn: [] });
    store.close();
    await openWorkflowStore(root).save(
      beginChange(
        { changeType: "bug", spec: "auth" },
        { key: stateKey(null, "fix-y"), approverMode: "user", now: new Date().toISOString() },
      ),
    );
    return root;
  }

  const payloadOf = (page: Page) =>
    page.evaluate(async () => {
      const response = await fetch("/api/canvas");
      return (await response.json()) as { frameWidths: Record<string, number> };
    });

  it("TC-GUI-100: every frame, three milestones, Unassigned and Changes, is drawn at the width the server sends", async () => {
    const { page } = await open({ root: await wideProject() });
    const { frameWidths } = await payloadOf(page);
    // 3 columns: 24 + 3 × 220 + 2 × 32 + 24; 1 column: 24 + 220 + 24.
    expect(frameWidths).toEqual({ "roadmap-1": 772, "roadmap-2": 268, unassigned: 268, changes: 268 });
    const drawn: Record<string, number> = await page
      .locator("[data-frame]")
      .evaluateAll((nodes: HTMLElement[]) =>
        Object.fromEntries(nodes.map((node) => [node.dataset.frame ?? "", parseFloat(node.style.width)])),
      );
    expect(drawn).toEqual(frameWidths);
  });

  it("TC-GUI-098: drops clamp to the server's width in a three-milestone frame, Unassigned and Changes", async () => {
    const { page, root } = await open({ root: await wideProject() });
    const scale = await scaleOf(page);
    const task1 = await styleBox(page, '[data-key="task-1"]');
    // Centre still inside the 772 px frame: pulled back to the third column at 24 + 2 × 252.
    await drag(page, '[data-key="task-1"]', 600 * scale, 0);
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-1"]).toEqual({ x: 528, y: task1.y });
    });
    const task5 = await styleBox(page, '[data-key="task-5"]');
    await drag(page, '[data-key="task-5"]', 100 * scale, 0);
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["task-5"]).toEqual({ x: 24, y: task5.y });
    });
    const change = await styleBox(page, '[data-key="change-branch-fix-y"]');
    await drag(page, '[data-key="change-branch-fix-y"]', -100 * scale, 0);
    await vi.waitFor(() => {
      expect(savedLayout(root).cards["change-branch-fix-y"]).toEqual({ x: 24, y: change.y });
    });
    // Centre past the frame's right edge: back where it was, and nothing saved for it.
    const task3 = await styleBox(page, '[data-key="task-3"]');
    await drag(page, '[data-key="task-3"]', 200 * scale, 0);
    expect(await styleBox(page, '[data-key="task-3"]')).toEqual(task3);
    expect(savedLayout(root).cards["task-3"]).toBeUndefined();
  });

  it("TC-GUI-097: Fit puts every frame of a three-milestone roadmap, Unassigned and Changes in view", async () => {
    const { page } = await open({ root: await wideProject() });
    await page.locator("#zoom-fit").click();
    const area = await page.locator("#canvas-area").boundingBox();
    if (area === null) throw new Error("No canvas area");
    for (const key of ["roadmap-1", "roadmap-2", "unassigned", "changes"]) {
      const box = await page.locator(`[data-frame="${key}"]`).boundingBox();
      expect(box, key).not.toBeNull();
      if (box === null) continue;
      expect(box.x >= area.x && box.x + box.width <= area.x + area.width + 0.5, key).toBe(true);
      expect(box.y >= area.y && box.y + box.height <= area.y + area.height + 0.5, key).toBe(true);
    }
  });

  it("TC-GUI-096: a picked session is forgotten when another task is opened, and when the panel closes", async () => {
    const { page } = await open({ withSessions: true });
    const entries = page.locator("#transcript .entries pre");
    await page.locator('[data-key="task-2"]').click();
    await page.locator(`button[data-session="${SESSION_OLD}"]`).click();
    await expect.poll(() => entries.allTextContents()).toEqual(["old question"]);
    // Clicking the same card again keeps the session the user picked.
    await page.locator('[data-key="task-2"]').click();
    expect(await page.locator(`button[data-session="${SESSION_OLD}"]`).getAttribute("aria-pressed")).toBe("true");
    await page.locator('[data-key="task-4"]').click();
    expect(await page.locator('[data-testid="no-sessions"]').isVisible()).toBe(true);
    await page.locator('[data-key="task-2"]').click();
    await expect.poll(() => entries.allTextContents()).toEqual(["live question", "live answer"]);
    expect(await page.locator(`button[data-session="${SESSION_LIVE}"]`).getAttribute("aria-pressed")).toBe("true");
    await page.locator(`button[data-session="${SESSION_OLD}"]`).click();
    await expect.poll(() => entries.allTextContents()).toEqual(["old question"]);
    await page.keyboard.press("Escape");
    expect(await page.locator("#panel").isHidden()).toBe(true);
    await page.locator('[data-key="task-2"]').click();
    await expect.poll(() => entries.allTextContents()).toEqual(["live question", "live answer"]);
  });
});
