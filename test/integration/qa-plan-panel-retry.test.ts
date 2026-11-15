/// <reference lib="dom" />
/**
 * QA run 3 probes for the Plan panel: Retry after Stop across places and repeated stops (roadmap-planning
 * FR-PLAN-014, FR-PLAN-030, FR-PLAN-038, DEF-12), refused and accepted plan_suggest calls in one turn (FR-PLAN-007,
 * FR-PLAN-037, DEF-11), notices from the page and the server together (FR-PLAN-041, DEF-13), and following the end
 * without jumping while scrolled up (FR-PLAN-040, DEF-14). Tests named with "QA" assert what the spec says.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { input } from "@inquirer/prompts";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import type { PlanPanelView } from "../../src/application/gui-planning.js";
import { runPlanCommand } from "../../src/cli/plan-command.js";
import { answerLastMessage, newPlanSession, type PlanSession } from "../../src/core/planning.js";
import { sendTo, startTestGui, type TestGui } from "../support/gui.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn(), input: vi.fn() }));

const WAIT = { timeout: 30_000, interval: 100 };
const SLOW = 120_000;

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

const viewOf = async (gui: TestGui) =>
  (JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as { plan: PlanPanelView }).plan;

const line = (type: "user" | "assistant", content: unknown) =>
  `${JSON.stringify({ type, timestamp: new Date().toISOString(), message: { content } })}\n`;
const suggest = (id: string, input: unknown) =>
  line("assistant", [{ type: "tool_use", id, name: "mcp__luseen__plan_suggest", input }]);
const toolResult = (id: string, content: string, isError = false) =>
  line("user", [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }]);
const says = (text: string) => line("assistant", [{ type: "text", text }]);

async function sessionWith(
  root: string,
  home: string,
  lines: readonly string[],
  extra: Partial<PlanSession> = {},
): Promise<{ session: PlanSession; file: string }> {
  const claudeSessionId = randomUUID();
  const folder = path.join(home, ".claude", "projects", realpathSync(root).replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${claudeSessionId}.jsonl`);
  writeFileSync(file, lines.join(""));
  const session = await openPlanStore(root).create((id) => ({
    ...newPlanSession({
      id,
      target: { kind: "new-roadmap" },
      summary: "A patient portal",
      holder: { place: "terminal", pid: process.pid },
      claudeSessionId,
      transcriptPath: file,
      now: new Date().toISOString(),
    }),
    holder: null,
    ...extra,
  }));
  return { session, file };
}

async function choose(page: Page, id: string): Promise<void> {
  await page.locator("#plan-sessions-button").click();
  await page.locator(`#plan-sessions-menu [data-plan-id="${id}"] [role=menuitem]`).click();
}

const buttonsShown = (page: Page) =>
  page.evaluate(() => {
    const box = document.getElementById("plan-suggestions") as HTMLElement;
    return box.hidden ? [] : [...box.querySelectorAll("button")].map((node) => node.textContent);
  });
const sourcesShown = (page: Page) =>
  page
    .locator("#plan-panel .plan-pm")
    .evaluateAll((nodes) => nodes.map((node) => node.querySelector(".plan-sources")?.textContent ?? ""));
const usersShown = (page: Page) => page.locator("#plan-panel .plan-user").allTextContents();
const notesShown = (page: Page) => page.locator("#plan-panel .plan-note").allTextContents();

/** Sends a message from the box, and waits until the fake `claude` has been called `calls` times. */
async function sendAndWait(page: Page, harness: ReturnType<typeof agentHarness>, text: string, calls: number) {
  await page.locator("#plan-text").fill(text);
  await page.locator("#plan-text").press("Enter");
  await expect.poll(() => harness.calls().length, WAIT).toBe(calls);
}

async function stopAndWait(page: Page) {
  await expect.poll(() => page.locator("#plan-stop").isVisible(), WAIT).toBe(true);
  await page.locator("#plan-stop").click();
  await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(0);
}

const retryButton = (page: Page) => page.locator("#plan-panel").getByRole("button", { name: "Retry" });

describe("QA run 3: Retry after Stop (DEF-12)", () => {
  for (const beforeTranscript of [false, true])
    it(
      `FR-PLAN-014, FR-PLAN-038 QA: Retry twice in a row repeats the user's message only while the transcript doesn't have it${beforeTranscript ? " (stopped before Claude wrote it)" : ""}`,
      async () => {
        const root = project();
        const { gui, harness } = await startGui(root, [
          { message: "Who pays?" },
          { hang: true, beforeTranscript },
          { hang: true, beforeTranscript },
          { message: "Shoppers pay." },
        ]);
        const page = await openPanel(gui);
        await sendAndWait(page, harness, "Add checkout", 1);
        await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
        await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(0);
        await sendAndWait(page, harness, "Shoppers", 2);
        await stopAndWait(page);
        await expect.poll(() => retryButton(page).isVisible(), WAIT).toBe(true);
        await retryButton(page).click();
        await expect.poll(() => harness.calls().length, WAIT).toBe(3);
        // FR-PLAN-014: the message is repeated only when the stopped turn didn't write it to the transcript.
        const repeated = beforeTranscript ? "Shoppers" : null;
        expect(harness.calls()[2]?.prompt).toBe(answerLastMessage(repeated));
        await stopAndWait(page);
        await expect.poll(() => retryButton(page).isVisible(), WAIT).toBe(true);
        // The user's message is still shown once, as theirs, after the second stop.
        await expect
          .poll(async () => (await usersShown(page)).filter((text) => text.includes("Shoppers")).length, WAIT)
          .toBe(1);
        await retryButton(page).click();
        await expect.poll(() => harness.calls().length, WAIT).toBe(4);
        // FR-PLAN-014: the first Retry's request never reached the transcript either way, so the second Retry asks the
        // same as the first, and never repeats the first Retry's request.
        expect(harness.calls()[3]?.prompt).toBe(answerLastMessage(repeated));
        await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
        expect((await usersShown(page)).filter((text) => text.includes("Shoppers"))).toHaveLength(1);
        expect((await usersShown(page)).join("\n")).not.toContain("Your last turn was stopped");
      },
      SLOW,
    );

  it(
    "FR-PLAN-030, FR-PLAN-038 QA: while a Retry runs and Claude hasn't written it yet, the user's message stays shown",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        { message: "Who pays?" },
        { hang: true, beforeTranscript: true },
        { hang: true, beforeTranscript: true },
      ]);
      const page = await openPanel(gui);
      await sendAndWait(page, harness, "Add checkout", 1);
      await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(0);
      await sendAndWait(page, harness, "Shoppers", 2);
      await stopAndWait(page);
      await expect.poll(() => retryButton(page).isVisible(), WAIT).toBe(true);
      await retryButton(page).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(3);
      await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(1);
      await page.waitForTimeout(500);
      expect((await usersShown(page)).filter((text) => text.includes("Shoppers"))).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "FR-PLAN-030, FR-PLAN-038 QA: after a stop before Claude wrote the message, a new message is sent and shown, and the stopped one isn't shown twice",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        { message: "Who pays?" },
        { hang: true, beforeTranscript: true },
        { message: "Noted." },
      ]);
      const page = await openPanel(gui);
      await sendAndWait(page, harness, "Add checkout", 1);
      await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(0);
      await sendAndWait(page, harness, "Shoppers", 2);
      await stopAndWait(page);
      await expect
        .poll(async () => (await usersShown(page)).filter((text) => text.includes("Shoppers")).length, WAIT)
        .toBe(1);
      await sendAndWait(page, harness, "Clinics instead", 3);
      expect(harness.calls()[2]?.prompt).toBe("Clinics instead");
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(0);
      const users = await usersShown(page);
      expect(users.filter((text) => text.includes("Clinics instead"))).toHaveLength(1);
      expect(users.filter((text) => text.includes("Shoppers")).length).toBeLessThanOrEqual(1);
      expect(await retryButton(page).count()).toBe(0);
      expect((await openPlanStore(root).read("plan-1"))?.unansweredMessage).toBeNull();
    },
    SLOW,
  );

  for (const beforeTranscript of [false, true])
    it(
      `FR-PLAN-014, FR-PLAN-031 QA: stopped in the GUI, then resumed in the terminal, the PM is asked to answer, with the user's message only if the transcript doesn't have it${beforeTranscript ? " (stopped before Claude wrote it)" : ""}`,
      async () => {
        const root = project();
        const { gui, harness } = await startGui(root, [{ message: "Who pays?" }, { hang: true, beforeTranscript }]);
        const page = await openPanel(gui);
        await sendAndWait(page, harness, "Add checkout", 1);
        await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(0);
        await sendAndWait(page, harness, "Shoppers", 2);
        await stopAndWait(page);
        await page.context().close();
        await running.splice(0).map((item) => item.stop())[0];
        const again = agentHarness({ rules: [{ message: "Shoppers pay." }], env: { HOME: harness.environment.HOME } });
        vi.mocked(input).mockRejectedValueOnce(new Error("stop here"));
        await runPlanCommand(
          { dir: root, resume: "plan-1", timeoutMinutes: 30, model: "sonnet", effort: "low" },
          again.context,
        ).catch(() => undefined);
        expect(again.calls()[0]?.args).toContain("--resume");
        expect(again.calls()[0]?.prompt).toBe(answerLastMessage(beforeTranscript ? "Shoppers" : null));
        expect(again.output.err).toContain("PM › Shoppers pay.");
      },
      SLOW,
    );

  it(
    "FR-PLAN-014, FR-PLAN-038 QA: stopped in the terminal before Claude wrote it, opening it in the GUI shows the message once and sends it again",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ message: "Shoppers pay." }]);
      const { session } = await sessionWith(
        root,
        harness.environment.HOME ?? "",
        [line("user", "Add checkout"), says("Who pays?")],
        { isAwaitingReply: true, unansweredMessage: "Shoppers" },
      );
      const page = await openPanel(gui);
      await choose(page, session.id);
      await expect.poll(() => harness.calls().length, WAIT).toBe(1);
      expect(harness.calls()[0]?.args).toContain("--resume");
      expect(harness.calls()[0]?.prompt).toBe(answerLastMessage("Shoppers"));
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(0);
      expect((await usersShown(page)).filter((text) => text.includes("Shoppers"))).toHaveLength(1);
      expect((await openPlanStore(root).read(session.id))?.unansweredMessage).toBeNull();
    },
    SLOW,
  );

  it(
    "FR-PLAN-014 QA: a GUI Retry after a terminal stop and a second GUI stop doesn't repeat the message the first request already repeated",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ hang: true }, { message: "Shoppers pay." }]);
      const { session } = await sessionWith(
        root,
        harness.environment.HOME ?? "",
        [line("user", "Add checkout"), says("Who pays?")],
        { isAwaitingReply: true, unansweredMessage: "Shoppers" },
      );
      const page = await openPanel(gui);
      await choose(page, session.id);
      await expect.poll(() => harness.calls().length, WAIT).toBe(1);
      expect(harness.calls()[0]?.prompt).toBe(answerLastMessage("Shoppers"));
      await stopAndWait(page);
      await expect.poll(() => retryButton(page).isVisible(), WAIT).toBe(true);
      await retryButton(page).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(2);
      // The first request, which repeated "Shoppers", is in the transcript now, so the message counts as written.
      expect(harness.calls()[1]?.prompt).toBe(answerLastMessage(null));
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      expect((await usersShown(page)).filter((text) => text.includes("Shoppers"))).toHaveLength(1);
    },
    SLOW,
  );
});

describe("QA run 3: refused and accepted plan_suggest calls in one turn (DEF-11)", () => {
  const cases: { name: string; lines: string[]; buttons: string[]; source: string }[] = [
    {
      name: "refused, then accepted: the accepted one shows",
      lines: [
        suggest("a", { suggestions: ["A", "B", "C", "D", "E"], sources: [] }),
        toolResult("a", "suggestions: Too big", true),
        suggest("b", { suggestions: ["Web"], sources: [{ title: "Ok", url: "https://ok.example.org/" }] }),
        toolResult("b", "Shown"),
      ],
      buttons: ["Web"],
      source: "ok.example.org",
    },
    {
      name: "accepted, then refused by its result: the accepted one stays",
      lines: [
        suggest("a", { suggestions: ["Web"], sources: [{ title: "Ok", url: "https://ok.example.org/" }] }),
        toolResult("a", "Shown"),
        suggest("b", { suggestions: ["Mobile"], sources: [{ title: "No", url: "https://no.example.org/" }] }),
        toolResult("b", "refused for another reason", true),
      ],
      buttons: ["Web"],
      source: "ok.example.org",
    },
    {
      name: "accepted, then input the schema refuses (no result yet): the accepted one stays",
      lines: [
        suggest("a", { suggestions: ["Web"], sources: [{ title: "Ok", url: "https://ok.example.org/" }] }),
        toolResult("a", "Shown"),
        suggest("b", { suggestions: ["Mobile"], sources: [{ title: "Bad", url: "ftp://bad.example.org/" }] }),
      ],
      buttons: ["Web"],
      source: "ok.example.org",
    },
    {
      name: "two accepted: the second replaces the first, sources too",
      lines: [
        suggest("a", { suggestions: ["Web"], sources: [{ title: "One", url: "https://one.example.org/" }] }),
        toolResult("a", "Shown"),
        suggest("b", { suggestions: ["Mobile"], sources: [] }),
        toolResult("b", "Shown"),
      ],
      buttons: ["Mobile"],
      source: "",
    },
  ];
  for (const item of cases)
    it(
      `FR-PLAN-007, FR-PLAN-037 QA: ${item.name}`,
      async () => {
        const root = project();
        const { gui, harness } = await startGui(root);
        const { session } = await sessionWith(root, harness.environment.HOME ?? "", [
          line("user", "Q"),
          ...item.lines,
          says("Which one?"),
        ]);
        const page = await openPanel(gui);
        await choose(page, session.id);
        await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
        await expect.poll(() => buttonsShown(page), WAIT).toEqual(item.buttons);
        const [shown] = await sourcesShown(page);
        if (item.source === "") expect(shown).toBe("");
        else expect(shown).toContain(item.source);
        expect(await page.locator("#plan-panel").textContent()).not.toMatch(/no\.example|bad\.example/);
      },
      SLOW,
    );

  it(
    "FR-PLAN-007, FR-PLAN-037 QA: the server's record and the panel agree after a GUI turn with a refused then an accepted call",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        {
          message: "Web or mobile?",
          tools: [
            { name: "plan_suggest", input: { suggestions: ["A", "B", "C", "D", "E"] } },
            {
              name: "plan_suggest",
              input: { suggestions: ["Web", "Mobile"], sources: [{ title: "G", url: "https://g.example.org/" }] },
            },
          ],
        },
      ]);
      const page = await openPanel(gui);
      await sendAndWait(page, harness, "A portal", 1);
      await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(0);
      await expect.poll(() => buttonsShown(page), WAIT).toEqual(["Web", "Mobile"]);
      const view = await viewOf(gui);
      expect(view.open?.suggestions).toEqual(["Web", "Mobile"]);
      expect(await sourcesShown(page)).toEqual([expect.stringContaining("g.example.org")]);
    },
    SLOW,
  );
});

describe("QA run 3: notices (DEF-13) and following the end (DEF-14)", () => {
  it(
    "FR-PLAN-041 QA: a refused file and Stop's notice show together, the page's first; Remove file removes only its own",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ hang: true }, { message: "Back." }]);
      const page = await openPanel(gui);
      await sendAndWait(page, harness, "Add checkout", 1);
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(10)], "song.mp3"));
        document
          .getElementById("plan-panel")
          ?.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
      });
      await stopAndWait(page);
      const errors = page.locator("#plan-panel .plan-error");
      await expect.poll(() => errors.count(), WAIT).toBe(2);
      const texts = await errors.allTextContents();
      expect(texts[0]).toContain("song.mp3");
      expect(texts[0]).toContain("Remove file");
      expect(texts[1]).toContain("Stopped");
      expect(texts[1]).toContain("Retry");
      await errors.first().getByRole("button", { name: "Remove file" }).click();
      await expect.poll(() => errors.count(), WAIT).toBe(1);
      expect(await errors.first().textContent()).toContain("Stopped");
      await retryButton(page).click();
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
      await expect.poll(() => errors.count(), WAIT).toBe(0);
    },
    SLOW,
  );

  it(
    "FR-PLAN-040 QA: suggestions and a reply arriving while scrolled up don't move the view, and Jump to latest shows",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        {
          message: "Which platform first?",
          delayMs: 1_500,
          tools: [{ name: "plan_suggest", input: { suggestions: ["Web", "Mobile"] } }],
        },
      ]);
      const lines: string[] = [];
      for (let i = 1; i <= 15; i += 1) lines.push(line("user", `Question ${i}`), says(`Answer ${i}\n\n- one\n- two`));
      const { session } = await sessionWith(root, harness.environment.HOME ?? "", lines);
      const page = await openPanel(gui);
      // A message sent while the session is still opening is refused (TC-PLAN-077), so wait for the open to finish.
      const opened = page.waitForResponse("**/api/plan/open");
      await choose(page, session.id);
      await opened;
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(15);
      await page.waitForTimeout(300);
      await sendAndWait(page, harness, "Web or mobile?", 1);
      const log = page.locator("#plan-log");
      await log.evaluate((node) => {
        node.scrollTop = 200;
        node.dispatchEvent(new Event("scroll"));
      });
      await expect.poll(() => page.locator("#plan-panel .jump-latest").count(), WAIT).toBe(1);
      const before = await log.evaluate((node) => node.scrollTop);
      await expect.poll(() => buttonsShown(page), WAIT).toEqual(["Web", "Mobile"]);
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(16);
      await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(0);
      await page.waitForTimeout(300);
      expect(Math.abs((await log.evaluate((node) => node.scrollTop)) - before)).toBeLessThan(2);
      expect(await page.locator("#plan-panel .jump-latest").count()).toBe(1);
      await page.locator("#plan-panel .jump-latest").click();
      await page.waitForTimeout(300);
      expect(await log.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(8);
      expect(await page.locator("#plan-panel .jump-latest").count()).toBe(0);
    },
    SLOW,
  );

  it(
    "FR-PLAN-040 QA: at the bottom, a reply from another place with suggestions keeps the end in view",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root);
      const lines: string[] = [];
      for (let i = 1; i <= 15; i += 1) lines.push(line("user", `Question ${i}`), says(`Answer ${i}`));
      const { session, file } = await sessionWith(root, harness.environment.HOME ?? "", lines);
      const page = await openPanel(gui);
      await choose(page, session.id);
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(15);
      await openPlanStore(root).update(session.id, (current) => ({
        save: { ...current, holder: { place: "claude-code", pid: process.pid } },
        value: undefined,
      }));
      appendFileSync(
        file,
        [
          line("user", "More?"),
          suggest("z", { suggestions: ["Yes", "No"], sources: [{ title: "S", url: "https://s.example.org/" }] }),
          toolResult("z", "Shown"),
          says("Shall I go on?"),
        ].join(""),
      );
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(16);
      await openPlanStore(root).update(session.id, (current) => ({
        save: { ...current, holder: null },
        value: undefined,
      }));
      await expect.poll(() => buttonsShown(page), WAIT).toEqual(["Yes", "No"]);
      await page.waitForTimeout(400);
      const log = page.locator("#plan-log");
      expect(await log.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(8);
      expect(await notesShown(page)).toEqual([]);
    },
    SLOW,
  );
});
