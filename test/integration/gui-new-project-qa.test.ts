/// <reference lib="dom" />
/** QA: a new project's design step, style guide and refusals in the GUI (gui FR-GUI-085 to FR-GUI-090). */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
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

function roadmapTitles(root: string): string[] {
  const store = openTaskStore(path.join(root, ".luseen"), "read");
  try {
    return store?.listRoadmaps().map((roadmap) => roadmap.title) ?? [];
  } finally {
    store?.close();
  }
}

function every(ms: number, run: () => Promise<void>): () => void {
  const timer = setInterval(() => void run(), Math.min(ms, 200));
  return () => {
    clearInterval(timer);
  };
}

/** The PM's roadmap turn ends without proposing anything, so nothing is saved (FR-PLAN-053). */
const NO_ROADMAP_RULES: FakeClaudeRule[] = [
  { match: "The specs are written in", message: "I'll think about the roadmap." },
  ...RULES.slice(1),
];

async function startGui(root: string, env: Record<string, string> = {}, rules: FakeClaudeRule[] = RULES) {
  const harness = agentHarness({ rules, env: { FAKE_CLAUDE_FALLBACK: "1", ...env } });
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

/**
 * Through the API: the brief approved, the only approval, so the setup writes the specs, saves the roadmap and runs
 * the design step by itself (FR-PLAN-061). Waits until the design step has ended: done, or failed at its design.
 */
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
    // The setup ends, or waits at its design after a failed design step (FR-PLAN-054).
    const phase = view.open?.project?.phase;
    if ((phase !== "design" && phase !== "done") || view.step !== null || view.turn !== null) {
      throw new Error("setup running");
    }
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
      // FR-GUI-089: the design system is approved with no click, so there's no Approve or Skip.
      const card = page.locator('[aria-label="Project set up"]');
      await card.waitFor(WAIT);
      expect(await page.locator("[data-plan-design]").count()).toBe(0);
      expect(readFileSync(path.join(root, ".luseen/design/design-system.md"), "utf8")).toContain(
        "## Status\n\napproved",
      );
      expect((await viewOf(gui)).open?.project?.phase).toBe("done");
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
      // FR-GUI-090: once set up, the canvas banner names the first task, with a copy button.
      await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
      const banner = page.locator("#next-step");
      await expect.poll(() => banner.innerText(), WAIT).toContain('"work on task 1"');
      expect(await banner.locator("button", { hasText: "Copy" }).count()).toBe(1);
    },
    SLOW,
  );

  it(
    "TC-GUI-140 (QA): continue without design before the design phase is refused, and the old approve flag is rejected",
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
      const early = await post(gui, "/api/plan/design", { planId });
      expect(early.status).toBe(409);
      // FR-GUI-089: the design system can't be approved by hand any more, so the route takes only the session.
      expect((await post(gui, "/api/plan/design", { planId, isApproved: true })).status).toBe(400);
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
    "TC-GUI-139/FR-GUI-089 (QA): a failed design step shows its message with Retry and Continue without design, which finishes",
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
      // FR-GUI-089: "A failure must show the message with Retry and Continue without design."
      const skip = page.locator('[data-plan-design="skip"]');
      await skip.first().waitFor(WAIT);
      expect(await skip.first().innerText()).toBe("Continue without design");
      expect(await page.locator('[data-plan-design="approve"]').count()).toBe(0);
      // FR-PLAN-053: the roadmap was saved with no approval asked, shown with no Approve or Cancel.
      const saved = page.locator('[aria-label="Roadmap saved"]');
      await saved.waitFor(WAIT);
      expect(await saved.locator("button").count()).toBe(0);
      const continued = await post(gui, "/api/plan/design", { planId });
      expect(continued.status).toBe(200);
      expect(continued.body).toContain("Continued without a design system.");
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
      // And continuing without design is refused, as the setup is already done.
      expect((await post(gui, "/api/plan/design", { planId })).status).toBe(409);
    },
    SLOW,
  );
});

describe("QA run 2: the GUI's design card", () => {
  it(
    "FR-GUI-089 (QA run 2, DEF-2): after a failed design step the card has Continue without design and no Approve, and clicking it finishes",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root, { FAKE_CLAUDE_DESIGN: "fail" });
      const page = await openPage(gui);
      await toDesign(gui, page);
      expect((await viewOf(gui)).open?.project?.phase).toBe("design");
      const card = page.locator('[aria-label="Design system"]');
      await card.waitFor(WAIT);
      expect(await card.locator('[data-plan-design="approve"]').count()).toBe(0);
      expect(await card.locator("button").allInnerTexts()).toEqual(["Continue without design"]);
      await card.locator('[data-plan-design="skip"]').click();
      await page.locator('[aria-label="Project set up"]').waitFor(WAIT);
      expect(await page.locator('[aria-label="Project set up"]').innerText()).not.toContain(".luseen/design");
      // FR-GUI-089: the style guide link is offered only when a design system exists.
      expect(await page.locator('[aria-label="Project set up"] a[href="/api/design/style-guide"]').count()).toBe(0);
      expect((await viewOf(gui)).open?.project?.phase ?? "done").toBe("done");
      expect(existsSync(path.join(root, ".luseen/design"))).toBe(false);
    },
    SLOW,
  );

  it(
    "TC-PLAN-087/FR-GUI-089 (QA run 2, DEF-3): a draft that fails the checks is removed, not approved; Continue without design names no design system",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root, { FAKE_CLAUDE_DESIGN: "invalid" });
      const page = await openPage(gui);
      await toDesign(gui, page);
      const view = await viewOf(gui);
      expect(view.open?.project?.phase).toBe("design");
      expect(view.notice?.action).toBe("retry");
      expect(existsSync(path.join(root, ".luseen/design/design-system.md"))).toBe(false);
      const card = page.locator('[aria-label="Design system"]');
      await card.waitFor(WAIT);
      expect(await card.locator('[data-plan-design="approve"]').count()).toBe(0);
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
      // The PM's roadmap turn proposes nothing, so the session waits at its roadmap with nothing saved.
      const gui = await startGui(root, { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DELAY_MS: "4000" }, NO_ROADMAP_RULES);
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
        if (view.notice?.action !== "retry" || view.turn !== null) throw new Error("roadmap turn not ended yet");
      }, WAIT);
      expect((await viewOf(gui)).notice?.message).toBe(
        "The PM ended without proposing the roadmap, so nothing was saved. Retry asks it again.",
      );
      expect(existsSync(path.join(root, ".luseen/sdd/README.md"))).toBe(true);
      const cancelled = await post(gui, "/api/plan/cancel", { planId });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toContain("Kept what was already written: README.md, .luseen/sdd and the agent setup");
      const [session] = (await openPlanStore(root).list()).sessions;
      expect(session).toMatchObject({ status: "cancelled", project: { phase: "roadmap" } });
      expect(existsSync(path.join(root, "README.md"))).toBe(true);
      expect(roadmapTitles(root)).toEqual([]);
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
      expect(await card.locator('[data-plan-decide="approve"]').innerText()).toBe("Approve and set up");
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
    "DEF-10 (QA run 3): two Continue without design sent at once after a failed design step: one wins, and the files match",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root, { FAKE_CLAUDE_DESIGN: "fail" });
      const planId = await toDesign(gui);
      expect((await viewOf(gui)).open?.project?.phase).toBe("design");
      const [first, second] = await Promise.all([
        post(gui, "/api/plan/design", { planId }),
        post(gui, "/api/plan/design", { planId }),
      ]);
      const statuses = [first.status, second.status].sort();
      // Exactly one finishes the setup, the other is refused, and the state matches.
      expect(statuses, JSON.stringify([first.body.slice(0, 200), second.body.slice(0, 200)])).toEqual([200, 409]);
      expect(existsSync(path.join(root, ".luseen/design"))).toBe(false);
      const [session] = (await openPlanStore(root).list()).sessions;
      expect(session).toMatchObject({ status: "approved", project: { phase: "done" } });
      expect(roadmapTitles(root)).toEqual(["First release"]);
    },
    SLOW,
  );
});

describe("QA (FR-PLAN-053, FR-PLAN-058, FR-PLAN-060): edge cases of the GUI's new project", () => {
  const approveBrief = async (gui: TestGui): Promise<string> => {
    await vi.waitFor(async () => {
      const view = await viewOf(gui);
      if ((view.open?.project?.brief ?? null) === null || view.turn !== null) throw new Error("no brief yet");
    }, WAIT);
    const planId = String((await viewOf(gui)).open?.id);
    expect((await post(gui, "/api/plan/approve", { planId })).status).toBe(200);
    return planId;
  };
  const waitForRetry = (gui: TestGui) =>
    vi.waitFor(async () => {
      const view = await viewOf(gui);
      if (view.notice?.action !== "retry" || view.turn !== null || view.step !== null) throw new Error("running");
      return view;
    }, WAIT);
  const waitForDone = (gui: TestGui) =>
    vi.waitFor(async () => {
      const view = await viewOf(gui);
      if (view.open?.project?.phase !== "done" || view.step !== null) throw new Error("setup running");
    }, WAIT);

  it(
    "TC-PLAN-086 (QA): an invalid roadmap proposal saves nothing and shows Retry; Retry saves the next valid one and goes on",
    async () => {
      const root = emptyProject();
      const invalid = { ...ROADMAP, milestones: [{ title: "Foundation", goal: "Shell", tasks: [{ key: "x" }] }] };
      const gui = await startGui(root, { FAKE_CLAUDE_DESIGN: "none" }, [
        {
          match: "The specs are written in",
          message: "Here it is.",
          tools: [{ name: "plan_propose", input: { proposal: invalid } }],
          times: 1,
        },
        ...RULES,
      ]);
      await post(gui, "/api/plan", { target: { kind: "new-project" }, text: "A booking app" });
      await approveBrief(gui);
      const failed = await waitForRetry(gui);
      expect(failed.open?.project?.phase).toBe("roadmap");
      expect(roadmapTitles(root)).toEqual([]);
      expect((await post(gui, "/api/plan/retry")).status).toBe(200);
      await waitForDone(gui);
      expect(roadmapTitles(root)).toEqual(["First release"]);
    },
    SLOW,
  );

  it(
    "TC-PLAN-092 (QA): a roadmap turn whose luseen server failed shows the problem with Retry; one Retry saves the roadmap",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root, { FAKE_CLAUDE_DESIGN: "none" }, [
        { match: "The specs are written in", mcpStatus: "failed", message: "I can't.", times: 1 },
        ...RULES,
      ]);
      await post(gui, "/api/plan", { target: { kind: "new-project" }, text: "A booking app" });
      await approveBrief(gui);
      const failed = await waitForRetry(gui);
      expect(failed.notice?.message).toContain("The PM can't reach luseen's planning tools");
      expect(failed.open?.project?.phase).toBe("roadmap");
      expect((await post(gui, "/api/plan/retry")).status).toBe(200);
      await waitForDone(gui);
      expect(roadmapTitles(root)).toEqual(["First release"]);
    },
    SLOW,
  );

  it(
    "TC-PLAN-094 (QA): a page reloaded before Claude writes the message shows it once, and once after the reply",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root, { FAKE_CLAUDE_STARTUP_MS: "5000" });
      const page = await openPage(gui);
      await page.locator("#new-project-start").click();
      await page.locator("#plan-text").fill("A todo app");
      await page.locator("#plan-text").press("Enter");
      await vi.waitFor(async () => {
        if ((await viewOf(gui)).open === null) throw new Error("not started");
      }, WAIT);
      await page.reload();
      await page
        .locator("#plan-panel")
        .waitFor({ state: "visible", timeout: 10_000 })
        .catch(async () => {
          await page.locator("#new-project-start").click();
        });
      const sent = page.locator(".plan-user", { hasText: "A todo app" });
      await sent.first().waitFor({ timeout: 3000 });
      expect(await sent.count()).toBe(1);
      await page.locator('[aria-label="Brief"]').waitFor(WAIT);
      expect(await sent.count()).toBe(1);
    },
    SLOW,
  );

  it(
    "TC-PLAN-094 (QA): a second Enter while the first message is being sent starts nothing else, and keeps what was typed",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root, { FAKE_CLAUDE_STARTUP_MS: "3000", FAKE_CLAUDE_PREPARE_MS: "1500" });
      const page = await openPage(gui);
      await page.locator("#new-project-start").click();
      await page.locator("#plan-text").fill("A todo app");
      await page.locator("#plan-text").press("Enter");
      await page.locator("#plan-text").press("Enter");
      await page.locator("#plan-text").fill("And a calendar");
      await page.locator("#plan-text").press("Enter");
      await page.locator('[aria-label="Brief"]').waitFor(WAIT);
      expect((await openPlanStore(root).list()).sessions.length).toBe(1);
      expect(await page.locator(".plan-user", { hasText: "A todo app" }).count()).toBe(1);
      expect(await page.locator(".plan-user", { hasText: "And a calendar" }).count()).toBe(0);
      expect(await page.locator("#plan-text").inputValue()).toBe("And a calendar");
    },
    SLOW,
  );

  it(
    "FR-PLAN-060, FR-PLAN-061 (QA): a message sent while the specs are written is refused and put back, and the setup goes on",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root, {
        FAKE_CLAUDE_DESIGN: "none",
        FAKE_CLAUDE_MODE: "slow",
        FAKE_CLAUDE_DELAY_MS: "3000",
      });
      const page = await openPage(gui);
      await page.locator("#new-project-start").click();
      await page.locator("#plan-text").fill("A booking app");
      await page.locator("#plan-text").press("Enter");
      await page.locator('[aria-label="Brief"]').waitFor(WAIT);
      await page.locator('[aria-label="Brief"]').getByRole("button", { name: "Approve and set up" }).click();
      await vi.waitFor(async () => {
        if ((await viewOf(gui)).step?.kind !== "specs") throw new Error("no specs step yet");
      }, WAIT);
      const refused = await post(gui, "/api/plan/message", { text: "Also payments", uploads: [] });
      expect(refused.status).toBe(409);
      await page.locator("#plan-text").fill("Also payments");
      await page.locator("#plan-text").press("Enter");
      await page.locator(".plan-error", { hasText: "luseen is still setting up the project" }).waitFor(WAIT);
      expect(await page.locator("#plan-text").inputValue()).toBe("Also payments");
      expect(await page.locator(".plan-user", { hasText: "Also payments" }).count()).toBe(0);
      await waitForDone(gui);
      expect(roadmapTitles(root)).toEqual(["First release"]);
      await page.locator('[aria-label="Project set up"]').waitFor(WAIT);
    },
    SLOW,
  );
  it(
    "FR-PLAN-056 (QA): cancelling during the roadmap turn saves no roadmap, runs no design step, and keeps what was written",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root, {}, [{ ...RULES[0], delayMs: 8000 }, ...RULES.slice(1)]);
      await post(gui, "/api/plan", { target: { kind: "new-project" }, text: "A booking app" });
      const planId = await approveBrief(gui);
      await vi.waitFor(async () => {
        const view = await viewOf(gui);
        if (view.open?.project?.phase !== "roadmap" || view.turn === null) throw new Error("no roadmap turn yet");
      }, WAIT);
      const cancelled = await post(gui, "/api/plan/cancel", { planId });
      expect(cancelled.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 9000));
      const [session] = (await openPlanStore(root).list()).sessions;
      expect(session).toMatchObject({ status: "cancelled", project: { phase: "roadmap" } });
      expect(roadmapTitles(root)).toEqual([]);
      expect(existsSync(path.join(root, ".luseen/design"))).toBe(false);
      expect(existsSync(path.join(root, "README.md"))).toBe(true);
    },
    SLOW,
  );

  it(
    "FR-PLAN-048 (QA): a GUI restarted during the roadmap turn continues the setup at the roadmap when the session is opened",
    async () => {
      const root = emptyProject();
      const first = await startGui(root, {}, [{ ...RULES[0], hang: true }, ...RULES.slice(1)]);
      await post(first, "/api/plan", { target: { kind: "new-project" }, text: "A booking app" });
      const planId = await approveBrief(first);
      await vi.waitFor(async () => {
        const view = await viewOf(first);
        if (view.open?.project?.phase !== "roadmap" || view.turn === null) throw new Error("no roadmap turn yet");
      }, WAIT);
      await first.stop();
      running.splice(running.indexOf(first), 1);

      const second = await startGui(root, { FAKE_CLAUDE_DESIGN: "none" });
      expect((await post(second, "/api/plan/open", { planId })).status).toBe(200);
      await vi.waitFor(async () => {
        const view = await viewOf(second);
        if (view.open?.project?.phase === "done") return;
        if (view.notice?.action === "retry" && view.turn === null && view.step === null) {
          await post(second, "/api/plan/retry");
        }
        throw new Error("not done yet");
      }, WAIT);
      expect(roadmapTitles(root)).toEqual(["First release"]);
      // README.md and the specs aren't written again.
      expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe(`${BRIEF}\n`);
    },
    SLOW,
  );
  it(
    "TC-GUI-140 (QA): the approved design system is shown with the paths of design-system.md and style-guide.html",
    async () => {
      const root = emptyProject();
      const gui = await startGui(root);
      const page = await openPage(gui);
      await toDesign(gui, page);
      const summary = page.locator('[aria-label="Project set up"]');
      await summary.waitFor(WAIT);
      const shown = await page.locator("#plan-log").innerText();
      expect(shown).toContain(".luseen/design/design-system.md");
      expect(shown).toContain(".luseen/design/style-guide.html");
    },
    SLOW,
  );
});
