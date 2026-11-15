/// <reference lib="dom" />
/**
 * QA for the Plan panel's refused files and per-turn sources (roadmap-planning FR-PLAN-022, FR-PLAN-033,
 * FR-PLAN-037, FR-PLAN-041): the page checks each file with the server's rules before sending it, names every
 * refused one with Remove file, and shows a turn's sources only under that turn's messages.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { newPlanSession, type PlanSession } from "../../src/core/planning.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";
import { sendTo, startTestGui, type TestGui } from "../support/gui.js";

const WAIT = { timeout: 30_000, interval: 100 };
const SLOW = 120_000;
const MB = 1024 * 1024;

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

async function startGui(root: string, rules: FakeClaudeRule[] = []) {
  const harness = agentHarness({ rules });
  const gui = await startTestGui(root, {}, { every }, harness.environment);
  running.push(gui);
  return { gui, harness };
}

/** The panel open, with the names of the files the page uploaded (not just checked). */
async function openPanel(gui: TestGui): Promise<{ page: Page; uploaded: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const uploaded: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/api/plan/uploads")) return;
    const body = request.postData() ?? "";
    const name = /"name":"([^"]*)"/.exec(body)?.[1];
    uploaded.push(name ?? "?");
  });
  await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
  await page.locator('[data-key="task-1"]').waitFor();
  await page.locator("#plan-open").click();
  return { page, uploaded };
}

type Way = "paste" | "drop" | "button";

function openAndClose(file: string): string {
  writeFileSync(file, "");
  return file;
}

/** Files of these names and sizes, given to the panel the way a person would. */
async function give(page: Page, way: Way, files: readonly (readonly [string, number])[]): Promise<void> {
  if (way === "button") {
    // Playwright can't pass a buffer over 50 MB, so the chosen files are real files.
    const folder = makeTempFolder();
    for (const [name, size] of files) truncateSync(openAndClose(path.join(folder, name)), size);
    await page.locator("#plan-files").setInputFiles(files.map(([name]) => path.join(folder, name)));
    return;
  }
  await page.evaluate(
    ([list, how]) => {
      const data = new DataTransfer();
      for (const [name, size] of list) data.items.add(new File([new Uint8Array(size)], name));
      if (how === "paste")
        document.getElementById("plan-text")?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
      else
        document
          .getElementById("plan-panel")
          ?.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    },
    [files, way] as const,
  );
}

const errors = (page: Page) => page.locator("#plan-panel .plan-error");
const chips = (page: Page) => page.locator("#plan-chips .plan-chip");

const line = (type: "user" | "assistant", content: unknown) =>
  `${JSON.stringify({ type, timestamp: new Date().toISOString(), message: { content } })}\n`;

async function unheldSession(
  root: string,
  home: string,
  lines: readonly string[],
  extra: Partial<PlanSession> = {},
): Promise<PlanSession> {
  const claudeSessionId = randomUUID();
  const folder = path.join(home, ".claude", "projects", realpathSync(root).replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${claudeSessionId}.jsonl`);
  writeFileSync(file, lines.join(""));
  return openPlanStore(root).create((id) => ({
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
}

describe("QA: refused files in the Plan panel (DEF-7, DEF-8)", () => {
  it(
    "FR-PLAN-022 QA: the check route gives the server's own reason at each limit",
    async () => {
      const root = project();
      const { gui } = await startGui(root);
      const check = async (name: string, sizeBytes: number) =>
        (
          JSON.parse((await sendTo(gui, "POST", "/api/plan/uploads/check", { name, sizeBytes })).body) as {
            problem: string | null;
          }
        ).problem;
      expect(await check("brief.pdf", 20 * MB)).toBeNull();
      expect(await check("brief.pdf", 20 * MB + 1)).toContain("at most 20 MB");
      expect(await check("shot.png", 5 * MB)).toBeNull();
      expect(await check("shot.PNG", 5 * MB + 1)).toContain("at most 5 MB");
      expect(await check("song.mp3", 1)).toContain("only images");
      expect(await check("huge.md", 100 * MB)).toContain("at most 20 MB");
      expect((await sendTo(gui, "POST", "/api/plan/uploads/check", { name: "", sizeBytes: 1 })).status).toBe(400);
      expect((await sendTo(gui, "POST", "/api/plan/uploads/check", { name: "a.md", sizeBytes: -1 })).status).toBe(400);
    },
    SLOW,
  );

  for (const way of ["paste", "drop", "button"] as const)
    it(
      `FR-PLAN-022, FR-PLAN-041 QA (${way}): a mix of files: the allowed ones become chips, each refused one is named with its own reason and Remove file, and is never uploaded`,
      async () => {
        const root = project();
        const { gui } = await startGui(root);
        const { page, uploaded } = await openPanel(gui);
        await give(page, way, [
          ["notes.md", 10],
          ["song.mp3", 10],
          ["big.png", 5 * MB + 1],
          ["huge.pdf", 100 * MB],
          ["shot.png", 1000],
        ]);
        await expect.poll(() => errors(page).count(), WAIT).toBe(3);
        await expect.poll(() => chips(page).count(), WAIT).toBe(2);
        const texts = await errors(page).allTextContents();
        expect(texts.find((text) => text.includes("song.mp3"))).toMatch(/only images/);
        expect(texts.find((text) => text.includes("big.png"))).toMatch(/5 MB/);
        expect(texts.find((text) => text.includes("huge.pdf"))).toMatch(/20 MB/);
        for (const error of await errors(page).all())
          expect(await error.getByRole("button", { name: "Remove file" }).count()).toBe(1);
        expect([...uploaded].sort()).toEqual(["notes.md", "shot.png"]);
        expect((await page.locator("#plan-panel").textContent()) ?? "").not.toContain("Failed to fetch");
        // Remove file takes away only its own refusal.
        await errors(page).filter({ hasText: "big.png" }).getByRole("button", { name: "Remove file" }).click();
        const left = await errors(page).allTextContents();
        expect(left).toHaveLength(2);
        expect(left.join(" ")).not.toContain("big.png");
        expect(await chips(page).count()).toBe(2);
      },
      SLOW,
    );

  it(
    "FR-PLAN-022 QA: a document of exactly 20 MB and an image of exactly 5 MB are attached, not refused",
    async () => {
      const root = project();
      const { gui } = await startGui(root);
      const { page, uploaded } = await openPanel(gui);
      await give(page, "paste", [
        ["exact.md", 20 * MB],
        ["exact.png", 5 * MB],
      ]);
      await expect.poll(() => chips(page).count(), { timeout: 60_000, interval: 200 }).toBe(2);
      expect(await errors(page).count()).toBe(0);
      expect(uploaded).toEqual(["exact.md", "exact.png"]);
    },
    SLOW,
  );

  it(
    "FR-PLAN-041 QA: refusals clear when the message is sent, and the sent message has only the allowed file",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ message: "Who is it for?" }]);
      const { page } = await openPanel(gui);
      await give(page, "paste", [
        ["song.mp3", 10],
        ["notes.md", 10],
      ]);
      await expect.poll(() => errors(page).count(), WAIT).toBe(1);
      await expect.poll(() => chips(page).count(), WAIT).toBe(1);
      await page.locator("#plan-text").fill("A patient portal");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => harness.calls().length, WAIT).toBe(1);
      await expect.poll(() => errors(page).count(), WAIT).toBe(0);
      const prompt = harness.calls()[0]?.prompt ?? "";
      expect(prompt).toContain("notes.md");
      expect(prompt).not.toContain("song.mp3");
    },
    SLOW,
  );

  it(
    "FR-PLAN-041 QA: refusals belong to the session they happened in, and clear when another session is chosen",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root);
      const other = await unheldSession(root, harness.environment.HOME ?? "", [
        line("user", "Another idea"),
        line("assistant", [{ type: "text", text: "Tell me more." }]),
      ]);
      const { page } = await openPanel(gui);
      await give(page, "paste", [
        ["song.mp3", 10],
        ["tool.exe", 10],
      ]);
      await expect.poll(() => errors(page).count(), WAIT).toBe(2);
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${other.id}"] [role=menuitem]`).click();
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(1);
      expect(await errors(page).count()).toBe(0);
    },
    SLOW,
  );

  it(
    "FR-PLAN-041 QA: an unavailable session's banner names why and Cancel session cancels it",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root);
      const lost = await openPlanStore(root).create((id) => ({
        ...newPlanSession({
          id,
          target: { kind: "new-roadmap" },
          summary: "Lost idea",
          holder: { place: "terminal", pid: process.pid },
          claudeSessionId: randomUUID(),
          transcriptPath: path.join(makeTempFolder(), "never.jsonl"),
          now: new Date().toISOString(),
        }),
        holder: null,
      }));
      const { page } = await openPanel(gui);
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${lost.id}"] [role=menuitem]`).click();
      const banner = page.locator("#plan-banner");
      await expect.poll(() => banner.textContent(), WAIT).toContain("can't be found");
      expect(await page.locator("#plan-text").isDisabled()).toBe(true);
      await banner.getByRole("button", { name: "Cancel session" }).click();
      await expect.poll(async () => (await openPlanStore(root).read(lost.id))?.status, WAIT).toBe("cancelled");
      await expect.poll(() => banner.isHidden(), WAIT).toBe(true);
      expect(harness.calls()).toHaveLength(0);
    },
    SLOW,
  );
});

describe("QA: sources stay with their turn (DEF-9)", () => {
  it(
    "FR-PLAN-037 QA: in a session Claude Code drives, a later turn without plan_suggest doesn't show the session's older sources",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root);
      const sources = [{ title: "One", url: "https://first.example.org/a" }];
      // Claude Code drives the PM through the MCP tools: plan_suggest saved the sources on the record, and no
      // luseen turn cleared them before the next message.
      const session = await unheldSession(
        root,
        harness.environment.HOME ?? "",
        [
          line("user", "Question 1"),
          line("assistant", [
            {
              type: "tool_use",
              id: "s1",
              name: "mcp__luseen__plan_suggest",
              input: { suggestions: ["Yes"], sources },
            },
          ]),
          line("user", [{ type: "tool_result", tool_use_id: "s1", content: "Shown" }]),
          line("assistant", [{ type: "text", text: "First answer" }]),
          line("user", "Question 2"),
          line("assistant", [{ type: "text", text: "Second answer, no sources" }]),
        ],
        { sources },
      );
      const { page } = await openPanel(gui);
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${session.id}"] [role=menuitem]`).click();
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      const shown = await page
        .locator("#plan-panel .plan-pm")
        .evaluateAll((nodes) => nodes.map((node) => node.querySelector(".plan-sources")?.textContent ?? ""));
      expect(shown[0]).toContain("first.example.org");
      expect(shown[1]).toBe("");
    },
    SLOW,
  );

  it(
    "FR-PLAN-037 QA: a luseen note (Propose now) starts a new turn, so sources given after it show only under its reply",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root);
      const { PROPOSE_NOW_MESSAGE } = await import("../../src/core/planning.js");
      const session = await unheldSession(root, harness.environment.HOME ?? "", [
        line("user", "Question 1"),
        line("assistant", [{ type: "text", text: "First answer" }]),
        line("user", PROPOSE_NOW_MESSAGE),
        line("assistant", [
          {
            type: "tool_use",
            id: "s2",
            name: "mcp__luseen__plan_suggest",
            input: { suggestions: ["Ok"], sources: [{ title: "Two", url: "https://second.example.org/b" }] },
          },
        ]),
        line("user", [{ type: "tool_result", tool_use_id: "s2", content: "Shown" }]),
        line("assistant", [{ type: "text", text: "Here is a plan." }]),
      ]);
      const { page } = await openPanel(gui);
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${session.id}"] [role=menuitem]`).click();
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      const shown = await page
        .locator("#plan-panel .plan-pm")
        .evaluateAll((nodes) => nodes.map((node) => node.querySelector(".plan-sources")?.textContent ?? ""));
      expect(shown[0]).toBe("");
      expect(shown[1]).toContain("second.example.org");
    },
    SLOW,
  );
});
