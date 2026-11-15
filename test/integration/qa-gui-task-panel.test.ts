/// <reference lib="dom" />
/** QA: edge cases of the task panel's steps, live agents, following, search, filter and folding (spec: gui). */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import type { AgentSession, RunState } from "../../src/core/automation.js";
import { runSteps } from "../../src/core/task-steps.js";
import { beginChange, stateKey } from "../../src/core/workflow.js";
import { makeTempFolder } from "../support/helpers.js";
import { startTestGui, type TestGui } from "../support/gui.js";

const RUN_ID = "20261112-110000";
const id = (n: number) => `9b000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LONG_WORD = "Averyveryverylongwordwithoutanyspacesatall".repeat(6);

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
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const toolUse = (name: string, input: unknown) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, input }] },
});
const toolResult = (content: string) => ({ type: "user", message: { content: [{ type: "tool_result", content }] } });
const said = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

function project(): string {
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
        tasks: ["a", "b", "c"].map((key) => ({
          key,
          title: `Task ${key}`,
          description: "",
          spec: null,
          dependsOn: [],
        })),
      },
    ],
  });
  store.close();
  return root;
}

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly file: (sessionId: string) => string;
}

/** A run of roadmap 1 for task 2, live or ended, with the given sessions' steps and transcripts. */
function withRun(
  sessions: readonly { n: number; step: string; start: number; end: number | null; exitCode?: number | null }[],
  options: { isLive: boolean; transcripts?: Record<number, string>; taskStatus?: "running" | "blocked" | "done" },
): Fixture {
  const root = project();
  const home = makeTempFolder();
  const projects = path.join(home, ".claude/projects/w");
  mkdirSync(projects, { recursive: true });
  const file = (sessionId: string) => path.join(projects, `${sessionId}.jsonl`);
  for (const [n, text] of Object.entries(options.transcripts ?? {})) writeFileSync(file(id(Number(n))), text);
  const folder = path.join(root, ".luseen/auto", RUN_ID);
  mkdirSync(path.join(folder, "sessions"), { recursive: true });
  for (const item of sessions) {
    const session: AgentSession = {
      sessionId: id(item.n),
      taskId: 2,
      role: item.step.startsWith("qa") ? "qa" : "developer",
      step: item.step,
      cwd: "/w",
      transcriptPath: file(id(item.n)),
      startedAt: minutesAgo(item.start),
      endedAt: item.end === null ? null : minutesAgo(item.end),
      exitCode: item.exitCode === undefined ? (item.end === null ? null : 0) : item.exitCode,
      costUsd: item.end === null ? null : 0.5,
    };
    writeFileSync(path.join(folder, "sessions", `${session.sessionId}.json`), JSON.stringify(session));
  }
  const state: RunState = {
    runId: RUN_ID,
    roadmapId: 1,
    roadmapTitle: "Payments",
    runBranch: `luseen/auto/${RUN_ID}/run`,
    startedAt: minutesAgo(60),
    finishedAt: options.isLive ? null : minutesAgo(1),
    outcome: options.isLive ? null : "partial",
    model: "haiku",
    effort: "low",
    timeoutMinutes: 30,
    limitResetsAt: null,
    spentUsd: 3.4,
    developers: 1,
    tasks: [
      {
        taskId: 2,
        title: "Task b",
        dependsOn: [],
        status: options.taskStatus ?? (options.isLive ? "running" : "blocked"),
        branch: null,
        rounds: { specReviews: 1, qaRuns: 1, implementationReviews: 0 },
        costUsd: 1.5,
        reason: null,
        requirementIds: [],
      },
    ],
    skippedInProgress: [],
  };
  writeFileSync(path.join(folder, "run.json"), JSON.stringify(state));
  if (options.isLive)
    writeFileSync(path.join(root, ".luseen/auto/.lock"), JSON.stringify({ pid: process.pid, runId: RUN_ID }));
  return { root, home, file };
}

async function open(
  fixture: Fixture,
  options: { viewport?: { width: number; height: number }; polling?: boolean; colorScheme?: "dark" | "light" } = {},
): Promise<{ gui: TestGui; page: Page }> {
  const gui = await startTestGui(fixture.root, {}, options.polling === true ? {} : { every: () => () => undefined }, {
    HOME: fixture.home,
  });
  running.push(gui);
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 900 },
    colorScheme: options.colorScheme ?? "light",
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
  await page.locator('[data-key="task-1"]').waitFor();
  return { gui, page };
}

const LIVE_QA = [
  { n: 1, step: "spec-1", start: 40, end: 35 },
  { n: 2, step: "implement-1", start: 35, end: 20 },
  { n: 3, step: "qa-1", start: 20, end: null },
];

describe("QA: task steps", () => {
  it("FR-GUI-055: each step status badge has its text and an icon, not only a colour", async () => {
    const { page } = await open(withRun(LIVE_QA, { isLive: true, transcripts: { 3: line(said("hi")) } }));
    await page.locator('[data-key="task-2"]').click();
    await expect.poll(() => page.locator(".steps > li").count()).toBe(4);
    const badges = await page.locator(".steps .step-status").evaluateAll((nodes) =>
      nodes.map((node) => {
        const before = getComputedStyle(node, "::before");
        const drawn =
          before.content !== "none" &&
          before.display !== "none" &&
          (before.content !== '""' || parseFloat(before.borderTopWidth) > 0 || before.backgroundImage !== "none");
        return [node.textContent, drawn];
      }),
    );
    expect(badges.filter(([, drawn]) => !drawn)).toEqual([]);
  });

  it("a step row doesn't pick up the card's step marker on a line of its own", async () => {
    const { page } = await open(withRun(LIVE_QA, { isLive: true, transcripts: { 3: line(said("hi")) } }));
    await page.locator('[data-key="task-2"]').click();
    const first = page.locator(".steps > li").first();
    await first.waitFor();
    const before = await first.evaluate((node) => getComputedStyle(node, "::before").content);
    const [rowTop, headTop] = await first.evaluate((node) => [
      node.getBoundingClientRect().top + parseFloat(getComputedStyle(node).paddingTop),
      node.querySelector(".step-head")?.getBoundingClientRect().top ?? 0,
    ]);
    expect({ before, headStartsTheRow: Math.abs(headTop - rowTop) < 2 }).toEqual({
      before: expect.not.stringContaining("▸") as unknown,
      headStartsTheRow: true,
    });
  });

  it("a run that ended shows no run section or frame progress, and a session it left open failed", async () => {
    const { page } = await open(
      withRun(
        [
          { n: 1, step: "spec-1", start: 40, end: 35 },
          { n: 2, step: "qa-1", start: 30, end: null },
        ],
        { isLive: false },
      ),
    );
    expect(await page.locator('[data-frame="roadmap-1"] .run-progress').count()).toBe(0);
    await page.locator('[data-key="task-2"]').click();
    const rows = page.locator(".steps > li");
    await expect.poll(() => rows.count()).toBe(3);
    expect(await rows.locator(".step-status").allTextContents()).toEqual(["Passed", "Failed", "Not started"]);
    expect(await page.locator(".run-section").count()).toBe(0);
    expect(await rows.locator(".timer").count()).toBe(0);
  });

  it("a session with an unknown step name gets its own row, labelled with its raw name", () => {
    const view = runSteps(
      [
        {
          sessionId: "s1",
          taskId: 2,
          role: "developer",
          step: "resolve-conflict",
          cwd: "/w",
          transcriptPath: "/t",
          startedAt: minutesAgo(5),
          endedAt: minutesAgo(1),
          exitCode: 0,
          costUsd: 0.1,
        },
      ],
      { status: "running" },
      true,
    );
    expect(view.rows.map((row) => [row.step, row.round, row.status])).toEqual([
      ["resolve-conflict", null, "passed"],
      ["merge", null, "not-started"],
    ]);
  });

  it("a task with an open change worked by the user and an older run shows the change's steps", async () => {
    const fixture = withRun([{ n: 1, step: "spec-1", start: 40, end: 35 }], { isLive: false });
    const state = beginChange(
      { changeType: "feature", spec: "refunds", taskId: 2 },
      { key: stateKey(2, "main"), approverMode: "user", now: minutesAgo(10) },
    );
    await openWorkflowStore(fixture.root).save({ ...state, step: "implement" });
    const { page } = await open(fixture);
    await page.locator('[data-key="task-2"]').click();
    const rows = page.locator(".steps > li .step-name");
    await expect
      .poll(() => rows.allTextContents())
      .toEqual(["Spec", "Implement", "QA", "Code review", "Preview", "Approval", "Commit"]);
    expect(await page.locator("#panel-body").textContent()).not.toContain("$");
  });

  it("at 768 px a long tool input and step name don't make the panel or page scroll sideways", async () => {
    const transcript = line(toolUse(LONG_WORD, { command: LONG_WORD }));
    const { page } = await open(
      withRun([{ n: 1, step: `${LONG_WORD}-1`, start: 10, end: null }], {
        isLive: true,
        transcripts: { 1: transcript },
      }),
      { viewport: { width: 768, height: 900 } },
    );
    await page.locator('[data-key="task-2"]').click();
    await page.locator(".steps .step-tool").waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);
    expect(await page.locator("#panel").evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(0);
    const wider = await page.evaluate(() =>
      [...document.querySelectorAll("#panel *")]
        .filter((node) => node.scrollWidth - node.clientWidth > 0 && getComputedStyle(node).overflowX !== "visible")
        .map((node) => `${node.tagName}.${node.className}`),
    );
    expect(wider).toEqual([]);
  });

  it("FR-GUI-057: a live session whose transcript is missing has no tool call and no stall mark", async () => {
    const { page } = await open(withRun([{ n: 1, step: "qa-1", start: 30, end: null }], { isLive: true }));
    await page.locator('[data-key="task-2"]').click();
    const row = page.locator(".steps > li.step-running");
    await row.waitFor();
    expect(await row.locator(".step-tool, .step-stalled").count()).toBe(0);
    expect(await row.locator(".timer").count()).toBe(1);
  });
});

describe("QA: transcript search, filter, fold and follow", () => {
  const MARKUP = '<img src=x onerror="window.__xss=1"><b>bold</b> a.*(b) [c]';

  it("HTML and regex characters in entries and in the search term show as text", async () => {
    const transcript = [line(said(MARKUP)), line(toolUse("Bash", { command: MARKUP })), line(toolResult(MARKUP))];
    const { page } = await open(
      withRun([{ n: 1, step: "qa-1", start: 5, end: null }], { isLive: true, transcripts: { 1: transcript.join("") } }),
    );
    await page.locator('[data-key="task-2"]').click();
    const entries = page.locator("#transcript .entries > li");
    await expect.poll(() => entries.count()).toBe(3);
    const search = page.locator('#transcript input[type="search"]');
    for (const term of ["<b>", ".*(b)", "[c]", "onerror="]) {
      await search.fill(term);
      expect(await page.locator("#transcript .entries mark").allTextContents()).toEqual([term, term, term]);
    }
    expect(await page.locator("#transcript .entries img, #transcript .entries b").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await search.fill("");
    expect(await page.locator("#transcript .entries mark").count()).toBe(0);
    expect(await entries.first().locator("pre").textContent()).toBe(MARKUP);
  });

  it("FR-GUI-059: search finds a match inside the folded part of a long tool result", async () => {
    const result = Array.from({ length: 50 }, (_, index) => `row ${index + 1}`).join("\n");
    const transcript = [line(toolUse("Bash", { command: "npm test" })), line(toolResult(`${result}\nneedle here`))];
    const { page } = await open(
      withRun([{ n: 1, step: "qa-1", start: 5, end: null }], { isLive: true, transcripts: { 1: transcript.join("") } }),
    );
    await page.locator('[data-key="task-2"]').click();
    await expect.poll(() => page.locator("#transcript .entries > li:not(.skeleton-entry)").count()).toBe(2);
    await page.locator('#transcript input[type="search"]').fill("needle");
    expect(await page.locator("#transcript .match-count").textContent()).toBe("1 match");
  });

  it("an empty transcript says so, and its search and filter still work", async () => {
    const { page } = await open(
      withRun([{ n: 1, step: "qa-1", start: 5, end: null }], { isLive: true, transcripts: { 1: "" } }),
    );
    await page.locator('[data-key="task-2"]').click();
    await expect
      .poll(() => page.locator("#transcript .transcript-note").textContent())
      .toBe("The transcript is empty so far.");
    await page.locator('#transcript input[type="search"]').fill("x");
    await page.locator('#transcript input[type="search"]').press("Enter");
    await page.locator("#transcript select").selectOption("tool-result");
    expect(await page.locator("#transcript .match-count").textContent()).toBe("0 matches");
    expect(await page.locator("#transcript .jump-latest").isVisible()).toBe(false);
  });

  it("filter, fold and search together: a hidden kind's matches aren't counted, and a match in the fold shows it whole", async () => {
    const result = Array.from({ length: 30 }, (_, index) => `npm line ${index + 1}`).join("\n");
    const transcript = [
      line(said("npm is used")),
      line(toolUse("Bash", { command: "npm ci" })),
      line(toolResult(result)),
    ];
    const { page } = await open(
      withRun([{ n: 1, step: "qa-1", start: 5, end: null }], { isLive: true, transcripts: { 1: transcript.join("") } }),
    );
    await page.locator('[data-key="task-2"]').click();
    await expect.poll(() => page.locator("#transcript .entries > li:not(.skeleton-entry)").count()).toBe(3);
    const search = page.locator('#transcript input[type="search"]');
    await search.fill("npm");
    // DEF-3: the result's matches past line 20 are shown and counted, so it isn't folded while they are.
    expect(await page.locator("#transcript .match-count").textContent()).toBe("32 matches");
    expect(await page.locator("#transcript .fold").count()).toBe(0);
    await page.locator("#transcript select").selectOption("tool-result");
    expect(await page.locator("#transcript .match-count").textContent()).toBe("30 matches");
    expect(await page.locator("#transcript .entries > li:not([hidden]) mark").count()).toBe(30);
    await search.fill("");
    expect(await page.locator("#transcript .fold").textContent()).toBe("Show all 30 lines");
  });

  it("FR-GUI-059: a search matching only the shown part keeps the result folded, and an unfold survives a search", async () => {
    const result = Array.from({ length: 30 }, (_, index) =>
      index < 3 ? `head ${index + 1}` : `tail ${index + 1}`,
    ).join("\n");
    const { page } = await open(
      withRun([{ n: 1, step: "qa-1", start: 5, end: null }], {
        isLive: true,
        transcripts: { 1: line(toolResult(result)) },
      }),
    );
    await page.locator('[data-key="task-2"]').click();
    await expect.poll(() => page.locator("#transcript .entries > li:not(.skeleton-entry)").count()).toBe(1);
    const search = page.locator('#transcript input[type="search"]');
    await search.fill("head");
    expect(await page.locator("#transcript .match-count").textContent()).toBe("3 matches");
    expect(await page.locator("#transcript .fold").textContent()).toBe("Show all 30 lines");
    expect((await page.locator("#transcript .entries > li pre").textContent())?.split("\n")).toHaveLength(20);
    await search.fill("tail 30");
    expect(await page.locator("#transcript .match-count").textContent()).toBe("1 match");
    expect(await page.locator("#transcript .entries > li mark").allTextContents()).toEqual(["tail 30"]);
    await search.fill("");
    await page.locator("#transcript .fold").click();
    await search.fill("head");
    await search.fill("");
    expect(await page.locator("#transcript .fold").getAttribute("aria-expanded")).toBe("true");
    expect((await page.locator("#transcript .entries > li pre").textContent())?.split("\n")).toHaveLength(30);
  });

  it("the new controls are reachable by keyboard, and Enter on the fold button unfolds", async () => {
    const result = Array.from({ length: 30 }, (_, index) => `r${index}`).join("\n");
    const { page } = await open(
      withRun([{ n: 1, step: "qa-1", start: 5, end: null }], {
        isLive: true,
        transcripts: { 1: line(toolResult(result)) },
      }),
    );
    await page.locator('[data-key="task-2"]').click();
    const search = page.locator('#transcript input[type="search"]');
    await search.waitFor();
    await search.focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("SELECT");
    const fold = page.locator("#transcript .fold");
    await fold.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => fold.getAttribute("aria-expanded")).toBe("true");
    expect(await search.getAttribute("aria-label")).toBe("Search transcript");
  });

  it("FR-GUI-058: a transcript paused by scrolling up counts new entries and resumes on Jump to latest", async () => {
    const lines = Array.from({ length: 80 }, (_, index) => line(said(`entry ${index + 1}`))).join("");
    const fixture = withRun([{ n: 1, step: "qa-1", start: 5, end: null }], { isLive: true, transcripts: { 1: lines } });
    const { page } = await open(fixture, { polling: true });
    await page.locator('[data-key="task-2"]').click();
    const list = page.locator("#transcript .entries");
    await expect.poll(() => list.locator("> li").count()).toBe(80);
    const atBottom = () => list.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight < 8);
    await expect.poll(atBottom).toBe(true);
    await list.evaluate((node) => {
      node.scrollTop = 0;
    });
    const jump = page.locator("#transcript .jump-latest");
    await expect.poll(() => jump.isVisible()).toBe(true);
    appendFileSync(fixture.file(id(1)), [1, 2, 3].map((n) => line(said(`late ${n}`))).join(""));
    await expect.poll(() => jump.textContent(), { timeout: 5_000 }).toBe("Jump to latest (3 new)");
    expect(await list.evaluate((node) => node.scrollTop)).toBe(0);
    await jump.click();
    expect(await atBottom()).toBe(true);
    expect(await jump.isVisible()).toBe(false);
  });

  it("FR-GUI-058: after a transcript is replaced, the view shows the new one and follows it", async () => {
    const lines = Array.from({ length: 80 }, (_, index) => line(said(`entry ${index + 1}`))).join("");
    const fixture = withRun([{ n: 1, step: "qa-1", start: 5, end: null }], { isLive: true, transcripts: { 1: lines } });
    const { page } = await open(fixture, { polling: true });
    await page.locator('[data-key="task-2"]').click();
    const list = page.locator("#transcript .entries");
    await expect.poll(() => list.locator("> li").count()).toBe(80);
    await list.evaluate((node) => {
      node.scrollTop = 0;
    });
    const jump = page.locator("#transcript .jump-latest");
    await expect.poll(() => jump.isVisible()).toBe(true);
    writeFileSync(fixture.file(id(1)), Array.from({ length: 60 }, (_, n) => line(said(`new ${n + 1}`))).join(""));
    await expect.poll(() => list.locator("> li").last().textContent(), { timeout: 5_000 }).toContain("new 60");
    expect(await jump.isVisible()).toBe(false);
    await expect
      .poll(() => list.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight < 8))
      .toBe(true);
  });
});

describe("QA: dark theme", () => {
  it("step rows, the budget bar and marks use theme colours in dark mode", async () => {
    const { page } = await open(
      withRun(LIVE_QA, { isLive: true, transcripts: { 3: line(toolUse("Bash", { command: "npm test" })) } }),
      { colorScheme: "dark" },
    );
    await page.locator('[data-key="task-2"]').click();
    await page.locator(".steps > li").first().waitFor();
    await page.locator('#transcript input[type="search"]').fill("npm");
    const colours = await page.evaluate(() => {
      const of = (selector: string) => {
        const node = document.querySelector(selector);
        return node === null ? null : getComputedStyle(node).backgroundColor;
      };
      return { body: getComputedStyle(document.body).backgroundColor, step: of(".steps > li"), mark: of("mark") };
    });
    expect(colours.step).not.toBeNull();
    expect(colours.step).not.toBe("rgb(255, 255, 255)");
    expect(colours.mark).not.toBe("rgb(255, 255, 0)");
  });
});
