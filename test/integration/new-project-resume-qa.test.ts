/** QA run 3 (DEF-3): resuming a new project stopped at its first roadmap, in the terminal and in the GUI (FR-PLAN-048, 053, 061). */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { input, select } from "@inquirer/prompts";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import type { PlanPanelView } from "../../src/application/gui-planning.js";
import { runPlanCommand } from "../../src/cli/plan-command.js";
import type { PlanSession, RoadmapProposal } from "../../src/core/planning.js";
import { agentHarness, makeTempFolder, type FakeClaudeRule } from "../support/helpers.js";
import { sendTo, startTestGui, type TestGui } from "../support/gui.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn(), input: vi.fn() }));
const inputMock = vi.mocked(input);
const selectMock = vi.mocked(select);

const SLOW = 180_000;
const WAIT = { timeout: 60_000, interval: 200 };
const isTty = process.stdin.isTTY;
let browser: Browser;
const running: TestGui[] = [];

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
  await Promise.all(running.splice(0).map((gui) => gui.stop()));
});

const BRIEF = [
  "# Clinic booking",
  "## What it is",
  "A web app where patients book visits with a clinic's doctors.",
  "## Who uses it",
  "- Patient: books visits",
  "## Main features",
  "### Booking",
  "- A visit is 30 minutes",
  "## Stack",
  "React with TypeScript, Vitest.",
  "## How we write code",
  "A test for every rule.",
  "## Out of scope for now",
  "Payments.",
].join("\n");

const ROADMAP: RoadmapProposal = {
  roadmap: { title: "First release", goal: "Patients book visits" },
  milestones: [
    {
      title: "Foundation",
      goal: "A runnable app shell",
      tasks: [{ key: "shell", title: "Scaffold the app", description: "Vite, lint, tests", spec: null, dependsOn: [] }],
    },
  ],
  openQuestions: [],
};

const BRIEF_RULE: FakeClaudeRule = {
  match: "empty folder",
  message: "Here's the brief.",
  tools: [{ name: "brief_propose", input: { markdown: BRIEF, hasScreens: false } }],
};
const ROADMAP_RULE: FakeClaudeRule = {
  match: "The specs are written in",
  message: "Here's the first release.",
  tools: [{ name: "plan_propose", input: { proposal: ROADMAP } }],
};
const WORKING: FakeClaudeRule[] = [ROADMAP_RULE, BRIEF_RULE];
const NO_ROADMAP: FakeClaudeRule[] = [
  { match: "The specs are written in", message: "I'll think about it." },
  BRIEF_RULE,
];
const ROADMAP_FAILED = "Planning the first roadmap didn't finish. What now?";

function emptyProject(): string {
  const root = makeTempFolder();
  mkdirSync(path.join(root, ".git"));
  return root;
}

async function onlySession(root: string): Promise<PlanSession> {
  const [session] = (await openPlanStore(root).list()).sessions;
  if (session === undefined) throw new Error("No planning session");
  return session;
}

function roadmapTitles(root: string): string[] {
  const store = openTaskStore(path.join(root, ".luseen"), "read");
  try {
    return store?.listRoadmaps().map((roadmap) => roadmap.title) ?? [];
  } finally {
    store?.close();
  }
}

type Harness = ReturnType<typeof agentHarness>;
const harnessOf = (rules: FakeClaudeRule[]) => agentHarness({ rules, env: { FAKE_CLAUDE_FALLBACK: "1" } });
const plan = (root: string, harness: Harness, resume?: string) =>
  runPlanCommand(
    { dir: root, timeoutMinutes: 5, model: "haiku", effort: "low", ...(resume === undefined ? {} : { resume }) },
    harness.context,
  );
const pmTurns = (harness: Harness) =>
  harness.calls().filter((call) => call.args.includes("--session-id") || call.args.includes("--resume"));
const asked = () => selectMock.mock.calls.map((call) => (call[0] as { message: string }).message);

function pressCtrlC(): void {
  inputMock.mockImplementationOnce(() => {
    const error = new Error("User force closed the prompt");
    error.name = "ExitPromptError";
    return Promise.reject(error);
  });
}

/** The roadmap turn stops for missing planning tools, and the user picks "later". */
async function stopForMissingTools(root: string): Promise<void> {
  const harness = harnessOf([
    { match: "The specs are written in", mcpStatus: "failed", message: "I can't save it.", times: 1 },
    ...WORKING,
  ]);
  inputMock.mockResolvedValueOnce("A booking app for a clinic").mockResolvedValueOnce("/approve");
  selectMock.mockResolvedValueOnce("later");
  await expect(plan(root, harness)).rejects.toThrow();
  expect(await onlySession(root)).toMatchObject({
    status: "open",
    proposal: null,
    project: { phase: "roadmap", isRoadmapAsked: false },
  });
  expect(roadmapTitles(root)).toEqual([]);
  selectMock.mockReset();
  inputMock.mockReset();
}

/** The roadmap turn ends with no proposal (an answered turn), and the user picks "later". */
async function stopWithNoProposal(root: string): Promise<void> {
  const harness = harnessOf(NO_ROADMAP);
  inputMock.mockResolvedValueOnce("A booking app for a clinic").mockResolvedValueOnce("/approve");
  selectMock.mockResolvedValueOnce("later");
  await expect(plan(root, harness)).rejects.toThrow();
  expect(await onlySession(root)).toMatchObject({ status: "open", proposal: null, project: { phase: "roadmap" } });
  selectMock.mockReset();
  inputMock.mockReset();
}

describe("QA run 3 (DEF-3): resuming in the terminal after a stop at the first roadmap", () => {
  it(
    "FR-PLAN-053 (QA run 3): after a missing-tools stop, a resume where the PM again proposes nothing offers Retry once, saves nothing, and a later resume saves it",
    async () => {
      const root = emptyProject();
      await stopForMissingTools(root);

      const again = harnessOf(NO_ROADMAP);
      selectMock.mockResolvedValueOnce("later");
      await expect(plan(root, again, "plan-1")).rejects.toThrow();
      expect(asked()).toEqual([ROADMAP_FAILED]);
      expect(inputMock).not.toHaveBeenCalled();
      expect(again.output.out + again.output.err).toContain("The PM ended without proposing the roadmap");
      expect(roadmapTitles(root)).toEqual([]);
      expect(await onlySession(root)).toMatchObject({
        status: "open",
        proposal: null,
        project: { phase: "roadmap", isRoadmapAsked: false },
      });
      // At most the kept message's retry and the roadmap request: the PM isn't asked in a loop.
      expect(pmTurns(again).length).toBeLessThanOrEqual(2);

      selectMock.mockReset();
      const last = harnessOf(WORKING);
      pressCtrlC();
      await plan(root, last, "plan-1").catch(() => undefined);
      expect(asked()).toEqual([]);
      expect(inputMock).not.toHaveBeenCalled();
      expect(roadmapTitles(root)).toEqual(["First release"]);
      expect(await onlySession(root)).toMatchObject({ status: "approved", project: { phase: "done" } });
    },
    SLOW,
  );

  it(
    "FR-PLAN-048 (QA run 3): after a missing-tools stop, resuming saves exactly one roadmap, and resuming again finds nothing open",
    async () => {
      const root = emptyProject();
      await stopForMissingTools(root);
      const resumed = harnessOf(WORKING);
      pressCtrlC();
      await plan(root, resumed, "plan-1").catch(() => undefined);
      expect(roadmapTitles(root)).toEqual(["First release"]);
      expect(pmTurns(resumed).every((call) => call.args.includes("--resume"))).toBe(true);
      expect(pmTurns(resumed).length).toBeLessThanOrEqual(2);
      await expect(plan(root, harnessOf(WORKING), "plan-1")).rejects.toThrow(/no open planning session plan-1/);
      expect(roadmapTitles(root)).toEqual(["First release"]);
    },
    SLOW,
  );

  it(
    "FR-PLAN-048 (QA run 3): at the roadmap with an answered turn and no proposal, resuming asks for the roadmap once and saves it",
    async () => {
      const root = emptyProject();
      await stopWithNoProposal(root);
      const resumed = harnessOf(WORKING);
      pressCtrlC();
      await plan(root, resumed, "plan-1").catch(() => undefined);
      expect(pmTurns(resumed).map((call) => call.prompt.slice(0, 24))).toEqual(["The specs are written in"]);
      expect(asked()).toEqual([]);
      expect(inputMock).not.toHaveBeenCalled();
      expect(roadmapTitles(root)).toEqual(["First release"]);
      expect(await onlySession(root)).toMatchObject({ status: "approved", project: { phase: "done" } });
    },
    SLOW,
  );
});

describe("QA run 3 (DEF-3): a terminal session stopped at its roadmap, opened in the GUI", () => {
  const every = (ms: number, run: () => Promise<void>) => {
    const timer = setInterval(() => void run(), Math.min(ms, 200));
    return () => {
      clearInterval(timer);
    };
  };
  const viewOf = async (gui: TestGui) =>
    (JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as { plan: PlanPanelView }).plan;
  const startGui = async (root: string) => {
    const harness = agentHarness({ rules: WORKING, env: { FAKE_CLAUDE_FALLBACK: "1", FAKE_CLAUDE_DESIGN: "none" } });
    const gui = await startTestGui(root, {}, { every }, harness.environment);
    running.push(gui);
    return gui;
  };
  const openAndFinish = async (root: string) => {
    const gui = await startGui(root);
    expect((await sendTo(gui, "POST", "/api/plan/open", { planId: "plan-1" })).status).toBe(200);
    let retries = 0;
    await vi.waitFor(async () => {
      const view = await viewOf(gui);
      if (view.open?.project?.phase === "done" && view.step === null) return;
      if (view.notice?.action === "retry" && view.turn === null && view.step === null) {
        retries += 1;
        throw new Error(`a retry was needed: ${view.notice.message}`);
      }
      throw new Error("not done yet");
    }, WAIT);
    return retries;
  };

  it(
    "FR-PLAN-048 (QA run 3): after a missing-tools stop in the terminal, opening it in the GUI saves the roadmap with no Retry",
    async () => {
      const root = emptyProject();
      await stopForMissingTools(root);
      expect(await openAndFinish(root)).toBe(0);
      expect(roadmapTitles(root)).toEqual(["First release"]);
      expect(await onlySession(root)).toMatchObject({ status: "approved", project: { phase: "done" } });
    },
    SLOW,
  );

  it(
    "FR-PLAN-048 (QA run 3): after a no-proposal stop in the terminal, opening it in the GUI saves the roadmap with no Retry",
    async () => {
      const root = emptyProject();
      await stopWithNoProposal(root);
      expect(await openAndFinish(root)).toBe(0);
      expect(roadmapTitles(root)).toEqual(["First release"]);
    },
    SLOW,
  );
});
