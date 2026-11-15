/// <reference lib="dom" />
/**
 * QA for the Plan panel's per-turn suggestions and sources across places (roadmap-planning FR-PLAN-037, DEF-10),
 * notices kept through a failed action (FR-PLAN-041), and Stop then Retry with the user's message shown
 * (FR-PLAN-038, TC-PLAN-057). Tests named with "QA" assert what the spec says.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { newPlanSession, type PlanSession } from "../../src/core/planning.js";
import { sendTo, startTestGui, type TestGui } from "../support/gui.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";

const WAIT = { timeout: 30_000, interval: 100 };
const SLOW = 90_000;

let browser: Browser;
const running: TestGui[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser.close();
});
afterEach(async () => {
  await Promise.all(browser.contexts().map((context) => context.close()));
  await Promise.all(running.splice(0).map((gui) => gui.stop()));
});

function project(): string {
  const root = makeTempFolder();
  writeProject(root, { ".cclinic/sdd/overview.md": "# Overview\n", ".cclinic/sdd/README.md": "# Specs\n" });
  const store = openTaskStore(path.join(root, ".cclinic"), "create");
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

async function startGui(root: string, rules: FakeClaudeRule[] = [], isPolling = true) {
  const harness = agentHarness({ rules });
  const gui = await startTestGui(root, {}, { every: isPolling ? every : () => () => undefined }, harness.environment);
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

const line = (type: "user" | "assistant", content: unknown) =>
  `${JSON.stringify({ type, timestamp: new Date().toISOString(), message: { content } })}\n`;

const suggest = (id: string, input: unknown) =>
  line("assistant", [{ type: "tool_use", id, name: "mcp__cclinic__plan_suggest", input }]);
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

const sourcesShown = (page: Page) =>
  page
    .locator("#plan-panel .plan-pm")
    .evaluateAll((nodes) => nodes.map((node) => node.querySelector(".plan-sources")?.textContent ?? ""));
const buttonsShown = (page: Page) =>
  page.evaluate(() => {
    const box = document.getElementById("plan-suggestions") as HTMLElement;
    return box.hidden ? [] : [...box.querySelectorAll("button")].map((node) => node.textContent);
  });

describe("QA: suggestions and sources belong to their own turn, wherever it ran (DEF-10)", () => {
  it(
    "FR-PLAN-037 QA: a session Claude Code drove shows no stale suggestions from its record, before or after release",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root);
      const { session } = await sessionWith(
        root,
        harness.environment.HOME ?? "",
        [
          line("user", "Question 1"),
          suggest("s1", { suggestions: ["Web"], sources: [{ title: "One", url: "https://one.example.org/a" }] }),
          toolResult("s1", "Shown"),
          says("Answer 1"),
          line("user", "Question 2"),
          says("Answer 2"),
        ],
        {
          holder: { place: "claude-code", pid: process.pid },
          suggestions: ["Stale"],
          sources: [{ title: "Stale", url: "https://stale.example.org/x" }],
        },
      );
      const page = await openPanel(gui);
      await choose(page, session.id);
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      expect(await sourcesShown(page)).toEqual([expect.stringContaining("one.example.org"), ""]);
      expect(await page.locator("#plan-panel").textContent()).not.toContain("stale.example.org");
      expect(await buttonsShown(page)).toEqual([]);
      await openPlanStore(root).update(session.id, (current) => ({
        save: { ...current, holder: null },
        value: undefined,
      }));
      await expect.poll(() => page.locator("#plan-text").isDisabled(), WAIT).toBe(false);
      expect(await buttonsShown(page)).toEqual([]);
      expect(await page.locator("#plan-panel").textContent()).not.toContain("Stale");
    },
    SLOW,
  );

  it(
    "FR-PLAN-037 QA: a plan_suggest with sources and no suggestions shows sources and no buttons, and the reverse",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root);
      const home = harness.environment.HOME ?? "";
      const onlySources = await sessionWith(root, home, [
        line("user", "Q"),
        suggest("s1", { suggestions: [], sources: [{ title: "Src", url: "https://src.example.org/" }] }),
        toolResult("s1", "Shown"),
        says("With sources"),
      ]);
      const onlySuggestions = await sessionWith(root, home, [
        line("user", "Q"),
        suggest("s2", { suggestions: ["Web", "Mobile"] }),
        toolResult("s2", "Shown"),
        says("With suggestions"),
      ]);
      const page = await openPanel(gui);
      await choose(page, onlySources.session.id);
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
      expect(await sourcesShown(page)).toEqual([expect.stringContaining("src.example.org")]);
      expect(await buttonsShown(page)).toEqual([]);
      await choose(page, onlySuggestions.session.id);
      await expect.poll(() => page.locator("#plan-panel .plan-pm").textContent(), WAIT).toContain("With suggestions");
      expect(await sourcesShown(page)).toEqual([""]);
      await expect.poll(() => buttonsShown(page), WAIT).toEqual(["Web", "Mobile"]);
      // No activity row for plan_suggest.
      expect(await page.locator("#plan-panel .plan-activity").count()).toBe(0);
    },
    SLOW,
  );

  it(
    "FR-PLAN-037 QA: in a GUI-driven session, the buttons of turn 1 go once turn 2 is sent and don't come back",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        {
          message: "Web or mobile?",
          tools: [
            {
              name: "plan_suggest",
              input: {
                suggestions: ["Web", "Mobile"],
                sources: [{ title: "Guide", url: "https://guide.example.org/" }],
              },
            },
          ],
        },
        { message: "Mobile it is.", delayMs: 1_500 },
      ]);
      const page = await openPanel(gui);
      await page.locator("#plan-text").fill("A patient portal");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => buttonsShown(page), WAIT).toEqual(["Web", "Mobile"]);
      expect(await sourcesShown(page)).toEqual([expect.stringContaining("guide.example.org")]);
      await page.locator("#plan-suggestions").getByRole("button", { name: "Mobile" }).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(2);
      expect(harness.calls()[1]?.prompt).toContain("Mobile");
      await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(1);
      expect(await buttonsShown(page)).toEqual([]);
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(0);
      expect(await buttonsShown(page)).toEqual([]);
      expect(await sourcesShown(page)).toEqual([expect.stringContaining("guide.example.org"), ""]);
      await page.reload();
      await page.locator('[data-key="task-1"]').waitFor();
      await page.locator("#plan-open").click();
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      expect(await buttonsShown(page)).toEqual([]);
      expect(await sourcesShown(page)).toEqual([expect.stringContaining("guide.example.org"), ""]);
    },
    SLOW,
  );

  it(
    "FR-PLAN-037 QA: mixed places in one session: a Claude Code turn's buttons show once released, then go after a GUI turn",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ message: "Thanks, noted." }]);
      const { session, file } = await sessionWith(
        root,
        harness.environment.HOME ?? "",
        [line("user", "From the terminal"), says("Terminal answer")],
        { holder: { place: "claude-code", pid: process.pid } },
      );
      const page = await openPanel(gui);
      await choose(page, session.id);
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
      appendFileSync(
        file,
        [
          line("user", "From Claude Code"),
          suggest("c1", { suggestions: ["Clinics"], sources: [{ title: "CC", url: "https://cc.example.org/" }] }),
          toolResult("c1", "Shown"),
          says("Claude Code answer"),
        ].join(""),
      );
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      expect(await sourcesShown(page)).toEqual(["", expect.stringContaining("cc.example.org")]);
      expect(await buttonsShown(page)).toEqual([]);
      await openPlanStore(root).update(session.id, (current) => ({
        save: { ...current, holder: null },
        value: undefined,
      }));
      await expect.poll(() => buttonsShown(page), WAIT).toEqual(["Clinics"]);
      await page.locator("#plan-text").fill("Also dentists");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(3);
      await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(0);
      expect(await buttonsShown(page)).toEqual([]);
      expect(await sourcesShown(page)).toEqual(["", expect.stringContaining("cc.example.org"), ""]);
      expect(harness.calls()[0]?.args).toContain("--resume");
    },
    SLOW,
  );

  it(
    "FR-PLAN-007, FR-PLAN-037 QA: a plan_suggest call the tool refused (5 suggestions) shows no buttons",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root);
      const { session } = await sessionWith(root, harness.environment.HOME ?? "", [
        line("user", "Q"),
        suggest("s1", { suggestions: ["A", "B", "C", "D", "E"], sources: [] }),
        toolResult("s1", "suggestions: Too big: expected array to have <=4 items", true),
        says("Which one?"),
      ]);
      const page = await openPanel(gui);
      await choose(page, session.id);
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
      expect(await buttonsShown(page)).toEqual([]);
    },
    SLOW,
  );

  it(
    "FR-PLAN-007, FR-PLAN-037 QA: a source the tool refused (ftp URL, in a refused call) isn't shown as a link",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root);
      const { session } = await sessionWith(root, harness.environment.HOME ?? "", [
        line("user", "Q"),
        suggest("s1", {
          suggestions: ["Yes"],
          sources: [
            { title: "Ok", url: "https://ok.example.org/" },
            { title: "Bad", url: "ftp://bad.example.org/" },
          ],
        }),
        toolResult("s1", "sources.1.url: must be an http or https URL", true),
        says("Here"),
      ]);
      const page = await openPanel(gui);
      await choose(page, session.id);
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
      expect(await sourcesShown(page)).toEqual([""]);
      expect(await buttonsShown(page)).toEqual([]);
    },
    SLOW,
  );
});

describe("QA: notices and Stop/Retry", () => {
  it(
    "FR-PLAN-041 QA (DEF-10): a failed send keeps the refused-file notice and adds its own problem",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [], false);
      const { session } = await sessionWith(root, harness.environment.HOME ?? "", [line("user", "Q"), says("A")]);
      const page = await openPanel(gui);
      await choose(page, session.id);
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(10)], "song.mp3"));
        document
          .getElementById("plan-panel")
          ?.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
      });
      await expect.poll(() => page.locator("#plan-panel .plan-error").textContent(), WAIT).toContain("song.mp3");
      // Another place takes the session; this GUI doesn't poll, so it learns only when its send is refused.
      await openPlanStore(root).update(session.id, (current) => ({
        save: { ...current, holder: { place: "terminal", pid: process.pid } },
        value: undefined,
      }));
      await page.locator("#plan-text").fill("Hello");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => page.locator("#plan-panel .plan-error").count(), WAIT).toBe(2);
      const texts = await page.locator("#plan-panel .plan-error").allTextContents();
      expect(texts[0]).toContain("song.mp3");
      expect(texts[0]).toContain("Remove file");
      expect(harness.calls()).toHaveLength(0);
    },
    SLOW,
  );

  for (const beforeTranscript of [false, true])
    it(
      `TC-PLAN-057 QA (browser): after Stop the user's message is shown once with Retry${beforeTranscript ? ", even when stopped before Claude wrote it" : ""}`,
      async () => {
        const root = project();
        const { gui, harness } = await startGui(root, [
          { message: "Who pays?" },
          { hang: true, beforeTranscript },
          { message: "Shoppers pay." },
        ]);
        const page = await openPanel(gui);
        await page.locator("#plan-text").fill("Add checkout");
        await page.locator("#plan-text").press("Enter");
        await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
        await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(0);
        await page.locator("#plan-text").fill("Shoppers");
        await page.locator("#plan-text").press("Enter");
        await expect.poll(() => harness.calls().length, WAIT).toBe(2);
        await expect.poll(() => page.locator("#plan-stop").isVisible(), WAIT).toBe(true);
        const users = page.locator("#plan-panel .plan-user");
        if (!beforeTranscript) await expect.poll(() => users.allTextContents(), WAIT).toHaveLength(2);
        await page.locator("#plan-stop").click();
        await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(0);
        const retry = page.locator("#plan-panel").getByRole("button", { name: "Retry" });
        await expect.poll(() => retry.isVisible(), WAIT).toBe(true);
        await expect
          .poll(async () => (await users.allTextContents()).filter((text) => text.includes("Shoppers")).length, WAIT)
          .toBe(1);
        await retry.click();
        await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
        expect(harness.calls()[2]?.args).toContain("--resume");
        expect((await users.allTextContents()).filter((text) => text.includes("Shoppers"))).toHaveLength(1);
        expect(await retry.count()).toBe(0);
      },
      SLOW,
    );

  it(
    "FR-PLAN-038, FR-PLAN-041 QA: a file refused while the turn runs doesn't hide Stop's Retry",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ hang: true }, { message: "Back." }]);
      const page = await openPanel(gui);
      await page.locator("#plan-text").fill("Add checkout");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => harness.calls().length, WAIT).toBe(1);
      await expect.poll(() => page.locator("#plan-stop").isVisible(), WAIT).toBe(true);
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(10)], "song.mp3"));
        document
          .getElementById("plan-panel")
          ?.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
      });
      await expect.poll(() => page.locator("#plan-panel .plan-error").textContent(), WAIT).toContain("song.mp3");
      await page.locator("#plan-stop").click();
      await expect.poll(() => page.locator("#plan-panel .plan-working").count(), WAIT).toBe(0);
      const view = JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as {
        plan: { notice: { action: string } | null };
      };
      expect(view.plan.notice?.action).toBe("retry");
      await expect
        .poll(() => page.locator("#plan-panel").getByRole("button", { name: "Retry" }).isVisible(), WAIT)
        .toBe(true);
      expect(await page.locator("#plan-panel .plan-error").first().textContent()).toContain("song.mp3");
    },
    SLOW,
  );
});

describe("QA: following the end of a long conversation", () => {
  for (const hasSuggestions of [false, true])
    it(
      `FR-PLAN-040 QA: opening a long session${hasSuggestions ? " whose newest turn offers suggestions" : ""} shows its end, with no Jump to latest`,
      async () => {
        const root = project();
        const { gui, harness } = await startGui(root);
        const lines: string[] = [];
        for (let i = 1; i <= 15; i += 1) lines.push(line("user", `Question ${i}`), says(`Answer ${i}\n\n- one\n- two`));
        lines.push(
          line("user", "Web or mobile?"),
          suggest("s", {
            suggestions: hasSuggestions ? ["Web", "Mobile"] : [],
            sources: [{ title: "Survey", url: "https://survey.example.com/" }],
          }),
          toolResult("s", "Shown"),
          says("Which platform first?"),
        );
        const { session } = await sessionWith(root, harness.environment.HOME ?? "", lines);
        const page = await openPanel(gui);
        await choose(page, session.id);
        await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(16);
        if (hasSuggestions) await expect.poll(() => buttonsShown(page), WAIT).toEqual(["Web", "Mobile"]);
        await page.waitForTimeout(500);
        const log = page.locator("#plan-log");
        expect(await log.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(8);
        expect(await page.locator("#plan-panel .jump-latest").count()).toBe(0);
        const source = page.locator("#plan-panel .plan-pm").last().locator(".plan-sources");
        const [sourceBox, logBox] = [await source.boundingBox(), await log.boundingBox()];
        expect((sourceBox?.y ?? 0) + (sourceBox?.height ?? 0)).toBeLessThanOrEqual(
          (logBox?.y ?? 0) + (logBox?.height ?? 0),
        );
      },
      SLOW,
    );
});
