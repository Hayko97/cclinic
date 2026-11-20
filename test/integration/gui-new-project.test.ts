/// <reference lib="dom" />
/** A new project from an empty folder, in the GUI (gui FR-GUI-085 to FR-GUI-090, roadmap-planning FR-PLAN-047). */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startProcess } from "../../src/adapters/process/job-process.js";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import type { PlanPanelView } from "../../src/application/gui-planning.js";
import { luseenBin } from "../../src/cli/luseen-bin.js";
import type { GuiDependencies } from "../../src/cli/gui-command.js";
import type { RoadmapProposal } from "../../src/core/planning.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";
import { sendTo, startTestGui, type TestGui } from "../support/gui.js";

/** The PM, its MCP server, generation and the design step are child processes. */
/** A full verify run loads the machine, so the child processes can take much longer than alone (QA DEF-8). */
const WAIT = { timeout: 150_000, interval: 200 };
const SLOW = 400_000;

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

const RULES: FakeClaudeRule[] = [
  {
    match: "The specs are written in",
    message: "The first release.",
    tools: [{ name: "plan_propose", input: { proposal: ROADMAP } }],
  },
  {
    match: "empty folder",
    message: "The brief.",
    tools: [{ name: "brief_propose", input: { markdown: BRIEF, hasScreens: true } }],
  },
];

function emptyProject(): string {
  const root = makeTempFolder();
  mkdirSync(path.join(root, ".git"));
  return root;
}

function every(ms: number, run: () => Promise<void>): () => void {
  const timer = setInterval(() => void run(), Math.min(ms, 200));
  return () => {
    clearInterval(timer);
  };
}

async function startGui(root: string, dependencies: GuiDependencies = {}) {
  const harness = agentHarness({ rules: RULES, env: { FAKE_CLAUDE_FALLBACK: "1" } });
  const gui = await startTestGui(root, {}, { every, ...dependencies }, harness.environment);
  running.push(gui);
  return gui;
}

const viewOf = async (gui: TestGui) =>
  (JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as { plan: PlanPanelView }).plan;
const post = (gui: TestGui, route: string, body: unknown = {}) => sendTo(gui, "POST", route, body);

async function openPage(gui: TestGui): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
  return page;
}

describe("Setup in an empty folder", () => {
  it(
    "TC-GUI-137: shows Start a new project instead of the generate form; a folder with files shows the form",
    async () => {
      const gui = await startGui(emptyProject());
      const setup = JSON.parse((await sendTo(gui, "GET", "/api/setup")).body) as { isEmpty: boolean };
      expect(setup.isEmpty).toBe(true);
      const page = await openPage(gui);
      await page.locator("#new-project-card").waitFor();
      expect(await page.locator("#generate-card").isHidden()).toBe(true);
      expect(await page.locator("body").innerText()).not.toContain("No files to analyse");
      const canvas = JSON.parse((await sendTo(gui, "GET", "/api/canvas")).body) as { nextStep: unknown };
      expect(canvas.nextStep).toEqual({ kind: "new-project" });

      const withFiles = emptyProject();
      writeProject(withFiles, { "README.md": "# App\n" });
      const other = await startGui(withFiles);
      const otherPage = await openPage(other);
      await otherPage.locator("#generate-card").waitFor();
      expect(await otherPage.locator("#new-project-card").isHidden()).toBe(true);
      // FR-GUI-085: a new project starts only in an empty folder.
      const refused = await post(other, "/api/plan", { target: { kind: "new-project" }, text: "An app" });
      expect(refused.status).toBe(409);
    },
    SLOW,
  );
});

describe("a new project in the GUI", () => {
  it(
    "TC-GUI-138, TC-GUI-140, TC-GUI-141: interview, brief, specs, roadmap, design and the first task",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root);
      const page = await openPage(gui);
      await page.locator("#new-project-start").click();
      await expect.poll(() => page.locator("#plan-panel").isVisible()).toBe(true);
      expect(await page.locator("#plan-progress .is-current").innerText()).toContain("Brief");
      await page.locator("#plan-text").fill("A booking app for a clinic");
      await page.locator("#plan-text").press("Enter");

      const brief = page.locator('[aria-label="Brief"]');
      await brief.waitFor(WAIT);
      expect(await brief.innerText()).toContain("Clinic booking");
      await brief.locator('[data-plan-decide="approve"]').click();

      // FR-GUI-088: the specs are written as a job, then the PM proposes the roadmap with no message of the user's.
      await vi.waitFor(async () => {
        const view = await viewOf(gui);
        if (view.open?.proposal?.kind !== "roadmap") throw new Error("no roadmap yet");
      }, WAIT);
      expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe(`${BRIEF}\n`);
      expect(existsSync(path.join(root, ".luseen/sdd/README.md"))).toBe(true);
      const jobs = JSON.parse((await sendTo(gui, "GET", "/api/jobs")).body) as { jobs: { kind: string }[] };
      expect(jobs.jobs.map((job) => job.kind)).toContain("project-specs");
      expect(await page.locator("#plan-progress .is-current").innerText()).toContain("Roadmap");

      await page.locator('[aria-label="Proposal"] [data-plan-decide="approve"]').click();
      const design = page.locator('[aria-label="Design system"]');
      await design.waitFor(WAIT);
      const styleGuide = await sendTo(gui, "GET", "/api/design/style-guide");
      expect(styleGuide.status).toBe(200);
      expect(styleGuide.body).toContain("Style guide");
      await design.locator('[data-plan-design="approve"]').click();

      await page.locator('[aria-label="Project set up"]').waitFor(WAIT);
      expect(await page.locator('[aria-label="Project set up"]').innerText()).toContain('"work on task 1"');
      expect(readFileSync(path.join(root, ".luseen/design/design-system.md"), "utf8")).toContain(
        "## Status\n\napproved",
      );
      const canvas = JSON.parse((await sendTo(gui, "GET", "/api/canvas")).body) as { nextStep: unknown };
      expect(canvas.nextStep).toEqual({ kind: "first-task", taskId: 1 });
      const [session] = (await openPlanStore(root).list()).sessions;
      expect(session).toMatchObject({ status: "approved", project: { phase: "done" } });

      // FR-GUI-047: only what the setup writes, and luseen's own folders.
      expect(readdirSync(root).sort()).toEqual(
        [".agents", ".claude", ".git", ".luseen", ".mcp.json", "AGENTS.md", "CLAUDE.md", "README.md"].sort(),
      );
    },
    SLOW,
  );

  it(
    "TC-GUI-139: a failed spec job shows its message with Retry, and Retry writes the specs and asks for the roadmap",
    async () => {
      const root = emptyProject();
      let failures = 1;
      const gui = await startGui(root, {
        startJob: (args, cwd) => {
          // The first spec job stops at Claude's usage limit, as the CLI reports it.
          if (args.includes("--no-design") && failures > 0) {
            failures -= 1;
            return startProcess(
              process.execPath,
              [
                "-e",
                'console.log(JSON.stringify({status:"error",message:"Claude\'s usage limit is reached."}));process.exit(4)',
              ],
              { cwd, environment: process.env },
            );
          }
          return startProcess(process.execPath, [luseenBin(), ...args], {
            cwd,
            environment: running.at(-1)?.harness.environment ?? process.env,
          });
        },
      });
      await post(gui, "/api/plan", { target: { kind: "new-project" }, text: "A booking app" });
      await vi.waitFor(async () => {
        {
          // The brief is recorded during the PM's turn; it can be approved once the turn ends.
          const view = await viewOf(gui);
          if ((view.open?.project?.brief ?? null) === null || view.turn !== null) throw new Error("no brief yet");
        }
      }, WAIT);
      const planId = (await viewOf(gui)).open?.id;
      await post(gui, "/api/plan/approve", { planId });
      const failed = await vi.waitFor(async () => {
        const view = await viewOf(gui);
        if (view.step !== null || view.notice === null) throw new Error("still writing the specs");
        return view;
      }, WAIT);
      expect(failed.notice).toEqual({
        message: "Writing the specs stopped: Claude's usage limit is reached.",
        action: "retry",
      });
      expect(failed.open?.project?.phase).toBe("specs");

      expect((await post(gui, "/api/plan/retry")).status).toBe(200);
      await vi.waitFor(async () => {
        const view = await viewOf(gui);
        if (view.open?.proposal?.kind !== "roadmap" || view.turn !== null) throw new Error("no roadmap yet");
      }, WAIT);
      expect(existsSync(path.join(root, ".luseen/sdd/README.md"))).toBe(true);
    },
    SLOW,
  );
});
