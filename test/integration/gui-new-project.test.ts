/// <reference lib="dom" />
/** A new project from an empty folder, in the GUI (gui FR-GUI-085 to FR-GUI-090, roadmap-planning FR-PLAN-047). */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startProcess } from "../../src/adapters/process/job-process.js";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import type { PlanPanelView } from "../../src/application/gui-planning.js";
import { luseenBin } from "../../src/cli/luseen-bin.js";
import type { GuiDependencies } from "../../src/cli/gui-command.js";
import type { RoadmapProposal } from "../../src/core/planning.js";
import { REPO_ROOT, agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";
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

/** The fake `claude` the GUI runs, with its rules and its recorded calls. */
const agentsOf = new Map<TestGui, ReturnType<typeof agentHarness>>();

async function startGui(
  root: string,
  dependencies: GuiDependencies = {},
  env: NodeJS.ProcessEnv = {},
  rules: readonly FakeClaudeRule[] = RULES,
) {
  const harness = agentHarness({ rules, env: { FAKE_CLAUDE_FALLBACK: "1", ...env } });
  const gui = await startTestGui(root, {}, { every, ...dependencies }, harness.environment);
  running.push(gui);
  agentsOf.set(gui, harness);
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
    "TC-GUI-138, TC-GUI-140, TC-GUI-141, TC-PLAN-096, TC-PLAN-091: one click on the brief sets up the whole project in the chat",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root);
      const page = await openPage(gui);
      await page.locator("#new-project-start").click();
      await expect.poll(() => page.locator("#plan-panel").isVisible()).toBe(true);
      expect(await page.locator("#plan-progress .is-current").innerText()).toContain("Brief");
      await page.locator("#plan-text").fill("A booking app for a clinic");
      await page.locator("#plan-text").press("Enter");

      // TC-PLAN-091: the brief comes from brief_propose, so the PM had luseen's planning tools.
      const brief = page.locator('[aria-label="Brief"]');
      await brief.waitFor(WAIT);
      expect(await brief.innerText()).toContain("Clinic booking");
      expect(await brief.innerText()).toContain("Approving it sets up the project");
      const turns = (agentsOf.get(gui)?.calls() ?? []).filter((call) => call.args.includes("--mcp-config"));
      expect(turns.length).toBeGreaterThan(0);
      for (const call of turns) expect(call.args).not.toContain("--safe-mode");

      // TC-PLAN-096: every button and step shown from here on, to prove nothing else was asked of the user.
      await page.evaluate(() => {
        const seen = { buttons: new Set<string>(), steps: new Set<string>() };
        Object.assign(window, { seen });
        new MutationObserver(() => {
          for (const control of document.querySelectorAll("#plan-log button")) seen.buttons.add(control.textContent);
          const current = document.querySelector("#plan-progress .is-current")?.textContent;
          if (current) seen.steps.add(current);
        }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      });
      await brief.getByRole("button", { name: "Approve and set up" }).click();

      const summary = page.locator('[aria-label="Project set up"]');
      await summary.waitFor(WAIT);
      const seen = await page.evaluate(() => {
        const { buttons, steps } = (window as unknown as { seen: { buttons: Set<string>; steps: Set<string> } }).seen;
        return { buttons: [...buttons], steps: [...steps] };
      });
      expect(
        seen.buttons.filter((label) => /^(Approve|Approve design|Skip.*|Continue without design)$/.test(label)),
      ).toEqual([]);
      for (const step of ["Specs", "Roadmap", "Design"])
        expect(
          seen.steps.some((shown) => shown.includes(step)),
          step,
        ).toBe(true);
      expect(await summary.innerText()).toContain('"work on task 1"');
      expect(await summary.getByRole("link", { name: "Open the style guide" }).getAttribute("href")).toBe(
        "/api/design/style-guide",
      );

      expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe(`${BRIEF}\n`);
      for (const file of [
        ".luseen/sdd/README.md",
        "AGENTS.md",
        "CLAUDE.md",
        ".mcp.json",
        ".agents/skills/write-code/SKILL.md",
        ".claude/agents/pm.md",
        ".claude/agents/designer.md",
      ])
        expect(existsSync(path.join(root, file)), file).toBe(true);
      const jobs = JSON.parse((await sendTo(gui, "GET", "/api/jobs")).body) as { jobs: { kind: string }[] };
      expect(jobs.jobs.map((job) => job.kind)).toContain("project-specs");
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
      // FR-PLAN-061: the PM is asked for the roadmap, which is saved without asking.
      await vi.waitFor(async () => {
        const phase = (await viewOf(gui)).open?.project?.phase;
        if (phase !== "design" && phase !== "done") throw new Error("no roadmap yet");
      }, WAIT);
      expect(existsSync(path.join(root, ".luseen/sdd/README.md"))).toBe(true);
    },
    SLOW,
  );
});

describe("the PM chat in the GUI", () => {
  it(
    "TC-PLAN-092: a turn whose luseen server failed stops before the PM replies, keeps the message, and Retry runs it",
    async () => {
      const root = emptyProject();
      const failing: FakeClaudeRule = {
        match: "empty folder",
        mcpStatus: "failed",
        message: "I can't save it.",
        times: 1,
      };
      // Retry asks the PM to answer the stopped turn.
      const retried: FakeClaudeRule = {
        match: "Your last turn was stopped",
        message: "The brief.",
        tools: [{ name: "brief_propose", input: { markdown: BRIEF, hasScreens: true } }],
      };
      const gui = await startGui(root, {}, {}, [failing, retried, ...RULES]);
      const page = await openPage(gui);
      await page.locator("#new-project-start").click();
      await page.locator("#plan-text").fill("A booking app");
      await page.locator("#plan-text").press("Enter");
      const problem = page.locator(".plan-error", { hasText: "The PM can't reach luseen's planning tools" });
      await problem.waitFor(WAIT);
      expect(await problem.innerText()).toContain("the luseen server is failed");
      expect(await page.locator(".plan-user", { hasText: "A booking app" }).count()).toBe(1);
      expect(await page.locator(".plan-pm").count()).toBe(0);
      const view = await viewOf(gui);
      expect(view.notice?.action).toBe("retry");
      expect(view.open?.status).toBe("open");

      await problem.getByRole("button", { name: "Retry" }).click();
      await page.locator('[aria-label="Brief"]').waitFor(WAIT);
    },
    SLOW,
  );

  it(
    "TC-PLAN-094: Enter shows the message at once, clears the box and shows Starting the PM, before Claude writes it",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root, {}, { FAKE_CLAUDE_STARTUP_MS: "5000", FAKE_CLAUDE_PREPARE_MS: "2000" });
      const page = await openPage(gui);
      await page.locator("#new-project-start").click();
      await page.locator("#plan-text").fill("A todo app");
      await page.locator("#plan-text").press("Enter");
      const sent = page.locator(".plan-user", { hasText: "A todo app" });
      const check = async () => {
        expect(await sent.count()).toBe(1);
        expect(await page.locator("#plan-text").inputValue()).toBe("");
        expect(await page.locator("#plan-start-heading").count()).toBe(0);
        expect(await page.locator(".plan-working").innerText()).toContain("Starting the PM");
      };
      await sent.waitFor({ timeout: 300 });
      await check();
      // At 3 s the start request is answered, and Claude Code is still starting up.
      await page.waitForTimeout(3000);
      await check();
      await page.locator('[aria-label="Brief"]').waitFor(WAIT);
      expect(await sent.count()).toBe(1);
      const order = await page
        .locator("#plan-log .plan-msg")
        .evaluateAll((nodes) => nodes.map((node) => (node.classList.contains("plan-user") ? "user" : "pm")));
      expect(order.slice(0, 2)).toEqual(["user", "pm"]);
    },
    SLOW,
  );

  it(
    "TC-PLAN-095: a start that fails puts the message and its file back in the box, with the problem and Retry",
    async () => {
      const root = emptyProject();
      const harness = agentHarness({ rules: RULES, withClaude: false, env: { FAKE_CLAUDE_FALLBACK: "1" } });
      const gui = await startTestGui(root, {}, { every }, harness.environment);
      running.push(gui);
      const page = await openPage(gui);
      await page.locator("#new-project-start").click();
      const image = path.join(makeTempFolder(), "mock.png");
      writeFileSync(image, Buffer.from("iVBORw0KGgo=", "base64"));
      await page.locator("#plan-files").setInputFiles(image);
      await page.locator("#plan-chips .plan-chip", { hasText: "mock.png" }).waitFor(WAIT);
      await page.locator("#plan-text").fill("A todo app");
      await page.locator("#plan-text").press("Enter");

      const problem = page.locator(".plan-error", { hasText: "Claude" });
      await problem.waitFor(WAIT);
      expect(await page.locator("#plan-text").inputValue()).toBe("A todo app");
      expect(await page.locator("#plan-chips .plan-chip", { hasText: "mock.png" }).count()).toBe(1);
      expect(await page.locator("#plan-log .plan-user").count()).toBe(0);

      // Claude Code is installed now, so Retry sends it.
      copyFileSync(path.join(REPO_ROOT, "test/fixtures/fake-claude/claude"), path.join(harness.bin, "claude"));
      chmodSync(path.join(harness.bin, "claude"), 0o755);
      await problem.getByRole("button", { name: "Retry" }).click();
      await page.locator('[aria-label="Brief"]').waitFor(WAIT);
      expect((await viewOf(gui)).open?.attachments).toEqual([expect.objectContaining({ name: "mock.png" })]);
    },
    SLOW,
  );

  it(
    "FR-PLAN-061 (review run 1): after a roadmap turn that proposed nothing, a reply asks again, and that turn shows as running",
    async () => {
      const root = emptyProject();
      const rules: FakeClaudeRule[] = [
        { match: "The specs are written in", message: "I need more detail first.", times: 1 },
        { match: "Go ahead", message: "OK." },
        {
          match: "The specs are written in",
          delayMs: 4000,
          message: "The first release.",
          tools: [{ name: "plan_propose", input: { proposal: ROADMAP } }],
        },
        ...RULES.filter((rule) => rule.match === "empty folder"),
      ];
      const gui = await startGui(root, {}, {}, rules);
      await post(gui, "/api/plan", { target: { kind: "new-project" }, text: "A booking app" });
      await vi.waitFor(async () => {
        const view = await viewOf(gui);
        if ((view.open?.project?.brief ?? null) === null || view.turn !== null) throw new Error("no brief yet");
      }, WAIT);
      await post(gui, "/api/plan/approve", { planId: (await viewOf(gui)).open?.id });
      await vi.waitFor(async () => {
        const view = await viewOf(gui);
        if (view.notice?.action !== "retry" || view.turn !== null) throw new Error("the roadmap turn hasn't ended");
      }, WAIT);
      expect((await post(gui, "/api/plan/message", { text: "Go ahead", uploads: [] })).status).toBe(200);
      const asks = () =>
        (agentsOf.get(gui)?.calls() ?? []).filter((call) => call.prompt.startsWith("The specs are written in")).length;
      await vi.waitFor(() => {
        if (asks() < 2) throw new Error("not asked again yet");
      }, WAIT);
      // The roadmap turn asked from the reply's turn is the one running, so Stop and the panel know about it.
      expect((await viewOf(gui)).turn).not.toBeNull();
      expect((await post(gui, "/api/plan/message", { text: "More", uploads: [] })).status).toBe(409);
      await vi.waitFor(async () => {
        const phase = (await viewOf(gui)).open?.project?.phase;
        if (phase !== "done") throw new Error("not done yet");
      }, WAIT);
    },
    SLOW,
  );
});
