/// <reference lib="dom" />
/**
 * QA run 7 probes around DEF-15 and DEF-16: Stop and Retry sequences in the terminal and the GUI, a Propose now or
 * a new message after a stop, cancel and approve after a stop, and a Claude Code resume after a GUI stop
 * (roadmap-planning FR-PLAN-014, FR-PLAN-030, FR-PLAN-031, FR-PLAN-038, TC-PLAN-072). Tests named with "QA" assert
 * what the spec says.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { input } from "@inquirer/prompts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import { openTaskStore, tasksDatabaseFile } from "../../src/adapters/storage/task-store.js";
import { createProjectServer } from "../../src/cli/mcp-command.js";
import { runPlanCommand } from "../../src/cli/plan-command.js";
import { createReporter } from "../../src/cli/reporter.js";
import { answerLastMessage, PROPOSE_NOW_MESSAGE, type RoadmapProposal } from "../../src/core/planning.js";
import { startTestGui, type TestGui } from "../support/gui.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn(), input: vi.fn() }));
const inputMock = vi.mocked(input);

const WAIT = { timeout: 30_000, interval: 100 };
const SLOW = 120_000;
const SPAWN_WAIT = { timeout: 15_000, interval: 50 };

let browser: Browser;
const running: TestGui[] = [];
const clients: Client[] = [];
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
  await Promise.all(clients.splice(0).map((client) => client.close()));
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

const proposal: RoadmapProposal = {
  roadmap: { title: "Portal", goal: "Book visits" },
  milestones: [
    {
      title: "Sign-in",
      goal: "Log in",
      tasks: [{ key: "a", title: "Login", description: "Log in", spec: null, dependsOn: [] }],
    },
  ],
  openQuestions: [],
};

function roadmapTitles(root: string): string[] {
  if (!existsSync(tasksDatabaseFile(path.join(root, ".luseen")))) return [];
  const store = openTaskStore(path.join(root, ".luseen"), "read");
  const titles = store?.listRoadmaps().map((item) => item.title) ?? [];
  store?.close();
  return titles;
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
const countOf = async (page: Page, text: string) =>
  (await usersShown(page)).filter((shown) => shown.includes(text)).length;
const buttonsShown = (page: Page) =>
  page.evaluate(() => {
    const box = document.getElementById("plan-suggestions") as HTMLElement;
    return box.hidden ? [] : [...box.querySelectorAll("button")].map((node) => node.textContent);
  });

async function sendAndWait(page: Page, harness: ReturnType<typeof agentHarness>, text: string, calls: number) {
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
}

const retryButton = (page: Page) => page.locator("#plan-panel").getByRole("button", { name: "Retry" });

async function retryAndWait(page: Page, harness: ReturnType<typeof agentHarness>, calls: number) {
  await expect.poll(() => retryButton(page).isVisible(), WAIT).toBe(true);
  await retryButton(page).click();
  await expect.poll(() => harness.calls().length, WAIT).toBe(calls);
}

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

/** Whether Claude Code has written the user's message `text` to plan-1's transcript. */
async function isWritten(root: string, text: string): Promise<boolean> {
  const file = (await openPlanStore(root).read("plan-1"))?.transcriptPath ?? "";
  if (!existsSync(file)) return false;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .some((item) => {
      const entry = JSON.parse(item) as { type: string; message: { content: unknown } };
      return entry.type === "user" && entry.message.content === text;
    });
}

describe("QA run 7: TC-PLAN-072 in the terminal", () => {
  for (const beforeTranscript of [false, true])
    it(
      `TC-PLAN-072 (terminal${beforeTranscript ? ", stopped before Claude wrote anything" : ""}): every --resume ${beforeTranscript ? 'repeats "Patients" once, never nested' : "asks without repeating it"}, and the history shows it once`,
      async () => {
        const root = project();
        const harness = agentHarness({ rules: [{ message: "Who uses it?" }, { hang: true, beforeTranscript }] });
        inputMock.mockResolvedValueOnce("A portal").mockResolvedValueOnce("Patients");
        const first = planInTerminal(root, harness);
        await vi.waitFor(async () => {
          expect(harness.calls()).toHaveLength(2);
          if (!beforeTranscript) expect(await isWritten(root, "Patients")).toBe(true);
        }, SPAWN_WAIT);
        harness.controller.abort();
        await first;
        // FR-PLAN-014: "Patients" is repeated only when no stopped turn wrote it to the transcript.
        const expected = answerLastMessage(beforeTranscript ? "Patients" : null);
        for (let stop = 0; stop < 2; stop += 1) {
          const again = agentHarness({
            rules: [{ hang: true, beforeTranscript }],
            env: { HOME: harness.environment.HOME },
          });
          const resumed = planInTerminal(root, again, "plan-1");
          await vi.waitFor(() => {
            expect(again.calls()).toHaveLength(1);
          }, SPAWN_WAIT);
          again.controller.abort();
          await resumed;
          expect(again.calls()[0]?.prompt).toBe(expected);
          expect(again.calls()[0]?.args).toContain("--resume");
        }
        const last = agentHarness({
          rules: [{ message: "Patients, noted." }],
          env: { HOME: harness.environment.HOME },
        });
        inputMock.mockRejectedValueOnce(new Error("stop here"));
        await planInTerminal(root, last, "plan-1");
        expect(last.calls()[0]?.prompt).toBe(expected);
        expect(last.output.err).toContain("PM › Patients, noted.");
        // The history shown on resume has the user's message once, as theirs, and never luseen's own request.
        const history = last.output.err;
        expect(history.split("You › Patients").length - 1, history).toBe(1);
        expect(history).not.toContain("You › Your last turn was stopped");
        expect((await openPlanStore(root).read("plan-1"))?.unansweredMessage).toBeNull();
      },
      SLOW,
    );
});

describe("QA run 7: after a stop in the GUI", () => {
  it(
    "FR-PLAN-024, FR-PLAN-014 QA: Propose now after a stop keeps the user's message for a later Retry, shown once, with no old suggestions",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        { message: "Who uses it?", tools: [{ name: "plan_suggest", input: { suggestions: ["Patients", "Staff"] } }] },
        { hang: true, beforeTranscript: true },
        { hang: true },
        { message: "Here it is.", tools: [{ name: "plan_propose", input: { proposal } }] },
      ]);
      const page = await openPanel(gui);
      await sendAndWait(page, harness, "A portal", 1);
      await expect.poll(() => buttonsShown(page), WAIT).toEqual(["Patients", "Staff"]);
      await sendAndWait(page, harness, "Patients", 2);
      await stopAndWait(page);
      expect(await countOf(page, "Patients")).toBe(1);
      expect(await buttonsShown(page)).toEqual([]);
      await page.locator("#plan-propose").click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(3);
      expect(harness.calls()[2]?.prompt).toBe(PROPOSE_NOW_MESSAGE);
      expect((await openPlanStore(root).read("plan-1"))?.unansweredMessage).toBe("Patients");
      await stopAndWait(page);
      expect(await countOf(page, "Patients")).toBe(1);
      expect(await buttonsShown(page)).toEqual([]);
      await retryAndWait(page, harness, 4);
      const prompt = harness.calls()[3]?.prompt ?? "";
      expect(prompt.split("Patients").length - 1).toBe(1);
      expect(prompt.split("Your last turn was stopped.").length - 1).toBe(1);
      await expect.poll(() => page.locator("#plan-panel .plan-card").count(), WAIT).toBe(1);
      await idle(page);
      expect(await countOf(page, "Patients")).toBe(1);
      expect(await buttonsShown(page)).toEqual([]);
      expect((await usersShown(page)).join("\n")).not.toContain("Propose now");
    },
    SLOW,
  );

  it(
    "FR-PLAN-030 QA: a new message after a stop replaces the unanswered one; a Retry of it repeats only the new one",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        { message: "Who uses it?" },
        { hang: true },
        { hang: true, beforeTranscript: true },
        { message: "Staff, noted." },
      ]);
      const page = await openPanel(gui);
      await sendAndWait(page, harness, "A portal", 1);
      await idle(page);
      await sendAndWait(page, harness, "Patients", 2);
      await stopAndWait(page);
      await sendAndWait(page, harness, "Staff", 3);
      expect(harness.calls()[2]?.prompt).toBe("Staff");
      expect((await openPlanStore(root).read("plan-1"))?.unansweredMessage).toBe("Staff");
      await stopAndWait(page);
      expect(await countOf(page, "Staff")).toBe(1);
      expect(await countOf(page, "Patients")).toBe(1);
      await retryAndWait(page, harness, 4);
      expect(harness.calls()[3]?.prompt).toBe(answerLastMessage("Staff"));
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      await idle(page);
      expect(await countOf(page, "Staff")).toBe(1);
      expect(await countOf(page, "Patients")).toBe(1);
    },
    SLOW,
  );

  it(
    "FR-PLAN-038 QA: a message with the same text as an earlier one, stopped before Claude wrote it, is still shown",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        { message: "Web?" },
        { message: "Mobile too?" },
        { hang: true, beforeTranscript: true },
      ]);
      const page = await openPanel(gui);
      await sendAndWait(page, harness, "A portal", 1);
      await idle(page);
      await sendAndWait(page, harness, "Yes", 2);
      await idle(page);
      await sendAndWait(page, harness, "Yes", 3);
      await stopAndWait(page);
      await expect.poll(() => retryButton(page).isVisible(), WAIT).toBe(true);
      // Two messages "Yes" were sent; both are the user's and both should show.
      expect(await countOf(page, "Yes")).toBe(2);
    },
    SLOW,
  );

  it(
    "FR-PLAN-014 QA: Cancel session after a stop saves nothing and closes the session",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ message: "Who uses it?" }, { hang: true }]);
      const page = await openPanel(gui);
      await sendAndWait(page, harness, "A portal", 1);
      await idle(page);
      await sendAndWait(page, harness, "Patients", 2);
      await stopAndWait(page);
      await page.locator("#plan-more").click();
      await page.locator("#plan-cancel-session").click();
      await expect.poll(async () => (await openPlanStore(root).read("plan-1"))?.status, WAIT).toBe("cancelled");
      expect(roadmapTitles(root)).toEqual(["Launch"]);
      expect(harness.calls()).toHaveLength(2);
      expect(await retryButton(page).count()).toBe(0);
    },
    SLOW,
  );

  it(
    "FR-PLAN-013, FR-PLAN-038 QA: the waiting proposal can still be approved after a later turn is stopped",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        { message: "Here it is.", tools: [{ name: "plan_propose", input: { proposal } }] },
        { hang: true },
      ]);
      const page = await openPanel(gui);
      await sendAndWait(page, harness, "A portal", 1);
      await expect.poll(() => page.locator("#plan-panel .plan-card").count(), WAIT).toBe(1);
      await idle(page);
      await sendAndWait(page, harness, "Split it", 2);
      await stopAndWait(page);
      await page.locator('#plan-panel [data-plan-decide="approve"]').click();
      await expect.poll(() => roadmapTitles(root), WAIT).toEqual(["Launch", "Portal"]);
      expect((await openPlanStore(root).read("plan-1"))?.status).toBe("approved");
    },
    SLOW,
  );
});

describe("QA run 7: Claude Code resumes after a GUI stop", () => {
  it(
    "FR-PLAN-014, FR-PLAN-030, FR-PLAN-046 QA: after Claude Code answered and moved on, reopening in the GUI doesn't ask again about the old message",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [{ message: "Who uses it?" }, { hang: true }]);
      const page = await openPanel(gui);
      await sendAndWait(page, harness, "A portal", 1);
      await idle(page);
      await sendAndWait(page, harness, "Patients", 2);
      await stopAndWait(page);
      await page.context().close();
      await Promise.all(running.splice(0).map((item) => item.stop()));

      // Claude Code resumes the session with plan_resume and the conversation goes on there.
      const server = await createProjectServer(
        { dir: root, approver: "user" },
        {
          reporter: createReporter({
            quiet: true,
            debug: false,
            color: "never",
            environment: {},
            stdout: { write: () => true },
            stderr: { write: () => true },
          }),
          environment: process.env,
          signal: new AbortController().signal,
          version: "0.1.0",
        },
      );
      const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      await client.connect(clientSide);
      clients.push(client);
      const resumed = await client.callTool({ name: "plan_resume", arguments: { planId: "plan-1" } });
      expect(resumed.isError).not.toBe(true);
      const session = await openPlanStore(root).read("plan-1");
      const transcript = session?.transcriptPath ?? "";
      expect(readFileSync(transcript, "utf8")).toContain("Patients");
      const line = (type: string, content: unknown) =>
        `${JSON.stringify({ type, timestamp: new Date().toISOString(), message: { role: type, content } })}\n`;
      appendFileSync(transcript, line("assistant", [{ type: "text", text: "Patients, noted. Anyone else?" }]));
      appendFileSync(transcript, line("user", "Staff too"));
      appendFileSync(transcript, line("assistant", [{ type: "text", text: "Staff, noted." }]));
      await client.close();
      clients.splice(0);
      await openPlanStore(root).update("plan-1", (current) => ({
        save: { ...current, holder: { place: "claude-code", pid: 2 ** 30 } },
        value: undefined,
      }));

      const next = await startGui(root, [{ message: "Should not be called" }], { HOME: harness.environment.HOME });
      const reopened = await openPanel(next.gui);
      await choose(reopened, "plan-1");
      await expect.poll(() => reopened.locator("#plan-panel .plan-pm").count(), WAIT).toBe(3);
      await reopened.waitForTimeout(1_500);
      // The user's last message, "Staff too", has its reply, so no turn asks the PM to answer "Patients" again.
      expect(next.harness.calls().map((call) => call.prompt)).toEqual([]);
      const users = await usersShown(reopened);
      expect(users.at(-1)).toContain("Staff too");
      expect(users.filter((text) => text.includes("Patients"))).toHaveLength(1);
    },
    SLOW,
  );
});
