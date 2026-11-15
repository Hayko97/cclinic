/// <reference lib="dom" />
/**
 * QA run 8 probes around DEF-17, DEF-18 and DEF-19: a stopped turn answered elsewhere, in Claude Code, then resumed
 * in the terminal and the GUI; a turn stopped after the PM wrote part of its turn; the terminal's resumed history
 * (roadmap-planning FR-PLAN-014, FR-PLAN-031, FR-PLAN-038, FR-PLAN-046, TC-PLAN-073). Tests named with "QA" assert
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
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { createProjectServer } from "../../src/cli/mcp-command.js";
import { runPlanCommand } from "../../src/cli/plan-command.js";
import { createReporter } from "../../src/cli/reporter.js";
import { answerLastMessage } from "../../src/core/planning.js";
import { startTestGui, type TestGui } from "../support/gui.js";
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

/** Starts "A portal", gets "Who uses it?", sends "Patients" and stops it in the terminal. */
async function stoppedInTerminal(
  root: string,
  rules: FakeClaudeRule[] = [{ message: "Who uses it?" }, { hang: true }],
) {
  const harness = agentHarness({ rules });
  inputMock.mockResolvedValueOnce("A portal").mockResolvedValueOnce("Patients");
  const first = planInTerminal(root, harness);
  // The turn for "Patients" is stopped after Claude Code wrote the message, as it does when the turn starts.
  await vi.waitFor(async () => {
    expect(harness.calls()).toHaveLength(2);
    expect(await isWritten(root, "Patients")).toBe(true);
  }, SPAWN_WAIT);
  return {
    harness,
    stop: async () => {
      harness.controller.abort();
      await first;
    },
  };
}

/** Claude Code takes the session with plan_resume, as `claude` with luseen's MCP server does. */
async function resumeInClaudeCode(root: string): Promise<void> {
  const quiet = { write: () => true };
  const server = await createProjectServer(
    { dir: root, approver: "user" },
    {
      reporter: createReporter({
        quiet: true,
        debug: false,
        color: "never",
        environment: {},
        stdout: quiet,
        stderr: quiet,
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
  const resumed = await client.callTool({ name: "plan_resume", arguments: { planId: "plan-1" } });
  expect(resumed.isError).not.toBe(true);
  await client.close();
}

const line = (type: string, content: unknown, withTime = true) =>
  `${JSON.stringify({ type, ...(withTime ? { timestamp: new Date().toISOString() } : {}), message: { role: type, content } })}\n`;

async function transcriptOf(root: string): Promise<string> {
  const session = await openPlanStore(root).read("plan-1");
  const file = session?.transcriptPath ?? "";
  expect(existsSync(file)).toBe(true);
  return file;
}

/** In Claude Code: the PM answers "Patients", and the user and PM exchange one more message. */
async function answeredInClaudeCode(root: string, withTime = true): Promise<void> {
  const file = await transcriptOf(root);
  appendFileSync(file, line("assistant", [{ type: "text", text: "Patients, noted. Anyone else?" }], withTime));
  appendFileSync(file, line("user", "Staff too", withTime));
  appendFileSync(file, line("assistant", [{ type: "text", text: "Staff, noted." }], withTime));
}

/** Claude Code has exited: its hold is on a process that's no longer running. */
async function claudeCodeExited(root: string): Promise<void> {
  await openPlanStore(root).update("plan-1", (current) => ({
    save: { ...current, holder: { place: "claude-code", pid: 2 ** 30 } },
    value: undefined,
  }));
}

const count = (text: string, part: string) => text.split(part).length - 1;

/** Whether Claude Code has written the user's message `text` to plan-1's transcript. */
async function isWritten(root: string, text: string): Promise<boolean> {
  const file = (await openPlanStore(root).read("plan-1"))?.transcriptPath ?? "";
  if (!existsSync(file)) return false;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .some((entry) => {
      const parsed = JSON.parse(entry) as { type: string; message: { content: unknown } };
      return parsed.type === "user" && parsed.message.content === text;
    });
}

describe("QA run 8: TC-PLAN-073", () => {
  it(
    "TC-PLAN-073 (terminal): a turn stopped in the terminal and answered in Claude Code isn't asked again on --resume",
    async () => {
      const root = project();
      const { harness, stop } = await stoppedInTerminal(root);
      await stop();
      await resumeInClaudeCode(root);
      await answeredInClaudeCode(root);
      await claudeCodeExited(root);

      const again = agentHarness({
        rules: [{ message: "Should not be called" }],
        env: { HOME: harness.environment.HOME },
      });
      inputMock.mockRejectedValueOnce(new Error("stop here"));
      await planInTerminal(root, again, "plan-1");
      expect(again.calls()).toEqual([]);
      const record = await openPlanStore(root).read("plan-1");
      expect(record?.isAwaitingReply).toBe(false);
      expect(record?.unansweredMessage).toBeNull();
      expect(record?.turnStartedAt).toBeNull();
      const history = again.output.err;
      expect(count(history, "You › Patients"), history).toBe(1);
      expect(count(history, "You › Staff too"), history).toBe(1);
      expect(count(history, "You › A portal"), history).toBe(1);
      expect(history).toContain("PM › Staff, noted.");
      expect(history).not.toContain("Your last turn was stopped");
      // The newest message shown is the PM's last reply, not the old "Patients".
      expect(history.lastIndexOf("You › Patients")).toBeLessThan(history.indexOf("PM › Patients, noted."));
    },
    SLOW,
  );

  it(
    "TC-PLAN-073 (GUI, then terminal): a turn stopped in the GUI and answered in Claude Code starts no turn and offers no Retry",
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
      expect((await openPlanStore(root).read("plan-1"))?.turnStartedAt).not.toBeNull();

      await resumeInClaudeCode(root);
      await answeredInClaudeCode(root);
      await claudeCodeExited(root);

      const next = await startGui(root, [{ message: "Should not be called" }], { HOME: harness.environment.HOME });
      const reopened = await openPanel(next.gui);
      await choose(reopened, "plan-1");
      await expect.poll(() => reopened.locator("#plan-panel .plan-pm").count(), WAIT).toBe(3);
      await reopened.waitForTimeout(1_500);
      expect(next.harness.calls()).toEqual([]);
      expect(await retryButton(reopened).count()).toBe(0);
      const users = await usersShown(reopened);
      expect(users.filter((text) => text.includes("Patients"))).toHaveLength(1);
      expect(users.at(-1)).toContain("Staff too");
      // The GUI writes the record when it takes the session, which may land after the page has drawn.
      await expect.poll(async () => (await openPlanStore(root).read("plan-1"))?.isAwaitingReply, WAIT).toBe(false);
      expect((await openPlanStore(root).read("plan-1"))?.unansweredMessage).toBeNull();
      await reopened.context().close();
      await Promise.all(running.splice(0).map((item) => item.stop()));

      const terminal = agentHarness({
        rules: [{ message: "Should not be called" }],
        env: { HOME: harness.environment.HOME },
      });
      inputMock.mockRejectedValueOnce(new Error("stop here"));
      await planInTerminal(root, terminal, "plan-1");
      expect(terminal.calls()).toEqual([]);
      expect(count(terminal.output.err, "You › Patients")).toBe(1);
    },
    SLOW,
  );
});

describe("QA run 8: probes around answered turns", () => {
  it(
    "FR-PLAN-038, FR-PLAN-042 QA: viewing a session Claude Code holds, after it answered a turn the GUI stopped, doesn't show the old message again",
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

      await resumeInClaudeCode(root);
      await answeredInClaudeCode(root);
      // Claude Code is still running and holds the session.
      await openPlanStore(root).update("plan-1", (current) => ({
        save: { ...current, holder: { place: "claude-code", pid: process.pid } },
        value: undefined,
      }));

      const next = await startGui(root, [{ message: "Should not be called" }], { HOME: harness.environment.HOME });
      const viewer = await openPanel(next.gui);
      await choose(viewer, "plan-1");
      await expect.poll(() => viewer.locator("#plan-panel .plan-pm").count(), WAIT).toBe(3);
      await viewer.waitForTimeout(1_000);
      const users = await usersShown(viewer);
      expect(
        users.filter((text) => text.includes("Patients")),
        users.join(" | "),
      ).toHaveLength(1);
      expect(users.at(-1)).toContain("Staff too");
      expect(next.harness.calls()).toEqual([]);
    },
    SLOW,
  );

  it(
    "FR-PLAN-014 QA: a turn stopped after the PM wrote only a lead-in and a tool call has no complete reply, so --resume asks again",
    async () => {
      const root = project();
      const { harness, stop } = await stoppedInTerminal(root);
      await vi.waitFor(async () => {
        expect(readFileSync(await transcriptOf(root), "utf8")).toContain("Patients");
      }, SPAWN_WAIT);
      const file = await transcriptOf(root);
      // Claude Code writes each block as it comes: a lead-in text, then the tool call it was running when stopped.
      appendFileSync(file, line("assistant", [{ type: "text", text: "Let me look at the specs first." }]));
      appendFileSync(file, line("assistant", [{ type: "tool_use", id: "r", name: "Read", input: { file_path: "a" } }]));
      await stop();

      const again = agentHarness({ rules: [{ message: "Patients, noted." }], env: { HOME: harness.environment.HOME } });
      inputMock.mockRejectedValueOnce(new Error("stop here"));
      await planInTerminal(root, again, "plan-1");
      // FR-PLAN-014: the transcript has "Patients", so it's asked again without repeating it.
      expect(again.calls().map((call) => call.prompt)).toEqual([answerLastMessage(null)]);
    },
    SLOW,
  );

  it(
    "FR-PLAN-031 QA: the terminal's resumed history shows a repeated message stopped before Claude wrote it",
    async () => {
      const root = project();
      const harness = agentHarness({
        rules: [{ message: "Web?" }, { message: "Mobile too?" }, { hang: true, beforeTranscript: true }],
      });
      inputMock.mockResolvedValueOnce("A portal").mockResolvedValueOnce("Yes").mockResolvedValueOnce("Yes");
      const first = planInTerminal(root, harness);
      await vi.waitFor(() => {
        expect(harness.calls()).toHaveLength(3);
      }, SPAWN_WAIT);
      harness.controller.abort();
      await first;
      const again = agentHarness({ rules: [{ hang: true }], env: { HOME: harness.environment.HOME } });
      const resumed = planInTerminal(root, again, "plan-1");
      await vi.waitFor(() => {
        expect(again.calls()).toHaveLength(1);
      }, SPAWN_WAIT);
      again.controller.abort();
      await resumed;
      expect(again.calls()[0]?.prompt).toBe(answerLastMessage("Yes"));
      const history = again.output.err;
      expect(count(history, "You › Yes"), history).toBe(2);
      expect(history.lastIndexOf("You › Yes")).toBeGreaterThan(history.indexOf("PM › Mobile too?"));
    },
    SLOW,
  );

  it(
    "FR-PLAN-031 QA (probe, unspecified): a session answered in Claude Code whose transcript lines have no timestamps",
    async () => {
      const root = project();
      const { harness, stop } = await stoppedInTerminal(root);
      await stop();
      await resumeInClaudeCode(root);
      await answeredInClaudeCode(root, false);
      await claudeCodeExited(root);
      const again = agentHarness({ rules: [{ message: "Noted." }], env: { HOME: harness.environment.HOME } });
      inputMock.mockRejectedValueOnce(new Error("stop here"));
      const outcome = await planInTerminal(root, again, "plan-1");
      // Recorded for the report: no timestamps means luseen can't tell the turn was answered.
      console.log(
        "QA probe, no timestamps:",
        JSON.stringify({ prompts: again.calls().map((call) => call.prompt), outcome: String(outcome) }),
      );
      expect(count(again.output.err, "You › Staff too")).toBe(1);
    },
    SLOW,
  );
});

/** A lead-in the PM wrote before it was stopped, optionally followed by the tool call it was running. */
async function leadInWritten(root: string, withToolCall: boolean): Promise<void> {
  await vi.waitFor(async () => {
    expect(readFileSync(await transcriptOf(root), "utf8")).toContain("Patients");
  }, SPAWN_WAIT);
  const file = await transcriptOf(root);
  appendFileSync(file, line("assistant", [{ type: "text", text: "Let me look at the specs first." }]));
  if (withToolCall)
    appendFileSync(file, line("assistant", [{ type: "tool_use", id: "r", name: "Read", input: { file_path: "a" } }]));
}

/** An ISO time `ms` from now, written with a +01:00 offset instead of Z. */
function offsetTime(ms: number): string {
  const shifted = new Date(Date.now() + ms + 60 * 60 * 1000).toISOString();
  return `${shifted.slice(0, -1)}+01:00`;
}

/** Claude Code holds the session, in a process that's still running. */
async function claudeCodeHolds(root: string): Promise<void> {
  await openPlanStore(root).update("plan-1", (current) => ({
    save: { ...current, holder: { place: "claude-code", pid: process.pid } },
    value: undefined,
  }));
}

async function stoppedInGui(root: string, rules: FakeClaudeRule[] = [{ message: "Who uses it?" }, { hang: true }]) {
  const { gui, harness } = await startGui(root, rules);
  const page = await openPanel(gui);
  await sendAndWait(page, harness, "A portal", 1);
  await idle(page);
  await sendAndWait(page, harness, "Patients", 2);
  return { gui, harness, page };
}

async function closeGuis(page?: Page) {
  if (page !== undefined) await page.context().close();
  await Promise.all(running.splice(0).map((item) => item.stop()));
}

describe("QA run 9: TC-PLAN-074", () => {
  it(
    'TC-PLAN-074 (terminal): a turn stopped after a lead-in and a tool call is asked again without repeating "Patients", which the transcript has, and the history shows it once',
    async () => {
      const root = project();
      const { harness, stop } = await stoppedInTerminal(root);
      await leadInWritten(root, true);
      await stop();

      const again = agentHarness({ rules: [{ hang: true }], env: { HOME: harness.environment.HOME } });
      const resumed = planInTerminal(root, again, "plan-1");
      await vi.waitFor(() => {
        expect(again.calls()).toHaveLength(1);
      }, SPAWN_WAIT);
      again.controller.abort();
      await resumed;
      // FR-PLAN-014: Claude Code wrote "Patients" before the stop, so the request doesn't repeat it.
      expect(again.calls()[0]?.prompt).toBe(answerLastMessage(null));
      const history = again.output.err;
      expect(count(history, "You › Patients"), history).toBe(1);
    },
    SLOW,
  );

  it(
    'TC-PLAN-074 (GUI): a session Claude Code still holds after answering a stopped turn shows "Patients" once, no Retry and no waiting bubble',
    async () => {
      const root = project();
      const { harness, page } = await stoppedInGui(root);
      await stopAndWait(page);
      await closeGuis(page);
      await resumeInClaudeCode(root);
      await answeredInClaudeCode(root);
      await claudeCodeHolds(root);

      const next = await startGui(root, [{ message: "Should not be called" }], { HOME: harness.environment.HOME });
      const viewer = await openPanel(next.gui);
      await choose(viewer, "plan-1");
      await expect.poll(() => viewer.locator("#plan-panel .plan-pm").count(), WAIT).toBe(3);
      await viewer.waitForTimeout(1_500);
      const users = await usersShown(viewer);
      expect(
        users.filter((text) => text.includes("Patients")),
        users.join(" | "),
      ).toHaveLength(1);
      expect(users.at(-1)).toContain("Staff too");
      expect(await retryButton(viewer).count()).toBe(0);
      expect(await viewer.locator("#plan-panel .plan-working").count()).toBe(0);
      expect(next.harness.calls()).toEqual([]);
      // Only viewing: the record held elsewhere isn't written.
      const record = await openPlanStore(root).read("plan-1");
      expect(record?.isAwaitingReply).toBe(true);
      expect(record?.holder?.place).toBe("claude-code");
    },
    SLOW,
  );
});

describe("QA run 9: probes around the answered rule", () => {
  it(
    'FR-PLAN-014 QA: a GUI held view, then a take-over once Claude Code exits, then the terminal: no turn, no Retry, "Patients" once each time',
    async () => {
      const root = project();
      const { harness, page } = await stoppedInGui(root);
      await stopAndWait(page);
      await closeGuis(page);
      await resumeInClaudeCode(root);
      // Claude Code answers with text only; the user writes nothing more there.
      appendFileSync(await transcriptOf(root), line("assistant", [{ type: "text", text: "Patients, noted." }]));
      await claudeCodeHolds(root);

      const next = await startGui(root, [{ message: "Should not be called" }], { HOME: harness.environment.HOME });
      const viewer = await openPanel(next.gui);
      await choose(viewer, "plan-1");
      await expect.poll(() => viewer.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      await viewer.waitForTimeout(1_000);
      expect((await usersShown(viewer)).filter((text) => text.includes("Patients"))).toHaveLength(1);
      expect(await retryButton(viewer).count()).toBe(0);

      await claudeCodeExited(root);
      await viewer.reload();
      await viewer.locator('[data-key="task-1"]').waitFor();
      await viewer.locator("#plan-open").click();
      // Choosing the session already shown does nothing, so take it over through New session, then the session.
      console.log("QA probe, composer after Claude Code exited:", await viewer.locator("#plan-text").isDisabled());
      await viewer.locator("#plan-sessions-button").click();
      await viewer.locator("#plan-sessions-menu [role=menuitem]").first().click();
      await choose(viewer, "plan-1");
      await expect.poll(() => viewer.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      await viewer.waitForTimeout(1_500);
      expect(next.harness.calls()).toEqual([]);
      expect(await retryButton(viewer).count()).toBe(0);
      expect((await usersShown(viewer)).filter((text) => text.includes("Patients"))).toHaveLength(1);
      await expect.poll(async () => (await openPlanStore(root).read("plan-1"))?.isAwaitingReply, WAIT).toBe(false);
      await closeGuis(viewer);

      const terminal = agentHarness({
        rules: [{ message: "Should not be called" }],
        env: { HOME: harness.environment.HOME },
      });
      inputMock.mockRejectedValueOnce(new Error("stop here"));
      await planInTerminal(root, terminal, "plan-1");
      expect(terminal.calls()).toEqual([]);
      expect(count(terminal.output.err, "You › Patients")).toBe(1);
      expect(terminal.output.err).toContain("PM › Patients, noted.");
    },
    SLOW,
  );

  it(
    'FR-PLAN-038 QA: a GUI turn stopped after a lead-in and a tool call shows "Patients" once, with Retry',
    async () => {
      const root = project();
      const { page } = await stoppedInGui(root);
      await leadInWritten(root, true);
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      await page.waitForTimeout(1_000);
      const working = await usersShown(page);
      expect(
        working.filter((text) => text.includes("Patients")),
        `while working: ${working.join(" | ")}`,
      ).toHaveLength(1);
      await stopAndWait(page);
      await page.waitForTimeout(1_000);
      const users = await usersShown(page);
      expect(
        users.filter((text) => text.includes("Patients")),
        users.join(" | "),
      ).toHaveLength(1);
      expect(await retryButton(page).count()).toBe(1);
    },
    SLOW,
  );

  it(
    "FR-PLAN-014 QA (probe): a turn stopped after only a lead-in, with no tool call, on --resume",
    async () => {
      const root = project();
      const { harness, stop } = await stoppedInTerminal(root);
      await leadInWritten(root, false);
      await stop();
      const again = agentHarness({ rules: [{ message: "Noted." }], env: { HOME: harness.environment.HOME } });
      inputMock.mockRejectedValueOnce(new Error("stop here"));
      await planInTerminal(root, again, "plan-1");
      console.log(
        "QA probe, lead-in only:",
        JSON.stringify({
          prompts: again.calls().map((call) => call.prompt),
          patientsShown: count(again.output.err, "You › Patients"),
        }),
      );
      expect(count(again.output.err, "You › Patients")).toBe(1);
    },
    SLOW,
  );

  it(
    "FR-PLAN-014 QA: entries with no time never count, so a turn answered in Claude Code without timestamps is asked again",
    async () => {
      const root = project();
      const { harness, stop } = await stoppedInTerminal(root);
      await stop();
      await resumeInClaudeCode(root);
      await answeredInClaudeCode(root, false);
      await claudeCodeExited(root);
      const again = agentHarness({ rules: [{ hang: true }], env: { HOME: harness.environment.HOME } });
      const resumed = planInTerminal(root, again, "plan-1");
      await vi.waitFor(() => {
        expect(again.calls()).toHaveLength(1);
      }, SPAWN_WAIT);
      again.controller.abort();
      await resumed;
      // FR-PLAN-014: "Patients" was written, with its time, after the turn started, so it isn't repeated.
      expect(again.calls()[0]?.prompt).toBe(answerLastMessage(null));
      console.log(
        "QA probe, no timestamps history:",
        JSON.stringify(again.output.err.split("\n").filter((l) => l.includes("›"))),
      );
    },
    SLOW,
  );

  it(
    "FR-PLAN-014 QA: a turn answered in Claude Code with +01:00 timestamps isn't asked again",
    async () => {
      const root = project();
      const { harness, stop } = await stoppedInTerminal(root);
      await stop();
      await resumeInClaudeCode(root);
      const file = await transcriptOf(root);
      const at = (ms: number, type: string, content: unknown) =>
        `${JSON.stringify({ type, timestamp: offsetTime(ms), message: { role: type, content } })}\n`;
      appendFileSync(file, at(1_000, "assistant", [{ type: "text", text: "Patients, noted." }]));
      await claudeCodeExited(root);
      const again = agentHarness({
        rules: [{ message: "Should not be called" }],
        env: { HOME: harness.environment.HOME },
      });
      inputMock.mockRejectedValueOnce(new Error("stop here"));
      await planInTerminal(root, again, "plan-1");
      expect(again.calls()).toEqual([]);
      expect((await openPlanStore(root).read("plan-1"))?.isAwaitingReply).toBe(false);
      expect(count(again.output.err, "You › Patients")).toBe(1);
    },
    SLOW,
  );

  it(
    'FR-PLAN-038 QA: Stop, Retry, Stop before Claude wrote anything, Retry answered; then --resume asks nothing and shows "Patients" once',
    async () => {
      const root = project();
      const { harness, page } = await stoppedInGui(root, [
        { message: "Who uses it?" },
        { hang: true },
        { hang: true, beforeTranscript: true },
        { message: "Patients, noted." },
      ]);
      await stopAndWait(page);
      await retryButton(page).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(3);
      await stopAndWait(page);
      await retryButton(page).click();
      await expect.poll(() => harness.calls().length, WAIT).toBe(4);
      await idle(page);
      await expect.poll(() => page.locator("#plan-panel .plan-pm").count(), WAIT).toBe(2);
      expect((await usersShown(page)).filter((text) => text.includes("Patients"))).toHaveLength(1);
      expect(await retryButton(page).count()).toBe(0);
      await closeGuis(page);

      const terminal = agentHarness({
        rules: [{ message: "Should not be called" }],
        env: { HOME: harness.environment.HOME },
      });
      inputMock.mockRejectedValueOnce(new Error("stop here"));
      await planInTerminal(root, terminal, "plan-1");
      expect(terminal.calls()).toEqual([]);
      expect(count(terminal.output.err, "You › Patients"), terminal.output.err).toBe(1);
    },
    SLOW,
  );
});
