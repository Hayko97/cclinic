/// <reference lib="dom" />
/**
 * QA run 10 probes for DEF-23 and DEF-24: the user's waiting message is shown once, by the rule in FR-PLAN-038 (shown
 * from the session only when the conversation has no message of the user's written since the turn started), through
 * lead-ins, tool calls, Retry chains, a message never written, and the same text sent twice in a row (roadmap-planning
 * FR-PLAN-014, FR-PLAN-031, FR-PLAN-038, TC-PLAN-072, TC-PLAN-074). Tests named with "QA" assert what the spec says.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { input } from "@inquirer/prompts";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { runPlanCommand } from "../../src/cli/plan-command.js";
import {
  answerLastMessage,
  newPlanSession,
  PROPOSAL_NO_LONGER_FITS,
  PROPOSE_NOW_MESSAGE,
  type PlanSession,
} from "../../src/core/planning.js";
import { sendTo, startTestGui, type TestGui } from "../support/gui.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn(), input: vi.fn() }));
const inputMock = vi.mocked(input);

const WAIT = { timeout: 30_000, interval: 100 };
const SLOW = 120_000;
const SPAWN_WAIT = { timeout: 15_000, interval: 50 };

let browser: Browser;
const running: TestGui[] = [];
const isTty = process.stdin.isTTY;

beforeAll(async () => {
  browser = await chromium.launch();
}, 120_000);
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

function project(): string {
  const root = makeTempFolder();
  writeProject(root, { ".luseen/sdd/overview.md": "# Overview\n", ".luseen/sdd/README.md": "# Specs\n" });
  const store = openTaskStore(path.join(root, ".luseen"), "create");
  if (store === undefined) throw new Error("No store");
  store.savePlan({
    roadmap: { title: "Launch", goal: "Ship" },
    milestones: [
      { title: "One", goal: "", tasks: [{ key: "x", title: "X", description: "", spec: null, dependsOn: [] }] },
    ],
  });
  store.close();
  return root;
}

function every(ms: number, run: () => Promise<void>): () => void {
  const timer = setInterval(() => void run(), Math.min(ms, 200));
  return () => {
    clearInterval(timer);
  };
}

async function startGui(root: string, rules: FakeClaudeRule[] = [], env: NodeJS.ProcessEnv = {}) {
  const harness = agentHarness({ rules, env });
  const gui = await startTestGui(root, {}, { every }, harness.environment);
  running.push(gui);
  return { gui, harness };
}

async function openPanel(gui: TestGui): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
  await page.locator('[data-key="task-1"]').waitFor();
  await page.locator("#plan-open").click();
  return page;
}

async function choose(page: Page, id: string): Promise<void> {
  await page.locator("#plan-sessions-button").click();
  await page.locator(`#plan-sessions-menu [data-plan-id="${id}"] [role=menuitem]`).click();
}

const usersShown = (page: Page) => page.locator("#plan-panel .plan-user").allTextContents();
const retryButton = (page: Page) => page.locator("#plan-panel").getByRole("button", { name: "Retry" });
const shownCount = async (page: Page, text: string) =>
  (await usersShown(page)).filter((shown) => shown.trim() === text || shown.includes(text)).length;

async function send(page: Page, harness: ReturnType<typeof agentHarness>, text: string, calls: number) {
  await page.locator("#plan-text").fill(text);
  await page.locator("#plan-text").press("Enter");
  await expect.poll(() => harness.calls().length, WAIT).toBe(calls);
}

async function idle(page: Page) {
  await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(0);
}

async function stopAndWait(page: Page) {
  await expect.poll(() => page.locator("#plan-stop").isVisible(), WAIT).toBe(true);
  await page.locator("#plan-stop").click();
  await idle(page);
  await expect.poll(() => retryButton(page).isVisible(), WAIT).toBe(true);
}

const line = (type: string, content: unknown) =>
  `${JSON.stringify({ type, timestamp: new Date().toISOString(), message: { role: type, content } })}\n`;

async function transcriptOf(root: string): Promise<string> {
  const session = await openPlanStore(root).read("plan-1");
  const file = session?.transcriptPath ?? "";
  expect(existsSync(file)).toBe(true);
  return file;
}

/** The user lines in the transcript that hold `prompt`. */
async function promptsWritten(root: string, prompt: string): Promise<number> {
  return readFileSync(await transcriptOf(root), "utf8")
    .split("\n")
    .filter((entry) => entry.includes('"type":"user"') && entry.includes(JSON.stringify(prompt).slice(1, -1))).length;
}

/** The user lines in the transcript whose message is exactly `text`. */
async function messagesWritten(root: string, text: string): Promise<number> {
  return readFileSync(await transcriptOf(root), "utf8")
    .split("\n")
    .filter(Boolean)
    .filter((entry) => {
      const parsed = JSON.parse(entry) as { type: string; message: { content: unknown } };
      return parsed.type === "user" && parsed.message.content === text;
    }).length;
}

/** The PM writes a lead-in (and a tool call) once Claude has written `prompt` for the `times`th time. */
async function leadInAfter(root: string, prompt: string, times = 1, withToolCall = true): Promise<void> {
  await vi.waitFor(async () => {
    expect(await promptsWritten(root, prompt)).toBeGreaterThanOrEqual(times);
  }, SPAWN_WAIT);
  const file = await transcriptOf(root);
  appendFileSync(file, line("assistant", [{ type: "text", text: "Let me look at the specs first." }]));
  if (withToolCall)
    appendFileSync(file, line("assistant", [{ type: "tool_use", id: "r", name: "Read", input: { file_path: "a" } }]));
}

const count = (text: string, part: string) => text.split(part).length - 1;

async function planInTerminal(root: string, harness: ReturnType<typeof agentHarness>, resume?: string) {
  return runPlanCommand(
    {
      dir: root,
      timeoutMinutes: 30,
      model: "haiku",
      effort: "low",
      ...(resume === undefined ? { roadmap: 1 } : { resume }),
    },
    harness.context,
  ).catch((caught: unknown) => caught);
}

describe("QA run 10: the waiting message in the GUI", () => {
  it(
    'FR-PLAN-038 QA: a lead-in and a tool call, Stop, Retry, another lead-in and tool call, Stop, Retry: "Patients" shows once throughout',
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        { message: "Who uses it?" },
        { hang: true },
        { hang: true },
        { message: "Patients, noted." },
      ]);
      const page = await openPanel(gui);
      await send(page, harness, "A portal", 1);
      await idle(page);
      await send(page, harness, "Patients", 2);
      await leadInAfter(root, "Patients");
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      await page.waitForTimeout(1_000);
      expect(await shownCount(page, "Patients"), "while running after a lead-in").toBe(1);
      await stopAndWait(page);
      await page.waitForTimeout(1_000);
      expect(await shownCount(page, "Patients"), "after the first stop").toBe(1);

      await retryButton(page).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(3);
      await leadInAfter(root, answerLastMessage(null));
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(3);
      await page.waitForTimeout(1_000);
      expect(await shownCount(page, "Patients"), "while the Retry runs after a lead-in").toBe(1);
      await stopAndWait(page);
      await page.waitForTimeout(1_000);
      expect(await shownCount(page, "Patients"), "after the second stop").toBe(1);

      await retryButton(page).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(4);
      await idle(page);
      await page.waitForTimeout(1_000);
      expect(await shownCount(page, "Patients"), (await usersShown(page)).join(" | ")).toBe(1);
      // FR-PLAN-014: Claude Code wrote "Patients" before the first stop, so neither Retry repeats it.
      expect(
        harness
          .calls()
          .map((call) => call.prompt)
          .slice(2),
      ).toEqual([answerLastMessage(null), answerLastMessage(null)]);
    },
    SLOW,
  );

  it(
    'FR-PLAN-038 QA: "Patients" never written to the transcript, Stop, then a Retry Claude writes and is stopped: "Patients" shows once',
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        { message: "Who uses it?" },
        { hang: true, beforeTranscript: true },
        { hang: true },
        { message: "Patients, noted." },
      ]);
      const page = await openPanel(gui);
      await send(page, harness, "A portal", 1);
      await idle(page);
      await send(page, harness, "Patients", 2);
      await stopAndWait(page);
      await page.waitForTimeout(1_000);
      expect(await shownCount(page, "Patients"), "after a stop before Claude wrote it").toBe(1);

      await retryButton(page).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(3);
      await leadInAfter(root, answerLastMessage("Patients"));
      await page.waitForTimeout(1_500);
      expect(await shownCount(page, "Patients"), "while the Retry runs").toBe(1);
      await stopAndWait(page);
      await page.waitForTimeout(1_000);
      expect(await shownCount(page, "Patients"), (await usersShown(page)).join(" | ")).toBe(1);

      await retryButton(page).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(4);
      await idle(page);
      await page.waitForTimeout(1_000);
      expect(await shownCount(page, "Patients"), (await usersShown(page)).join(" | ")).toBe(1);
      // FR-PLAN-014: the first Retry repeats "Patients", which was never written; the second finds it in the first
      // Retry's request, so it doesn't repeat it again.
      expect(
        harness
          .calls()
          .map((call) => call.prompt)
          .slice(2),
      ).toEqual([answerLastMessage("Patients"), answerLastMessage(null)]);
    },
    SLOW,
  );

  for (const written of [false, true]) {
    it(
      `${written ? "FR-PLAN-038 QA" : "TC-PLAN-075 (GUI)"}: "Yes" answered, then "Yes" again stopped${written ? " after Claude wrote it" : " before Claude wrote it"}, then Retry stopped: both messages show, once each`,
      async () => {
        const root = project();
        const { gui, harness } = await startGui(root, [
          { message: "Is it for patients?" },
          { message: "Noted. Should staff use it too?" },
          { hang: true, beforeTranscript: !written },
          { hang: true },
          { message: "Staff too, noted." },
        ]);
        const page = await openPanel(gui);
        await send(page, harness, "A portal", 1);
        await idle(page);
        await send(page, harness, "Yes", 2);
        await idle(page);
        await send(page, harness, "Yes", 3);
        if (written) await expect.poll(() => messagesWritten(root, "Yes"), WAIT).toBe(2);
        await stopAndWait(page);
        await page.waitForTimeout(1_000);
        expect.soft(await shownCount(page, "Yes"), `after the stop: ${(await usersShown(page)).join(" | ")}`).toBe(2);

        await retryButton(page).click();
        await expect.poll(() => harness.calls().length, WAIT).toBe(4);
        // FR-PLAN-014: the first Retry repeats the second "Yes" only when Claude Code never wrote it.
        expect(harness.calls()[3]?.prompt).toBe(answerLastMessage(written ? null : "Yes"));
        await leadInAfter(root, harness.calls()[3]?.prompt ?? "");
        await page.waitForTimeout(1_500);
        expect
          .soft(await shownCount(page, "Yes"), `while the Retry runs: ${(await usersShown(page)).join(" | ")}`)
          .toBe(2);
        await stopAndWait(page);
        await page.waitForTimeout(1_000);
        expect
          .soft(await shownCount(page, "Yes"), `after the Retry stopped: ${(await usersShown(page)).join(" | ")}`)
          .toBe(2);

        await retryButton(page).click();
        await expect.poll(() => harness.calls().length, WAIT).toBe(5);
        // The second "Yes" is in the transcript now, as itself or in the first Retry's request.
        expect(harness.calls()[4]?.prompt).toBe(answerLastMessage(null));
        await idle(page);
        await page.waitForTimeout(1_000);
        expect
          .soft(await shownCount(page, "Yes"), `after the Retry answered: ${(await usersShown(page)).join(" | ")}`)
          .toBe(2);
        // A fresh page shows the same.
        const fresh = await openPanel(gui);
        await expect.poll(() => fresh.locator("#plan-panel .plan-pm").count(), WAIT).toBeGreaterThan(2);
        await fresh.waitForTimeout(1_000);
        expect.soft(await shownCount(fresh, "Yes"), `fresh page: ${(await usersShown(fresh)).join(" | ")}`).toBe(2);
        // And the same page reloaded.
        await page.reload();
        await page.locator('[data-key="task-1"]').waitFor();
        await page.locator("#plan-open").click();
        await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBeGreaterThan(2);
        await page.waitForTimeout(1_000);
        expect.soft(await shownCount(page, "Yes"), `reloaded: ${(await usersShown(page)).join(" | ")}`).toBe(2);
      },
      SLOW,
    );
  }
});

describe("QA run 10: the waiting message in the terminal", () => {
  for (const written of [false, true]) {
    it(
      `${written ? "FR-PLAN-031 QA" : "TC-PLAN-075 (terminal)"}: "Yes" answered, "Yes" again stopped${written ? " after Claude wrote it" : " before Claude wrote it"}, --resume stopped, --resume: the history shows "You › Yes" twice`,
      async () => {
        const root = project();
        const harness = agentHarness({
          rules: [
            { message: "Is it for patients?" },
            { message: "Noted. Should staff use it too?" },
            { hang: true, beforeTranscript: !written },
          ],
        });
        inputMock.mockResolvedValueOnce("A portal").mockResolvedValueOnce("Yes").mockResolvedValueOnce("Yes");
        const first = planInTerminal(root, harness);
        await vi.waitFor(async () => {
          expect(harness.calls()).toHaveLength(3);
          if (written) expect(await messagesWritten(root, "Yes")).toBe(2);
        }, SPAWN_WAIT);
        harness.controller.abort();
        await first;

        const again = agentHarness({ rules: [{ hang: true }], env: { HOME: harness.environment.HOME } });
        const resumed = planInTerminal(root, again, "plan-1");
        await vi.waitFor(() => {
          expect(again.calls()).toHaveLength(1);
        }, SPAWN_WAIT);
        // FR-PLAN-014: the second "Yes" is repeated only when Claude Code never wrote it.
        const resumeRequest = answerLastMessage(written ? null : "Yes");
        expect(again.calls()[0]?.prompt).toBe(resumeRequest);
        expect(count(again.output.err, "You › Yes"), again.output.err).toBe(2);
        await leadInAfter(root, resumeRequest);
        again.controller.abort();
        await resumed;

        const third = agentHarness({ rules: [{ hang: true }], env: { HOME: harness.environment.HOME } });
        const resumedAgain = planInTerminal(root, third, "plan-1");
        await vi.waitFor(() => {
          expect(third.calls()).toHaveLength(1);
        }, SPAWN_WAIT);
        third.controller.abort();
        await resumedAgain;
        // The first --resume's request is in the transcript, so the second "Yes" counts as written either way.
        expect(third.calls()[0]?.prompt).toBe(answerLastMessage(null));
        expect(count(third.output.err, "You › Yes"), third.output.err).toBe(2);
        expect(third.output.err).not.toContain("Your last turn was stopped");
      },
      SLOW,
    );
  }

  it(
    'TC-PLAN-074 QA (terminal): a lead-in and a tool call, --resume with another lead-in and tool call stopped, --resume: "You › Patients" once each time',
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [{ message: "Who uses it?" }, { hang: true }] });
      inputMock.mockResolvedValueOnce("A portal").mockResolvedValueOnce("Patients");
      const first = planInTerminal(root, harness);
      await vi.waitFor(() => {
        expect(harness.calls()).toHaveLength(2);
      }, SPAWN_WAIT);
      await leadInAfter(root, "Patients");
      harness.controller.abort();
      await first;

      for (let round = 0; round < 2; round += 1) {
        const again = agentHarness({ rules: [{ hang: true }], env: { HOME: harness.environment.HOME } });
        const resumed = planInTerminal(root, again, "plan-1");
        await vi.waitFor(() => {
          expect(again.calls()).toHaveLength(1);
        }, SPAWN_WAIT);
        await leadInAfter(root, answerLastMessage(null), round + 1);
        again.controller.abort();
        await resumed;
        // FR-PLAN-014: Claude Code wrote "Patients" before the first stop, so no --resume repeats it.
        expect(again.calls()[0]?.prompt).toBe(answerLastMessage(null));
        expect(count(again.output.err, "You › Patients"), `round ${round}: ${again.output.err}`).toBe(1);
      }
    },
    SLOW,
  );
});

describe("QA run 11: around the newest-message rule", () => {
  it(
    'FR-PLAN-038 QA: a turn stopped after a lead-in only (no tool call), then Retry stopped and Retry: "Patients" shows once throughout',
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        { message: "Who uses it?" },
        { hang: true },
        { hang: true },
        { message: "Patients, noted." },
      ]);
      const page = await openPanel(gui);
      await send(page, harness, "A portal", 1);
      await idle(page);
      await send(page, harness, "Patients", 2);
      await leadInAfter(root, "Patients", 1, false);
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      expect.soft(await shownCount(page, "Patients"), "while running after a lead-in only").toBe(1);
      await expect.poll(() => page.locator("#plan-stop").isVisible(), WAIT).toBe(true);
      await page.locator("#plan-stop").click();
      await idle(page);
      await page.waitForTimeout(1_000);
      const retryOffered = await retryButton(page).isVisible();
      process.stderr.write(`QA probe, Retry offered after a lead-in-only stop: ${retryOffered}\n`);
      expect
        .soft(await shownCount(page, "Patients"), `after the stop: ${(await usersShown(page)).join(" | ")}`)
        .toBe(1);
      if (!retryOffered) return;

      await retryButton(page).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(3);
      // FR-PLAN-014: "Patients" was written before the stop, so Retry doesn't repeat it.
      expect(harness.calls()[2]?.prompt).toBe(answerLastMessage(null));
      await vi.waitFor(async () => {
        expect(await promptsWritten(root, answerLastMessage(null))).toBe(1);
      }, SPAWN_WAIT);
      await page.waitForTimeout(1_500);
      expect
        .soft(await shownCount(page, "Patients"), `while the Retry runs: ${(await usersShown(page)).join(" | ")}`)
        .toBe(1);
      await stopAndWait(page);
      await page.waitForTimeout(1_000);
      expect
        .soft(await shownCount(page, "Patients"), `after the Retry stopped: ${(await usersShown(page)).join(" | ")}`)
        .toBe(1);
      await retryButton(page).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(4);
      await idle(page);
      await page.waitForTimeout(1_000);
      expect.soft(await shownCount(page, "Patients"), `answered: ${(await usersShown(page)).join(" | ")}`).toBe(1);
      await page.reload();
      await page.locator('[data-key="task-1"]').waitFor();
      await page.locator("#plan-open").click();
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBeGreaterThan(1);
      await page.waitForTimeout(1_000);
      expect.soft(await shownCount(page, "Patients"), `reloaded: ${(await usersShown(page)).join(" | ")}`).toBe(1);
    },
    SLOW,
  );

  it(
    'FR-PLAN-038 QA: "Yes" answered by a reply that ends with a tool call and its result, then "Yes" again stopped before Claude wrote it and Retried: both show, once each',
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        { message: "Is it for patients?" },
        { message: "Noted. Should staff use it too?" },
        { hang: true, beforeTranscript: true },
        { hang: true },
        { message: "Staff too, noted." },
      ]);
      const page = await openPanel(gui);
      await send(page, harness, "A portal", 1);
      await idle(page);
      await send(page, harness, "Yes", 2);
      await idle(page);
      // The answered turn ends with a tool call and its result after the PM's text.
      const file = await transcriptOf(root);
      appendFileSync(file, line("assistant", [{ type: "tool_use", id: "g", name: "Glob", input: { pattern: "*" } }]));
      appendFileSync(file, line("user", [{ type: "tool_result", tool_use_id: "g", content: "a.md" }]));
      await page.waitForTimeout(1_000);
      await send(page, harness, "Yes", 3);
      await stopAndWait(page);
      await page.waitForTimeout(1_000);
      expect.soft(await shownCount(page, "Yes"), `after the stop: ${(await usersShown(page)).join(" | ")}`).toBe(2);
      await retryButton(page).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(4);
      await vi.waitFor(async () => {
        expect(await promptsWritten(root, answerLastMessage("Yes"))).toBe(1);
      }, SPAWN_WAIT);
      await page.waitForTimeout(1_500);
      expect
        .soft(await shownCount(page, "Yes"), `while the Retry runs: ${(await usersShown(page)).join(" | ")}`)
        .toBe(2);
      await stopAndWait(page);
      await retryButton(page).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(5);
      await idle(page);
      await page.waitForTimeout(1_000);
      expect.soft(await shownCount(page, "Yes"), `answered: ${(await usersShown(page)).join(" | ")}`).toBe(2);
      await page.reload();
      await page.locator('[data-key="task-1"]').waitFor();
      await page.locator("#plan-open").click();
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBeGreaterThan(2);
      await page.waitForTimeout(1_000);
      expect.soft(await shownCount(page, "Yes"), `reloaded: ${(await usersShown(page)).join(" | ")}`).toBe(2);
    },
    SLOW,
  );
});

const says = (text: string) => line("assistant", [{ type: "text", text }]);

/** A session record with the given transcript, as an older luseen left it: waiting for "Patients", with no turn time. */
async function olderSession(root: string, home: string, lines: readonly string[]): Promise<PlanSession> {
  const claudeSessionId = randomUUID();
  const folder = path.join(home, ".claude", "projects", realpathSync(root).replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${claudeSessionId}.jsonl`);
  writeFileSync(file, lines.join(""));
  return openPlanStore(root).create((id) => ({
    ...newPlanSession({
      id,
      target: { kind: "new-roadmap" },
      summary: "A portal",
      holder: { place: "terminal", pid: process.pid },
      claudeSessionId,
      transcriptPath: file,
      now: new Date().toISOString(),
    }),
    holder: null,
    isAwaitingReply: true,
    unansweredMessage: "Patients",
    turnStartedAt: null,
  }));
}

describe("QA run 12: the redesigned Retry (FR-PLAN-014: repeat only what the transcript doesn't have)", () => {
  it(
    'FR-PLAN-014 QA: a Retry that repeated "Patients", stopped, then answered in Claude Code: no Retry, no turn, "Patients" once in the GUI and the terminal',
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        { message: "Who uses it?" },
        { hang: true, beforeTranscript: true },
        { hang: true },
      ]);
      const page = await openPanel(gui);
      await send(page, harness, "A portal", 1);
      await idle(page);
      await send(page, harness, "Patients", 2);
      await stopAndWait(page);
      await retryButton(page).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(3);
      expect(harness.calls()[2]?.prompt).toBe(answerLastMessage("Patients"));
      await vi.waitFor(async () => {
        expect(await promptsWritten(root, answerLastMessage("Patients"))).toBe(1);
      }, SPAWN_WAIT);
      await stopAndWait(page);
      expect(await shownCount(page, "Patients")).toBe(1);
      await page.context().close();
      await Promise.all(running.splice(0).map((item) => item.stop()));
      // Claude Code answers the repeated message.
      appendFileSync(await transcriptOf(root), says("Patients, noted. Anyone else?"));

      const next = await startGui(root, [{ message: "Should not be called" }], { HOME: harness.environment.HOME });
      const viewer = await openPanel(next.gui);
      await choose(viewer, "plan-1");
      await expect.poll(() => viewer.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      await viewer.waitForTimeout(1_500);
      expect(await shownCount(viewer, "Patients"), (await usersShown(viewer)).join(" | ")).toBe(1);
      expect(await retryButton(viewer).count()).toBe(0);
      expect(await viewer.locator("#plan-panel .plan-working").count()).toBe(0);
      expect(next.harness.calls()).toEqual([]);
      await viewer.context().close();
      await Promise.all(running.splice(0).map((item) => item.stop()));

      const terminal = agentHarness({
        rules: [{ message: "Should not be called" }],
        env: { HOME: harness.environment.HOME },
      });
      inputMock.mockRejectedValueOnce(new Error("stop here"));
      await planInTerminal(root, terminal, "plan-1");
      expect(terminal.calls()).toEqual([]);
      const history = terminal.output.err;
      expect(count(history, "You › Patients"), history).toBe(1);
      expect(history).toContain("PM › Patients, noted. Anyone else?");
      expect(history).not.toContain("Your last turn was stopped");
      expect((await openPlanStore(root).read("plan-1"))?.isAwaitingReply).toBe(false);
    },
    SLOW,
  );

  it(
    'FR-PLAN-031 QA: the terminal history shows a Retry request\'s repeated message as "You › Patients", once, and no note',
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [{ message: "Who uses it?" }, { hang: true, beforeTranscript: true }] });
      inputMock.mockResolvedValueOnce("A portal").mockResolvedValueOnce("Patients");
      const first = planInTerminal(root, harness);
      await vi.waitFor(() => {
        expect(harness.calls()).toHaveLength(2);
      }, SPAWN_WAIT);
      harness.controller.abort();
      await first;
      const again = agentHarness({ rules: [{ hang: true }], env: { HOME: harness.environment.HOME } });
      const resumed = planInTerminal(root, again, "plan-1");
      await vi.waitFor(async () => {
        expect(again.calls()).toHaveLength(1);
        expect(await promptsWritten(root, answerLastMessage("Patients"))).toBe(1);
      }, SPAWN_WAIT);
      expect(count(again.output.err, "You › Patients")).toBe(1);
      again.controller.abort();
      await resumed;
      const third = agentHarness({ rules: [{ hang: true }], env: { HOME: harness.environment.HOME } });
      const resumedAgain = planInTerminal(root, third, "plan-1");
      await vi.waitFor(() => {
        expect(third.calls()).toHaveLength(1);
      }, SPAWN_WAIT);
      third.controller.abort();
      await resumedAgain;
      expect(third.calls()[0]?.prompt).toBe(answerLastMessage(null));
      const history = third.output.err;
      expect(count(history, "You › Patients"), history).toBe(1);
      expect(count(history, "You › "), history).toBe(2);
      expect(history).not.toContain("Your last turn was stopped");
      expect(history).not.toContain("Asked the PM");
    },
    SLOW,
  );

  const older = [
    {
      name: "stopped after a lead-in and a tool call",
      tail: () => [
        line("user", "Patients"),
        says("Let me look."),
        line("assistant", [{ type: "tool_use", id: "r", name: "Read", input: { file_path: "a" } }]),
      ],
      repeated: null,
    },
    { name: "stopped right after Claude wrote it", tail: () => [line("user", "Patients")], repeated: null },
    { name: "never written", tail: () => [], repeated: "Patients" },
    {
      name: "never written, after a Retry request that repeated it was written and stopped",
      tail: () => [line("user", answerLastMessage("Patients"))],
      repeated: null,
    },
  ] as const;
  for (const variant of older) {
    it(
      `${variant.repeated === null ? "TC-PLAN-076" : "FR-PLAN-014 QA"}: an older record with no turnStartedAt, "Patients" ${variant.name}: --resume and the GUI show it once`,
      async () => {
        const root = project();
        const home = makeTempFolder();
        await olderSession(root, home, [line("user", "A portal"), says("Who uses it?"), ...variant.tail()]);
        // Choosing a waiting session the GUI can hold asks the PM again (FR-PLAN-030); it's stopped once written.
        const guiView = async (label: string) => {
          const { gui, harness } = await startGui(root, [{ hang: true }], { HOME: home });
          const page = await openPanel(gui);
          const notes = await promptsWritten(root, "Your last turn was stopped");
          await choose(page, "plan-1");
          await expect.poll(() => harness.calls().length, WAIT).toBe(1);
          await vi.waitFor(async () => {
            expect(await promptsWritten(root, "Your last turn was stopped")).toBe(notes + 1);
          }, SPAWN_WAIT);
          await page.waitForTimeout(1_500);
          expect
            .soft(await shownCount(page, "Patients"), `${label}, running: ${(await usersShown(page)).join(" | ")}`)
            .toBe(1);
          await stopAndWait(page);
          await page.waitForTimeout(1_000);
          expect
            .soft(await shownCount(page, "Patients"), `${label}, stopped: ${(await usersShown(page)).join(" | ")}`)
            .toBe(1);
          await page.context().close();
          await Promise.all(running.splice(0).map((item) => item.stop()));
          return harness.calls()[0]?.prompt;
        };
        const resume = async () => {
          const terminal = agentHarness({ rules: [{ hang: true }], env: { HOME: home } });
          const resumed = planInTerminal(root, terminal, "plan-1");
          await vi.waitFor(() => {
            expect(terminal.calls()).toHaveLength(1);
          }, SPAWN_WAIT);
          // The resumed turn is written, as Claude Code does, before it's stopped.
          await vi.waitFor(async () => {
            expect(await promptsWritten(root, "Your last turn was stopped")).toBeGreaterThan(0);
          }, SPAWN_WAIT);
          terminal.controller.abort();
          await resumed;
          return { prompt: terminal.calls()[0]?.prompt, history: terminal.output.err };
        };
        expect(await guiView("GUI first")).toBe(answerLastMessage(variant.repeated));
        const first = await resume();
        expect.soft(first.prompt, "--resume after the GUI's Retry").toBe(answerLastMessage(null));
        expect.soft(count(first.history, "You › Patients"), first.history).toBe(1);
        expect.soft(await guiView("GUI after a --resume"), "GUI Retry after a --resume").toBe(answerLastMessage(null));
        const second = await resume();
        expect.soft(second.prompt, "second --resume").toBe(answerLastMessage(null));
        expect.soft(count(second.history, "You › Patients"), `second --resume history: ${second.history}`).toBe(1);
      },
      SLOW,
    );
  }

  it(
    'FR-PLAN-014 QA (observation): an older record with no turnStartedAt, "Patients" written and stopped after a lead-in only',
    async () => {
      const root = project();
      const home = makeTempFolder();
      await olderSession(root, home, [
        line("user", "A portal"),
        says("Who uses it?"),
        line("user", "Patients"),
        says("Let me look."),
      ]);
      const terminal = agentHarness({ rules: [{ hang: true }], env: { HOME: home } });
      const resumed = planInTerminal(root, terminal, "plan-1");
      await vi.waitFor(() => {
        expect(terminal.calls()).toHaveLength(1);
      }, SPAWN_WAIT);
      terminal.controller.abort();
      await resumed;
      process.stderr.write(
        `QA probe, older lead-in only: prompt=${JSON.stringify(terminal.calls()[0]?.prompt)} shown=${count(terminal.output.err, "You › Patients")}\n`,
      );
    },
    SLOW,
  );
});

describe("QA run 13: around the DEF-28 fix (a note keeps a waiting turn's start, even an unknown one)", () => {
  /** An older waiting record for "Patients", already written; the GUI retries it on choosing, and it's stopped. */
  async function legacyRetriedInGui(rules: FakeClaudeRule[]) {
    const root = project();
    const home = makeTempFolder();
    await olderSession(root, home, [line("user", "A portal"), says("Who uses it?"), line("user", "Patients")]);
    const { gui, harness } = await startGui(root, [{ hang: true }, ...rules], { HOME: home });
    const page = await openPanel(gui);
    await choose(page, "plan-1");
    await expect.poll(() => harness.calls().length, WAIT).toBe(1);
    expect(harness.calls()[0]?.prompt).toBe(answerLastMessage(null));
    await vi.waitFor(async () => {
      expect(await promptsWritten(root, "Your last turn was stopped")).toBe(1);
    }, SPAWN_WAIT);
    await stopAndWait(page);
    return { root, home, gui, harness, page };
  }

  async function resumeOnce(root: string, home: string) {
    const terminal = agentHarness({ rules: [{ hang: true }], env: { HOME: home } });
    const resumed = planInTerminal(root, terminal, "plan-1");
    await vi.waitFor(() => {
      expect(terminal.calls()).toHaveLength(1);
    }, SPAWN_WAIT);
    terminal.controller.abort();
    await resumed;
    return { prompt: terminal.calls()[0]?.prompt, history: terminal.output.err };
  }

  it(
    'FR-PLAN-014 QA: Propose now while an older record\'s "Patients" waits keeps the waiting message and its unknown start; "Patients" shows once and isn\'t repeated',
    async () => {
      const { root, home, harness, page } = await legacyRetriedInGui([{ hang: true }]);
      await expect.poll(() => page.locator("#plan-propose").isVisible(), WAIT).toBe(true);
      await page.locator("#plan-propose").click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(2);
      expect(harness.calls()[1]?.prompt).toBe(PROPOSE_NOW_MESSAGE);
      const record = await openPlanStore(root).read("plan-1");
      expect(record?.unansweredMessage).toBe("Patients");
      expect(record?.turnStartedAt).toBeNull();
      await vi.waitFor(async () => {
        expect(await promptsWritten(root, PROPOSE_NOW_MESSAGE)).toBe(1);
      }, SPAWN_WAIT);
      await page.waitForTimeout(1_500);
      expect(await shownCount(page, "Patients"), `running: ${(await usersShown(page)).join(" | ")}`).toBe(1);
      await stopAndWait(page);
      await page.waitForTimeout(1_000);
      expect(await shownCount(page, "Patients"), `stopped: ${(await usersShown(page)).join(" | ")}`).toBe(1);
      await page.context().close();
      await Promise.all(running.splice(0).map((item) => item.stop()));
      const resumed = await resumeOnce(root, home);
      expect(resumed.prompt).toBe(answerLastMessage(null));
      expect(count(resumed.history, "You › Patients"), resumed.history).toBe(1);
    },
    SLOW,
  );

  it(
    "FR-PLAN-014 QA: Propose now with no waiting message starts a new turn with a time, and Retry after its stop doesn't repeat anything",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ message: "Who uses it?" }, { hang: true }, { hang: true }]);
      const page = await openPanel(gui);
      await send(page, harness, "A portal", 1);
      await idle(page);
      await expect.poll(() => page.locator("#plan-propose").isVisible(), WAIT).toBe(true);
      await page.locator("#plan-propose").click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(2);
      const record = await openPlanStore(root).read("plan-1");
      expect(record?.unansweredMessage).toBeNull();
      expect(record?.turnStartedAt).not.toBeNull();
      await stopAndWait(page);
      expect(await shownCount(page, "A portal")).toBe(1);
      await retryButton(page).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(3);
      expect(harness.calls()[2]?.prompt).toBe(answerLastMessage(null));
      expect((await usersShown(page)).length, (await usersShown(page)).join(" | ")).toBe(1);
    },
    SLOW,
  );

  it(
    "FR-PLAN-014 QA: a new message after an older record's Retry starts a timed turn; both messages show once and resume doesn't repeat",
    async () => {
      const { root, home, harness, page } = await legacyRetriedInGui([{ hang: true }]);
      await send(page, harness, "Staff too", 2);
      await vi.waitFor(async () => {
        expect(await messagesWritten(root, "Staff too")).toBe(1);
      }, SPAWN_WAIT);
      const record = await openPlanStore(root).read("plan-1");
      expect(record?.unansweredMessage).toBe("Staff too");
      expect(record?.turnStartedAt).not.toBeNull();
      await stopAndWait(page);
      await page.waitForTimeout(1_000);
      expect(await shownCount(page, "Patients"), (await usersShown(page)).join(" | ")).toBe(1);
      expect(await shownCount(page, "Staff too"), (await usersShown(page)).join(" | ")).toBe(1);
      await page.context().close();
      await Promise.all(running.splice(0).map((item) => item.stop()));
      const resumed = await resumeOnce(root, home);
      expect(resumed.prompt).toBe(answerLastMessage(null));
      expect(count(resumed.history, "You › Patients"), resumed.history).toBe(1);
      expect(count(resumed.history, "You › Staff too"), resumed.history).toBe(1);
    },
    SLOW,
  );
});

describe("QA run 14: the GUI Retry path after the code review", () => {
  const proposal = {
    roadmap: { title: "Portal", goal: "Patients book visits" },
    milestones: [
      {
        title: "Booking",
        goal: "Book a visit",
        tasks: [{ key: "a", title: "Book", description: "Book a visit", spec: null, dependsOn: [] }],
      },
    ],
    openQuestions: [],
  };
  const proposing: FakeClaudeRule = {
    message: "Here's a plan.",
    tools: [{ name: "plan_propose", input: { proposal } }],
  };

  async function proposedThenStopped(rules: FakeClaudeRule[]) {
    const root = project();
    const { gui, harness } = await startGui(root, [proposing, { hang: true }, ...rules]);
    const page = await openPanel(gui);
    await send(page, harness, "A portal", 1);
    await idle(page);
    await expect.poll(() => page.locator("#plan-panel .plan-card").count(), WAIT).toBe(1);
    await send(page, harness, "Add wallets", 2);
    await expect.poll(() => messagesWritten(root, "Add wallets"), WAIT).toBe(1);
    await stopAndWait(page);
    return { root, gui, harness, page };
  }

  it(
    "FR-PLAN-014 QA: Retry with a fitting proposal waiting asks the PM to answer, without repeating the written message, and keeps the card",
    async () => {
      const { harness, page } = await proposedThenStopped([{ hang: true }]);
      expect(await page.locator("#plan-panel .plan-card").count()).toBe(1);
      await retryButton(page).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(3);
      expect(harness.calls()[2]?.prompt).toBe(answerLastMessage(null));
      await page.waitForTimeout(1_000);
      expect(await shownCount(page, "Add wallets"), (await usersShown(page)).join(" | ")).toBe(1);
      expect(await page.locator("#plan-panel .plan-card").count()).toBe(1);
    },
    SLOW,
  );

  it(
    "TC-PLAN-078 (GUI): with a fitting proposal waiting, a stopped turn answered in Claude Code isn't asked again by a Retry request",
    async () => {
      const { root, gui, harness, page } = await proposedThenStopped([{ message: "Should not be called" }]);
      appendFileSync(await transcriptOf(root), says("Wallets added to the plan."));
      await page.waitForTimeout(1_500);
      const retryShown = await retryButton(page).isVisible();
      process.stderr.write(`QA probe, Retry shown after the answer elsewhere with a proposal waiting: ${retryShown}\n`);
      const reply = await sendTo(gui, "POST", "/api/plan/retry");
      await page.waitForTimeout(2_000);
      expect(reply.status).toBe(200);
      expect(
        harness
          .calls()
          .slice(2)
          .map((call) => call.prompt),
      ).toEqual([]);
      expect(await shownCount(page, "Add wallets")).toBe(1);
      const record = await openPlanStore(root).read("plan-1");
      expect(record?.isAwaitingReply).toBe(false);
      expect(record?.proposal).not.toBeNull();
      expect(await page.locator("#plan-panel .plan-card").count()).toBe(1);
    },
    SLOW,
  );

  it(
    'FR-PLAN-014 QA: a turn answered in Claude Code with no timestamps is asked again once, without repeating "Patients", which shows once',
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ message: "Who uses it?" }, { hang: true }]);
      const page = await openPanel(gui);
      await send(page, harness, "A portal", 1);
      await idle(page);
      await send(page, harness, "Patients", 2);
      await expect.poll(() => messagesWritten(root, "Patients"), WAIT).toBe(1);
      await stopAndWait(page);
      await page.context().close();
      await Promise.all(running.splice(0).map((item) => item.stop()));
      const untimed = (type: string, content: unknown) =>
        `${JSON.stringify({ type, message: { role: type, content } })}\n`;
      const file = await transcriptOf(root);
      appendFileSync(file, untimed("assistant", [{ type: "text", text: "Patients, noted. Anyone else?" }]));
      appendFileSync(file, untimed("user", "Staff too"));
      appendFileSync(file, untimed("assistant", [{ type: "text", text: "Staff, noted." }]));

      const next = await startGui(root, [{ hang: true }], { HOME: harness.environment.HOME });
      const viewer = await openPanel(next.gui);
      await choose(viewer, "plan-1");
      await viewer.waitForTimeout(1_500);
      if (next.harness.calls().length === 0 && (await retryButton(viewer).isVisible()))
        await retryButton(viewer).click();
      await expect.poll(() => next.harness.calls().length, WAIT).toBe(1);
      expect(next.harness.calls()[0]?.prompt).toBe(answerLastMessage(null));
      await viewer.waitForTimeout(1_500);
      expect(next.harness.calls()).toHaveLength(1);
      const users = (await usersShown(viewer)).join(" | ");
      expect(await shownCount(viewer, "Patients"), users).toBe(1);
      expect(await shownCount(viewer, "Staff too"), users).toBe(1);
    },
    SLOW,
  );

  it(
    "TC-PLAN-077: two Retry requests sent at once start one PM turn, and the second is refused",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        { message: "Who uses it?" },
        { hang: true },
        { hang: true },
        { hang: true },
      ]);
      const page = await openPanel(gui);
      await send(page, harness, "A portal", 1);
      await idle(page);
      await send(page, harness, "Patients", 2);
      await expect.poll(() => messagesWritten(root, "Patients"), WAIT).toBe(1);
      await stopAndWait(page);
      const replies = await Promise.all([
        sendTo(gui, "POST", "/api/plan/retry"),
        sendTo(gui, "POST", "/api/plan/retry"),
      ]);
      await page.waitForTimeout(2_500);
      process.stderr.write(
        `QA probe, two Retry requests: statuses ${replies.map((reply) => reply.status).join(",")}\n`,
      );
      expect.soft(harness.calls().length, "PM turns started by two Retry requests").toBe(3);
      expect.soft(replies.filter((reply) => reply.status === 200)).toHaveLength(1);
      expect.soft(replies.map((reply) => reply.body).join(" ")).toContain("The PM is still working");
      // The turn that runs can be stopped, and nothing keeps running after it.
      await page.locator("#plan-stop").click();
      await idle(page);
      await page.waitForTimeout(1_000);
      expect(await page.locator("#plan-panel .plan-working").count()).toBe(0);
    },
    SLOW,
  );

  it(
    "TC-PLAN-077: double-clicking Retry starts one PM turn",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        { message: "Who uses it?" },
        { hang: true },
        { hang: true },
        { hang: true },
      ]);
      const page = await openPanel(gui);
      await send(page, harness, "A portal", 1);
      await idle(page);
      await send(page, harness, "Patients", 2);
      await expect.poll(() => messagesWritten(root, "Patients"), WAIT).toBe(1);
      await stopAndWait(page);
      await retryButton(page).dblclick();
      await page.waitForTimeout(2_500);
      expect(harness.calls().length).toBe(3);
    },
    SLOW,
  );
});

describe("QA run 14: other GUI requests that start a turn, sent twice at once", () => {
  for (const kind of ["propose", "message"] as const) {
    it(
      `TC-PLAN-077: two ${kind === "propose" ? "Propose now" : "message"} requests sent at once start one PM turn, and the second is refused`,
      async () => {
        const root = project();
        const { gui, harness } = await startGui(root, [{ message: "Who uses it?" }, { hang: true }, { hang: true }]);
        const page = await openPanel(gui);
        await send(page, harness, "A portal", 1);
        await idle(page);
        const request = () =>
          kind === "propose"
            ? sendTo(gui, "POST", "/api/plan/propose")
            : sendTo(gui, "POST", "/api/plan/message", { text: "Patients", uploads: [] });
        const replies = await Promise.all([request(), request()]);
        await page.waitForTimeout(2_500);
        process.stderr.write(
          `QA probe, two ${kind} requests: ${replies.map((reply) => `${reply.status} ${reply.body.slice(0, 80)}`).join(" / ")}\n`,
        );
        expect(harness.calls().length).toBe(2);
        expect(replies.filter((reply) => reply.status === 200)).toHaveLength(1);
        expect(replies.map((reply) => reply.body).join(" ")).toContain("The PM is still working");
      },
      SLOW,
    );
  }
});

describe("QA run 15: around the DEF-33 and DEF-34 fixes", () => {
  const proposal = {
    roadmap: { title: "Portal", goal: "Patients book visits" },
    milestones: [
      {
        title: "Booking",
        goal: "Book a visit",
        tasks: [{ key: "a", title: "Book", description: "Book a visit", spec: null, dependsOn: [] }],
      },
    ],
    openQuestions: [],
  };
  const proposing: FakeClaudeRule = {
    message: "Here's a plan.",
    tools: [{ name: "plan_propose", input: { proposal } }],
  };

  /** In the terminal: a proposal, then "Add wallets" written and stopped. */
  async function proposedInTerminal(root: string) {
    const harness = agentHarness({ rules: [proposing, { hang: true }] });
    inputMock.mockResolvedValueOnce("A portal").mockResolvedValueOnce("Add wallets");
    const first = planInTerminal(root, harness);
    await vi.waitFor(async () => {
      expect(harness.calls()).toHaveLength(2);
      expect(await messagesWritten(root, "Add wallets")).toBe(1);
    }, SPAWN_WAIT);
    harness.controller.abort();
    await first;
    expect((await openPlanStore(root).read("plan-1"))?.proposal).not.toBeNull();
    return harness;
  }

  it(
    "TC-PLAN-078 (terminal): --resume with a fitting proposal and a stopped turn answered in Claude Code starts no turn, stops waiting and keeps the proposal",
    async () => {
      const root = project();
      const harness = await proposedInTerminal(root);
      appendFileSync(await transcriptOf(root), says("Wallets added to the plan."));
      const again = agentHarness({
        rules: [{ message: "Should not be called" }],
        env: { HOME: harness.environment.HOME },
      });
      inputMock.mockRejectedValueOnce(new Error("stop here"));
      await planInTerminal(root, again, "plan-1");
      expect(again.calls()).toEqual([]);
      const record = await openPlanStore(root).read("plan-1");
      expect(record?.isAwaitingReply).toBe(false);
      expect(record?.proposal).not.toBeNull();
      expect(again.output.err).toContain("/approve");
    },
    SLOW,
  );

  it(
    "FR-PLAN-014 QA: --resume with a fitting proposal and an unanswered stopped turn asks the PM to answer, without repeating, and keeps the proposal",
    async () => {
      const root = project();
      const harness = await proposedInTerminal(root);
      const again = agentHarness({ rules: [{ hang: true }], env: { HOME: harness.environment.HOME } });
      const resumed = planInTerminal(root, again, "plan-1");
      await vi.waitFor(() => {
        expect(again.calls()).toHaveLength(1);
      }, SPAWN_WAIT);
      again.controller.abort();
      await resumed;
      expect(again.calls()[0]?.prompt).toBe(answerLastMessage(null));
      expect(count(again.output.err, "You › Add wallets"), again.output.err).toBe(1);
      expect((await openPlanStore(root).read("plan-1"))?.proposal).not.toBeNull();
    },
    SLOW,
  );

  it(
    "FR-PLAN-034 QA: a message sent while another session is still opening never goes to the session being left",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ message: "Who uses it?" }, { hang: true }, { hang: true }]);
      const page = await openPanel(gui);
      await send(page, harness, "A portal", 1);
      await idle(page);
      const home = harness.environment.HOME ?? "";
      const claudeSessionId = randomUUID();
      const folder = path.join(home, ".claude", "projects", realpathSync(root).replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(folder, { recursive: true });
      const file = path.join(folder, `${claudeSessionId}.jsonl`);
      writeFileSync(file, [line("user", "Something else"), says("Tell me more.")].join(""));
      const other = await openPlanStore(root).create((id) => ({
        ...newPlanSession({
          id,
          target: { kind: "new-roadmap" },
          summary: "Another",
          holder: { place: "terminal", pid: process.pid },
          claudeSessionId,
          transcriptPath: file,
          now: new Date().toISOString(),
        }),
        holder: null,
      }));
      const [opened, sent] = await Promise.all([
        sendTo(gui, "POST", "/api/plan/open", { planId: other.id }),
        sendTo(gui, "POST", "/api/plan/message", { text: "Hello there", uploads: [] }),
      ]);
      await page.waitForTimeout(2_500);
      const calls = harness.calls().slice(1);
      const target = (args: readonly string[]) => args[args.indexOf("--resume") + 1];
      const first = (await openPlanStore(root).read("plan-1"))?.claudeSessionId;
      process.stderr.write(
        `QA probe, send while opening: open ${opened.status} ${opened.body.slice(0, 80)} / send ${sent.status} ${sent.body.slice(0, 80)} / calls to ${calls.map((call) => (target(call.args) === first ? "plan-1" : target(call.args) === claudeSessionId ? other.id : target(call.args))).join(",")}\n`,
      );
      expect(calls.filter((call) => target(call.args) === first && call.prompt.includes("Hello there"))).toEqual([]);
    },
    SLOW,
  );

  it(
    "FR-PLAN-038 QA: a Stop sent while a Retry is still starting ends the turn, or is refused and the turn can still be stopped",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ message: "Who uses it?" }, { hang: true }, { hang: true }]);
      const page = await openPanel(gui);
      await send(page, harness, "A portal", 1);
      await idle(page);
      await send(page, harness, "Patients", 2);
      await expect.poll(() => messagesWritten(root, "Patients"), WAIT).toBe(1);
      await stopAndWait(page);
      const retried = sendTo(gui, "POST", "/api/plan/retry");
      const stopped = await sendTo(gui, "POST", "/api/plan/stop");
      const retry = await retried;
      await page.waitForTimeout(2_500);
      const turn = (JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as { plan: { turn: unknown } }).plan.turn;
      process.stderr.write(
        `QA probe, Stop in the gap: retry ${retry.status}, stop ${stopped.status} ${stopped.body.slice(0, 90)}, calls ${harness.calls().length}, turn ${turn === null ? "none" : "running"}\n`,
      );
      if (turn !== null) {
        // Refused in the gap: the turn that started must still be stoppable from the panel.
        await expect.poll(() => page.locator("#plan-stop").isVisible(), WAIT).toBe(true);
        await page.locator("#plan-stop").click();
        await idle(page);
      }
      await expect
        .poll(
          async () =>
            (JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as { plan: { turn: unknown } }).plan.turn,
          WAIT,
        )
        .toBeNull();
    },
    SLOW,
  );
});

describe("QA run 16: around the DEF-35 fix (opening and starting never overlap)", () => {
  /** A session left with "Patients" written and its turn stopped, waiting for a reply, held by no one. */
  async function waitingSession(root: string, home: string, summary: string): Promise<PlanSession> {
    const claudeSessionId = randomUUID();
    const folder = path.join(home, ".claude", "projects", realpathSync(root).replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${claudeSessionId}.jsonl`);
    writeFileSync(file, [line("user", summary), says("Who uses it?")].join(""));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const started = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    appendFileSync(file, line("user", "Patients"));
    return openPlanStore(root).create((id) => ({
      ...newPlanSession({
        id,
        target: { kind: "new-roadmap" },
        summary,
        holder: { place: "terminal", pid: process.pid },
        claudeSessionId,
        transcriptPath: file,
        now: started,
      }),
      holder: null,
      isAwaitingReply: true,
      unansweredMessage: "Patients",
      turnStartedAt: started,
    }));
  }

  const viewOf = async (gui: TestGui) =>
    (
      JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as {
        plan: { open: { id: string } | null; turn: unknown };
      }
    ).plan;
  const resumed = (call: { args: readonly string[] }) => call.args[call.args.indexOf("--resume") + 1];

  it(
    "TC-PLAN-077 QA: two sessions opened at once: the last one is shown, and any PM turn started is for the session shown",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ hang: true }, { hang: true }]);
      const home = harness.environment.HOME ?? "";
      const first = await waitingSession(root, home, "Portal B");
      const second = await waitingSession(root, home, "Portal C");
      const [one, two] = await Promise.all([
        sendTo(gui, "POST", "/api/plan/open", { planId: first.id }),
        sendTo(gui, "POST", "/api/plan/open", { planId: second.id }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      const view = await viewOf(gui);
      const sessions = harness.calls().map((call) => {
        const id = resumed(call);
        return id === first.claudeSessionId ? first.id : id === second.claudeSessionId ? second.id : id;
      });
      const records = await Promise.all([first.id, second.id].map((id) => openPlanStore(root).read(id)));
      process.stderr.write(
        `QA probe, two opens: ${one.status}/${two.status}, shown ${view.open?.id ?? "none"}, turn ${view.turn === null ? "none" : "running"}, PM turns for ${sessions.join(",") || "none"}, holders ${records.map((record) => `${record?.id}:${record?.holder?.place ?? "none"}`).join(" ")}\n`,
      );
      expect(view.open?.id).toBe(second.id);
      expect(sessions.filter((id) => id !== view.open?.id)).toEqual([]);
      expect(sessions.length).toBeLessThanOrEqual(1);
    },
    SLOW,
  );

  it(
    "TC-PLAN-077 QA: open then New session at once: New session is never refused, and the server ends with what was chosen last",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ hang: true }]);
      const session = await waitingSession(root, harness.environment.HOME ?? "", "Portal B");
      const opened = sendTo(gui, "POST", "/api/plan/open", { planId: session.id });
      const fresh = await sendTo(gui, "POST", "/api/plan/new");
      const open = await opened;
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      const view = await viewOf(gui);
      process.stderr.write(
        `QA probe, open then New session: open ${open.status}, new ${fresh.status} ${fresh.body.slice(0, 70)}, shown ${view.open?.id ?? "none"}, turn ${view.turn === null ? "none" : "running"}, PM turns ${harness.calls().length}, holder ${(await openPlanStore(root).read(session.id))?.holder?.place ?? "none"}\n`,
      );
      expect(fresh.status).toBe(200);
      expect(view.open, "New session was chosen last").toBeNull();
      expect(view.turn).toBeNull();
    },
    SLOW,
  );

  it(
    "TC-PLAN-077 QA: a message sent right after an open completes is accepted and goes to that session",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ hang: true }, { hang: true }]);
      const session = await waitingSession(root, harness.environment.HOME ?? "", "Portal B");
      // The open asks the PM to answer the stopped turn; Stop it, then send.
      expect((await sendTo(gui, "POST", "/api/plan/open", { planId: session.id })).status).toBe(200);
      await expect.poll(() => harness.calls().length, WAIT).toBe(1);
      await expect.poll(async () => (await viewOf(gui)).turn !== null, WAIT).toBe(true);
      await sendTo(gui, "POST", "/api/plan/stop");
      await expect.poll(async () => (await viewOf(gui)).turn, WAIT).toBeNull();
      const sent = await sendTo(gui, "POST", "/api/plan/message", { text: "Staff too", uploads: [] });
      expect(sent.status, sent.body).toBe(200);
      await expect.poll(() => harness.calls().length, WAIT).toBe(2);
      expect(resumed(harness.calls()[1] ?? { args: [] })).toBe(session.claudeSessionId);
      expect(harness.calls()[1]?.prompt).toBe("Staff too");
    },
    SLOW,
  );

  it(
    "TC-PLAN-077 QA (panel): choosing a session from the menu and sending at once never sends to the session left; a refusal keeps the text",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ message: "Who uses it?" }, { hang: true }, { hang: true }]);
      const page = await openPanel(gui);
      await send(page, harness, "A portal", 1);
      await idle(page);
      const other = await waitingSession(root, harness.environment.HOME ?? "", "Portal B");
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${other.id}"] [role=menuitem]`).click();
      await page.locator("#plan-text").fill("Hello there");
      await page.locator("#plan-text").press("Enter");
      await page.waitForTimeout(2_500);
      const first = (await openPlanStore(root).read("plan-1"))?.claudeSessionId;
      const toFirst = harness
        .calls()
        .slice(1)
        .filter((call) => resumed(call) === first);
      const notices = await page.locator("#plan-panel").textContent();
      process.stderr.write(
        `QA probe, panel choose then send: subtitle ${await page.locator("#plan-subtitle").textContent()}, calls after ${harness
          .calls()
          .slice(1)
          .map(
            (call) =>
              (resumed(call) === first ? "plan-1" : resumed(call) === other.claudeSessionId ? other.id : "?") +
              ":" +
              call.prompt.slice(0, 30),
          )
          .join(
            " | ",
          )}, box "${await page.locator("#plan-text").inputValue()}", still-opening notice ${notices?.includes("still opening") ?? false}\n`,
      );
      expect(toFirst).toEqual([]);
      const reachedOther = harness
        .calls()
        .some((call) => resumed(call) === other.claudeSessionId && call.prompt.includes("Hello there"));
      if (!reachedOther) expect(await page.locator("#plan-text").inputValue()).toBe("Hello there");
    },
    SLOW,
  );

  it(
    'TC-GUI-104 QA: "Plan a task" from a roadmap frame starts a single-task session for that roadmap, and its first message reaches the PM',
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ message: "Which part of the app?" }]);
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
      await page.locator('[data-key="task-1"]').waitFor();
      await page.locator('[data-frame="roadmap-1"] button[data-action="plan-task"]').click();
      expect(await page.locator("#plan-subtitle").textContent()).toBe("One task in roadmap #1");
      await send(page, harness, "Add a login page", 1);
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
      const record = await openPlanStore(root).read("plan-1");
      expect(record?.target).toEqual({ kind: "task", roadmapId: 1 });
      expect(await shownCount(page, "Add a login page")).toBe(1);
    },
    SLOW,
  );
});

describe("QA run 16: follow-ups", () => {
  async function waitingSession(root: string, home: string, summary: string): Promise<PlanSession> {
    const claudeSessionId = randomUUID();
    const folder = path.join(home, ".claude", "projects", realpathSync(root).replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${claudeSessionId}.jsonl`);
    writeFileSync(file, [line("user", summary), says("Who uses it?")].join(""));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const started = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    appendFileSync(file, line("user", "Patients"));
    return openPlanStore(root).create((id) => ({
      ...newPlanSession({
        id,
        target: { kind: "new-roadmap" },
        summary,
        holder: { place: "terminal", pid: process.pid },
        claudeSessionId,
        transcriptPath: file,
        now: started,
      }),
      holder: null,
      isAwaitingReply: true,
      unansweredMessage: "Patients",
      turnStartedAt: started,
    }));
  }

  it(
    "TC-PLAN-077 QA (panel): choosing a waiting session and then New session at once leaves the panel and the server on New session, with no PM turn",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ hang: true }]);
      const session = await waitingSession(root, harness.environment.HOME ?? "", "Portal B");
      const page = await openPanel(gui);
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${session.id}"] [role=menuitem]`).click();
      await page.locator("#plan-sessions-button").click();
      await page.locator("#plan-sessions-menu [role=menuitem]").first().click();
      await page.waitForTimeout(3_000);
      const view = (
        JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as {
          plan: { open: { id: string } | null; turn: unknown };
        }
      ).plan;
      process.stderr.write(
        `QA probe, panel open then New session: subtitle "${await page.locator("#plan-subtitle").textContent()}", empty ${await page.locator("#plan-panel .plan-empty").count()}, server shown ${view.open?.id ?? "none"}, turn ${view.turn === null ? "none" : "running"}, PM turns ${harness.calls().length}, holder ${(await openPlanStore(root).read(session.id))?.holder?.place ?? "none"}\n`,
      );
      expect.soft(await page.locator("#plan-panel .plan-empty").count()).toBe(1);
      expect.soft(view.open).toBeNull();
      expect.soft(harness.calls()).toHaveLength(0);
    },
    SLOW,
  );

  it(
    "FR-PLAN-032 QA: after two opens at once, the session no longer shown isn't left held by the GUI, so the terminal can resume it",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ hang: true }, { hang: true }]);
      const home = harness.environment.HOME ?? "";
      const first = await waitingSession(root, home, "Portal B");
      const second = await waitingSession(root, home, "Portal C");
      await Promise.all([
        sendTo(gui, "POST", "/api/plan/open", { planId: first.id }),
        sendTo(gui, "POST", "/api/plan/open", { planId: second.id }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const holder = (await openPlanStore(root).read(first.id))?.holder?.place ?? null;
      const terminal = agentHarness({ rules: [{ hang: true }], env: { HOME: home } });
      const resumed = planInTerminal(root, terminal, first.id);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      terminal.controller.abort();
      const outcome = String(await resumed);
      process.stderr.write(
        `QA probe, leaked hold: ${first.id} holder ${holder}, terminal calls ${terminal.calls().length}, outcome ${outcome.slice(0, 160)}\n`,
      );
      expect.soft(holder).not.toBe("gui");
      expect.soft(terminal.calls().length).toBe(1);
    },
    SLOW,
  );
});

describe("QA run 17: choices overtaken while opening (DEF-36, DEF-37 fixes)", () => {
  async function sessionOf(
    root: string,
    home: string,
    summary: string,
    extra: Partial<PlanSession> & { waiting?: boolean } = {},
  ): Promise<PlanSession> {
    const claudeSessionId = randomUUID();
    const folder = path.join(home, ".claude", "projects", realpathSync(root).replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${claudeSessionId}.jsonl`);
    writeFileSync(file, [line("user", summary), says("Who uses it?")].join(""));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const started = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { waiting = true, ...rest } = extra;
    if (waiting) appendFileSync(file, line("user", "Patients"));
    return openPlanStore(root).create((id) => ({
      ...newPlanSession({
        id,
        target: { kind: "new-roadmap" },
        summary,
        holder: { place: "terminal", pid: process.pid },
        claudeSessionId,
        transcriptPath: file,
        now: started,
      }),
      holder: null,
      ...(waiting ? { isAwaitingReply: true, unansweredMessage: "Patients", turnStartedAt: started } : {}),
      ...rest,
    }));
  }
  const viewOf = async (gui: TestGui) =>
    (
      JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as {
        plan: { open: { id: string } | null; turn: unknown };
      }
    ).plan;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let round = 1; round <= 3; round += 1) {
    it(
      `TC-PLAN-077 (round ${round}): B, C, then New session chosen at once: nothing is shown, held or run`,
      async () => {
        const root = project();
        const { gui, harness } = await startGui(root, [{ hang: true }, { hang: true }]);
        const home = harness.environment.HOME ?? "";
        const b = await sessionOf(root, home, "Portal B");
        const c = await sessionOf(root, home, "Portal C");
        const replies = await Promise.all([
          sendTo(gui, "POST", "/api/plan/open", { planId: b.id }),
          sendTo(gui, "POST", "/api/plan/open", { planId: c.id }),
          sendTo(gui, "POST", "/api/plan/new"),
        ]);
        await pause(2_500);
        const view = await viewOf(gui);
        const holders = await Promise.all([b.id, c.id].map(async (id) => (await openPlanStore(root).read(id))?.holder));
        process.stderr.write(
          `QA probe, B C New (round ${round}): ${replies.map((reply) => reply.status).join("/")}, shown ${view.open?.id ?? "none"}, turn ${view.turn === null ? "none" : "running"}, PM turns ${harness.calls().length}, holders ${holders.map((holder) => holder?.place ?? "none").join(",")}\n`,
        );
        expect(view.open).toBeNull();
        expect(view.turn).toBeNull();
        expect(harness.calls()).toEqual([]);
        expect(holders.filter((holder) => holder?.place === "gui")).toEqual([]);
      },
      SLOW,
    );
  }

  it(
    "FR-PLAN-036 QA (panel): Send and Propose now are disabled while a chosen session is still opening, and Enter sends nothing",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ message: "Who uses it?" }, { hang: true }]);
      const page = await openPanel(gui);
      await send(page, harness, "A portal", 1);
      await idle(page);
      const other = await sessionOf(root, harness.environment.HOME ?? "", "Portal B", { waiting: false });
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/api/plan/open", async (route) => {
        const response = await route.fetch();
        await released;
        await route.fulfill({ response });
      });
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${other.id}"] [role=menuitem]`).click();
      await page.locator("#plan-text").fill("Hello there");
      await page.waitForTimeout(500);
      expect(await page.locator("#plan-send").isDisabled()).toBe(true);
      expect(await page.locator("#plan-propose").isDisabled()).toBe(true);
      await page.locator("#plan-text").press("Enter");
      await page.waitForTimeout(1_000);
      expect(harness.calls()).toHaveLength(1);
      expect(await page.locator("#plan-text").inputValue()).toBe("Hello there");
      release();
      await expect.poll(() => page.locator("#plan-send").isDisabled(), WAIT).toBe(false);
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => harness.calls().length, WAIT).toBe(2);
      const args = harness.calls()[1]?.args ?? [];
      expect(args[args.indexOf("--resume") + 1]).toBe(other.claudeSessionId);
    },
    SLOW,
  );

  for (let round = 1; round <= 3; round += 1) {
    it(
      `FR-PLAN-042 QA (round ${round}): a session held by a terminal, then quickly another: the other is shown and run, and the terminal keeps its hold`,
      async () => {
        const root = project();
        const { gui, harness } = await startGui(root, [{ hang: true }, { hang: true }]);
        const home = harness.environment.HOME ?? "";
        const held = await sessionOf(root, home, "Portal B", { holder: { place: "terminal", pid: process.pid } });
        const c = await sessionOf(root, home, "Portal C");
        await Promise.all([
          sendTo(gui, "POST", "/api/plan/open", { planId: held.id }),
          sendTo(gui, "POST", "/api/plan/open", { planId: c.id }),
        ]);
        await pause(2_500);
        const view = await viewOf(gui);
        const resumedIds = harness.calls().map((call) => call.args[call.args.indexOf("--resume") + 1]);
        expect(view.open?.id).toBe(c.id);
        expect(resumedIds).toEqual([c.claudeSessionId]);
        expect((await openPlanStore(root).read(held.id))?.holder).toEqual({ place: "terminal", pid: process.pid });
        expect((await openPlanStore(root).read(c.id))?.holder?.place).toBe("gui");
      },
      SLOW,
    );
  }

  for (let round = 1; round <= 3; round += 1) {
    it(
      `FR-PLAN-014 QA (round ${round}): an overtaken open never drops a proposal that no longer fits without the PM being told`,
      async () => {
        const root = project();
        const { gui, harness } = await startGui(root, [{ hang: true }, { hang: true }, { hang: true }]);
        const home = harness.environment.HOME ?? "";
        const stale = await sessionOf(root, home, "Login task", {
          waiting: false,
          target: { kind: "task", roadmapId: 1 },
          proposal: {
            kind: "task",
            proposal: {
              task: { title: "Login", description: "Log in", spec: null, dependsOn: [] },
              milestoneId: 999,
              openQuestions: [],
            },
            proposedAt: new Date().toISOString(),
          },
        });
        const c = await sessionOf(root, home, "Portal C", { waiting: false });
        await Promise.all([
          sendTo(gui, "POST", "/api/plan/open", { planId: stale.id }),
          sendTo(gui, "POST", "/api/plan/open", { planId: c.id }),
        ]);
        await pause(2_000);
        const afterRace = await openPlanStore(root).read(stale.id);
        const toldInRace = harness
          .calls()
          .some(
            (call) =>
              call.args[call.args.indexOf("--resume") + 1] === stale.claudeSessionId &&
              call.prompt.startsWith(PROPOSAL_NO_LONGER_FITS),
          );
        // Open it again on its own: the PM must hear about the stale proposal now if it didn't before.
        if ((await viewOf(gui)).turn !== null) await sendTo(gui, "POST", "/api/plan/stop");
        await expect.poll(async () => (await viewOf(gui)).turn, WAIT).toBeNull();
        await sendTo(gui, "POST", "/api/plan/open", { planId: stale.id });
        await pause(2_000);
        const toldLater = harness
          .calls()
          .some(
            (call) =>
              call.args[call.args.indexOf("--resume") + 1] === stale.claudeSessionId &&
              call.prompt.startsWith(PROPOSAL_NO_LONGER_FITS),
          );
        process.stderr.write(
          `QA probe, stale proposal (round ${round}): proposal after race ${afterRace?.proposal === null ? "removed" : "kept"}, told in race ${toldInRace}, told on reopen ${toldLater}\n`,
        );
        // TC-PLAN-079: the proposal never disappears untold, and once the PM is told, it's no longer waiting.
        if (afterRace?.proposal === null) expect(toldInRace, "removed in the race without telling the PM").toBe(true);
        expect(toldInRace || toldLater, "the PM is told its proposal no longer fits").toBe(true);
        const told = harness
          .calls()
          .filter(
            (call) =>
              call.args[call.args.indexOf("--resume") + 1] === stale.claudeSessionId &&
              call.prompt.startsWith(PROPOSAL_NO_LONGER_FITS),
          );
        expect(told, "told once").toHaveLength(1);
        expect((await openPlanStore(root).read(stale.id))?.proposal).toBeNull();
      },
      SLOW,
    );
  }
});

describe("QA run 18: a proposal that no longer fits (TC-PLAN-079)", () => {
  const staleProposal = (dependsOn: number[], milestoneId: number) => ({
    kind: "task" as const,
    proposal: {
      task: { title: "Login", description: "Log in", spec: null, dependsOn },
      milestoneId,
      openQuestions: [],
    },
    proposedAt: new Date().toISOString(),
  });

  async function taskSession(root: string, home: string, extra: Partial<PlanSession>): Promise<PlanSession> {
    const claudeSessionId = randomUUID();
    const folder = path.join(home, ".claude", "projects", realpathSync(root).replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${claudeSessionId}.jsonl`);
    writeFileSync(file, [line("user", "Add login"), says("Here's the task.")].join(""));
    return openPlanStore(root).create((id) => ({
      ...newPlanSession({
        id,
        target: { kind: "task", roadmapId: 1 },
        summary: "Add login",
        holder: { place: "terminal", pid: process.pid },
        claudeSessionId,
        transcriptPath: file,
        now: new Date().toISOString(),
      }),
      holder: null,
      ...extra,
    }));
  }
  const toldCalls = (harness: ReturnType<typeof agentHarness>, session: PlanSession) =>
    harness
      .calls()
      .filter(
        (call) =>
          call.args[call.args.indexOf("--resume") + 1] === session.claudeSessionId &&
          call.prompt.startsWith(PROPOSAL_NO_LONGER_FITS),
      );

  it(
    "TC-PLAN-079 QA (panel): double-clicking a session with a stale proposal in the menu tells the PM once, and no card is offered",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ hang: true }, { hang: true }]);
      const session = await taskSession(root, harness.environment.HOME ?? "", { proposal: staleProposal([], 999) });
      const page = await openPanel(gui);
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${session.id}"] [role=menuitem]`).dblclick();
      await page.waitForTimeout(3_000);
      process.stderr.write(
        `QA probe, double-click stale: PM calls ${harness.calls().length}, told ${toldCalls(harness, session).length}, card ${await page.locator("#plan-panel .plan-card").count()}, proposal ${(await openPlanStore(root).read(session.id))?.proposal === null ? "cleared" : "kept"}\n`,
      );
      expect(toldCalls(harness, session)).toHaveLength(1);
      expect(harness.calls()).toHaveLength(1);
      expect((await openPlanStore(root).read(session.id))?.proposal).toBeNull();
      expect(await page.locator("#plan-panel .plan-card").count()).toBe(0);
    },
    SLOW,
  );

  it(
    "TC-PLAN-077 QA (panel): double-clicking a waiting session in the menu starts one Retry turn",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ hang: true }, { hang: true }]);
      const home = harness.environment.HOME ?? "";
      const claudeSessionId = randomUUID();
      const folder = path.join(home, ".claude", "projects", realpathSync(root).replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(folder, { recursive: true });
      const file = path.join(folder, `${claudeSessionId}.jsonl`);
      writeFileSync(file, [line("user", "A portal"), says("Who uses it?")].join(""));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const started = new Date().toISOString();
      await new Promise((resolve) => setTimeout(resolve, 5));
      appendFileSync(file, line("user", "Patients"));
      const session = await openPlanStore(root).create((id) => ({
        ...newPlanSession({
          id,
          target: { kind: "new-roadmap" },
          summary: "A portal",
          holder: { place: "terminal", pid: process.pid },
          claudeSessionId,
          transcriptPath: file,
          now: started,
        }),
        holder: null,
        isAwaitingReply: true,
        unansweredMessage: "Patients",
        turnStartedAt: started,
      }));
      const page = await openPanel(gui);
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${session.id}"] [role=menuitem]`).dblclick();
      await page.waitForTimeout(3_000);
      expect(harness.calls().map((call) => call.prompt)).toEqual([answerLastMessage(null)]);
      expect(await shownCount(page, "Patients")).toBe(1);
    },
    SLOW,
  );

  it(
    "TC-PLAN-079 QA (terminal): --resume with a stale proposal sends the note, doesn't offer /approve for it, and the proposal is gone",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [{ hang: true }] });
      const session = await taskSession(root, harness.environment.HOME ?? "", { proposal: staleProposal([], 999) });
      const resumed = planInTerminal(root, harness, session.id);
      await vi.waitFor(() => {
        expect(harness.calls()).toHaveLength(1);
      }, SPAWN_WAIT);
      expect(harness.calls()[0]?.prompt.startsWith(PROPOSAL_NO_LONGER_FITS)).toBe(true);
      expect(harness.calls()[0]?.prompt).toContain("milestoneId must be one of");
      expect(harness.output.err).not.toContain("/approve to save it");
      expect((await openPlanStore(root).read(session.id))?.proposal).toBeNull();
      harness.controller.abort();
      await resumed;
      // Resumed again, the PM isn't told twice and there's still nothing to approve.
      const again = agentHarness({ rules: [{ message: "Noted." }], env: { HOME: harness.environment.HOME } });
      inputMock.mockRejectedValueOnce(new Error("stop here"));
      const outcome = await planInTerminal(root, again, session.id);
      process.stderr.write(
        `QA probe, stale resumed twice: calls ${JSON.stringify(again.calls().map((call) => call.prompt.slice(0, 60)))}, outcome ${String(outcome).slice(0, 80)}\n`,
      );
      expect(again.calls().filter((call) => call.prompt.startsWith(PROPOSAL_NO_LONGER_FITS))).toEqual([]);
      expect(again.output.err).not.toContain("/approve to save it");
    },
    SLOW,
  );

  it(
    "TC-PLAN-079 QA (GUI): opening a session whose proposal no longer fits tells the PM, and the card goes away",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ hang: true }]);
      const session = await taskSession(root, harness.environment.HOME ?? "", { proposal: staleProposal([], 999) });
      const page = await openPanel(gui);
      await choose(page, session.id);
      await expect.poll(() => toldCalls(harness, session).length, WAIT).toBe(1);
      await expect.poll(() => page.locator("#plan-panel .plan-card").count(), WAIT).toBe(0);
      expect((await openPlanStore(root).read(session.id))?.proposal).toBeNull();
      const approve = await sendTo(gui, "POST", "/api/plan/approve", { planId: session.id });
      process.stderr.write(`QA probe, approve after stale: ${approve.status} ${approve.body.slice(0, 100)}\n`);
      expect(approve.status).not.toBe(200);
    },
    SLOW,
  );

  it(
    "TC-PLAN-079 QA (GUI Retry): a proposal made stale after a stopped turn is reported on Retry, and the card goes away",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ hang: true }, { hang: true }]);
      const home = harness.environment.HOME ?? "";
      const session = await taskSession(root, home, { proposal: staleProposal([1], 1) });
      const page = await openPanel(gui);
      // Send is ignored while the chosen session is still opening (FR-PLAN-036), so wait for the open's reply.
      const opened = page.waitForResponse("**/api/plan/open");
      await choose(page, session.id);
      await opened;
      await expect.poll(() => page.locator("#plan-panel .plan-card").count(), WAIT).toBe(1);
      await page.locator("#plan-text").fill("Make it smaller");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => harness.calls().length, WAIT).toBe(1);
      await expect.poll(() => promptsWritten(root, "Make it smaller"), WAIT).toBe(1);
      await stopAndWait(page);
      const store = openTaskStore(path.join(root, ".luseen"), "update");
      if (store === undefined) throw new Error("No store");
      store.removeTask(1);
      store.close();
      await retryButton(page).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(2);
      expect(harness.calls()[1]?.prompt.startsWith(PROPOSAL_NO_LONGER_FITS)).toBe(true);
      expect(harness.calls()[1]?.prompt).toContain("task 1");
      await expect.poll(() => page.locator("#plan-panel .plan-card").count(), WAIT).toBe(0);
      expect((await openPlanStore(root).read(session.id))?.proposal).toBeNull();
    },
    SLOW,
  );
});
