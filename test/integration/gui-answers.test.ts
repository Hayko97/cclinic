/// <reference lib="dom" />
/** Answering a change's waiting question from the GUI, as `luseen approve` does (spec: gui FR-GUI-038). */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import {
  answerPending,
  beginChange,
  stateKey,
  withPending,
  type PendingQuestion,
  type WorkflowState,
} from "../../src/core/workflow.js";
import { makeTempFolder } from "../support/helpers.js";
import { sendTo, startTestGui, type TestGui } from "../support/gui.js";

const G1_QUESTION = 'Approve the spec change for task #2 (spec "refunds")?';
const G1: PendingQuestion = {
  kind: "gate",
  gate: "G1",
  step: null,
  reason: null,
  question: G1_QUESTION,
  answers: ["approve", "refine", "review-doc"],
  answer: null,
  notes: null,
};
const G6: PendingQuestion = {
  ...G1,
  gate: "G6",
  question: 'Commit this change to spec "auth"?',
  answers: ["yes", "no"],
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

/** Tasks 1 and 2 with no roadmap; task 2's change waits at G1, and a change on branch `fix-x` waits at G6. */
async function project(): Promise<{ root: string; taskChange: WorkflowState; branchChange: WorkflowState }> {
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
    G1,
    now,
  );
  const branchChange = withPending(
    beginChange({ changeType: "bug", spec: "auth" }, { key: stateKey(null, "fix-x"), approverMode: "user", now }),
    G6,
    now,
  );
  await openWorkflowStore(root).save(taskChange);
  await openWorkflowStore(root).save(branchChange);
  return { root, taskChange, branchChange };
}

async function start(root: string): Promise<TestGui> {
  const gui = await startTestGui(root, {}, { every: () => () => undefined });
  running.push(gui);
  return gui;
}

const stateOf = async (root: string, key: string) =>
  (await openWorkflowStore(root).list()).find((state) => state.key === key);

const answerPath = (key: string) => `/api/changes/${key}/answer`;

describe("answering through the API", () => {
  it("TC-GUI-052: an answer is recorded exactly as luseen approve records it, and the question no longer waits", async () => {
    const { root, taskChange } = await project();
    const gui = await start(root);
    const reply = await sendTo(gui, "POST", answerPath(taskChange.key), { question: G1_QUESTION, answer: "approve" });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ message: 'Recorded "approve". The agent picks it up on its next call.' });
    const saved = await stateOf(root, taskChange.key);
    const outcome = answerPending(taskChange, "approve", null, saved?.updatedAt ?? "");
    expect("state" in outcome && outcome.state).toEqual(saved);
    expect(saved?.pending).toMatchObject({ answer: "approve", notes: null });
  });

  it("TC-GUI-053: no token gets 401, an answer the question doesn't allow gets 400, and nothing changes", async () => {
    const { root, taskChange } = await project();
    const gui = await start(root);
    const noToken = await sendTo({ ...gui, token: "" }, "POST", answerPath(taskChange.key), {
      question: G1_QUESTION,
      answer: "approve",
    });
    expect(noToken.status).toBe(401);
    const wrong = await sendTo(gui, "POST", answerPath(taskChange.key), { question: G1_QUESTION, answer: "yes" });
    expect(wrong.status).toBe(400);
    expect(JSON.parse(wrong.body)).toEqual({ error: '"yes" isn\'t one of the answers.' });
    const malformed = await sendTo(gui, "POST", answerPath(taskChange.key), { answer: "approve" });
    expect(malformed.status).toBe(400);
    expect(await stateOf(root, taskChange.key)).toEqual(taskChange);
  });

  it("TC-GUI-124: an answer to a question already answered, or not the one waiting, is refused with 409", async () => {
    const { root, taskChange, branchChange } = await project();
    const gui = await start(root);
    expect(
      (await sendTo(gui, "POST", answerPath(taskChange.key), { question: G1_QUESTION, answer: "approve" })).status,
    ).toBe(200);
    const first = await stateOf(root, taskChange.key);
    const again = await sendTo(gui, "POST", answerPath(taskChange.key), { question: G1_QUESTION, answer: "refine" });
    expect(again.status).toBe(409);
    expect(JSON.parse(again.body)).toEqual({
      error: "That question was answered or changed meanwhile, so nothing was recorded. Look at it again.",
    });
    expect(await stateOf(root, taskChange.key)).toEqual(first);

    const other = await sendTo(gui, "POST", answerPath(branchChange.key), { question: G1_QUESTION, answer: "yes" });
    expect(other.status).toBe(409);
    expect(await stateOf(root, branchChange.key)).toEqual(branchChange);
  });

  it("TC-GUI-125: an unknown change key, or one that isn't a safe file name, gets 404 and writes nothing", async () => {
    const { root } = await project();
    const gui = await start(root);
    const before = readdirSync(path.join(root, ".luseen/workflow")).sort();
    for (const key of ["task-99", "..", "..%2F..%2Fescape", "a%00b", "a/b"]) {
      const reply = await sendTo(gui, "POST", answerPath(key), { question: G1_QUESTION, answer: "approve" });
      expect(reply.status, key).toBe(404);
    }
    expect(readdirSync(path.join(root, ".luseen/workflow")).sort()).toEqual(before);
    expect(existsSync(path.join(root, "escape"))).toBe(false);
  });

  it("a damaged state of another change is named, with how to fix it, and nothing is recorded", async () => {
    const { root, branchChange } = await project();
    writeFileSync(path.join(root, ".luseen/workflow/branch-broken.json"), "{ not json");
    const gui = await start(root);
    const reply = await sendTo(gui, "POST", answerPath(branchChange.key), { question: G6.question, answer: "yes" });
    expect(reply.status).toBe(409);
    expect((JSON.parse(reply.body) as { error: string }).error).toMatch(
      /branch-broken\.json isn't a readable workflow state\. Delete it to start the change again\.$/,
    );
    rmSync(path.join(root, ".luseen/workflow/branch-broken.json"));
    expect(await stateOf(root, branchChange.key)).toEqual(branchChange);
  });

  it("notes longer than the limit are refused with a message naming the limit", async () => {
    const { root, taskChange } = await project();
    const gui = await start(root);
    const reply = await sendTo(gui, "POST", answerPath(taskChange.key), {
      question: G1_QUESTION,
      answer: "refine",
      notes: "n".repeat(4001),
    });
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body)).toEqual({ error: "Notes for the agent can be at most 4000 characters." });
    expect(await stateOf(root, taskChange.key)).toEqual(taskChange);
  });

  it("only an answer that carries notes keeps them, and empty notes are none", async () => {
    const { root, taskChange, branchChange } = await project();
    const gui = await start(root);
    await sendTo(gui, "POST", answerPath(branchChange.key), { question: G6.question, answer: "yes", notes: "ignored" });
    expect((await stateOf(root, branchChange.key))?.pending).toMatchObject({ answer: "yes", notes: null });
    await sendTo(gui, "POST", answerPath(taskChange.key), { question: G1_QUESTION, answer: "refine", notes: "  " });
    expect((await stateOf(root, taskChange.key))?.pending).toMatchObject({ answer: "refine", notes: null });
  });
});

describe("answering from the page", () => {
  async function openPage(root: string) {
    const gui = await start(root);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
    await page.locator('[data-key="task-1"]').waitFor();
    return page;
  }

  it("TC-GUI-126: Needs you opens the task's question; refine asks for notes, and the answer clears Needs you", async () => {
    const { root, taskChange } = await project();
    const page = await openPage(root);
    expect(await page.locator("#needs-count").textContent()).toBe("2");
    await page.locator("#needs-you").click();
    await page.locator("#needs-list .needs-item", { hasText: "Task #2" }).locator("button").click();
    const section = page.locator(".waiting-question");
    expect(await section.locator(".question").textContent()).toBe(G1_QUESTION);
    expect(await section.locator("[data-answer]").allTextContents()).toEqual(["approve", "refine", "review-doc"]);

    await section.locator('[data-answer="refine"]').click();
    const notes = section.locator("textarea");
    await expect.poll(() => notes.evaluate((node) => node === document.activeElement)).toBe(true);
    expect((await stateOf(root, taskChange.key))?.pending?.answer).toBeNull();
    await notes.fill("Name the refund limit.");
    await section.locator('[data-focus="send-answer"]').click();

    await expect
      .poll(async () => (await stateOf(root, taskChange.key))?.pending)
      .toMatchObject({
        answer: "refine",
        notes: "Name the refund limit.",
      });
    await expect.poll(() => page.locator("#needs-count").textContent()).toBe("1");
    expect(await page.locator('[data-key="task-2"] .needs-you').count()).toBe(0);
    expect(await page.locator(".waiting-question").count()).toBe(0);
  });

  it("TC-GUI-127: a change with no task shows its question in its change panel, and yes is recorded with no notes", async () => {
    const { root, branchChange } = await project();
    const page = await openPage(root);
    await page.locator(`[data-key="change-${branchChange.key}"]`).click();
    const section = page.locator(".waiting-question");
    expect(await section.locator("[data-answer]").allTextContents()).toEqual(["yes", "no"]);
    await section.locator('[data-answer="yes"]').click();
    await expect
      .poll(async () => (await stateOf(root, branchChange.key))?.pending)
      .toMatchObject({
        answer: "yes",
        notes: null,
      });
    await expect.poll(() => page.locator("#needs-count").textContent()).toBe("1");
  });

  it("TC-GUI-124: an answer refused because the question changed says so, and the page shows the new question", async () => {
    const { root, taskChange } = await project();
    const page = await openPage(root);
    await page.locator('[data-key="task-2"]').click();
    await page.locator(".waiting-question").waitFor();
    const changed = "Approve the refined spec change for task #2?";
    await openWorkflowStore(root).save(withPending(taskChange, { ...G1, question: changed }, new Date().toISOString()));
    await page.locator('.waiting-question [data-answer="approve"]').click();
    await expect.poll(() => page.locator("#notice").textContent()).toContain("answered or changed meanwhile");
    await expect.poll(() => page.locator(".waiting-question .question").textContent()).toBe(changed);
    expect((await stateOf(root, taskChange.key))?.pending).toMatchObject({ question: changed, answer: null });
  });
});
