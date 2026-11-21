/** QA: a new project's phases, stops, resumes and cancels in the terminal (roadmap-planning FR-PLAN-047 to 057). */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import { writeProjectBrief } from "../../src/adapters/storage/project-files.js";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { cancelSession } from "../../src/application/planning-session.js";
import { runGenerate, type GenerateOptions } from "../../src/cli/generate-command.js";
import { runPlanCommand } from "../../src/cli/plan-command.js";
import { decisionPorts } from "../../src/cli/planning-ports.js";
import type { PlanSession, RoadmapProposal } from "../../src/core/planning.js";
import { agentHarness, makeTempFolder, type FakeClaudeRule } from "../support/helpers.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn(), input: vi.fn() }));
const inputMock = vi.mocked(input);
const selectMock = vi.mocked(select);
const confirmMock = vi.mocked(confirm);

const SLOW = 180_000;
const isTty = process.stdin.isTTY;
beforeEach(() => {
  process.stdin.isTTY = true;
});
afterEach(() => {
  process.stdin.isTTY = isTty;
  vi.resetAllMocks();
});

const BRIEF = [
  "# Clinic booking",
  "## What it is",
  "A web app where patients book visits with a clinic's doctors, and doctors see and manage their day.",
  "## Who uses it",
  "- Patient: books, moves and cancels visits",
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

const rules = (hasScreens: boolean): FakeClaudeRule[] => [
  {
    match: "The specs are written in",
    message: "Here's the first release.",
    tools: [{ name: "plan_propose", input: { proposal: ROADMAP } }],
  },
  {
    match: "empty folder",
    message: "Here's the brief.",
    tools: [{ name: "brief_propose", input: { markdown: BRIEF, hasScreens } }],
  },
];

function emptyProject(): string {
  const root = makeTempFolder();
  mkdirSync(path.join(root, ".git"));
  return root;
}

function typing(...messages: string[]): void {
  for (const message of messages) inputMock.mockResolvedValueOnce(message);
}

/** Ctrl+C at the prompt, as @inquirer reports it. */
function pressCtrlC(): void {
  inputMock.mockImplementationOnce(() => {
    const error = new Error("User force closed the prompt");
    error.name = "ExitPromptError";
    return Promise.reject(error);
  });
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
const plan = (root: string, harness: Harness, resume?: string) =>
  runPlanCommand(
    { dir: root, timeoutMinutes: 5, model: "haiku", effort: "low", ...(resume === undefined ? {} : { resume }) },
    harness.context,
  );

const generateOptions: GenerateOptions = {
  include: [],
  exclude: [],
  cache: true,
  maxFiles: 100,
  maxInputTokens: 2_000_000,
  maxFileSizeMib: 1,
  concurrency: 2,
  timeoutMinutes: 1,
  maxRetries: 0,
};

/** Generation calls of the fake claude: the ones that aren't PM turns. */
const generationCalls = (harness: Harness) =>
  harness.calls().filter((call) => !call.args.includes("--session-id") && !call.args.includes("--resume"));
const pmTurns = (harness: Harness) =>
  harness.calls().filter((call) => call.args.includes("--session-id") || call.args.includes("--resume"));

/** Ctrl+C at a menu, as @inquirer reports it. */
function pressCtrlCAtMenu(): void {
  selectMock.mockImplementationOnce(() => {
    const error = new Error("User force closed the prompt");
    error.name = "ExitPromptError";
    return Promise.reject(error);
  });
}

/** The PM's roadmap turn that ends without proposing anything, so the session stays at its roadmap (FR-PLAN-053). */
const noRoadmapRules = (hasScreens: boolean): FakeClaudeRule[] => [
  { match: "The specs are written in", message: "I'll think about the roadmap." },
  ...rules(hasScreens).slice(1),
];

const ROADMAP_FAILED = "Planning the first roadmap didn't finish. What now?";
const DESIGN_FAILED = "Making the design system didn't finish. What now?";

/**
 * Runs the session up to its roadmap, where the PM's turn proposes nothing, then answers the failure's menu with
 * `answer` ("later"), or Ctrl+C when none is given. Nothing is saved, and the session stays at its roadmap.
 */
async function stopAtRoadmap(
  root: string,
  hasScreens: boolean,
  firstMessage = "A booking app for a clinic",
  answer?: string,
) {
  const harness = agentHarness({ rules: noRoadmapRules(hasScreens), env: { FAKE_CLAUDE_FALLBACK: "1" } });
  typing(firstMessage, "/approve");
  if (answer === undefined) pressCtrlCAtMenu();
  else selectMock.mockResolvedValueOnce(answer);
  await expect(plan(root, harness)).rejects.toThrow();
  const asked = selectMock.mock.calls.map((call) => (call[0] as { message: string }).message);
  expect(asked).toEqual([ROADMAP_FAILED]);
  const said = harness.output.out + harness.output.err;
  expect(said).toContain("The PM ended without proposing the roadmap, so nothing was saved. Retry asks it again.");
  const session = await onlySession(root);
  expect(session).toMatchObject({ status: "open", proposal: null, project: { phase: "roadmap" } });
  expect(roadmapTitles(root)).toEqual([]);
  selectMock.mockReset();
  inputMock.mockReset();
  return harness;
}

describe("QA: resuming a new project at its roadmap", () => {
  it(
    "TC-PLAN-089 (QA): luseen plan --resume continues at the roadmap, with no generation and no brief turn",
    async () => {
      const root = emptyProject();
      const first = await stopAtRoadmap(root, false);
      const claudeSessionId = (await onlySession(root)).claudeSessionId;
      expect(generationCalls(first).length).toBeGreaterThan(0);
      const resumed = agentHarness({ rules: rules(false), env: { FAKE_CLAUDE_FALLBACK: "1" } });
      await plan(root, resumed, "plan-1");
      // No generation and no brief turn: the only PM turn asks for the roadmap again, in the same Claude session,
      // and the roadmap it proposes is saved with nothing asked (FR-PLAN-053, FR-PLAN-061).
      expect(generationCalls(resumed)).toEqual([]);
      expect(pmTurns(resumed).map((call) => call.prompt.slice(0, 24))).toEqual(["The specs are written in"]);
      expect(pmTurns(resumed)[0]?.args).toContain(claudeSessionId);
      expect(selectMock).not.toHaveBeenCalled();
      expect(inputMock).not.toHaveBeenCalled();
      expect(roadmapTitles(root)).toEqual(["First release"]);
      expect(await onlySession(root)).toMatchObject({ status: "approved", project: { phase: "done" } });
    },
    SLOW,
  );

  it(
    "TC-PLAN-089 (QA): running luseen again in the folder continues the setup at the roadmap",
    async () => {
      const root = emptyProject();
      await stopAtRoadmap(root, false);
      const again = agentHarness({ rules: rules(false), env: { FAKE_CLAUDE_FALLBACK: "1" } });
      const started: string[] = [];
      // Any question generation asks is answered no, so it would stop without writing.
      confirmMock.mockResolvedValue(false);
      selectMock.mockResolvedValue(false);
      await runGenerate(root, generateOptions, again.context, (target, resume) => {
        started.push(resume ?? "new");
        return Promise.resolve();
      }).catch(() => undefined);
      expect(started).toEqual(["plan-1"]);
      expect(generationCalls(again)).toEqual([]);
    },
    SLOW,
  );
});

describe("QA: running luseen again before the specs exist", () => {
  const again = async (root: string) => {
    const harness = agentHarness({ rules: rules(false), env: { FAKE_CLAUDE_FALLBACK: "1" } });
    const started: string[] = [];
    confirmMock.mockResolvedValue(false);
    await runGenerate(root, generateOptions, harness.context, (target, resume) => {
      started.push(resume ?? "new");
      return Promise.resolve();
    });
    return { started, harness };
  };

  it(
    "TC-PLAN-089 (QA): at the brief, luseen continues the open session instead of asking to start another",
    async () => {
      const root = emptyProject();
      const first = agentHarness({ rules: rules(false), env: { FAKE_CLAUDE_FALLBACK: "1" } });
      typing("A booking app for a clinic");
      pressCtrlC();
      await plan(root, first).catch(() => undefined);
      expect((await onlySession(root)).project?.phase).toBe("brief");
      const { started, harness } = await again(root);
      expect(started).toEqual(["plan-1"]);
      expect(confirmMock).not.toHaveBeenCalled();
      expect(harness.calls()).toEqual([]);
    },
    SLOW,
  );

  it(
    "TC-PLAN-089 (QA): at the specs (README.md written, no .luseen/sdd), luseen continues the session, not a plain generation",
    async () => {
      const root = emptyProject();
      const failing = agentHarness({
        rules: rules(false),
        env: { FAKE_CLAUDE_FALLBACK: "1", FAKE_CLAUDE_MODE: "usage-limit" },
      });
      typing("A booking app for a clinic", "/approve");
      await plan(root, failing).catch(() => undefined);
      expect((await onlySession(root)).project?.phase).toBe("specs");
      const { started, harness } = await again(root);
      expect(started).toEqual(["plan-1"]);
      expect(harness.calls()).toEqual([]);
    },
    SLOW,
  );
});

describe("QA: cancelling and failing after the brief", () => {
  it(
    "TC-PLAN-088 (QA): cancelling at the roadmap keeps README.md, docs/ and the specs, saves no roadmap, and names them",
    async () => {
      const root = emptyProject();
      const outside = makeTempFolder();
      writeFileSync(path.join(outside, "idea.md"), "# Idea\n");
      // The roadmap is saved as soon as the PM proposes it, so the session is at its roadmap, with nothing saved,
      // only when the PM's turn proposed nothing and the user stopped at the failure.
      await stopAtRoadmap(root, false, `A booking app @${path.join(outside, "idea.md")}`, "later");
      // Cancelled the way /cancel does it.
      const cancelled = await cancelSession(decisionPorts(root), "plan-1", {
        pid: process.pid,
        isRunning: () => false,
      });
      expect(existsSync(path.join(root, "README.md"))).toBe(true);
      expect(readFileSync(path.join(root, "docs/idea.md"), "utf8")).toBe("# Idea\n");
      expect(existsSync(path.join(root, ".luseen/sdd/README.md"))).toBe(true);
      expect(roadmapTitles(root)).toEqual([]);
      const session = await onlySession(root);
      expect(session.status).toBe("cancelled");
      expect(cancelled.message).toBe(
        "Cancelled. Kept what was already written: README.md, docs/, .luseen/sdd and the agent setup.",
      );
    },
    SLOW,
  );

  it(
    "TC-PLAN-087 (QA): a failed design step keeps the design phase, and resuming runs it again",
    async () => {
      const root = emptyProject();
      const failing = agentHarness({
        rules: rules(true),
        env: { FAKE_CLAUDE_FALLBACK: "1", FAKE_CLAUDE_DESIGN: "fail" },
      });
      typing("A booking app for a clinic", "/approve", "/approve");
      await expect(plan(root, failing)).rejects.toThrow();
      const waiting = await onlySession(root);
      expect(waiting).toMatchObject({ status: "open", project: { phase: "design" } });
      expect(roadmapTitles(root)).toEqual(["First release"]);

      const resumed = agentHarness({ rules: rules(true), env: { FAKE_CLAUDE_FALLBACK: "1" } });
      selectMock.mockResolvedValueOnce(true);
      await plan(root, resumed, "plan-1");
      expect(pmTurns(resumed)).toEqual([]);
      expect(readFileSync(path.join(root, ".luseen/design/design-system.md"), "utf8")).toContain(
        "## Status\n\napproved",
      );
      expect((await onlySession(root)).project?.phase).toBe("done");
    },
    SLOW,
  );

  it(
    "TC-PLAN-087 (QA): a failed design step leaves no partial draft; continuing without design removes the design folder, and the summary doesn't claim a design system",
    async () => {
      const root = emptyProject();
      const draft = path.join(root, ".luseen/design/design-system.md");
      // The design step fails after writing part of a draft, as a run that stops partway does, into the design folder.
      const harness = agentHarness({
        rules: rules(true),
        env: { FAKE_CLAUDE_FALLBACK: "1", FAKE_CLAUDE_DESIGN: "fail", FAKE_CLAUDE_ALSO_WRITE: draft },
      });
      typing("A booking app for a clinic");
      inputMock.mockImplementationOnce(() => {
        mkdirSync(path.dirname(draft), { recursive: true });
        return Promise.resolve("/approve");
      });
      selectMock.mockImplementationOnce(() => {
        // The failed step left no partial draft behind when the failure is shown, so nothing unapproved is used.
        expect(existsSync(draft)).toBe(false);
        return Promise.resolve("skip");
      });
      await plan(root, harness);
      expect(selectMock).toHaveBeenCalledTimes(1);
      expect(await onlySession(root)).toMatchObject({ status: "approved", project: { phase: "done" } });
      const said = harness.output.out + harness.output.err;
      expect(said).toContain("Continued without a design system.");
      const summary = said.slice(said.indexOf("The project is set up:"));
      // TC-PLAN-087: Continue without design removes the draft and moves to done with no design files.
      expect(existsSync(path.join(root, ".luseen/design"))).toBe(false);
      // FR-PLAN-055: the design system's paths are listed only when it was made.
      expect(summary).not.toContain(
        "The design system: .luseen/design/design-system.md and .luseen/design/style-guide.html",
      );
    },
    SLOW,
  );

  it(
    "TC-PLAN-086 (QA): without screens, approving the roadmap finishes with no design step",
    async () => {
      const root = emptyProject();
      const harness = agentHarness({ rules: rules(false), env: { FAKE_CLAUDE_FALLBACK: "1" } });
      typing("A booking app for a clinic", "/approve", "/approve");
      await plan(root, harness);
      expect(selectMock).not.toHaveBeenCalled();
      expect(existsSync(path.join(root, ".luseen/design"))).toBe(false);
      expect((await onlySession(root)).project?.phase).toBe("done");
      expect(harness.output.out + harness.output.err).toContain('"work on task 1"');
    },
    SLOW,
  );
});

describe("QA: the brief's edge cases", () => {
  it(
    "TC-PLAN-084 (QA): a README.md written while the brief waits is refused in the chat, and the brief stays waiting",
    async () => {
      const root = emptyProject();
      const harness = agentHarness({ rules: rules(false), env: { FAKE_CLAUDE_FALLBACK: "1" } });
      typing("A booking app for a clinic");
      inputMock.mockImplementationOnce(() => {
        writeFileSync(path.join(root, "README.md"), "mine\n");
        return Promise.resolve("/approve");
      });
      pressCtrlC();
      const outcome = await plan(root, harness).then(
        () => "finished",
        (error: unknown) => String(error),
      );
      expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe("mine\n");
      const session = await onlySession(root);
      expect(session.status).toBe("open");
      expect(session.project?.phase).toBe("brief");
      expect(session.project?.brief).not.toBeNull();
      expect(harness.output.out + harness.output.err + outcome).toContain("README.md already exists");
    },
    SLOW,
  );

  it(
    "QA exploratory: after a refused brief, the chat goes on so the user can move README.md and /approve again",
    async () => {
      const root = emptyProject();
      const harness = agentHarness({ rules: rules(false), env: { FAKE_CLAUDE_FALLBACK: "1" } });
      typing("A booking app for a clinic");
      inputMock.mockImplementationOnce(() => {
        writeFileSync(path.join(root, "README.md"), "mine\n");
        return Promise.resolve("/approve");
      });
      pressCtrlC();
      const outcome = await plan(root, harness).then(
        () => "finished",
        (error: unknown) => `${(error as Error).name}: ${(error as Error).message}`,
      );
      expect(outcome).not.toContain("UsageError");
      expect(inputMock).toHaveBeenCalledTimes(3);
    },
    SLOW,
  );

  it(
    "QA: luseen plan in an empty folder needs an interactive terminal, and writes nothing without one",
    async () => {
      const root = emptyProject();
      process.stdin.isTTY = false;
      await expect(plan(root, agentHarness())).rejects.toThrow("interactive terminal");
      expect(existsSync(path.join(root, ".luseen"))).toBe(false);
    },
    SLOW,
  );

  it(
    "QA: luseen plan --roadmap or --task in an empty folder is refused",
    async () => {
      const root = emptyProject();
      await expect(
        runPlanCommand({ dir: root, timeoutMinutes: 5, roadmap: 1 }, agentHarness().context),
      ).rejects.toThrow("Leave out --roadmap and --task");
    },
    SLOW,
  );
});

describe("QA run 2: the design phase in the terminal", () => {
  it(
    "TC-PLAN-089 (QA run 2, DEF-1): stopped with Ctrl+C at a failed design step, running luseen again continues the open session",
    async () => {
      const root = emptyProject();
      const first = agentHarness({
        rules: rules(true),
        env: { FAKE_CLAUDE_FALLBACK: "1", FAKE_CLAUDE_DESIGN: "fail" },
      });
      typing("A booking app for a clinic", "/approve");
      pressCtrlCAtMenu();
      await plan(root, first).catch(() => undefined);
      expect(selectMock.mock.calls.map((call) => (call[0] as { message: string }).message)).toEqual([DESIGN_FAILED]);
      expect((await onlySession(root)).project?.phase).toBe("design");
      const again = agentHarness({ rules: rules(true), env: { FAKE_CLAUDE_FALLBACK: "1" } });
      const started: string[] = [];
      confirmMock.mockResolvedValue(false);
      await runGenerate(root, generateOptions, again.context, (target, resume) => {
        started.push(resume ?? "new");
        return Promise.resolve();
      });
      expect(started).toEqual(["plan-1"]);
      expect(confirmMock).not.toHaveBeenCalled();
      expect(again.calls()).toEqual([]);
    },
    SLOW,
  );

  it(
    "TC-PLAN-087 (QA run 2, DEF-4): when the designer makes no design system, the setup ends with nothing to approve",
    async () => {
      const root = emptyProject();
      const harness = agentHarness({
        rules: rules(true),
        env: { FAKE_CLAUDE_FALLBACK: "1", FAKE_CLAUDE_DESIGN: "none" },
      });
      typing("A booking app for a clinic", "/approve", "/approve");
      await plan(root, harness);
      expect(selectMock).not.toHaveBeenCalled();
      expect(existsSync(path.join(root, ".luseen/design/design-system.md"))).toBe(false);
      const session = await onlySession(root);
      expect(session).toMatchObject({ status: "approved", project: { phase: "done" } });
      const said = harness.output.out + harness.output.err;
      const summary = said.slice(said.indexOf("The project is set up:"));
      expect(said).toContain("The project is set up:");
      expect(summary).not.toContain(".luseen/design");
      expect(summary).toContain('"work on task 1"');
    },
    SLOW,
  );

  it(
    "TC-PLAN-087 (QA run 2, DEF-3): a draft that fails the checks is removed, not approved; continue without design names no design system",
    async () => {
      const root = emptyProject();
      const harness = agentHarness({
        rules: rules(true),
        env: { FAKE_CLAUDE_FALLBACK: "1", FAKE_CLAUDE_DESIGN: "invalid" },
      });
      typing("A booking app for a clinic", "/approve");
      selectMock.mockImplementationOnce(async () => {
        // The failing draft is already removed when the failure is shown, and the session waits at its design.
        expect(existsSync(path.join(root, ".luseen/design"))).toBe(false);
        expect((await onlySession(root)).project?.phase).toBe("design");
        return "skip";
      });
      await plan(root, harness);
      expect(selectMock.mock.calls.map((call) => (call[0] as { message: string }).message)).toEqual([DESIGN_FAILED]);
      expect(existsSync(path.join(root, ".luseen/design"))).toBe(false);
      const said = harness.output.out + harness.output.err;
      expect(said).toContain("Continued without a design system.");
      expect(said.slice(said.indexOf("The project is set up:"))).not.toContain(".luseen/design");
      expect((await onlySession(root)).status).toBe("approved");
    },
    SLOW,
  );

  it(
    "FR-PLAN-054 (QA run 2): a failed design step in the terminal offers retry or continue without design",
    async () => {
      const root = emptyProject();
      const failing = agentHarness({
        rules: rules(true),
        env: { FAKE_CLAUDE_FALLBACK: "1", FAKE_CLAUDE_DESIGN: "fail" },
      });
      typing("A booking app for a clinic", "/approve");
      const outcome = await plan(root, failing).then(
        () => "finished",
        (error: unknown) => String(error),
      );
      const said = failing.output.out + failing.output.err + outcome;
      expect((await onlySession(root)).project?.phase).toBe("design");
      // The failure is shown, then retry, continue without design, or stop and continue later are offered (FR-PLAN-054).
      const question = selectMock.mock.calls[0]?.[0];
      expect(question?.message, said.slice(-1500)).toBe(DESIGN_FAILED);
      const choices = question?.choices as readonly { value: string; name: string }[] | undefined;
      expect(choices?.map((choice) => choice.value)).toEqual(["retry", "skip", "later"]);
      expect(choices?.map((choice) => choice.name)).toEqual([
        "Retry it",
        "Continue without design",
        "Stop, and continue later",
      ]);
    },
    SLOW,
  );
});

const designCalls = (harness: Harness) =>
  harness.calls().filter((call) => call.prompt.startsWith("Create the design system for the project"));
const questions = () => selectMock.mock.calls.map((call) => (call[0] as { message: string }).message);
const choicesOf = (index: number) =>
  ((selectMock.mock.calls[index]?.[0] as { choices?: readonly { value: unknown }[] } | undefined)?.choices ?? []).map(
    (choice) => choice.value,
  );

describe("QA run 3: a failed step in the terminal (DEF-9)", () => {
  it(
    "FR-PLAN-054 (QA run 3): a failed design step's 'later' stops at the design; resuming makes it and approves it with nothing asked",
    async () => {
      const root = emptyProject();
      const failing = agentHarness({
        rules: rules(true),
        env: { FAKE_CLAUDE_FALLBACK: "1", FAKE_CLAUDE_DESIGN: "fail" },
      });
      typing("A booking app for a clinic", "/approve");
      selectMock.mockResolvedValueOnce("later");
      await expect(plan(root, failing)).rejects.toThrow();
      expect(questions()).toEqual([DESIGN_FAILED]);
      expect(choicesOf(0)).toEqual(["retry", "skip", "later"]);
      expect(await onlySession(root)).toMatchObject({ status: "open", project: { phase: "design" } });
      expect(existsSync(path.join(root, ".luseen/design"))).toBe(false);
      expect(roadmapTitles(root)).toEqual(["First release"]);

      selectMock.mockReset();
      const resumed = agentHarness({ rules: rules(true), env: { FAKE_CLAUDE_FALLBACK: "1" } });
      await plan(root, resumed, "plan-1");
      expect(questions()).toEqual([]);
      expect(designCalls(resumed)).toHaveLength(1);
      expect(pmTurns(resumed)).toEqual([]);
      expect(readFileSync(path.join(root, ".luseen/design/design-system.md"), "utf8")).toContain(
        "## Status\n\napproved",
      );
      expect(await onlySession(root)).toMatchObject({ status: "approved", project: { phase: "done" } });
      expect(resumed.output.out + resumed.output.err).toContain(
        "The design system: .luseen/design/design-system.md and .luseen/design/style-guide.html",
      );
    },
    SLOW,
  );

  it(
    "FR-PLAN-054 (QA run 3): retrying a failed design step that then succeeds approves the design system with nothing asked",
    async () => {
      const root = emptyProject();
      const harness = agentHarness({
        rules: rules(true),
        env: { FAKE_CLAUDE_FALLBACK: "1", FAKE_CLAUDE_DESIGN: "fail" },
      });
      typing("A booking app for a clinic", "/approve");
      selectMock.mockImplementationOnce(() => {
        // The next try succeeds, as after a passing outage.
        harness.environment.FAKE_CLAUDE_DESIGN = "valid";
        return Promise.resolve("retry");
      });
      await plan(root, harness);
      expect(questions()).toEqual([DESIGN_FAILED]);
      expect(designCalls(harness)).toHaveLength(2);
      expect(readFileSync(path.join(root, ".luseen/design/design-system.md"), "utf8")).toContain(
        "## Status\n\napproved",
      );
      expect(await onlySession(root)).toMatchObject({ status: "approved", project: { phase: "done" } });
    },
    SLOW,
  );

  it(
    "TC-PLAN-085 (QA run 3): a failed spec generation offers retry or later, never skip; a retry that succeeds goes on to the roadmap",
    async () => {
      const root = emptyProject();
      const harness = agentHarness({ rules: rules(false), env: { FAKE_CLAUDE_FALLBACK: "1" } });
      // Only the generation fails: the brief turn runs before the limit is set.
      typing("A booking app for a clinic");
      inputMock.mockImplementationOnce(() => {
        harness.environment.FAKE_CLAUDE_MODE = "usage-limit";
        return Promise.resolve("/approve");
      });
      typing("/approve");
      selectMock.mockImplementationOnce(() => {
        delete harness.environment.FAKE_CLAUDE_MODE;
        return Promise.resolve("retry");
      });
      // The generation runs as a child process whose output goes straight to the terminal.
      let shown = "";
      const capture = (chunk: unknown): boolean => {
        shown += String(chunk);
        return true;
      };
      const out = vi.spyOn(process.stdout, "write").mockImplementation(capture);
      const err = vi.spyOn(process.stderr, "write").mockImplementation(capture);
      try {
        await plan(root, harness);
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
      expect(questions()).toEqual(["Writing the specs didn't finish. What now?"]);
      expect(choicesOf(0)).toEqual(["retry", "later"]);
      // The generation's own message is shown (FR-PLAN-052).
      expect(shown).toContain("You've hit your session limit");
      expect(existsSync(path.join(root, ".luseen/sdd/README.md"))).toBe(true);
      expect(roadmapTitles(root)).toEqual(["First release"]);
      expect(await onlySession(root)).toMatchObject({ status: "approved", project: { phase: "done" } });
    },
    SLOW,
  );
});

describe("QA run 3: continuing a new project", () => {
  it(
    "TC-PLAN-089 (QA run 3): resuming at the design with a draft already made approves it, without running the design step again",
    async () => {
      const root = emptyProject();
      const first = agentHarness({
        rules: rules(true),
        env: { FAKE_CLAUDE_FALLBACK: "1", FAKE_CLAUDE_DESIGN: "fail" },
      });
      typing("A booking app for a clinic", "/approve");
      pressCtrlCAtMenu();
      await plan(root, first).catch(() => undefined);
      expect((await onlySession(root)).project?.phase).toBe("design");
      // A valid draft left behind, as when the session stopped after the design step wrote it and before luseen
      // approved it.
      const draftFolder = path.join(root, ".luseen/design");
      const sections = ["Status", "Principles", "Color", "Typography", "Spacing and layout", "Shape and elevation"]
        .concat(["Motion", "Accessibility", "Components", "Templates", "Decisions", "Sources", "Open questions"])
        .map((name) => `## ${name}\n\n${name === "Status" ? "draft" : "Text."}\n`)
        .join("\n");
      mkdirSync(draftFolder, { recursive: true });
      writeFileSync(path.join(draftFolder, "design-system.md"), `# Design system\n\n${sections}`);
      writeFileSync(
        path.join(draftFolder, "design.tokens.json"),
        JSON.stringify({ color: { $type: "color", blue: { $value: "#2563eb" } } }),
      );
      writeFileSync(path.join(draftFolder, "style-guide.html"), "<!doctype html><title>Style guide</title>");

      selectMock.mockReset();
      // A design step run again would fail, so the test sees it.
      const resumed = agentHarness({
        rules: rules(true),
        env: { FAKE_CLAUDE_FALLBACK: "1", FAKE_CLAUDE_DESIGN: "fail" },
      });
      await plan(root, resumed, "plan-1");
      expect(designCalls(resumed)).toEqual([]);
      expect(resumed.calls()).toEqual([]);
      expect(questions()).toEqual([]);
      expect(readFileSync(path.join(draftFolder, "design-system.md"), "utf8")).toContain("## Status\n\napproved");
      expect(await onlySession(root)).toMatchObject({ status: "approved", project: { phase: "done" } });
    },
    SLOW,
  );

  it(
    "FR-PLAN-048 (QA run 3): luseen plan in the empty folder with an open new-project session continues it, not a second one",
    async () => {
      const root = emptyProject();
      const first = agentHarness({ rules: rules(false), env: { FAKE_CLAUDE_FALLBACK: "1" } });
      typing("A booking app for a clinic");
      pressCtrlC();
      await plan(root, first).catch(() => undefined);
      const stopped = await onlySession(root);
      expect(stopped.project?.phase).toBe("brief");

      const again = agentHarness({ rules: rules(false), env: { FAKE_CLAUDE_FALLBACK: "1" } });
      typing("/approve", "/approve");
      await plan(root, again);
      const { sessions } = await openPlanStore(root).list();
      expect(sessions.map((session) => session.id)).toEqual([stopped.id]);
      // The PM's only turn continues the first Claude session.
      expect(pmTurns(again).every((call) => call.args.includes("--resume"))).toBe(true);
      expect(pmTurns(again).map((call) => call.prompt.slice(0, 24))).toEqual(["The specs are written in"]);
      expect(existsSync(path.join(root, "README.md"))).toBe(true);
      expect(await onlySession(root)).toMatchObject({ status: "approved", project: { phase: "done" } });
    },
    SLOW,
  );
});

describe("QA run 3: the files the brief writes", () => {
  it(
    "TC-PLAN-083/FR-PLAN-055 (QA run 3): two files with one name are both copied, and the summary lists the names written",
    async () => {
      const root = emptyProject();
      const one = makeTempFolder();
      const two = makeTempFolder();
      writeFileSync(path.join(one, "idea.md"), "# One\n");
      writeFileSync(path.join(two, "idea.md"), "# Two\n");
      const harness = agentHarness({ rules: rules(false), env: { FAKE_CLAUDE_FALLBACK: "1" } });
      typing(`A booking app @${path.join(one, "idea.md")} @${path.join(two, "idea.md")}`, "/approve", "/approve");
      await plan(root, harness);
      const contents = [
        readFileSync(path.join(root, "docs/idea.md"), "utf8"),
        readFileSync(path.join(root, "docs/idea-2.md"), "utf8"),
      ].sort();
      expect(contents).toEqual(["# One\n", "# Two\n"]);
      const session = await onlySession(root);
      expect(session.project?.files).toEqual(["README.md", "docs/idea.md", "docs/idea-2.md"]);
      const said = harness.output.out + harness.output.err;
      expect(said.slice(said.indexOf("The project is set up:"))).toContain("- README.md, docs/idea.md, docs/idea-2.md");
    },
    SLOW,
  );

  it("TC-PLAN-083/084 (QA run 3): a failed copy keeps a docs/ folder that was already there, and removes only what it wrote", async () => {
    const root = emptyProject();
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "a.md"), "A\n");
    await expect(
      writeProjectBrief(root, BRIEF, [
        { path: "a.md", name: "../../a.md" },
        { path: "missing.md", name: "b.md" },
      ]),
    ).rejects.toThrow();
    expect(existsSync(path.join(root, "README.md"))).toBe(false);
    expect(existsSync(path.join(root, "docs"))).toBe(true);
    expect(readdirSync(path.join(root, "docs"))).toEqual([]);
    expect(existsSync(path.join(path.dirname(root), "a.md"))).toBe(false);

    // Then, with the file there, the same brief is written, its name reduced to the base name.
    writeFileSync(path.join(root, "missing.md"), "B\n");
    const written = await writeProjectBrief(root, BRIEF, [
      { path: "a.md", name: "../../a.md" },
      { path: "missing.md", name: "..\\b.md" },
    ]);
    expect(written).toEqual(["README.md", "docs/a.md", "docs/b.md"]);
    expect(readdirSync(path.join(root, "docs")).sort()).toEqual(["a.md", "b.md"]);
  });

  it("TC-PLAN-083 (QA run 3): a name of only dots is refused and nothing is written", async () => {
    const root = emptyProject();
    writeFileSync(path.join(root, "a.md"), "A\n");
    for (const name of ["..", "...", "../..", "dir/.."]) {
      await expect(writeProjectBrief(root, BRIEF, [{ path: "a.md", name }])).rejects.toThrow("can't be copied");
      expect(existsSync(path.join(root, "README.md"))).toBe(false);
      expect(existsSync(path.join(root, "docs"))).toBe(false);
    }
  });
});

describe("QA (FR-PLAN-053, FR-PLAN-058, FR-PLAN-061): the first roadmap in the terminal", () => {
  it(
    "TC-PLAN-092 (QA): a roadmap turn stopped for missing planning tools runs the PM again on the first Retry",
    async () => {
      const root = emptyProject();
      const harness = agentHarness({
        rules: [
          { match: "The specs are written in", mcpStatus: "failed", message: "I can't save it.", times: 1 },
          ...rules(false),
        ],
        env: { FAKE_CLAUDE_FALLBACK: "1" },
      });
      typing("A booking app for a clinic", "/approve");
      selectMock.mockResolvedValueOnce("retry");
      await plan(root, harness);
      const said = harness.output.out + harness.output.err;
      expect(said).toContain("The PM can't reach luseen's planning tools");
      // One Retry is enough: the PM is asked again, and nothing claims it ended without proposing.
      expect(selectMock.mock.calls.map((call) => (call[0] as { message: string }).message)).toEqual([ROADMAP_FAILED]);
      expect(said).not.toContain("The PM ended without proposing the roadmap");
      expect(pmTurns(harness).length).toBe(3);
      expect(roadmapTitles(root)).toEqual(["First release"]);
      expect((await onlySession(root)).project?.phase).toBe("done");
    },
    SLOW,
  );

  it(
    "TC-PLAN-092 (QA): in a fake TTY, a brief turn missing brief_propose stops with no PM text; resuming answers the kept message",
    async () => {
      const root = emptyProject();
      const missing = agentHarness({
        rules: [{ match: "empty folder", hiddenTools: ["brief_propose"], message: "Run luseen plan and paste this." }],
        env: { FAKE_CLAUDE_FALLBACK: "1" },
      });
      typing("A booking app for a clinic");
      const error = await plan(root, missing).catch((caught: unknown) => caught);
      expect((error as Error).message).toContain(
        "The PM can't reach luseen's planning tools: brief_propose is missing.",
      );
      expect(missing.output.out + missing.output.err).not.toContain("Run luseen plan and paste this.");
      expect(await onlySession(root)).toMatchObject({ status: "open", project: { phase: "brief" } });

      inputMock.mockReset();
      const working = agentHarness({
        rules: [{ ...rules(false)[1], match: "Your last turn was stopped" }],
        env: { FAKE_CLAUDE_FALLBACK: "1" },
      });
      typing("/cancel");
      await plan(root, working, "plan-1");
      const [retried] = pmTurns(working);
      expect(retried?.args).toContain("--resume");
      // The kept message is in the Claude session's transcript, so the PM is asked to answer it.
      expect(retried?.prompt).toMatch(/^Your last turn was stopped\. Answer my last message\./);
      expect(working.output.out + working.output.err).toContain("PM › Here's the brief.");
    },
    SLOW,
  );

  it(
    "TC-PLAN-086 (QA): a roadmap turn whose only proposal is invalid saves nothing, keeps the roadmap phase, and offers Retry",
    async () => {
      const root = emptyProject();
      const invalid = { ...ROADMAP, milestones: [{ title: "Foundation", goal: "Shell", tasks: [{ key: "x" }] }] };
      const harness = agentHarness({
        rules: [
          {
            match: "The specs are written in",
            message: "Here it is.",
            tools: [{ name: "plan_propose", input: { proposal: invalid } }],
            times: 1,
          },
          ...rules(false),
        ],
        env: { FAKE_CLAUDE_FALLBACK: "1" },
      });
      typing("A booking app for a clinic", "/approve");
      selectMock.mockResolvedValueOnce("later");
      await expect(plan(root, harness)).rejects.toThrow();
      expect(selectMock.mock.calls.map((call) => (call[0] as { message: string }).message)).toEqual([ROADMAP_FAILED]);
      expect(roadmapTitles(root)).toEqual([]);
      expect(await onlySession(root)).toMatchObject({ status: "open", proposal: null, project: { phase: "roadmap" } });
    },
    SLOW,
  );
});

describe("QA run 2 (DEF-1): retrying the first roadmap in the terminal", () => {
  const roadmapFailedAsked = () => selectMock.mock.calls.map((call) => (call[0] as { message: string }).message);

  it(
    "FR-PLAN-053 (QA run 2): a roadmap turn stopped by the usage limit runs the PM again on the first Retry",
    async () => {
      const root = emptyProject();
      const harness = agentHarness({
        rules: [
          {
            match: "The specs are written in",
            message: "You've hit your session limit. Resets at 5pm.",
            exitCode: 1,
            apiErrorStatus: 429,
            times: 1,
          },
          ...rules(false),
        ],
        env: { FAKE_CLAUDE_FALLBACK: "1" },
      });
      typing("A booking app for a clinic", "/approve");
      selectMock.mockResolvedValueOnce("retry");
      await plan(root, harness);
      const said = harness.output.out + harness.output.err;
      expect(said).toContain("The PM stopped: Claude's usage limit is reached.");
      expect(roadmapFailedAsked()).toEqual([ROADMAP_FAILED]);
      expect(said).not.toContain("The PM ended without proposing the roadmap");
      // The brief's turn, the stopped roadmap turn, and the retried one.
      expect(pmTurns(harness).length).toBe(3);
      expect(roadmapTitles(root)).toEqual(["First release"]);
      expect(await onlySession(root)).toMatchObject({ status: "approved", project: { phase: "done" } });
    },
    SLOW,
  );

  it(
    "FR-PLAN-058 (QA run 2): two stops for missing planning tools need two Retries, each running the PM",
    async () => {
      const root = emptyProject();
      const harness = agentHarness({
        rules: [
          { match: "The specs are written in", mcpStatus: "failed", message: "I can't save it.", times: 2 },
          ...rules(false),
        ],
        env: { FAKE_CLAUDE_FALLBACK: "1" },
      });
      typing("A booking app for a clinic", "/approve");
      selectMock.mockResolvedValueOnce("retry").mockResolvedValueOnce("retry");
      await plan(root, harness);
      const said = harness.output.out + harness.output.err;
      expect(roadmapFailedAsked()).toEqual([ROADMAP_FAILED, ROADMAP_FAILED]);
      expect(said).not.toContain("The PM ended without proposing the roadmap");
      expect(pmTurns(harness).length).toBe(4);
      expect(roadmapTitles(root)).toEqual(["First release"]);
      expect(await onlySession(root)).toMatchObject({ status: "approved", project: { phase: "done" } });
    },
    SLOW,
  );

  it(
    "FR-PLAN-048 (QA run 2, DEF-3): a stop for missing planning tools, then 'later'; resuming saves the PM's roadmap with nothing asked",
    async () => {
      const root = emptyProject();
      const stopped = agentHarness({
        rules: [
          { match: "The specs are written in", mcpStatus: "failed", message: "I can't save it.", times: 1 },
          ...rules(false),
        ],
        env: { FAKE_CLAUDE_FALLBACK: "1" },
      });
      typing("A booking app for a clinic", "/approve");
      selectMock.mockResolvedValueOnce("later");
      await expect(plan(root, stopped)).rejects.toThrow();
      expect(await onlySession(root)).toMatchObject({
        status: "open",
        proposal: null,
        project: { phase: "roadmap", isRoadmapAsked: false },
      });
      expect(roadmapTitles(root)).toEqual([]);

      selectMock.mockReset();
      inputMock.mockReset();
      const resumed = agentHarness({ rules: rules(false), env: { FAKE_CLAUDE_FALLBACK: "1" } });
      // No message is typed: resuming must finish the setup by itself (FR-PLAN-048, FR-PLAN-061).
      pressCtrlC();
      await plan(root, resumed, "plan-1").catch(() => undefined);
      expect(inputMock).not.toHaveBeenCalled();
      expect(roadmapFailedAsked()).toEqual([]);
      expect(pmTurns(resumed).length).toBeGreaterThanOrEqual(1);
      expect(roadmapTitles(root)).toEqual(["First release"]);
      expect(await onlySession(root)).toMatchObject({ status: "approved", project: { phase: "done" } });
    },
    SLOW,
  );

  it(
    "FR-PLAN-048 (QA run 2): a roadmap turn stopped by the usage limit, then 'later'; resuming saves the roadmap with nothing asked",
    async () => {
      const root = emptyProject();
      const stopped = agentHarness({
        rules: [
          {
            match: "The specs are written in",
            message: "You've hit your session limit. Resets at 5pm.",
            exitCode: 1,
            apiErrorStatus: 429,
            times: 1,
          },
          ...rules(false),
        ],
        env: { FAKE_CLAUDE_FALLBACK: "1" },
      });
      typing("A booking app for a clinic", "/approve");
      selectMock.mockResolvedValueOnce("later");
      await expect(plan(root, stopped)).rejects.toThrow();
      expect(await onlySession(root)).toMatchObject({ status: "open", proposal: null, project: { phase: "roadmap" } });

      selectMock.mockReset();
      inputMock.mockReset();
      const resumed = agentHarness({ rules: rules(false), env: { FAKE_CLAUDE_FALLBACK: "1" } });
      // No message is typed: resuming must finish the setup by itself (FR-PLAN-048, FR-PLAN-061).
      pressCtrlC();
      await plan(root, resumed, "plan-1").catch(() => undefined);
      expect(inputMock).not.toHaveBeenCalled();
      expect(roadmapFailedAsked()).toEqual([]);
      expect(roadmapTitles(root)).toEqual(["First release"]);
      expect(await onlySession(root)).toMatchObject({ status: "approved", project: { phase: "done" } });
    },
    SLOW,
  );
});
