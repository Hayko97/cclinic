/// <reference lib="dom" />
/** QA for the GUI's polish (spec: gui, stage D6): URLs, job notices, times, loading, motion and narrow screens. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import type { JobProcess } from "../../src/application/gui-jobs.js";
import { beginChange, linkSession, stateKey, withPending, type PendingQuestion } from "../../src/core/workflow.js";
import { makeTempFolder } from "../support/helpers.js";
import { startTestGui, type TestGui } from "../support/gui.js";

const SESSION = "5e5e0000-0000-4000-8000-000000000001";
const BRANCH_KEY = stateKey(null, "fix.x");
const PAST_RUN = "20261101-120000";
const G1: PendingQuestion = {
  kind: "gate",
  gate: "G1",
  step: null,
  reason: null,
  question: 'Approve the spec change for task #2 (spec "payments")?',
  answers: ["approve", "refine", "review-doc"],
  answer: null,
  notes: null,
};

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

/** Roadmap 1 "Payments" with tasks 1 to 4, task 2's change with one session, a change keyed by branch `fix.x`, and a past run. */
async function project(home: string, { isGenerated = true, isWaiting = false } = {}): Promise<string> {
  const root = makeTempFolder();
  mkdirSync(path.join(root, ".cclinic"), { recursive: true });
  if (isGenerated) mkdirSync(path.join(root, ".cclinic/sdd"), { recursive: true });
  const store = openTaskStore(path.join(root, ".cclinic"), "create");
  if (store === undefined) throw new Error("No store");
  store.savePlan({
    roadmap: { title: "Payments", goal: "Card checkout" },
    milestones: [
      {
        title: "Cards",
        goal: "Pay by card",
        tasks: ["Token", "Charge", "Receipt", "Card form"].map((title, index) => ({
          key: `t${index}`,
          title,
          description: "",
          spec: null,
          dependsOn: [],
        })),
      },
    ],
  });
  store.close();
  const folder = path.join(home, ".claude/projects/p");
  mkdirSync(folder, { recursive: true });
  const transcript = path.join(folder, `${SESSION}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "Charge the card" } })}\n`);
  const now = new Date().toISOString();
  const workflow = openWorkflowStore(root);
  const taskChange = linkSession(
    beginChange(
      { changeType: "feature", spec: "payments", taskId: 2 },
      { key: stateKey(2, "main"), approverMode: "user", now },
    ),
    { sessionId: SESSION, transcriptPath: transcript },
    now,
  );
  await workflow.save(isWaiting ? withPending(taskChange, G1, now) : taskChange);
  await workflow.save(
    beginChange({ changeType: "bug", spec: "payments" }, { key: BRANCH_KEY, approverMode: "user", now }),
  );
  const run = path.join(root, ".cclinic/auto", PAST_RUN);
  mkdirSync(path.join(run, "logs"), { recursive: true });
  writeFileSync(
    path.join(run, "run.json"),
    JSON.stringify({
      runId: PAST_RUN,
      roadmapId: 1,
      roadmapTitle: "Payments",
      runBranch: `cclinic/auto/${PAST_RUN}/run`,
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      finishedAt: now,
      outcome: "completed",
      budgetUsd: 10,
      spentUsd: 2,
      developers: 1,
      tasks: [],
      skippedInProgress: [],
    }),
  );
  writeFileSync(path.join(run, "report.md"), "# Automated run\n\nOutcome: completed\n");
  return root;
}

const PLAN = { status: "plan", roadmapId: 1, plan: "Roadmap #1: Payments\n  1. #1 Token", runnable: [1], blocked: [] };

/** Jobs held until the test ends them; an auto plan (no `--yes`) answers with PLAN at once. */
function heldJobs() {
  const started: string[][] = [];
  const exits: { readonly command: string; readonly exit: (code: number) => void }[] = [];
  const startJob = (args: readonly string[]): JobProcess => {
    started.push([...args]);
    let print: ((stream: "stdout" | "stderr", chunk: string) => void) | undefined;
    let exit: ((code: number) => void) | undefined;
    const isPlan = args[0] === "auto" && !args.includes("--yes");
    return {
      onOutput: (listener) => {
        print = listener;
      },
      onExit: (listener) => {
        exit = listener;
        if (isPlan)
          void Promise.resolve().then(() => {
            print?.("stdout", `${JSON.stringify(PLAN)}\n`);
            listener(0);
          });
        else exits.push({ command: args[0] ?? "", exit: listener });
      },
      signal: () => exit?.(130),
    };
  };
  const end = (command: string, code: number) => {
    const index = exits.findIndex((item) => item.command === command);
    if (index === -1) throw new Error(`No running ${command} job`);
    exits.splice(index, 1)[0]?.exit(code);
  };
  return { started, startJob, end };
}

interface Opened {
  readonly gui: TestGui;
  readonly page: Page;
  readonly errors: string[];
  readonly jobs: ReturnType<typeof heldJobs>;
}

async function open(
  options: {
    hash?: string;
    isGenerated?: boolean;
    isWaiting?: boolean;
    width?: number;
    beforeLoad?: (page: Page) => Promise<void>;
    waitForCards?: boolean;
  } = {},
): Promise<Opened> {
  const home = makeTempFolder();
  const root = await project(home, {
    isGenerated: options.isGenerated ?? true,
    isWaiting: options.isWaiting ?? false,
  });
  const jobs = heldJobs();
  const gui = await startTestGui(root, {}, { startJob: jobs.startJob, every: () => () => undefined }, { HOME: home });
  running.push(gui);
  const context = await browser.newContext({ viewport: { width: options.width ?? 1280, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await options.beforeLoad?.(page);
  await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}${options.hash ?? ""}`);
  if (options.waitForCards ?? true) await page.locator('[data-key="task-1"]').waitFor({ state: "attached" });
  return { gui, page, errors, jobs };
}

/** Opens another page on the same GUI, with the cookie the first load set, at `hash`. */
async function openAt(gui: TestGui, hash: string): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}${hash}`);
  await page.locator('[data-key="task-1"]').waitFor({ state: "attached" });
  return { page, errors };
}

const hash = (page: Page) => page.evaluate(() => location.hash);
const visibleView = (page: Page) =>
  page.evaluate(() => ["canvas", "setup", "jobs"].find((name) => !document.getElementById(`view-${name}`)?.hidden));
const panelTitle = (page: Page) =>
  page.evaluate(() =>
    document.getElementById("panel")?.hidden ? null : document.getElementById("panel-title")?.textContent,
  );

describe("QA FR-GUI-063: URLs", () => {
  it("QA: the token link with a hash opens what the hash names, and drops only the token", async () => {
    const { page, errors } = await open({ hash: "#/task/2" });
    await expect.poll(() => panelTitle(page)).toBe("Task #2");
    expect(await page.evaluate(() => location.search)).toBe("");
    expect(await hash(page)).toBe("#/task/2");
    expect(errors).toEqual([]);
  });

  it("QA: a reload on each kind of URL returns to the same view", async () => {
    const { gui } = await open();
    const cases: [string, () => (page: Page) => Promise<unknown>, unknown][] = [
      ["#/canvas", () => visibleView, "canvas"],
      ["#/setup", () => visibleView, "setup"],
      ["#/jobs", () => visibleView, "jobs"],
      ["#/task/3", () => panelTitle, "Task #3"],
      ["#/roadmap/1", () => panelTitle, "Roadmap #1"],
      [`#/change/${BRANCH_KEY}`, () => visibleView, "canvas"],
    ];
    for (const [url, read, expected] of cases) {
      const { page, errors } = await openAt(gui, url);
      await expect.poll(() => read()(page)).toBe(expected);
      await page.reload();
      await page.locator('[data-key="task-1"]').waitFor({ state: "attached" });
      await expect.poll(() => read()(page)).toBe(expected);
      expect(await hash(page)).toBe(url);
      expect(errors).toEqual([]);
    }
  });

  it("QA: a change keyed by a branch with a dot opens by its URL, and its URL is recorded when it's opened", async () => {
    const { gui, page } = await open();
    await page.locator(`[data-key="change-${BRANCH_KEY}"]`).click();
    await expect.poll(() => hash(page)).toBe(`#/change/${BRANCH_KEY}`);
    const other = await openAt(gui, `#/change/${BRANCH_KEY}`);
    await expect.poll(() => other.page.locator("#panel").isVisible()).toBe(true);
    expect(await other.page.locator("#notice").textContent()).toBe("");
  });

  it("QA: a URL for a removed roadmap or change says so, and the canvas still works", async () => {
    const { gui } = await open();
    for (const [url, message] of [
      ["#/roadmap/99", "Roadmap #99 isn't in this project."],
      ["#/change/branch-gone", "The change branch-gone isn't in this project."],
    ]) {
      const { page, errors } = await openAt(gui, url ?? "");
      await expect.poll(() => page.locator("#notice").textContent()).toBe(message);
      expect(await page.locator("#panel").isHidden()).toBe(true);
      // DEF-4 fix: the URL names what's shown, so a reload doesn't repeat the problem.
      expect(await hash(page)).toBe("#/canvas");
      await page.locator('[data-key="task-1"]').click();
      await expect.poll(() => panelTitle(page)).toBe("Task #1");
      expect(errors).toEqual([]);
    }
  });

  it("QA: bad or badly encoded URL parts throw nothing and open nothing", async () => {
    const { gui } = await open();
    for (const url of ["#/task/abc", "#/task/0", "#/task/01", "#/nothing", "#/task/2/session/%E0%A4%A", "#%ZZ"]) {
      const { page, errors } = await openAt(gui, url);
      expect(errors, url).toEqual([]);
      if (url.startsWith("#/task/2/")) await expect.poll(() => panelTitle(page)).toBe("Task #2");
      else expect(await page.locator("#panel").isHidden(), url).toBe(true);
    }
  });

  it("QA: a past run opens by its URL, and one that isn't there says why and opens the roadmap", async () => {
    const { gui } = await open();
    const { page, errors } = await openAt(gui, `#/roadmap/1/run/${PAST_RUN}`);
    await expect.poll(() => page.locator("#panel-body").textContent()).toContain("Outcome: completed");
    expect(await hash(page)).toBe(`#/roadmap/1/run/${PAST_RUN}`);
    const missing = await openAt(gui, "#/roadmap/1/run/20991231-000000");
    // DEF-4 fix: like a removed task, a run that isn't there says why, and the URL names what's shown instead.
    await expect
      .poll(() => missing.page.locator("#notice").textContent())
      .toBe("Run 20991231-000000 isn't one of roadmap #1's finished runs.");
    expect(await missing.page.locator("#panel-title").textContent()).toBe("Roadmap #1");
    expect(await hash(missing.page)).toBe("#/roadmap/1");
    expect([...errors, ...missing.errors]).toEqual([]);
  });

  it("QA: back and forward move across screens and panels", async () => {
    const { page } = await open();
    await page.locator('[data-key="task-2"]').click();
    await page.locator('[data-view="setup"]').click();
    await page.locator('[data-view="jobs"]').click();
    await page.goBack();
    await expect.poll(() => visibleView(page)).toBe("setup");
    await page.goBack();
    await expect.poll(() => visibleView(page)).toBe("canvas");
    await expect.poll(() => panelTitle(page)).toBe("Task #2");
    await page.goForward();
    await expect.poll(() => visibleView(page)).toBe("setup");
  });

  it("QA: back to the page as it was first loaded (no hash) returns to the canvas", async () => {
    const { page } = await open();
    await page.locator('[data-view="setup"]').click();
    expect(await hash(page)).toBe("#/setup");
    await page.goBack();
    await expect.poll(() => hash(page)).toBe("");
    await expect.poll(() => visibleView(page)).toBe("canvas");
  });

  it("QA: a link to a task, opened on a project that isn't generated yet, keeps its hash", async () => {
    const { page } = await open({ isGenerated: false, hash: "#/task/2" });
    await expect
      .poll(() => panelTitle(page), { message: `hash ${await hash(page)}, view ${await visibleView(page)}` })
      .toBe("Task #2");
    expect(await hash(page)).toBe("#/task/2");
  });
});

describe("QA FR-GUI-062: job notices", () => {
  it("QA: an auto run started from the GUI shows a notice when it ends, with Show output", async () => {
    const { page, jobs } = await open({ beforeLoad: (loaded) => loaded.clock.install() });
    const frame = page.locator('[data-frame="roadmap-1"]');
    await frame.locator('button[data-action="run-ai"]').click();
    const dialog = page.locator("#auto-dialog");
    await dialog.locator('input[name="maxBudgetUsd"]').fill("5");
    await dialog.locator('input[name="developers"]').fill("1");
    await dialog.locator("#auto-show-plan").click();
    await expect.poll(() => dialog.locator("#auto-plan").textContent()).toContain("Roadmap #1: Payments");
    await dialog.locator("#auto-start").click();
    await expect.poll(() => page.locator("#notice").textContent()).toContain("Started an automated run");
    await page.clock.runFor(2_000);
    jobs.end("auto", 0);
    await page.clock.runFor(2_000);
    await expect.poll(() => page.locator("#notice").textContent()).toContain("cclinic auto");
    expect(await page.locator("#notice button", { hasText: "Show output" }).count()).toBe(1);
    expect(await page.locator("#notice").textContent()).not.toContain("auto-preview");
  });

  it("QA: a job started through runJob, which reports itself, isn't announced again", async () => {
    const { page, jobs } = await open({ beforeLoad: (loaded) => loaded.clock.install() });
    await page.locator('[data-key="task-4"]').click();
    await page.locator('#panel-body [data-focus="remove"]').click();
    await page.locator("#confirm-ok").click();
    await expect.poll(() => jobs.started.some((args) => args[0] === "tasks")).toBe(true);
    await page.clock.runFor(2_000);
    jobs.end("tasks", 0);
    await expect.poll(() => page.locator("#notice").textContent()).toBe("Removed task #4.");
    for (let tick = 0; tick < 3; tick += 1) {
      await page.clock.runFor(2_000);
      expect(await page.locator("#notice").textContent()).not.toContain("cclinic tasks");
    }
  });

  it("QA: a failure notice's Close button works by keyboard", async () => {
    const { page, jobs } = await open({ beforeLoad: (loaded) => loaded.clock.install() });
    await page.locator('[data-view="setup"]').click();
    await page.locator("#run-doctor").click();
    await page.locator("#view-jobs:not([hidden])").waitFor();
    jobs.end("doctor", 1);
    await page.clock.runFor(2_000);
    const close = page.locator("#notice .notice-close");
    await close.waitFor();
    expect(await close.getAttribute("aria-label")).toBe("Close the notice");
    await close.focus();
    await page.keyboard.press("Enter");
    expect(await page.locator("#notice").textContent()).toBe("");
    expect(await page.locator("#notice").isVisible()).toBe(false);
  });

  it("QA: a failure notice stays until it's closed, even when another notice follows", async () => {
    const { page, jobs } = await open({ beforeLoad: (loaded) => loaded.clock.install() });
    await page.locator('[data-view="setup"]').click();
    await page.locator("#run-doctor").click();
    await page.locator("#view-jobs:not([hidden])").waitFor();
    jobs.end("doctor", 1);
    await page.clock.runFor(2_000);
    await expect.poll(() => page.locator("#notice").getAttribute("class")).toContain("error");
    // Anything else that tells the user something, here removing task 4.
    await page.locator('[data-view="canvas"]').click();
    await page.locator('[data-key="task-4"]').click();
    await page.locator('#panel-body [data-focus="remove"]').click();
    await page.locator("#confirm-ok").click();
    await expect.poll(() => jobs.started.some((args) => args[0] === "tasks")).toBe(true);
    await page.clock.runFor(500);
    jobs.end("tasks", 0);
    await page.clock.runFor(10_000);
    expect(await page.locator("#notice").textContent()).toContain("cclinic doctor");
  });

  it("QA: at 768 px a notice with a long command and Show output stays on the screen, in both themes", async () => {
    const { page } = await open({ width: 768 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(`(async () => {
        document.documentElement.dataset.theme = ${JSON.stringify(theme)};
        const { notify } = await import("/assets/api.js");
        notify("cclinic tasks add --title " + "x".repeat(400) + ": Failed (exit 1)", true, { label: "Show output", run: () => undefined });
      })()`);
      const box = await page.locator("#notice").boundingBox();
      // Failure notices stack, so the newest is checked.
      const buttons = await page.locator("#notice .notice-item:last-child button").evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= window.innerWidth && rect.width > 0;
        }),
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);
      expect(box !== null && box.x >= 0 && box.x + box.width <= 768).toBe(true);
      expect(buttons).toEqual([true, true]);
    }
  });

  it("QA: in the dark theme, the notices' text has at least 4.5:1 contrast", async () => {
    const { page } = await open();
    const ratios = await page.evaluate(`(async () => {
      document.documentElement.dataset.theme = "dark";
      const { notify } = await import("/assets/api.js");
      const channel = (value) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      const lum = (color) => { const [r, g, b] = color.match(/[\\d.]+/g).map(Number); return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const out = {};
      // Each notice's text against the background it's drawn on: its own, or the container's.
      const shownOn = (node) => {
        for (let at = node; at !== null; at = at.parentElement) {
          const background = getComputedStyle(at).backgroundColor;
          if (background !== "rgba(0, 0, 0, 0)" && background !== "transparent") return background;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      for (const isError of [false, true]) {
        notify("A notice", isError, { label: "Show output", run: () => undefined });
        const item = document.querySelector("#notice .notice-item:last-child .notice-text");
        out[isError ? "failure" : "success"] = ratio(getComputedStyle(item).color, shownOn(item));
      }
      // A success shown while a failure stays: the success sits on the container's background.
      notify("Another notice", false);
      const success = document.querySelector("#notice .notice-item:not(.error) .notice-text");
      out.successOverFailure = ratio(getComputedStyle(success).color, shownOn(success));
      return out;
    })()`);
    expect((ratios as { success: number }).success).toBeGreaterThanOrEqual(4.5);
    expect((ratios as { failure: number }).failure).toBeGreaterThanOrEqual(4.5);
    expect((ratios as { successOverFailure: number }).successOverFailure).toBeGreaterThanOrEqual(4.5);
  });
});

describe("QA FR-GUI-065, FR-GUI-066, FR-GUI-064: times, loading and motion", () => {
  it("QA TC-GUI-089: relative times and running durations stay current on the injected clock", async () => {
    const { page } = await open({ beforeLoad: (loaded) => loaded.clock.install() });
    await page.evaluate(`(async () => {
      const { when, timer } = await import("/assets/api.js");
      const now = new Date(Date.now()).toISOString();
      const time = when(now);
      time.id = "qa-time";
      const running = timer(now);
      running.id = "qa-timer";
      document.body.append(time, running);
    })()`);
    expect(await page.locator("#qa-time").textContent()).toBe("just now");
    const before = await page.locator("#qa-timer").textContent();
    // The clock ticks once a second from page load, so two seconds always see at least one tick past a second.
    await page.clock.runFor(2_000);
    const after = await page.locator("#qa-timer").textContent();
    expect(after).not.toBe(before);
    await page.clock.runFor(180_000);
    expect(await page.locator("#qa-time").textContent()).toBe("3 min ago");
    await page.clock.runFor(2 * 3_600_000);
    expect(await page.locator("#qa-time").textContent()).toBe("2 h ago");
  });

  it("QA: a time slightly in the future, as another machine's clock can give, reads as just now", async () => {
    const { page } = await open();
    const text = await page.evaluate(`(async () => {
      const { ago } = await import("/assets/api.js");
      return ago(new Date(Date.now() + 60_000).toISOString());
    })()`);
    expect(text).toBe("just now");
  });

  it("QA: a canvas that arrives quickly never shows the placeholder", async () => {
    const { gui } = await open();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const seen = { skeleton: false };
      (window as unknown as { qaSeen: typeof seen }).qaSeen = seen;
      new MutationObserver(() => {
        if (document.querySelector(".skeleton-frame") !== null) seen.skeleton = true;
      }).observe(document, { subtree: true, childList: true });
    });
    await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
    await page.locator('[data-key="task-1"]').waitFor();
    expect(await page.evaluate(() => (window as unknown as { qaSeen: { skeleton: boolean } }).qaSeen.skeleton)).toBe(
      false,
    );
    expect(await page.locator("#canvas-loading").isHidden()).toBe(true);
  });

  it("QA TC-GUI-088: with reduced motion the placeholder and dialogs run no animation or transition", async () => {
    const { gui } = await open();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    let release: () => void = () => undefined;
    let isHeld = true;
    await page.route("**/api/canvas", async (route) => {
      if (isHeld) await new Promise<void>((resolve) => (release = resolve));
      await route.continue();
    });
    await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
    await page.locator("#canvas-loading .skeleton-frame").first().waitFor();
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    isHeld = false;
    release();
    await page.locator('[data-key="task-4"]').waitFor();
    await page.locator('[data-key="task-4"]').click();
    await page.locator('#panel-body [data-focus="remove"]').click();
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await page.keyboard.press("Escape");
  });

  it("QA: the canvas placeholder is marked busy for screen readers, and a failure is announced", async () => {
    const { gui } = await open();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.route("**/api/canvas", (route) =>
      route.fulfill({ status: 500, body: JSON.stringify({ error: "Disk on fire." }) }),
    );
    await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
    await page.locator("#canvas-loading .error").waitFor();
    expect(await page.locator("#canvas-loading .error").getAttribute("role")).toBe("alert");
    expect(await page.locator("#canvas-loading button", { hasText: "Retry" }).isVisible()).toBe(true);
  });
});

describe("QA run 2: fixes of run 1's defects", () => {
  it("QA DEF-3: a success replaces the success before it and closes after 6 s; a failure stays under it", async () => {
    const { page } = await open({ beforeLoad: (loaded) => loaded.clock.install() });
    const items = () => page.locator("#notice .notice-item").allTextContents();
    await page.evaluate(`(async () => {
      const { notify } = await import("/assets/api.js");
      notify("First success");
      notify("Second success");
    })()`);
    expect(await items()).toEqual(["Second success"]);
    await page.clock.runFor(5_000);
    expect(await items()).toEqual(["Second success"]);
    await page.clock.runFor(1_500);
    expect(await items()).toEqual([]);
    expect(await page.locator("#notice").isVisible()).toBe(false);

    await page.evaluate(`(async () => {
      const { notify } = await import("/assets/api.js");
      notify("A failure", true);
      notify("A success");
    })()`);
    expect(await items()).toEqual(["A failure", "A success"]);
    expect(await page.locator("#notice").getAttribute("class")).toContain("error");
    await page.clock.runFor(7_000);
    expect(await items()).toEqual(["A failure"]);
    await page.evaluate(`(async () => {
      const { notify } = await import("/assets/api.js");
      notify("A second failure", true);
    })()`);
    expect(await items()).toEqual(["A failure", "A second failure"]);
    await page.locator("#notice .notice-item").first().locator(".notice-close").click();
    expect(await items()).toEqual(["A second failure"]);
    expect(await page.locator("#notice").getAttribute("class")).toContain("error");
    await page.locator("#notice .notice-close").click();
    expect(await items()).toEqual([]);
    expect(await page.locator("#notice").getAttribute("class")).not.toContain("error");
  });

  it("QA DEF-3: a success followed by a failure leaves only the failure after 6 s", async () => {
    const { page } = await open({ beforeLoad: (loaded) => loaded.clock.install() });
    const items = () => page.locator("#notice .notice-item").allTextContents();
    await page.evaluate(`(async () => {
      const { notify } = await import("/assets/api.js");
      notify("A success");
      notify("A failure", true);
    })()`);
    await page.clock.runFor(7_000);
    expect(await items()).toEqual(["A failure"]);
  });

  it("QA DEF-4: a missing task's URL is replaced with the canvas, and reload doesn't repeat the notice", async () => {
    const { gui } = await open();
    const { page, errors } = await openAt(gui, "#/task/99");
    await expect.poll(() => page.locator("#notice").textContent()).toBe("Task #99 isn't in this project.");
    expect(await hash(page)).toBe("#/canvas");
    await page.reload();
    await page.locator('[data-key="task-1"]').waitFor({ state: "attached" });
    expect(await page.locator("#notice").textContent()).toBe("");
    expect(errors).toEqual([]);
  });

  it("QA DEF-8: a URL for a job that isn't there, or isn't a job ID, says so and names the Jobs screen", async () => {
    const { gui } = await open();
    for (const job of ["job-999", "job-0", "abc", "job-1%2F..", "job-1234567"]) {
      const { page, errors } = await openAt(gui, `#/jobs/${job}`);
      await expect.poll(() => visibleView(page)).toBe("jobs");
      await expect
        .poll(() => page.locator("#notice").textContent(), { message: job })
        .toBe(`Job ${decodeURIComponent(job)} isn't one of this GUI's jobs.`);
      expect(await hash(page), job).toBe("#/jobs");
      expect(await page.locator("#output").textContent(), job).toBe("");
      expect(errors, job).toEqual([]);
      await page.reload();
      await page.locator("#view-jobs:not([hidden])").waitFor();
      expect(await page.locator("#notice").textContent(), job).toBe("");
    }
  });

  it("QA DEF-5: the empty Jobs list says why and offers Run doctor, which starts it", async () => {
    const { page, jobs } = await open();
    await page.locator('[data-view="jobs"]').click();
    expect(await page.locator("#job-list").textContent()).toContain(
      "No jobs yet. Everything the GUI runs shows here, with its output.",
    );
    await page.locator("#job-list button", { hasText: "Run doctor" }).click();
    await expect.poll(() => jobs.started.some((args) => args[0] === "doctor")).toBe(true);
    await expect.poll(() => page.locator("#job-list").textContent()).toContain("cclinic doctor");
    expect(await page.locator("#job-list").textContent()).not.toContain("No jobs yet");
  });

  it("QA DEF-6: each session in the list says when it started, as time ago with the exact time on hover", async () => {
    const { page } = await open();
    await page.locator('[data-key="task-2"]').click();
    const session = page.locator(`#panel-body button[data-session="${SESSION}"]`);
    await session.waitFor();
    expect(await session.textContent()).toMatch(/· (live|ended) · started (just now|\d+ (min|h|d) ago)/);
    const time = session.locator("time");
    expect(await time.getAttribute("title")).not.toBeNull();
    expect(await time.getAttribute("datetime")).not.toBeNull();
  });

  it("QA DEF-7: the roadmap panel, with no live run, never writes null or undefined", async () => {
    const { page, errors } = await open();
    await page.locator('[data-frame="roadmap-1"] [data-action="open-roadmap"]').click();
    await expect.poll(() => panelTitle(page)).toBe("Roadmap #1");
    const text = (await page.locator("#panel-body").textContent()) ?? "";
    expect(text).not.toMatch(/null|undefined/);
    expect(errors).toEqual([]);
  });

  it("QA Q2: a slow past run shows skeleton lines, then its report; a failed one says why with Retry", async () => {
    const { gui } = await open();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    let mode: "hold" | "fail" | "pass" = "hold";
    let release: () => void = () => undefined;
    await page.route("**/api/runs/**", async (route) => {
      if (mode === "hold") {
        await new Promise<void>((resolve) => (release = resolve));
        await route.continue();
      } else if (mode === "fail") await route.fulfill({ status: 500, body: JSON.stringify({ error: "Gone." }) });
      else await route.continue();
    });
    await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}#/roadmap/1/run/${PAST_RUN}`);
    await page.locator("#panel-body .skeleton-lines").waitFor();
    expect(await page.locator("#panel-body .skeleton-lines").getAttribute("aria-hidden")).toBe("true");
    mode = "pass";
    release();
    await expect.poll(() => page.locator("#panel-body").textContent()).toContain("Outcome: completed");
    expect(await page.locator("#panel-body .skeleton-lines").count()).toBe(0);
    mode = "fail";
    await page.reload();
    await expect.poll(() => page.locator("#panel-body [role=alert]").count()).toBe(1);
    mode = "pass";
    await page.locator("#panel-body button", { hasText: "Retry" }).click();
    await expect.poll(() => page.locator("#panel-body").textContent()).toContain("Outcome: completed");
  });

  it("QA Q2: a transcript shows skeleton entries until it arrives; search ignores them and nothing throws", async () => {
    const { gui } = await open();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let release: () => void = () => undefined;
    await page.route("**/api/sessions/**", async (route) => {
      await new Promise<void>((resolve) => (release = resolve));
      await route.continue();
    });
    await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}#/task/2/session/${SESSION}`);
    await page.locator("#transcript .skeleton-entry").first().waitFor({ state: "attached" });
    expect(await page.locator("#transcript .skeleton-entry").count()).toBe(3);
    await page.locator('#transcript input[type="search"]').fill("Charge");
    expect(await page.locator("#transcript mark").count()).toBe(0);
    release();
    await expect.poll(() => page.locator("#transcript .skeleton-entry").count(), { timeout: 10_000 }).toBe(0);
    await expect.poll(() => page.locator("#transcript .entries").textContent()).toContain("Charge the card");
    expect(errors).toEqual([]);
  });
});

describe("QA run 3: history entries and the job watcher", () => {
  const length = (page: Page) => page.evaluate(() => history.length);

  it("QA: open a task, Setup, Canvas, then back and forward, one entry each, ending on the first load", async () => {
    const { page, errors } = await open();
    const start = await length(page);
    await page.locator('[data-key="task-1"]').click();
    await page.locator('[data-view="setup"]').click();
    await page.locator('[data-view="canvas"]').click();
    expect(await hash(page)).toBe("#/task/1");
    expect(await length(page)).toBe(start + 3);
    await page.goBack();
    await expect.poll(() => hash(page)).toBe("#/setup");
    await expect.poll(() => visibleView(page)).toBe("setup");
    await page.goBack();
    await expect.poll(() => hash(page)).toBe("#/task/1");
    await expect.poll(() => visibleView(page)).toBe("canvas");
    await expect.poll(() => panelTitle(page)).toBe("Task #1");
    await page.goBack();
    await expect.poll(() => hash(page)).toBe("");
    await expect.poll(() => panelTitle(page)).toBe(null);
    await page.goForward();
    await expect.poll(() => panelTitle(page)).toBe("Task #1");
    // Going back and forward adds no entries.
    expect(await length(page)).toBe(start + 3);
    expect(errors).toEqual([]);
  });

  it("QA: a Needs you item, opened from Setup, adds one entry, and back returns to Setup", async () => {
    const { page, errors } = await open({ isWaiting: true });
    await page.locator('[data-view="setup"]').click();
    const before = await length(page);
    await page.locator("#needs-you").click();
    await page.locator("#needs-list .needs-item", { hasText: "Task #2" }).locator("button").click();
    await expect.poll(() => panelTitle(page)).toBe("Task #2");
    expect(await hash(page)).toBe("#/task/2");
    expect(await length(page)).toBe(before + 1);
    await page.goBack();
    await expect.poll(() => visibleView(page)).toBe("setup");
    expect(await hash(page)).toBe("#/setup");
    await page.goForward();
    await expect.poll(() => panelTitle(page)).toBe("Task #2");
    expect(errors).toEqual([]);
  });

  it("QA: Show output on a job's notice adds one entry, and back returns to the panel it was on", async () => {
    const { page, jobs, errors } = await open({ beforeLoad: (loaded) => loaded.clock.install() });
    await page.locator('[data-view="setup"]').click();
    await page.locator("#run-doctor").click();
    await expect.poll(() => hash(page)).toMatch(/^#\/jobs\/job-\d+$/);
    const jobUrl = await hash(page);
    await page.locator('[data-view="canvas"]').click();
    await page.locator('[data-key="task-3"]').click();
    expect(await hash(page)).toBe("#/task/3");
    const before = await length(page);
    jobs.end("doctor", 1);
    await page.clock.runFor(2_000);
    await page.locator("#notice button", { hasText: "Show output" }).click();
    await expect.poll(() => hash(page)).toBe(jobUrl);
    expect(await visibleView(page)).toBe("jobs");
    expect(await length(page)).toBe(before + 1);
    await page.goBack();
    await expect.poll(() => hash(page)).toBe("#/task/3");
    await expect.poll(() => panelTitle(page)).toBe("Task #3");
    expect(await visibleView(page)).toBe("canvas");
    expect(errors).toEqual([]);
  });

  it("QA: a project that isn't generated opens on Setup with no extra history entry", async () => {
    const generated = await open();
    const loaded = await length(generated.page);
    const { page, errors } = await open({ isGenerated: false });
    await expect.poll(() => visibleView(page)).toBe("setup");
    expect(await hash(page)).toBe("#/setup");
    expect(await length(page)).toBe(loaded);
    expect(errors).toEqual([]);
  });

  it("QA: a failed job poll stops watching and says so once", async () => {
    const { page, errors } = await open({ beforeLoad: (loaded) => loaded.clock.install() });
    await page.locator('[data-view="setup"]').click();
    await page.locator("#run-doctor").click();
    await page.locator("#view-jobs:not([hidden])").waitFor();
    let polls = 0;
    await page.route("**/api/jobs", (route) => {
      polls += 1;
      return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"The GUI broke."}' });
    });
    await page.clock.runFor(2_000);
    const stopped = page.locator("#notice .notice-item", { hasText: "Stopped following running jobs" });
    await expect.poll(() => stopped.count()).toBe(1);
    const after = polls;
    await page.clock.runFor(10_000);
    expect(await stopped.count()).toBe(1);
    expect(polls).toBe(after);
    expect(errors).toEqual([]);
  });
});
