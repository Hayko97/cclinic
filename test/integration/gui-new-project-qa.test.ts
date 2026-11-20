/// <reference lib="dom" />
/** QA: a new project's design step, style guide and refusals in the GUI (gui FR-GUI-085 to FR-GUI-090). */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import type { PlanPanelView } from "../../src/application/gui-planning.js";
import { newPlanSession, type RoadmapProposal } from "../../src/core/planning.js";
import { agentHarness, makeTempFolder, type FakeClaudeRule } from "../support/helpers.js";
import { sendTo, startTestGui, type TestGui } from "../support/gui.js";

const WAIT = { timeout: 60_000, interval: 200 };
const SLOW = 180_000;

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

async function startGui(root: string, env: Record<string, string> = {}) {
  const harness = agentHarness({ rules: RULES, env: { FAKE_CLAUDE_FALLBACK: "1", ...env } });
  const gui = await startTestGui(root, {}, { every }, harness.environment);
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

/** Through the API: the brief, the specs and the roadmap approved, so the session is at its design. */
async function toDesign(gui: TestGui, page?: Page): Promise<string> {
  if (page === undefined) await post(gui, "/api/plan", { target: { kind: "new-project" }, text: "A booking app" });
  else {
    await page.locator("#new-project-start").click();
    await page.locator("#plan-text").fill("A booking app");
    await page.locator("#plan-text").press("Enter");
  }
  await vi.waitFor(async () => {
    {
      // The brief is recorded during the PM's turn; it can be approved once the turn ends.
      const view = await viewOf(gui);
      if ((view.open?.project?.brief ?? null) === null || view.turn !== null) throw new Error("no brief yet");
    }
  }, WAIT);
  const planId = String((await viewOf(gui)).open?.id);
  expect((await post(gui, "/api/plan/approve", { planId })).status).toBe(200);
  await vi.waitFor(async () => {
    const view = await viewOf(gui);
    if (view.open?.proposal?.kind !== "roadmap" || view.turn !== null) throw new Error("no roadmap yet");
  }, WAIT);
  expect((await post(gui, "/api/plan/approve", { planId })).status).toBe(200);
  await vi.waitFor(async () => {
    const view = await viewOf(gui);
    // With no design system made, the setup ends instead of waiting at its design (FR-PLAN-054).
    const phase = view.open?.project?.phase;
    if ((phase !== "design" && phase !== "done") || view.step !== null) throw new Error("design step running");
  }, WAIT);
  return planId;
}

/** A request with no token, as another site or tab without the cookie would send it. */
function sendWithoutToken(gui: TestGui, requestPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: "127.0.0.1", port: gui.port, path: requestPath, headers: { host: `127.0.0.1:${gui.port}` } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("QA: the GUI's new project", () => {
  it(
    "TC-GUI-140 (QA): the style guide link opens in a new tab through the token-protected server, with a sandboxing CSP",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root);
      const page = await openPage(gui);
      await toDesign(gui, page);
      const card = page.locator('[aria-label="Design system"]');
      await card.waitFor(WAIT);
      const [tab] = await Promise.all([
        page.context().waitForEvent("page"),
        card.locator('a[href="/api/design/style-guide"]').click(),
      ]);
      await tab.waitForLoadState();
      expect(tab.url()).toBe(`http://127.0.0.1:${gui.port}/api/design/style-guide`);
      expect(await tab.content()).toContain("Style guide");
      const response = await tab.reload();
      if (response === null) throw new Error("no response");
      expect(response.status()).toBe(200);
      const csp = response.headers()["content-security-policy"] ?? "";
      expect(csp).toContain("sandbox");
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain("script-src");
      expect(await sendWithoutToken(gui, "/api/design/style-guide")).not.toBe(200);
      // A new project's own jobs can't be started from Setup.
      const job = await post(gui, "/api/jobs", { command: "project-specs" });
      expect(job.status).toBe(400);
      // FR-GUI-090: once approved, the canvas banner names the first task, with a copy button.
      await card.locator('[data-plan-design="approve"]').click();
      await page.locator('[aria-label="Project set up"]').waitFor(WAIT);
      await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
      const banner = page.locator("#next-step");
      await expect.poll(() => banner.innerText(), WAIT).toContain('"work on task 1"');
      expect(await banner.locator("button", { hasText: "Copy" }).count()).toBe(1);
    },
    SLOW,
  );

  it(
    "TC-GUI-140 (QA): approve design before the design phase is refused",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root);
      await post(gui, "/api/plan", { target: { kind: "new-project" }, text: "A booking app" });
      await vi.waitFor(async () => {
        {
          // The brief is recorded during the PM's turn; it can be approved once the turn ends.
          const view = await viewOf(gui);
          if ((view.open?.project?.brief ?? null) === null || view.turn !== null) throw new Error("no brief yet");
        }
      }, WAIT);
      const planId = String((await viewOf(gui)).open?.id);
      const early = await post(gui, "/api/plan/design", { planId, isApproved: true });
      expect(early.status).toBe(409);
      expect((await viewOf(gui)).open?.project?.phase).toBe("brief");
    },
    SLOW,
  );

  it(
    "FR-GUI-087 (QA): a README.md made while the brief waits is refused on approve, and the brief stays waiting",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root);
      await post(gui, "/api/plan", { target: { kind: "new-project" }, text: "A booking app" });
      await vi.waitFor(async () => {
        {
          // The brief is recorded during the PM's turn; it can be approved once the turn ends.
          const view = await viewOf(gui);
          if ((view.open?.project?.brief ?? null) === null || view.turn !== null) throw new Error("no brief yet");
        }
      }, WAIT);
      const planId = String((await viewOf(gui)).open?.id);
      writeFileSync(path.join(root, "README.md"), "mine\n");
      const refused = await post(gui, "/api/plan/approve", { planId });
      expect(refused.status).toBe(409);
      expect(refused.body).toContain("README.md already exists");
      const view = await viewOf(gui);
      expect(view.open?.project?.phase).toBe("brief");
      expect(view.open?.project?.brief).not.toBeNull();
      expect(existsSync(path.join(root, ".luseen/sdd"))).toBe(false);
    },
    SLOW,
  );

  it(
    "TC-GUI-139/FR-GUI-089 (QA): a failed design step shows its message with Retry and Skip, and Skip finishes",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root, { FAKE_CLAUDE_DESIGN: "fail" });
      const page = await openPage(gui);
      const planId = await toDesign(gui, page);
      const view = await viewOf(gui);
      expect(view.notice?.action).toBe("retry");
      expect(view.open?.project?.phase).toBe("design");
      await page.locator(".plan-error").first().waitFor(WAIT);
      const panel = await page.locator("#plan-panel").innerText();
      expect(panel).toContain("Retry");
      // FR-GUI-089: "A failure must show the message with Retry and Skip."
      expect(await page.locator('[data-plan-design="skip"]').count()).toBeGreaterThan(0);
      expect((await post(gui, "/api/plan/design", { planId, isApproved: false })).status).toBe(200);
      expect((await viewOf(gui)).open?.project?.phase).toBe("done");
    },
    SLOW,
  );

  it(
    "QA exploratory: when the designer makes no design system, the GUI doesn't offer to approve files that aren't there",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root, { FAKE_CLAUDE_DESIGN: "none" });
      const page = await openPage(gui);
      const planId = await toDesign(gui, page);
      expect(existsSync(path.join(root, ".luseen/design/design-system.md"))).toBe(false);
      // The panel shows the session's end of the conversation (the roadmap's approval) before the check.
      await expect.poll(() => page.locator("#plan-panel").isVisible(), WAIT).toBe(true);
      // FR-PLAN-054: with nothing to approve, the setup ends, and the summary names no design system.
      await page.locator('[aria-label="Project set up"]').waitFor(WAIT);
      expect(await page.locator('[aria-label="Project set up"]').innerText()).not.toContain(".luseen/design");
      const card = page.locator('[aria-label="Design system"]');
      expect(await card.count()).toBe(0);
      // And approving it is refused, as nothing passes the checks.
      expect((await post(gui, "/api/plan/design", { planId, isApproved: true })).status).toBe(409);
    },
    SLOW,
  );
});

describe("QA run 2: the GUI's design card", () => {
  it(
    "FR-GUI-089 (QA run 2, DEF-2): after a failed design step the card has Skip and no Approve, and clicking Skip finishes",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root, { FAKE_CLAUDE_DESIGN: "fail" });
      const page = await openPage(gui);
      await toDesign(gui, page);
      expect((await viewOf(gui)).open?.project?.phase).toBe("design");
      const card = page.locator('[aria-label="Design system"]');
      await card.waitFor(WAIT);
      expect(await card.locator('[data-plan-design="approve"]').count()).toBe(0);
      await card.locator('[data-plan-design="skip"]').click();
      await page.locator('[aria-label="Project set up"]').waitFor(WAIT);
      expect(await page.locator('[aria-label="Project set up"]').innerText()).not.toContain(".luseen/design");
      expect((await viewOf(gui)).open?.project?.phase ?? "done").toBe("done");
      expect(existsSync(path.join(root, ".luseen/design"))).toBe(false);
    },
    SLOW,
  );

  it(
    "TC-PLAN-087/FR-GUI-089 (QA run 2, DEF-3): Skip on a waiting draft removes it, and the summary names no design system",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root);
      const page = await openPage(gui);
      await toDesign(gui, page);
      expect(existsSync(path.join(root, ".luseen/design/design-system.md"))).toBe(true);
      const card = page.locator('[aria-label="Design system"]');
      await card.waitFor(WAIT);
      expect(await card.locator('[data-plan-design="approve"]').count()).toBe(1);
      await card.locator('[data-plan-design="skip"]').click();
      const done = page.locator('[aria-label="Project set up"]');
      await done.waitFor(WAIT);
      expect(await done.innerText()).not.toContain(".luseen/design");
      expect(await done.innerText()).toContain('"work on task 1"');
      expect(existsSync(path.join(root, ".luseen/design"))).toBe(false);
    },
    SLOW,
  );
});

/** A new-project session written straight to the store, held by a process that has ended. */
async function storedSession(root: string, brief: string | null) {
  const store = openPlanStore(root);
  const session = await store.create((id) =>
    newPlanSession({
      id,
      target: { kind: "new-project" },
      summary: "A booking app",
      holder: { place: "terminal", pid: 2_147_483_646 },
      claudeSessionId: null,
      transcriptPath: null,
      now: new Date().toISOString(),
    }),
  );
  if (brief === null) return session;
  return store.update(session.id, (current) => {
    const next = {
      ...current,
      project:
        current.project === null
          ? null
          : { ...current.project, brief: { markdown: brief, hasScreens: false, proposedAt: new Date().toISOString() } },
    };
    return { save: next, value: next };
  });
}

describe("QA run 3: the GUI's new project after the code review", () => {
  it(
    "FR-PLAN-056/FR-GUI-088 (QA run 3): Cancel is refused while the specs are written, and works once the step ends",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root, { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DELAY_MS: "4000" });
      await post(gui, "/api/plan", { target: { kind: "new-project" }, text: "A booking app" });
      await vi.waitFor(async () => {
        const view = await viewOf(gui);
        if ((view.open?.project?.brief ?? null) === null || view.turn !== null) throw new Error("no brief yet");
      }, WAIT);
      const planId = String((await viewOf(gui)).open?.id);
      expect((await post(gui, "/api/plan/approve", { planId })).status).toBe(200);
      expect((await viewOf(gui)).step?.kind).toBe("specs");
      const refused = await post(gui, "/api/plan/cancel", { planId });
      expect(refused.status).toBe(409);
      expect(refused.body).toContain("luseen is still setting up the project");
      expect((await viewOf(gui)).open).toMatchObject({ id: planId, status: "open", project: { phase: "specs" } });

      await vi.waitFor(async () => {
        const view = await viewOf(gui);
        if (view.open?.proposal?.kind !== "roadmap" || view.turn !== null) throw new Error("no roadmap yet");
      }, WAIT);
      expect(existsSync(path.join(root, ".luseen/sdd/README.md"))).toBe(true);
      expect((await post(gui, "/api/plan/cancel", { planId })).status).toBe(200);
      const [session] = (await openPlanStore(root).list()).sessions;
      expect(session).toMatchObject({ status: "cancelled", project: { phase: "roadmap" } });
      expect(existsSync(path.join(root, "README.md"))).toBe(true);
    },
    SLOW,
  );

  it(
    "FR-PLAN-048 (QA run 3): approving a brief of a session not open in the panel writes it, but doesn't run its specs",
    async () => {
      const root = emptyProject();
      const other = await storedSession(root, BRIEF);
      const shown = await storedSession(root, null);
      const gui = await startGui(root);
      expect((await post(gui, "/api/plan/open", { planId: shown.id })).status).toBe(200);
      expect((await viewOf(gui)).open?.id).toBe(shown.id);

      const approved = await post(gui, "/api/plan/approve", { planId: other.id });
      expect(approved.status, approved.body).toBe(200);
      expect(approved.body).toContain("Saved README.md");
      const view = await viewOf(gui);
      expect(view.open?.id).toBe(shown.id);
      expect(view.step).toBeNull();
      expect((await openPlanStore(root).read(other.id))?.project?.phase).toBe("specs");
      expect(existsSync(path.join(root, "README.md"))).toBe(true);
      expect(existsSync(path.join(root, ".luseen/sdd"))).toBe(false);
    },
    SLOW,
  );

  it(
    "FR-GUI-087 (QA run 3): the brief card's buttons are disabled once one is clicked, and the brief is approved once",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root, { FAKE_CLAUDE_DESIGN: "none" });
      const page = await openPage(gui);
      await page.locator("#new-project-start").click();
      await page.locator("#plan-text").fill("A booking app");
      await page.locator("#plan-text").press("Enter");
      const card = page.locator('[aria-label="Brief"]');
      await card.waitFor(WAIT);
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let approvals = 0;
      await page.route("**/api/plan/approve", async (route) => {
        approvals += 1;
        await held;
        await route.continue();
      });
      await card.locator('[data-plan-decide="approve"]').click();
      expect(await card.locator('[data-plan-decide="approve"]').isDisabled()).toBe(true);
      expect(await card.locator('[data-plan-decide="cancel"]').isDisabled()).toBe(true);
      await card.locator('[data-plan-decide="approve"]').click({ force: true });
      release();
      await vi.waitFor(async () => {
        if ((await viewOf(gui)).open?.project?.phase === "brief") throw new Error("still at the brief");
      }, WAIT);
      expect(approvals).toBe(1);
      expect(existsSync(path.join(root, "README.md"))).toBe(true);
    },
    SLOW,
  );

  it(
    "FR-GUI-089 (QA run 3): the style guide route is 404 only when the file is missing, and an unreadable one is an error",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root);
      expect((await sendTo(gui, "GET", "/api/design/style-guide")).status).toBe(404);
      mkdirSync(path.join(root, ".luseen/design/style-guide.html"), { recursive: true });
      const unreadable = await sendTo(gui, "GET", "/api/design/style-guide");
      expect(unreadable.status).toBe(500);
      expect(unreadable.body).not.toContain(root);
      rmSync(path.join(root, ".luseen/design/style-guide.html"), { recursive: true });
      writeFileSync(path.join(root, ".luseen/design/style-guide.html"), "<!doctype html><title>Style guide</title>");
      const found = await sendTo(gui, "GET", "/api/design/style-guide");
      expect(found.status).toBe(200);
      expect(found.body).toContain("<title>Style guide</title>");
    },
    SLOW,
  );
});

describe("QA run 3: exploring the design card", () => {
  it(
    "DEF-10 (QA run 3): approve and skip sent at once leave a state that matches the answer each got",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root);
      const planId = await toDesign(gui);
      expect(existsSync(path.join(root, ".luseen/design/design-system.md"))).toBe(true);
      const [approved, skipped] = await Promise.all([
        post(gui, "/api/plan/design", { planId, isApproved: true }),
        post(gui, "/api/plan/design", { planId, isApproved: false }),
      ]);
      const hasDesign = existsSync(path.join(root, ".luseen/design/design-system.md"));
      const statuses = [approved.status, skipped.status];
      // Exactly one decision wins, and the files match it.
      expect(
        statuses.filter((status) => status === 200),
        JSON.stringify([approved.body, skipped.body]),
      ).toHaveLength(1);
      expect(
        hasDesign,
        JSON.stringify([approved.status, approved.body.slice(0, 200), skipped.status, skipped.body.slice(0, 200)]),
      ).toBe(approved.status === 200);
    },
    SLOW,
  );
});
