/// <reference lib="dom" />
/** The GUI's polish: confirmations, job notices, URLs, times and loading (spec: gui, stage D6). */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import type { JobProcess } from "../../src/application/gui-jobs.js";
import { beginChange, linkSession, stateKey } from "../../src/core/workflow.js";
import { makeTempFolder } from "../support/helpers.js";
import { startTestGui, type TestGui } from "../support/gui.js";

const SESSION = "5e5e0000-0000-4000-8000-000000000001";

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

/** Roadmap 1 "Payments" with tasks 1 to 4 (task 4 "Card form"), and task 2's change with one session. */
async function project(home: string): Promise<string> {
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
  const change = linkSession(
    beginChange(
      { changeType: "feature", spec: "payments", taskId: 2 },
      { key: stateKey(2, "main"), approverMode: "user", now },
    ),
    { sessionId: SESSION, transcriptPath: transcript },
    now,
  );
  await openWorkflowStore(root).save(change);
  return root;
}

/** Jobs that end when the test says, with the exit code it gives, recording their arguments. */
function heldJobs() {
  const started: string[][] = [];
  const exits: { readonly command: string; readonly exit: (code: number) => void }[] = [];
  const startJob = (args: readonly string[]): JobProcess => {
    started.push([...args]);
    let exit: ((code: number) => void) | undefined;
    return {
      onOutput: () => undefined,
      onExit: (listener) => {
        exit = listener;
        exits.push({ command: args[0] ?? "", exit: listener });
      },
      signal: () => exit?.(130),
    };
  };
  /** Ends the oldest running job of `command`, such as `doctor`. */
  const end = (command: string, code: number) => {
    const index = exits.findIndex((item) => item.command === command);
    exits.splice(index, 1)[0]?.exit(code);
  };
  return { started, startJob, end };
}

async function open(
  options: { jobs?: ReturnType<typeof heldJobs>; beforeLoad?: (page: Page) => Promise<void> } = {},
): Promise<{ gui: TestGui; page: Page; root: string }> {
  const home = makeTempFolder();
  const root = await project(home);
  const jobs = options.jobs ?? heldJobs();
  const gui = await startTestGui(root, {}, { startJob: jobs.startJob, every: () => () => undefined }, { HOME: home });
  running.push(gui);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await options.beforeLoad?.(page);
  await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
  await page.locator('[data-key="task-1"]').waitFor();
  return { gui, page, root };
}

const hash = (page: Page) => page.evaluate(() => location.hash);

describe("GUI polish", () => {
  it("TC-GUI-084: removing a task names it and its effect, with Remove in danger style, Cancel focused, and Escape cancels", async () => {
    const jobs = heldJobs();
    const { page } = await open({ jobs });
    await page.locator('[data-key="task-4"]').click();
    await page.locator('#panel-body [data-focus="remove"]').click();
    const message = (await page.locator("#confirm-message").textContent()) ?? "";
    expect(message).toContain('#4 "Card form"');
    expect(message).toContain("This can't be undone.");
    expect(await page.locator("#confirm-ok").getAttribute("class")).toBe("danger");
    expect(await page.evaluate(() => (document.activeElement as HTMLButtonElement | null)?.value)).toBe("cancel");
    await page.keyboard.press("Escape");
    expect(await page.locator("#confirm").isVisible()).toBe(false);
    expect(jobs.started).toEqual([]);
  });

  it("FR-GUI-061: Tidy up isn't shown as dangerous, since it deletes nothing", async () => {
    const { page } = await open();
    await page.locator('[data-frame="roadmap-1"] [data-action="tidy"]').click();
    expect(await page.locator("#confirm-ok").getAttribute("class")).toBe("primary");
    await page.keyboard.press("Escape");
  });

  it("TC-GUI-085: a job's end shows a notice with a link to its output; success closes itself, failure stays", async () => {
    const jobs = heldJobs();
    const { page } = await open({ jobs, beforeLoad: (loaded) => loaded.clock.install() });
    const notice = page.locator("#notice");
    expect(await notice.getAttribute("aria-live")).toBe("polite");

    await page.locator('[data-view="setup"]').click();
    await page.locator("#run-doctor").click();
    await page.locator("#view-jobs:not([hidden])").waitFor();
    jobs.end("doctor", 0);
    await page.clock.runFor(2_000);
    await expect.poll(() => notice.textContent()).toContain("cclinic doctor --json");
    expect(await notice.locator("button", { hasText: "Show output" }).count()).toBe(1);
    await page.clock.runFor(6_500);
    await expect.poll(() => notice.textContent()).toBe("");

    await page.locator('[data-view="setup"]').click();
    await page.locator("#run-doctor").click();
    await page.locator("#view-jobs:not([hidden])").waitFor();
    await page.locator('[data-view="canvas"]').click();
    jobs.end("doctor", 1);
    await page.clock.runFor(2_000);
    await expect.poll(() => notice.getAttribute("class")).toContain("error");
    await page.clock.runFor(20_000);
    expect(await notice.textContent()).toContain("cclinic doctor --json");
    await notice.locator("button", { hasText: "Show output" }).click();
    expect(await page.locator("#view-jobs").isVisible()).toBe(true);
    await notice.locator(".notice-close").click();
    expect(await notice.textContent()).toBe("");
  });

  it("TC-GUI-086: a task, its session, a roadmap and a job each have a URL; back and reload return to them", async () => {
    const jobs = heldJobs();
    const { page } = await open({ jobs });
    await page.locator('[data-key="task-2"]').click();
    expect(await hash(page)).toBe("#/task/2");
    await page.locator(`button[data-session="${SESSION}"]`).click();
    expect(await hash(page)).toBe(`#/task/2/session/${SESSION}`);
    await page.locator('[data-frame="roadmap-1"] [data-action="open-roadmap"]').click();
    expect(await hash(page)).toBe("#/roadmap/1");

    await page.goBack();
    await expect.poll(() => page.locator("#panel-title").textContent()).toBe("Task #2");
    expect(await page.locator(`button[data-session="${SESSION}"]`).getAttribute("aria-pressed")).toBe("true");

    await page.reload();
    await expect.poll(() => page.locator("#panel-title").textContent()).toBe("Task #2");
    expect(await hash(page)).toBe(`#/task/2/session/${SESSION}`);

    await page.locator('[data-view="setup"]').click();
    await page.locator("#run-doctor").click();
    await expect.poll(() => hash(page)).toMatch(/^#\/jobs\/job-\d+$/);
    const jobUrl = await hash(page);
    await page.reload();
    await page.locator("#view-jobs:not([hidden])").waitFor();
    expect(await hash(page)).toBe(jobUrl);
    jobs.end("doctor", 0);
  });

  it("FR-GUI-063: a URL for a task that isn't there says so and shows the canvas", async () => {
    const { gui } = await open();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}#/task/99`);
    await expect.poll(() => page.locator("#notice").textContent()).toBe("Task #99 isn't in this project.");
    expect(await page.locator("#panel").isHidden()).toBe(true);
  });

  it("FR-GUI-063: a job link that isn't there, or isn't a job ID, says so and names the Jobs screen instead", async () => {
    const { gui } = await open();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    for (const job of ["job-999", "..%2F..%2Fapi%2Fcanvas"]) {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}#/jobs/${job}`);
      await expect.poll(() => page.locator("#notice").textContent()).toContain("isn't one of this GUI's jobs.");
      expect(await hash(page)).toBe("#/jobs");
    }
  });

  it("FR-GUI-063: the Canvas button keeps an open panel in the URL, and one step adds one history entry", async () => {
    const jobs = heldJobs();
    const { page } = await open({ jobs });
    await page.locator('[data-key="task-1"]').click();
    await page.locator('[data-view="setup"]').click();
    await page.locator('[data-view="canvas"]').click();
    expect(await hash(page)).toBe("#/task/1");
    const before = await page.evaluate(() => history.length);
    await page.locator('[data-view="setup"]').click();
    await page.locator("#run-doctor").click();
    await expect.poll(() => hash(page)).toMatch(/^#\/jobs\/job-\d+$/);
    // Setup, then the job's output: Run doctor shows the Jobs screen and the job in one step.
    expect(await page.evaluate(() => history.length)).toBe(before + 2);
    await page.goBack();
    await expect.poll(() => hash(page)).toBe("#/setup");
    jobs.end("doctor", 0);
  });

  it("TC-GUI-089: times read as how long ago, with the exact time on hover", async () => {
    const { page } = await open();
    const shown = await page.evaluate(`(async () => {
      const { ago, when } = await import("/assets/api.js");
      const threeMinutesAgo = new Date(Date.now() - 180_000).toISOString();
      const node = when(threeMinutesAgo);
      return {
        text: node.textContent,
        title: node.title === new Date(threeMinutesAgo).toLocaleString(),
        justNow: ago(new Date().toISOString()),
        hours: ago(new Date(Date.now() - 7_200_000).toISOString()),
      };
    })()`);
    expect(shown).toEqual({ text: "3 min ago", title: true, justNow: "just now", hours: "2 h ago" });
  });

  it("TC-GUI-090: a slow canvas shows a placeholder until it arrives; a failed one says why, with Retry that loads it", async () => {
    let mode: "slow" | "fail" | "pass" = "slow";
    const { gui } = await open();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    let release: () => void = () => undefined;
    await page.route("**/api/canvas", async (route) => {
      if (mode === "slow") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await route.continue();
      } else if (mode === "fail")
        await route.fulfill({ status: 500, body: JSON.stringify({ error: "Disk on fire." }) });
      else await route.continue();
    });
    await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
    await page.locator("#canvas-loading .skeleton-frame").first().waitFor();
    mode = "pass";
    release();
    await page.locator("#canvas-loading").waitFor({ state: "hidden" });

    mode = "fail";
    await page.reload();
    await expect
      .poll(() => page.locator("#canvas-loading .error").textContent())
      .toBe("Couldn't load the canvas: Disk on fire.");
    mode = "pass";
    await page.locator("#canvas-loading button", { hasText: "Retry" }).click();
    await page.locator("#canvas-loading").waitFor({ state: "hidden" });
    await page.locator('[data-key="task-1"]').waitFor();
  });
});
