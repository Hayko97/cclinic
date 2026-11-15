/// <reference lib="dom" />
/** QA: edge cases of answering a change's waiting question from the GUI (spec: gui FR-GUI-038). */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import {
  beginChange,
  stateKey,
  withPending,
  type PendingQuestion,
  type WorkflowState,
} from "../../src/core/workflow.js";
import { waitingQuestion } from "../../src/core/canvas.js";
import { makeTempFolder } from "../support/helpers.js";
import { sendTo, startTestGui, type TestGui } from "../support/gui.js";

const G1: PendingQuestion = {
  kind: "gate",
  gate: "G1",
  step: null,
  reason: null,
  question: 'Approve the spec change for task #2 (spec "refunds")?',
  answers: ["approve", "refine", "review-doc"],
  answer: null,
  notes: null,
};

let browser: Browser;
const running: TestGui[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  await Promise.all(browser.contexts().map((context) => context.close()));
  await Promise.all(running.splice(0).map((gui) => gui.stop()));
});

/** Tasks 1 and 2; task 2's change waits with `pending`, and optionally a branch change waits with `branch`. */
async function project(
  pending: PendingQuestion,
  branch?: { name: string; pending: PendingQuestion },
): Promise<{ root: string; taskChange: WorkflowState; branchChange?: WorkflowState }> {
  const root = makeTempFolder();
  mkdirSync(path.join(root, ".luseen/sdd"), { recursive: true });
  const store = openTaskStore(path.join(root, ".luseen"), "create");
  if (store === undefined) throw new Error("No store");
  store.addTask({ title: "Store card token", dependsOn: [] });
  store.addTask({ title: "Charge on checkout", dependsOn: [] });
  store.close();
  const now = new Date().toISOString();
  const taskChange = withPending(
    beginChange(
      { changeType: "feature", spec: "refunds", taskId: 2 },
      { key: stateKey(2, "main"), approverMode: "user", now },
    ),
    pending,
    now,
  );
  await openWorkflowStore(root).save(taskChange);
  if (branch === undefined) return { root, taskChange };
  const branchChange = withPending(
    beginChange({ changeType: "bug", spec: "auth" }, { key: stateKey(null, branch.name), approverMode: "user", now }),
    branch.pending,
    now,
  );
  await openWorkflowStore(root).save(branchChange);
  return { root, taskChange, branchChange };
}

/** The canvas checks the GUI would run on its timer, run only when a test calls `tick`. */
async function start(root: string): Promise<{ gui: TestGui; tick: () => Promise<void> }> {
  const checks: (() => Promise<void>)[] = [];
  const gui = await startTestGui(
    root,
    {},
    {
      every: (_ms, run) => {
        checks.push(run);
        return () => {
          checks.splice(checks.indexOf(run), 1);
        };
      },
    },
  );
  running.push(gui);
  return {
    gui,
    tick: async () => {
      await Promise.all(checks.map((run) => run()));
    },
  };
}

const stateOf = async (root: string, key: string) =>
  (await openWorkflowStore(root).list()).find((state) => state.key === key);

const answerPath = (key: string) => `/api/changes/${key}/answer`;

async function openPage(gui: TestGui, options: { width?: number; colorScheme?: "light" | "dark" } = {}): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: 900 },
    colorScheme: options.colorScheme ?? "light",
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
  await page.locator('[data-key="task-1"]').waitFor();
  return page;
}

async function openTask2(page: Page) {
  await page.locator('[data-key="task-2"]').click();
  const section = page.locator(".waiting-question");
  await section.waitFor();
  return section;
}

describe("QA: question text", () => {
  it("a question holding a secret is shown and answered redacted, and the secret never reaches the page", async () => {
    const secret = `sk-ant-${"a1B2".repeat(8)}`;
    const { root, taskChange } = await project({ ...G1, question: `Approve with key ${secret}?` });
    const { gui } = await start(root);
    const canvas = await sendTo(gui, "GET", "/api/canvas");
    expect(canvas.body).not.toContain(secret);
    const page = await openPage(gui);
    const section = await openTask2(page);
    expect(await section.locator(".question").textContent()).toBe("Approve with key [REDACTED:anthropic-key]?");
    expect(await page.content()).not.toContain(secret);
    await section.locator('[data-answer="approve"]').click();
    await expect.poll(async () => (await stateOf(root, taskChange.key))?.pending?.answer).toBe("approve");
  });

  it("a question holding HTML is shown as text, not markup", async () => {
    const html = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
    const { root, taskChange } = await project({ ...G1, question: html });
    const { gui } = await start(root);
    const page = await openPage(gui);
    const section = await openTask2(page);
    expect(await section.locator(".question").textContent()).toBe(html);
    expect(await section.locator(".question img, .question b").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await section.locator('[data-answer="approve"]').click();
    await expect.poll(async () => (await stateOf(root, taskChange.key))?.pending?.answer).toBe("approve");
  });

  it("a very long unbroken question keeps the panel within 768 px", async () => {
    const { root } = await project({ ...G1, question: `Approve ${"Averyveryverylongword".repeat(60)}?` });
    const { gui } = await start(root);
    const page = await openPage(gui, { width: 768 });
    const section = await openTask2(page);
    await section.locator('[data-answer="refine"]').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);
    expect(await page.locator("#panel").evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(0);
  });

  it("a skip question whose agent reason is at its 4000-character limit can still be answered", async () => {
    // FR-MCP: the skip reason may be up to 4000 characters, and the question adds its own words around it.
    const reason = "r".repeat(4000);
    const skip: PendingQuestion = {
      kind: "skip",
      gate: null,
      step: "qa",
      reason,
      question: `Skip the "qa" step? The agent's reason: ${reason}`,
      answers: ["yes", "no"],
      answer: null,
      notes: null,
    };
    const { root, taskChange } = await project(skip);
    const { gui } = await start(root);
    // The question as the page shows it, which is what an answer names.
    const shown = waitingQuestion(taskChange) ?? "";
    expect(shown.length).toBeGreaterThan(4000);
    const reply = await sendTo(gui, "POST", answerPath(taskChange.key), { question: shown, answer: "no" });
    expect(reply.status, reply.body).toBe(200);
    expect((await stateOf(root, taskChange.key))?.pending?.answer).toBe("no");
  });
});

describe("QA: skip and resume questions", () => {
  it("a skip question is answered yes, and a resume question no, from the page", async () => {
    const skip: PendingQuestion = {
      kind: "skip",
      gate: null,
      step: "review",
      reason: "Docs only.",
      question: 'Skip the "review" step? The agent\'s reason: Docs only.',
      answers: ["yes", "no"],
      answer: null,
      notes: null,
    };
    const resume: PendingQuestion = {
      kind: "resume",
      gate: null,
      step: null,
      reason: null,
      question: "The change stopped: QA failed 3 times. Continue, with the QA and review counts started again?",
      answers: ["yes", "no"],
      answer: null,
      notes: null,
    };
    const { root, taskChange, branchChange } = await project(skip, { name: "fix-y", pending: resume });
    const { gui } = await start(root);
    const page = await openPage(gui);
    const section = await openTask2(page);
    expect(await section.locator("[data-answer]").allTextContents()).toEqual(["yes", "no"]);
    await section.locator('[data-answer="yes"]').click();
    await expect.poll(async () => (await stateOf(root, taskChange.key))?.pending).toMatchObject({ answer: "yes" });
    await page.keyboard.press("Escape");
    await page.locator(`[data-key="change-${branchChange?.key ?? ""}"]`).click();
    await page.locator('.waiting-question [data-answer="no"]').click();
    await expect
      .poll(async () => (await stateOf(root, branchChange?.key ?? ""))?.pending)
      .toMatchObject({ answer: "no", notes: null });
  });

  it("G5 request changes asks for notes, and a branch key with dots is answered", async () => {
    const g5: PendingQuestion = {
      ...G1,
      gate: "G5",
      question: "Approve the implementation?",
      answers: ["approve", "request changes"],
    };
    const { root, branchChange } = await project(G1, { name: "release/1.2.3", pending: g5 });
    expect(branchChange?.key).toBe("branch-release-1.2.3");
    const { gui } = await start(root);
    const page = await openPage(gui);
    await page.locator(`[data-key="change-${branchChange?.key ?? ""}"]`).click();
    const section = page.locator(".waiting-question");
    await section.locator('[data-answer="request changes"]').click();
    await section.locator("textarea").fill("Fix the totals.");
    await section.locator('[data-focus="send-answer"]').click();
    await expect
      .poll(async () => (await stateOf(root, branchChange?.key ?? ""))?.pending)
      .toMatchObject({ answer: "request changes", notes: "Fix the totals." });
  });
});

describe("QA: the notes form", () => {
  it("notes typed survive a canvas update that redraws the panel, and typing goes on at the end", async () => {
    const { root, taskChange } = await project(G1);
    const { gui, tick } = await start(root);
    const page = await openPage(gui);
    const section = await openTask2(page);
    await section.locator('[data-answer="refine"]').click();
    const notes = section.locator("textarea");
    await notes.pressSequentially("abc");
    // Something else about task 2's change moves on, so its panel is drawn again.
    await openWorkflowStore(root).save({
      ...taskChange,
      qaRuns: [{ passed: true, failures: [], at: new Date().toISOString() }],
      updatedAt: new Date().toISOString(),
    });
    await tick();
    await expect.poll(() => page.locator('#panel-body [data-step="qa-1"]').count()).toBe(1);
    expect(await notes.inputValue()).toBe("abc");
    expect(await notes.evaluate((node) => node === document.activeElement)).toBe(true);
    await page.keyboard.type("def");
    expect(await notes.inputValue()).toBe("abcdef");
  });

  it("Cancel drops the notes form and records nothing", async () => {
    const { root, taskChange } = await project(G1);
    const { gui } = await start(root);
    const page = await openPage(gui);
    const section = await openTask2(page);
    await section.locator('[data-answer="refine"]').click();
    await section.locator("textarea").fill("draft");
    await section.getByRole("button", { name: "Cancel" }).click();
    expect(await section.locator("textarea").count()).toBe(0);
    expect(await stateOf(root, taskChange.key)).toEqual(taskChange);
    await section.locator('[data-answer="refine"]').click();
    expect(await section.locator("textarea").inputValue()).toBe("");
  });

  it("works by keyboard alone: Enter on refine, type, Tab to Send and Enter", async () => {
    const { root, taskChange } = await project(G1);
    const { gui } = await start(root);
    const page = await openPage(gui);
    const section = await openTask2(page);
    await section.locator('[data-answer="refine"]').focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => section.locator("textarea").evaluate((node) => node === document.activeElement)).toBe(true);
    await page.keyboard.type("Line one");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Line two");
    expect((await stateOf(root, taskChange.key))?.pending?.answer).toBeNull();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-focus"))).toBe("send-answer");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await stateOf(root, taskChange.key))?.pending)
      .toMatchObject({ answer: "refine", notes: "Line one\nLine two" });
  });

  it("notes over 4000 characters are refused with a message, nothing changes, and the notes stay", async () => {
    const { root, taskChange } = await project(G1);
    const { gui } = await start(root);
    const api = await sendTo(gui, "POST", answerPath(taskChange.key), {
      question: G1.question,
      answer: "refine",
      notes: "n".repeat(4001),
    });
    expect(api.status).toBe(400);
    expect(JSON.parse(api.body)).toEqual({ error: "Notes for the agent can be at most 4000 characters." });
    expect(await stateOf(root, taskChange.key)).toEqual(taskChange);

    const page = await openPage(gui);
    const section = await openTask2(page);
    await section.locator('[data-answer="refine"]').click();
    await section.locator("textarea").fill("n".repeat(4001));
    await section.locator('[data-focus="send-answer"]').click();
    await expect
      .poll(() => page.locator("#notice").textContent())
      .toContain("Notes for the agent can be at most 4000 characters.");
    expect(await stateOf(root, taskChange.key)).toEqual(taskChange);
    expect((await section.locator("textarea").inputValue()).length).toBe(4001);
  });
});

describe("QA run 3: refused bodies and damaged states", () => {
  it("notes that aren't text get the generic refusal, not a notes-limit message", async () => {
    const { root, taskChange } = await project(G1);
    const { gui } = await start(root);
    for (const notes of [42, ["a"], { a: 1 }]) {
      const reply = await sendTo(gui, "POST", answerPath(taskChange.key), {
        question: G1.question,
        answer: "refine",
        notes,
      });
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body)).toEqual({ error: "That isn't an answer to a question." });
    }
    for (const body of [{ question: G1.question }, { question: G1.question, answer: "approve", extra: 1 }, "x", null]) {
      const reply = await sendTo(gui, "POST", answerPath(taskChange.key), body);
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body)).toEqual({ error: "That isn't an answer to a question." });
    }
    expect(await stateOf(root, taskChange.key)).toEqual(taskChange);
  });

  it("exactly 4000 characters of notes are kept", async () => {
    const { root, taskChange } = await project(G1);
    const { gui } = await start(root);
    const reply = await sendTo(gui, "POST", answerPath(taskChange.key), {
      question: G1.question,
      answer: "refine",
      notes: "n".repeat(4000),
    });
    expect(reply.status).toBe(200);
    expect((await stateOf(root, taskChange.key))?.pending).toMatchObject({ answer: "refine", notes: "n".repeat(4000) });
  });

  it("a damaged state file of the same change is refused with 409 naming it, and the file is left as it was", async () => {
    const { root, taskChange } = await project(G1);
    const { gui } = await start(root);
    const file = path.join(root, ".luseen/workflow", `${taskChange.key}.json`);
    writeFileSync(file, "{ not json");
    const reply = await sendTo(gui, "POST", answerPath(taskChange.key), { question: G1.question, answer: "approve" });
    expect(reply.status).toBe(409);
    expect((JSON.parse(reply.body) as { error: string }).error).toMatch(
      new RegExp(
        `${taskChange.key.replace(/[.]/g, "\\.")}\\.json isn't a readable workflow state\\. Delete it to start the change again\\.$`,
      ),
    );
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("the page shows a damaged other state's message as a notice, and records nothing", async () => {
    const { root, taskChange } = await project(G1);
    const { gui } = await start(root);
    const page = await openPage(gui);
    const section = await openTask2(page);
    writeFileSync(path.join(root, ".luseen/workflow/branch-broken.json"), "{ not json");
    await section.locator('[data-answer="approve"]').click();
    await expect
      .poll(() => page.locator("#notice").textContent())
      .toMatch(/branch-broken\.json isn't a readable workflow state\. Delete it to start the change again\./);
    rmSync(path.join(root, ".luseen/workflow/branch-broken.json"));
    expect(await stateOf(root, taskChange.key)).toEqual(taskChange);
  });
});

describe("QA: repeated and concurrent answers", () => {
  it("a double click records one answer and shows no refusal", async () => {
    const { root, taskChange } = await project(G1);
    const { gui } = await start(root);
    const page = await openPage(gui);
    const section = await openTask2(page);
    await section.locator('[data-answer="approve"]').dblclick();
    await expect.poll(async () => (await stateOf(root, taskChange.key))?.pending?.answer).toBe("approve");
    await expect.poll(() => page.locator("#notice").textContent()).toContain("Recorded");
    expect(await page.locator("#notice").textContent()).not.toContain("meanwhile");
  });

  it("two tabs: the second tab's answer is refused once the first answered", async () => {
    const { root, taskChange } = await project(G1);
    const { gui } = await start(root);
    const first = await openPage(gui);
    const second = await openPage(gui);
    const one = await openTask2(first);
    const two = await openTask2(second);
    await one.locator('[data-answer="approve"]').click();
    await expect.poll(async () => (await stateOf(root, taskChange.key))?.pending?.answer).toBe("approve");
    await two.locator('[data-answer="review-doc"]').click();
    await expect.poll(() => second.locator("#notice").textContent()).toContain("answered or changed meanwhile");
    expect((await stateOf(root, taskChange.key))?.pending?.answer).toBe("approve");
  });

  it("two answers sent at the same moment: exactly one is recorded and the other is refused", async () => {
    for (let round = 0; round < 5; round += 1) {
      const { root, taskChange } = await project(G1);
      const { gui } = await start(root);
      const replies = await Promise.all([
        sendTo(gui, "POST", answerPath(taskChange.key), { question: G1.question, answer: "approve" }),
        sendTo(gui, "POST", answerPath(taskChange.key), { question: G1.question, answer: "review-doc" }),
      ]);
      const recorded = (await stateOf(root, taskChange.key))?.pending?.answer;
      expect({ statuses: replies.map((reply) => reply.status).sort(), recorded }, `round ${round}`).toMatchObject({
        statuses: [200, 409],
      });
    }
  });
});

describe("QA: theme", () => {
  for (const [scheme, background, border] of [
    ["light", "rgb(253, 243, 227)", "rgb(180, 83, 9)"],
    ["dark", "rgb(58, 44, 15)", "rgb(251, 191, 36)"],
  ] as const)
    it(`the waiting question's box uses the ${scheme} theme's tokens on all four sides`, async () => {
      const { root } = await project(G1);
      const { gui } = await start(root);
      const page = await openPage(gui, { colorScheme: scheme });
      const section = await openTask2(page);
      const style = await section.evaluate((node) => {
        const computed = getComputedStyle(node);
        return {
          background: computed.backgroundColor,
          borders: [
            computed.borderTopColor,
            computed.borderRightColor,
            computed.borderBottomColor,
            computed.borderLeftColor,
          ],
          paddingTop: computed.paddingTop,
          paddingBottom: computed.paddingBottom,
        };
      });
      expect(style.background).toBe(background);
      expect(style.borders).toEqual([border, border, border, border]);
      expect(style.paddingTop).toBe(style.paddingBottom);
    });
});
