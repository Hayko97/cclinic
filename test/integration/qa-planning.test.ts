/**
 * QA for roadmap-planning: test cases with no integration test yet, and edge cases found while exploring.
 * Tests named with a requirement ID and "QA" reproduce a defect: they assert what the spec says.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { confirm, input, select } from "@inquirer/prompts";
import { chromium } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import { approveProposal, cancelSession } from "../../src/application/planning-session.js";
import { createProjectServer, runSessionLink } from "../../src/cli/mcp-command.js";
import { runPlanCommand, type PlanOptions } from "../../src/cli/plan-command.js";
import { decisionPorts } from "../../src/cli/planning-ports.js";
import { createReporter } from "../../src/cli/reporter.js";
import { newPlanSession, parseChatInput, type PlanSession, type RoadmapProposal } from "../../src/core/planning.js";
import { beginChange, stateKey } from "../../src/core/workflow.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";
import { sendTo, startTestGui, type TestGui } from "../support/gui.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn(), input: vi.fn() }));
const selectMock = vi.mocked(select);
const inputMock = vi.mocked(input);
const confirmMock = vi.mocked(confirm);

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SLOW = 90_000;
const WAIT = { timeout: 30_000, interval: 100 };
/** No process has this ID: process IDs are far smaller on every supported system. */
const ENDED_PID = 2 ** 30;

const isTty = process.stdin.isTTY;
const running: TestGui[] = [];
beforeAll(() => {}, SLOW);
beforeEach(() => {
  process.stdin.isTTY = true;
});
afterEach(async () => {
  process.stdin.isTTY = isTty;
  vi.resetAllMocks();
  vi.restoreAllMocks();
  await Promise.all(running.splice(0).map((gui) => gui.stop()));
});

const planned = (key: string, dependsOn: (string | number)[] = []) => ({
  key,
  title: `Task ${key}`,
  description: `About ${key}`,
  spec: null,
  dependsOn,
});
const roadmap: RoadmapProposal = {
  roadmap: { title: "Portal", goal: "Book visits" },
  milestones: [{ title: "Sign-in", goal: "Log in", tasks: [planned("login"), planned("book", ["login"])] }],
  openQuestions: [],
};
const says = (message: string, extra: Omit<FakeClaudeRule, "message"> = {}): FakeClaudeRule => ({ message, ...extra });

function project(): string {
  const root = makeTempFolder();
  writeProject(root, { ".cclinic/sdd/overview.md": "# Overview\n", ".cclinic/sdd/README.md": "# Specs\n" });
  const store = openTaskStore(path.join(root, ".cclinic"), "create");
  store?.savePlan({
    roadmap: { title: "Launch", goal: "Ship" },
    milestones: [{ title: "One", goal: "", tasks: [planned("x")] }],
  });
  store?.close();
  return root;
}

function roadmapTitles(root: string): string[] {
  const store = openTaskStore(path.join(root, ".cclinic"), "read");
  try {
    return store?.listRoadmaps().map((item) => item.title) ?? [];
  } finally {
    store?.close();
  }
}

/** The user's messages in order; after the last one, the prompt fails, as a closed terminal would. */
function typing(...messages: string[]): void {
  for (const message of messages) inputMock.mockResolvedValueOnce(message);
  inputMock.mockRejectedValueOnce(new Error("terminal closed"));
}

async function plan(root: string, harness: ReturnType<typeof agentHarness>, options: Partial<PlanOptions> = {}) {
  await runPlanCommand({ dir: root, timeoutMinutes: 30, model: "haiku", effort: "low", ...options }, harness.context);
}

async function sessions(root: string): Promise<readonly PlanSession[]> {
  return (await openPlanStore(root).list()).sessions;
}

const quietContext = {
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
};

async function host(root: string) {
  const server = await createProjectServer({ dir: root, approver: "user" }, quietContext);
  const client = new Client({ name: "qa", version: "1.0.0" }, { capabilities: {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    const body = JSON.parse(text) as Record<string, unknown>;
    return { ...body, isError: result.isError === true } as Record<string, unknown> & { isError: boolean };
  };
  return { client, call };
}

function hook(root: string, fields: Record<string, unknown>): Promise<void> {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return runSessionLink(Readable.from([JSON.stringify({ cwd: root, hook_event_name: "PostToolUse", ...fields })]), {});
}

describe("QA: terminal attachments and messages", () => {
  it(
    "TC-PLAN-040: with 28 files in the session, a message with 3 more is refused naming the 30-file limit, and nothing is lost",
    async () => {
      const root = project();
      const names = Array.from({ length: 31 }, (_, index) => `f${index + 1}.md`);
      writeProject(root, Object.fromEntries(names.map((name) => [name, `# ${name}`])));
      const refs = (from: number, to: number) =>
        names
          .slice(from, to)
          .map((name) => `@${name}`)
          .join(" ");
      const harness = agentHarness({ rules: [{ message: "Noted.", times: 0 }] });
      selectMock.mockResolvedValueOnce("new");
      typing(`Start ${refs(0, 10)}`, `More ${refs(10, 20)}`, `More ${refs(20, 28)}`, `Three ${refs(28, 31)}`);
      await plan(root, harness).catch(() => undefined);
      expect(harness.calls()).toHaveLength(3);
      expect(harness.output.err).toContain("at most 30 files");
      const [session] = await sessions(root);
      expect(session?.status).toBe("open");
      expect(session?.attachments).toHaveLength(28);
      const copies = readdirSync(path.join(root, ".cclinic/plans", session?.id ?? "", "attachments"));
      expect(copies).toHaveLength(28);
    },
    SLOW,
  );

  it(
    "TC-PLAN-041: a message with text and no attachment is sent, and no attachment is asked for",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [says("Hi."), says("Sure.")] });
      selectMock.mockResolvedValueOnce("new");
      typing("Start", "hello");
      await plan(root, harness).catch(() => undefined);
      expect(harness.calls()[1]?.prompt).toBe("hello");
      expect(harness.output.err).not.toMatch(/attach a file/i);
    },
    SLOW,
  );

  it(
    "FR-PLAN-022 (QA): a first message naming a file that doesn't exist is refused and asked again, not ended with no PM turn",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [says("Hi.")] });
      selectMock.mockResolvedValueOnce("new");
      typing("Look at @missing.pdf", "Look at this instead");
      await plan(root, harness).catch(() => undefined);
      // The refused message isn't sent; the second one starts the session.
      expect(harness.calls()).toHaveLength(1);
      expect(harness.calls()[0]?.prompt).toContain("Look at this instead");
    },
    SLOW,
  );
});

describe("QA: files outside the scan", () => {
  it("TC-PLAN-043: a session's attachments are never analysed and never show in git status", async () => {
    const root = project();
    writeProject(root, { "src/app.ts": "export const a = 1;\n", "notes.md": "# Brief\n" });
    const store = openPlanStore(root);
    const session = await store.create((id) =>
      newPlanSession({
        id,
        target: { kind: "new-roadmap" },
        summary: "Idea",
        holder: { place: "terminal", pid: ENDED_PID },
        claudeSessionId: "u-1",
        transcriptPath: null,
        now: new Date().toISOString(),
      }),
    );
    await store.copyAttachments(session.id, [{ file: path.join(root, "notes.md"), name: "notes.md" }]);
    execFileSync("git", ["init", "-q"], { cwd: root });
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(status).not.toContain(".cclinic/plans");
    const dry = execFileSync(
      process.execPath,
      [path.join(REPO, "bin/cclinic.js"), "--dry-run", "--json", "--model", "sonnet", "--effort", "low", root],
      { encoding: "utf8", env: { ...process.env, CCLINIC_PROVIDER: "claude-cli" } },
    );
    const result = JSON.parse(dry.slice(dry.indexOf("{"))) as { included: { path: string }[] };
    expect(result.included.map((item) => item.path)).toContain("src/app.ts");
    expect(result.included.some((item) => item.path.startsWith(".cclinic/plans"))).toBe(false);
  });
});

describe("QA: sessions moving between places", () => {
  it(
    "TC-PLAN-067: a session begun in Claude Code is listed and continued by cclinic plan with its Claude session, once Claude Code lets go",
    async () => {
      const root = project();
      const { client, call } = await host(root);
      const begun = await call("plan_begin", { target: { kind: "new-roadmap" }, request: "A patient portal" });
      const planId = String(begun["planId"]);
      const harness = agentHarness({ rules: [says("Welcome back.")] });
      const home = harness.environment.HOME ?? "";
      const transcript = path.join(home, ".claude/projects/p/s-cc.jsonl");
      writeProject(path.dirname(transcript), {
        "s-cc.jsonl": `${JSON.stringify({ type: "user", message: { content: "Plan a portal" } })}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Who uses it?" }] } })}\n`,
      });
      await hook(root, {
        session_id: "s-cc",
        transcript_path: transcript,
        tool_name: "mcp__cclinic__plan_begin",
        tool_input: {},
        tool_response: [{ type: "text", text: JSON.stringify({ planId }) }],
      });
      // While Claude Code holds it, the terminal is refused.
      await expect(plan(root, agentHarness(), { resume: planId })).rejects.toThrow("Claude Code");
      await client.close();
      await openPlanStore(root).update(planId, (current) => ({
        save: { ...current, holder: { place: "claude-code", pid: ENDED_PID } },
        value: undefined,
      }));
      selectMock.mockImplementationOnce((config) => {
        const choices = config.choices as readonly { name: string; value: unknown }[];
        expect(choices.map((choice) => choice.name).join("\n")).toContain(planId);
        return Promise.resolve(choices[0]?.value);
      });
      typing("Patients");
      await plan(root, harness, { resume: true }).catch(() => undefined);
      expect(harness.output.err).toContain("Who uses it?");
      const [first] = harness.calls();
      expect(first?.args).toContain("--resume");
      expect(first?.args).toContain("s-cc");
      expect(first?.prompt).toBe("Patients");
    },
    SLOW,
  );

  it("TC-MCP-074: a planning tool links the planning session; a workflow tool links only the change", async () => {
    const root = project();
    const { call } = await host(root);
    const planId = String((await call("plan_begin", { target: { kind: "new-roadmap" }, request: "x" }))["planId"]);
    const workflow = openWorkflowStore(root);
    await workflow.save(
      beginChange(
        { changeType: "feature", spec: "refunds", taskId: 3 },
        { key: stateKey(3, "main"), approverMode: "user", now: "2026-11-11T10:00:00.000Z" },
      ),
    );
    await hook(root, {
      session_id: "s1",
      transcript_path: "/t/s1.jsonl",
      tool_name: "mcp__cclinic__plan_begin",
      tool_input: {},
      tool_response: [{ type: "text", text: JSON.stringify({ planId }) }],
    });
    await hook(root, { session_id: "s2", transcript_path: "/t/s2.jsonl", tool_name: "mcp__cclinic__workflow_status" });
    expect(await openPlanStore(root).read(planId)).toMatchObject({
      claudeSessionId: "s1",
      transcriptPath: "/t/s1.jsonl",
    });
    const [state] = await workflow.list();
    expect(state?.sessions.map((session) => session.sessionId)).toEqual(["s2"]);
  });
});

describe("QA: approving while another place holds the session", () => {
  it("FR-PLAN-013 (QA): two approvals at once, as from Needs you and cclinic approve, save the roadmap once", async () => {
    const root = project();
    const { call } = await host(root);
    const planId = String((await call("plan_begin", { target: { kind: "new-roadmap" }, request: "x" }))["planId"]);
    expect((await call("plan_propose", { planId, proposal: roadmap }))["status"]).toBe("waiting-for-approval");
    const results = await Promise.allSettled([
      approveProposal(decisionPorts(root), planId),
      approveProposal(decisionPorts(root), planId),
    ]);
    expect(roadmapTitles(root)).toEqual(["Launch", "Portal"]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it(
    "TC-PLAN-066 (GUI part): a proposal Claude Code left waiting is approved from the GUI while Claude Code holds the session",
    async () => {
      const root = project();
      const { call } = await host(root);
      const planId = String((await call("plan_begin", { target: { kind: "new-roadmap" }, request: "x" }))["planId"]);
      await call("plan_propose", { planId, proposal: roadmap });
      const harness = agentHarness({ rules: [] });
      const gui = await startTestGui(root, {}, { every: () => () => undefined }, harness.environment);
      running.push(gui);
      const view = JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as {
        plan: { sessions: { id: string; heldBy: string | null; hasProposal: boolean }[] };
      };
      expect(view.plan.sessions).toEqual([
        expect.objectContaining({ id: planId, heldBy: "claude-code", hasProposal: true }),
      ]);
      const approved = await sendTo(gui, "POST", "/api/plan/approve", { planId });
      expect(approved.status).toBe(200);
      expect(roadmapTitles(root)).toEqual(["Launch", "Portal"]);
      expect(await call("plan_status", { planId })).toMatchObject({ sessionStatus: "approved" });
      expect(harness.calls()).toHaveLength(0);
    },
    SLOW,
  );
});

describe("QA: a session whose Claude transcript is gone", () => {
  async function goneSession(root: string): Promise<PlanSession> {
    return openPlanStore(root).create((id) =>
      newPlanSession({
        id,
        target: { kind: "new-roadmap" },
        summary: "Idea",
        holder: { place: "terminal", pid: ENDED_PID },
        claudeSessionId: "0b0b0b0b-0000-4000-8000-000000000000",
        transcriptPath: path.join(makeTempFolder(), "gone.jsonl"),
        now: new Date().toISOString(),
      }),
    );
  }

  it("Edge case (terminal): --resume names it as unavailable, offers to cancel it, and calls no Claude", async () => {
    const root = project();
    const session = await goneSession(root);
    const harness = agentHarness();
    const error = await plan(root, harness, { resume: session.id }).catch((caught: unknown) => caught);
    expect(String(error)).toContain("can't be found");
    expect(String(error)).toMatch(/cancel/i);
    expect(harness.calls()).toHaveLength(0);
  });

  it(
    "Edge case (GUI): the GUI names it as unavailable instead of driving it as a new Claude session",
    async () => {
      const root = project();
      const session = await goneSession(root);
      const harness = agentHarness({ rules: [says("Who are you?")] });
      const gui = await startTestGui(root, {}, { every: () => () => undefined }, harness.environment);
      running.push(gui);
      await sendTo(gui, "POST", "/api/plan/open", { planId: session.id });
      const sent = await sendTo(gui, "POST", "/api/plan/message", { text: "Patients" });
      await vi.waitFor(async () => {
        const view = JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as { plan: { turn: unknown } };
        if (view.plan.turn !== null) throw new Error("working");
      }, WAIT);
      // Whatever the GUI shows, it mustn't start the PM without its instructions as if this were a first turn.
      const started = harness.calls().find((item) => item.args.includes("--session-id"));
      expect(
        started === undefined || started.prompt.includes("product-engineer"),
        "PM started with no instructions",
      ).toBe(true);
      expect(sent.status).toBe(409);
    },
    SLOW,
  );
});

describe("QA: attachment names", () => {
  it("FR-PLAN-023 (QA): two files whose names differ only in case are both kept", async () => {
    const root = project();
    const folder = makeTempFolder();
    writeFileSync(path.join(folder, "Notes.md"), "upper");
    writeProject(folder, { "other/notes.md": "lower" });
    const store = openPlanStore(root);
    const session = await store.create((id) =>
      newPlanSession({
        id,
        target: { kind: "new-roadmap" },
        summary: "Idea",
        holder: { place: "terminal", pid: ENDED_PID },
        claudeSessionId: null,
        transcriptPath: null,
        now: new Date().toISOString(),
      }),
    );
    const stored = await store.copyAttachments(session.id, [
      { file: path.join(folder, "Notes.md"), name: "Notes.md" },
      { file: path.join(folder, "other/notes.md"), name: "notes.md" },
    ]);
    const contents = stored.map((item) => readFileSync(path.join(root, item.path), "utf8"));
    expect(contents.sort()).toEqual(["lower", "upper"]);
    expect(existsSync(path.join(root, stored[0]?.path ?? ""))).toBe(true);
  });
});

describe("QA: Needs you in the browser", () => {
  it(
    "TC-GUI-131: a chat waiting for the user's reply is opened from Needs you with its whole conversation, and cancelling ends it with nothing saved",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [says("Who pays?")] });
      const gui = await startTestGui(root, {}, {}, harness.environment);
      running.push(gui);
      await sendTo(gui, "POST", "/api/plan", {
        target: { kind: "new-roadmap" },
        model: "sonnet",
        effort: "low",
        text: "Add checkout",
      });
      await vi.waitFor(async () => {
        const view = JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as { plan: { turn: unknown } };
        if (view.plan.turn !== null) throw new Error("working");
      }, WAIT);
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
        await page.locator('[data-key="task-1"]').waitFor();
        await page.locator("#needs-you").click();
        const item = page.locator(".needs-item", { hasText: "The PM" });
        await item.getByRole("button", { name: "Open" }).click();
        const panel = page.locator("#plan-panel");
        await expect.poll(() => panel.textContent(), WAIT).toContain("Who pays?");
        expect(await panel.textContent()).toContain("Add checkout");
        // The ⋯ menu holds Cancel session (FR-PLAN-034).
        await panel.getByRole("button", { name: "More" }).click();
        const cancel = panel.getByRole("menuitem", { name: /cancel/i });
        await expect.poll(() => cancel.count(), { timeout: 5_000 }).toBeGreaterThan(0);
        await cancel.first().click();
        await expect.poll(async () => (await openPlanStore(root).read("plan-1"))?.status, WAIT).toBe("cancelled");
        expect(roadmapTitles(root)).toEqual(["Launch"]);
      } finally {
        await browser.close();
      }
    },
    SLOW,
  );
});

describe("QA run 2: fixes from run 1, and what's around them", () => {
  it("FR-PLAN-024 (QA run 2): only the @reference is taken out; the rest of the message's spacing is kept", () => {
    const typed = "Keep  this\n    indented line\n- a\t\tb";
    expect(parseChatInput(typed)).toEqual({ kind: "message", text: typed, files: [] });
    expect(parseChatInput("see @notes.md now")).toEqual({ kind: "message", text: "see now", files: ["notes.md"] });
  });

  it(
    "Edge case (QA run 2): accepting the offer to cancel a session whose transcript is gone cancels it and calls no Claude",
    async () => {
      const root = project();
      writeProject(root, { "notes.md": "# n" });
      const store = openPlanStore(root);
      const session = await store.create((id) =>
        newPlanSession({
          id,
          target: { kind: "new-roadmap" },
          summary: "Idea",
          holder: { place: "terminal", pid: ENDED_PID },
          claudeSessionId: "0c0c0c0c-0000-4000-8000-000000000000",
          transcriptPath: path.join(makeTempFolder(), "gone.jsonl"),
          now: new Date().toISOString(),
        }),
      );
      await store.copyAttachments(session.id, [{ file: path.join(root, "notes.md"), name: "notes.md" }]);
      confirmMock.mockResolvedValueOnce(true);
      const harness = agentHarness();
      // Cancelling it is what the user asked for, so it ends without an error.
      await plan(root, harness, { resume: session.id });
      expect(harness.output.out).toContain("Cancelled. Nothing was saved.");
      expect((await openPlanStore(root).read(session.id))?.status).toBe("cancelled");
      expect(existsSync(path.join(root, ".cclinic/plans", session.id, "attachments"))).toBe(false);
      expect(harness.calls()).toHaveLength(0);
      expect(roadmapTitles(root)).toEqual(["Launch"]);
    },
    SLOW,
  );

  it("FR-PLAN-013, FR-PLAN-014 (QA run 2): an approval and a cancel at once leave one consistent outcome", async () => {
    const root = project();
    const { call } = await host(root);
    const planId = String((await call("plan_begin", { target: { kind: "new-roadmap" }, request: "x" }))["planId"]);
    await call("plan_propose", { planId, proposal: roadmap });
    const results = await Promise.allSettled([
      approveProposal(decisionPorts(root), planId),
      cancelSession(decisionPorts(root), planId, { pid: process.pid, isRunning: () => false }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const status = (await openPlanStore(root).read(planId))?.status;
    expect(roadmapTitles(root)).toEqual(status === "approved" ? ["Launch", "Portal"] : ["Launch"]);
  });

  it(
    "FR-PLAN-022 (QA run 2, GUI): a first message naming an upload that isn't there is refused and starts no session",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [says("Hi.")] });
      const gui = await startTestGui(root, {}, { every: () => () => undefined }, harness.environment);
      running.push(gui);
      const started = await sendTo(gui, "POST", "/api/plan", {
        target: { kind: "new-roadmap" },
        model: "sonnet",
        effort: "low",
        text: "Look at this",
        uploads: ["upload-0123456789abcdef"],
      });
      expect(started.status).toBeGreaterThanOrEqual(400);
      expect(await sessions(root)).toEqual([]);
      expect(harness.calls()).toHaveLength(0);
    },
    SLOW,
  );

  it(
    "FR-PLAN-038 (QA run 2, GUI): Cancel session during a running turn ends the PM and closes the session with nothing saved",
    async () => {
      const root = project();
      const pids = path.join(makeTempFolder(), "pids");
      const harness = agentHarness({ rules: [says("Late", { delayMs: 20_000 })], env: { FAKE_CLAUDE_PIDS: pids } });
      const gui = await startTestGui(root, {}, { every: () => () => undefined }, harness.environment);
      running.push(gui);
      await sendTo(gui, "POST", "/api/plan", {
        target: { kind: "new-roadmap" },
        model: "sonnet",
        effort: "low",
        text: "Add checkout",
      });
      await vi.waitFor(() => {
        if (!existsSync(pids)) throw new Error("no PM yet");
      }, WAIT);
      const cancelled = await sendTo(gui, "POST", "/api/plan/cancel", { planId: "plan-1" });
      expect(cancelled.status).toBe(200);
      expect((await openPlanStore(root).read("plan-1"))?.status).toBe("cancelled");
      const pid = Number(readFileSync(pids, "utf8").trim());
      await vi.waitFor(() => {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        if (alive) throw new Error("PM still running");
      }, WAIT);
      expect(roadmapTitles(root)).toEqual(["Launch"]);
    },
    SLOW,
  );

  it(
    "FR-PLAN-014 (QA run 2): a session stopped in its first turn, before Claude wrote a transcript, can be resumed and answered",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [{ hang: true, beforeTranscript: true }, says("Hello, tell me more.")] });
      selectMock.mockResolvedValueOnce("new");
      typing("Add SSO");
      const stopped = await plan(root, harness, { timeoutMinutes: 0.02 }).catch((caught: unknown) => caught);
      expect(String(stopped)).toContain("--resume");
      const [session] = await sessions(root);
      expect(session?.status).toBe("open");
      typing();
      const resumed = await plan(root, harness, { resume: session?.id ?? "" }).catch((caught: unknown) => caught);
      expect(String(resumed)).not.toContain("can't be found");
      const second = harness.calls()[1];
      expect(second?.prompt).toContain("Add SSO");
    },
    SLOW,
  );

  it("FR-MCP-045 (QA run 2): a plan_resume refused because the session is held elsewhere doesn't move its link", async () => {
    const root = project();
    const store = openPlanStore(root);
    const session = await store.create((id) =>
      newPlanSession({
        id,
        target: { kind: "new-roadmap" },
        summary: "Idea",
        holder: { place: "terminal", pid: process.pid },
        claudeSessionId: "u-terminal",
        transcriptPath: "/t/u-terminal.jsonl",
        now: new Date().toISOString(),
      }),
    );
    const { call } = await host(root);
    const refused = await call("plan_resume", { planId: session.id });
    expect(refused.isError).toBe(true);
    await hook(root, {
      session_id: "s-other",
      transcript_path: "/t/s-other.jsonl",
      tool_name: "mcp__cclinic__plan_resume",
      tool_input: { planId: session.id },
      tool_response: [{ type: "text", text: JSON.stringify(refused) }],
    });
    expect(await openPlanStore(root).read(session.id)).toMatchObject({
      claudeSessionId: "u-terminal",
      transcriptPath: "/t/u-terminal.jsonl",
    });
  });
});

describe("QA run 2: Cancel session in the browser", () => {
  it(
    "FR-GUI-024 (QA run 2): Cancel session in the panel's header ends a session while the PM works, and isn't offered for one held in a terminal",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [says("Late", { delayMs: 20_000 })] });
      const gui = await startTestGui(root, {}, {}, harness.environment);
      running.push(gui);
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
        await page.locator('[data-key="task-1"]').waitFor();
        await page.locator("#plan-open").click();
        await page.locator("#plan-text").fill("Add checkout");
        await page.locator("#plan-text").press("Enter");
        const cancel = page.locator("#plan-cancel-session");
        // The ⋯ menu holds Cancel session (FR-PLAN-034).
        await expect.poll(() => page.locator("#plan-more").isEnabled(), WAIT).toBe(true);
        await page.locator("#plan-more").click();
        await expect.poll(() => cancel.isVisible(), WAIT).toBe(true);
        await cancel.click();
        await expect.poll(async () => (await openPlanStore(root).read("plan-1"))?.status, WAIT).toBe("cancelled");
        expect(roadmapTitles(root)).toEqual(["Launch"]);

        const transcript = path.join(makeTempFolder(), "u-held.jsonl");
        writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "Held" } })}\n`);
        const held = await openPlanStore(root).create((id) =>
          newPlanSession({
            id,
            target: { kind: "new-roadmap" },
            summary: "Held",
            holder: { place: "terminal", pid: process.pid },
            claudeSessionId: "u-held",
            transcriptPath: transcript,
            now: new Date().toISOString(),
          }),
        );
        await page.locator("#plan-sessions-button").click();
        const heldItem = page.locator(`#plan-sessions-menu [data-plan-id="${held.id}"] [role=menuitem]`);
        await expect.poll(() => heldItem.count(), WAIT).toBe(1);
        await heldItem.click();
        await expect.poll(() => page.locator("#plan-subtitle").textContent(), WAIT).toContain(held.id);
        if (await page.locator("#plan-more").isEnabled()) await page.locator("#plan-more").click();
        expect(await cancel.isVisible()).toBe(false);
      } finally {
        await browser.close();
      }
    },
    SLOW,
  );
});

describe("QA run 3: TC-PLAN-069 to TC-PLAN-071, and fixes from run 2", () => {
  /** A process that runs until killed, standing in for a live `cclinic plan` in another terminal. */
  function liveTerminal(): { pid: number; stop: () => void } {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    return { pid: child.pid ?? 0, stop: () => child.kill("SIGKILL") };
  }

  async function idle(
    gui: TestGui,
  ): Promise<{ plan: Record<string, unknown> & { open: Record<string, unknown> | null } }> {
    let view: { plan: Record<string, unknown> & { open: Record<string, unknown> | null } } | undefined;
    await vi.waitFor(async () => {
      view = JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as typeof view;
      if (view?.plan["turn"] !== null) throw new Error("working");
    }, WAIT);
    return view as NonNullable<typeof view>;
  }

  it(
    "TC-PLAN-069: a first message naming a missing file is refused naming it, creates no session, and is asked again; the GUI refuses an unknown upload and creates no session",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [says("Hi.")] });
      selectMock.mockResolvedValueOnce("new");
      let sessionsWhenAskedAgain: number | undefined;
      inputMock.mockResolvedValueOnce("Look at @missing.pdf");
      inputMock.mockImplementationOnce(async () => {
        sessionsWhenAskedAgain = (await sessions(root)).length;
        return "Look at this instead";
      });
      inputMock.mockRejectedValueOnce(new Error("terminal closed"));
      await plan(root, harness).catch(() => undefined);
      expect(harness.output.err).toContain("missing.pdf");
      expect(sessionsWhenAskedAgain).toBe(0);
      expect(harness.calls()).toHaveLength(1);
      expect(harness.calls()[0]?.prompt).toContain("Look at this instead");
      expect(harness.calls()[0]?.prompt).not.toContain("missing.pdf");
      expect(await sessions(root)).toHaveLength(1);

      const guiRoot = project();
      const guiHarness = agentHarness({ rules: [says("Hi.")] });
      const gui = await startTestGui(guiRoot, {}, { every: () => () => undefined }, guiHarness.environment);
      running.push(gui);
      const started = await sendTo(gui, "POST", "/api/plan", {
        target: { kind: "new-roadmap" },
        model: "sonnet",
        effort: "low",
        text: "Look at this",
        uploads: ["upload-0123456789abcdef"],
      });
      expect(started.status).toBeGreaterThanOrEqual(400);
      expect(started.status).toBeLessThan(500);
      expect(await sessions(guiRoot)).toEqual([]);
      expect(guiHarness.calls()).toHaveLength(0);
    },
    SLOW,
  );

  it(
    "TC-PLAN-070 (terminal): a session stopped in its first turn before a transcript existed resumes by sending the first prompt again with --session-id",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [{ hang: true, beforeTranscript: true }, says("Hello, tell me more.")] });
      selectMock.mockResolvedValueOnce("new");
      typing("Add SSO for clinics");
      await plan(root, harness, { timeoutMinutes: 0.02 }).catch(() => undefined);
      const [session] = await sessions(root);
      expect(session?.status).toBe("open");
      expect(session?.pendingFirstMessage).toContain("Add SSO for clinics");
      typing();
      await plan(root, harness, { resume: session?.id ?? "" }).catch(() => undefined);
      const [first, again] = harness.calls();
      expect(again?.args).toContain("--session-id");
      expect(again?.args).not.toContain("--resume");
      expect(again?.args[again.args.indexOf("--session-id") + 1]).toBe(session?.claudeSessionId);
      expect(again?.prompt).toBe(first?.prompt);
      expect(again?.prompt).toContain("# Plan the work as the PM");
      expect(again?.prompt).toContain("Add SSO for clinics");
      // Once the PM replied, the kept first message is dropped (FR-PLAN-030).
      expect((await openPlanStore(root).read(session?.id ?? ""))?.pendingFirstMessage).toBeNull();
    },
    SLOW,
  );

  it(
    "TC-PLAN-070 (GUI): opening such a session in the GUI sends the first prompt again with --session-id",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [{ hang: true, beforeTranscript: true }, says("Hello from the GUI.")] });
      selectMock.mockResolvedValueOnce("new");
      typing("Add exports");
      await plan(root, harness, { timeoutMinutes: 0.02 }).catch(() => undefined);
      const [session] = await sessions(root);
      const gui = await startTestGui(root, {}, { every: () => () => undefined }, harness.environment);
      running.push(gui);
      const opened = await sendTo(gui, "POST", "/api/plan/open", {
        planId: session?.id,
        model: "sonnet",
        effort: "low",
      });
      expect(opened.status).toBe(200);
      await idle(gui);
      const [first, again] = harness.calls();
      expect(again?.args).toContain("--session-id");
      expect(again?.args).not.toContain("--resume");
      expect(again?.prompt).toBe(first?.prompt);
      const view = await idle(gui);
      expect(view.plan.open?.["unavailable"]).toBeNull();
      expect((await openPlanStore(root).read(session?.id ?? ""))?.pendingFirstMessage).toBeNull();
    },
    SLOW,
  );

  it(
    "TC-PLAN-070 (lost): a session with no transcript and no kept first message is named unavailable and offered for cancelling, in the terminal and the GUI",
    async () => {
      const root = project();
      const lost = await openPlanStore(root).create((id) =>
        newPlanSession({
          id,
          target: { kind: "new-roadmap" },
          summary: "Idea",
          holder: { place: "terminal", pid: ENDED_PID },
          claudeSessionId: "0d0d0d0d-0000-4000-8000-000000000000",
          transcriptPath: path.join(makeTempFolder(), "never.jsonl"),
          now: new Date().toISOString(),
        }),
      );
      expect(lost.pendingFirstMessage).toBeNull();
      const harness = agentHarness();
      confirmMock.mockResolvedValueOnce(false);
      const error = await plan(root, harness, { resume: lost.id }).catch((caught: unknown) => caught);
      expect(confirmMock).toHaveBeenCalledTimes(1);
      expect(String(confirmMock.mock.calls[0]?.[0].message)).toMatch(/cancel/i);
      expect(String(error)).toContain("can't be found");
      expect(harness.calls()).toHaveLength(0);
      expect((await openPlanStore(root).read(lost.id))?.status).toBe("open");

      const gui = await startTestGui(root, {}, { every: () => () => undefined }, harness.environment);
      running.push(gui);
      await sendTo(gui, "POST", "/api/plan/open", { planId: lost.id, model: "sonnet", effort: "low" });
      const view = await idle(gui);
      expect(String(view.plan.open?.["unavailable"])).toContain("can't be found");
      expect((await sendTo(gui, "POST", "/api/plan/message", { text: "Hello" })).status).toBe(409);
      expect((await sendTo(gui, "POST", "/api/plan/cancel", { planId: lost.id })).status).toBe(200);
      expect((await openPlanStore(root).read(lost.id))?.status).toBe("cancelled");
      expect(harness.calls()).toHaveLength(0);
    },
    SLOW,
  );

  it(
    "TC-PLAN-071: cancelling from the GUI a session a live terminal holds with no proposal is refused naming the terminal; with a proposal waiting it can be answered",
    async () => {
      const root = project();
      const terminal = liveTerminal();
      try {
        const store = openPlanStore(root);
        const held = await store.create((id) =>
          newPlanSession({
            id,
            target: { kind: "new-roadmap" },
            summary: "Held",
            holder: { place: "terminal", pid: terminal.pid },
            claudeSessionId: "u-held-071",
            transcriptPath: null,
            now: new Date().toISOString(),
          }),
        );
        const { call } = await host(root);
        const waitingId = String(
          (await call("plan_begin", { target: { kind: "new-roadmap" }, request: "x" }))["planId"],
        );
        await call("plan_propose", { planId: waitingId, proposal: roadmap });
        const cancelId = String(
          (await call("plan_begin", { target: { kind: "new-roadmap" }, request: "y" }))["planId"],
        );
        await call("plan_propose", { planId: cancelId, proposal: roadmap });
        for (const id of [waitingId, cancelId]) {
          await store.update(id, (current) => ({
            save: { ...current, holder: { place: "terminal", pid: terminal.pid } },
            value: undefined,
          }));
        }
        const gui = await startTestGui(root, {}, { every: () => () => undefined }, agentHarness().environment);
        running.push(gui);

        const refused = await sendTo(gui, "POST", "/api/plan/cancel", { planId: held.id });
        expect(refused.status).toBe(409);
        expect(refused.body).toMatch(/terminal/i);
        expect((await store.read(held.id))?.status).toBe("open");
        expect((await store.read(held.id))?.holder).toEqual({ place: "terminal", pid: terminal.pid });

        const approved = await sendTo(gui, "POST", "/api/plan/approve", { planId: waitingId });
        expect(approved.status).toBe(200);
        expect((await store.read(waitingId))?.status).toBe("approved");
        expect(roadmapTitles(root)).toEqual(["Launch", "Portal"]);

        const cancelled = await sendTo(gui, "POST", "/api/plan/cancel", { planId: cancelId });
        expect(cancelled.status).toBe(200);
        expect((await store.read(cancelId))?.status).toBe("cancelled");
        expect(roadmapTitles(root)).toEqual(["Launch", "Portal"]);
      } finally {
        terminal.stop();
      }
    },
    SLOW,
  );

  it(
    "FR-PLAN-032 (QA run 3): once the holding terminal has ended, the GUI can cancel the session",
    async () => {
      const root = project();
      const terminal = liveTerminal();
      const held = await openPlanStore(root).create((id) =>
        newPlanSession({
          id,
          target: { kind: "new-roadmap" },
          summary: "Held",
          holder: { place: "terminal", pid: terminal.pid },
          claudeSessionId: "u-held-dead",
          transcriptPath: null,
          now: new Date().toISOString(),
        }),
      );
      terminal.stop();
      await vi.waitFor(() => {
        let alive = true;
        try {
          process.kill(terminal.pid, 0);
        } catch {
          alive = false;
        }
        if (alive) throw new Error("still running");
      }, WAIT);
      const gui = await startTestGui(root, {}, { every: () => () => undefined }, agentHarness().environment);
      running.push(gui);
      expect((await sendTo(gui, "POST", "/api/plan/cancel", { planId: held.id })).status).toBe(200);
      expect((await openPlanStore(root).read(held.id))?.status).toBe("cancelled");
    },
    SLOW,
  );

  it(
    "FR-PLAN-021 (QA run 3): /approve or /propose as the first message is refused and asked again, starting nothing",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [says("Hi.")] });
      selectMock.mockResolvedValueOnce("new");
      let sessionsWhenAsked: number[] = [];
      inputMock.mockImplementationOnce(() => Promise.resolve("/approve"));
      inputMock.mockImplementationOnce(async () => {
        sessionsWhenAsked.push((await sessions(root)).length);
        return "/propose";
      });
      inputMock.mockImplementationOnce(async () => {
        sessionsWhenAsked.push((await sessions(root)).length);
        return "Add SSO";
      });
      inputMock.mockRejectedValueOnce(new Error("terminal closed"));
      await plan(root, harness).catch(() => undefined);
      expect(sessionsWhenAsked).toEqual([0, 0]);
      expect(harness.output.err).toContain("Write what you want first");
      expect(harness.calls()).toHaveLength(1);
      expect(harness.calls()[0]?.prompt).toContain("Add SSO");
      sessionsWhenAsked = [];
    },
    SLOW,
  );

  it(
    "FR-PLAN-014 (QA run 3, GUI): a first turn stopped before Claude wrote a transcript refuses a new message, and Retry sends the first prompt again with --session-id",
    async () => {
      const root = project();
      const harness = agentHarness({ rules: [{ hang: true, beforeTranscript: true }, says("Hi there.")] });
      const gui = await startTestGui(root, {}, { every: () => () => undefined }, harness.environment);
      running.push(gui);
      const request = { target: { kind: "new-roadmap" }, model: "sonnet", effort: "low", text: "First idea" };
      expect((await sendTo(gui, "POST", "/api/plan", request)).status).toBe(201);
      await vi.waitFor(() => {
        if (harness.calls().length === 0) throw new Error("no PM yet");
      }, WAIT);
      expect((await sendTo(gui, "POST", "/api/plan/stop", {})).status).toBe(200);
      await idle(gui);
      expect((await openPlanStore(root).read("plan-1"))?.pendingFirstMessage).toContain("First idea");
      const sent = await sendTo(gui, "POST", "/api/plan/message", { text: "Second" });
      expect(sent.status).toBe(409);
      expect(sent.body).toContain("Retry");
      expect((await sendTo(gui, "POST", "/api/plan/retry", {})).status).toBe(200);
      await idle(gui);
      const [first, again] = harness.calls();
      expect(harness.calls()).toHaveLength(2);
      expect(again?.args).toContain("--session-id");
      expect(again?.prompt).toBe(first?.prompt);
      expect(again?.prompt).not.toContain("Second");
    },
    SLOW,
  );

  it(
    "FR-PLAN-022 (QA run 3, GUI): a start refused for an unknown upload keeps the valid upload it named for the next start",
    async () => {
      const root = project();
      const gui = await startTestGui(
        root,
        {},
        { every: () => () => undefined },
        agentHarness({ rules: [says("Got it.")] }).environment,
      );
      running.push(gui);
      const uploaded = await sendTo(gui, "POST", "/api/plan/uploads", {
        name: "notes.md",
        contentBase64: Buffer.from("# Notes").toString("base64"),
      });
      const { id } = (JSON.parse(uploaded.body) as { upload: { id: string } }).upload;
      const request = { target: { kind: "new-roadmap" }, model: "sonnet", effort: "low", text: "See notes" };
      const refused = await sendTo(gui, "POST", "/api/plan", { ...request, uploads: [id, "upload-0123456789abcdef"] });
      expect(refused.status).toBe(409);
      expect(await sessions(root)).toEqual([]);
      expect((await sendTo(gui, "POST", "/api/plan", { ...request, uploads: [id] })).status).toBe(201);
      expect((await openPlanStore(root).read("plan-1"))?.attachments.map((item) => item.name)).toEqual(["notes.md"]);
    },
    SLOW,
  );

  it("FR-PLAN-024 (QA run 3): several @refs in a row all attach, an e-mail address isn't a ref, and other spacing is kept", () => {
    expect(parseChatInput("@a.md @b.png @c.pdf")).toEqual({
      kind: "message",
      text: "",
      files: ["a.md", "b.png", "c.pdf"],
    });
    expect(parseChatInput("see @a.md@b.md")).toEqual({ kind: "message", text: "see", files: ["a.md@b.md"] });
    expect(parseChatInput("mail me@x.com  now")).toEqual({ kind: "message", text: "mail me@x.com  now", files: [] });
    expect(parseChatInput("one\n  @a.md\n  two")).toEqual({ kind: "message", text: "one\n\n  two", files: ["a.md"] });
    expect(parseChatInput('look @"my brief.pdf"  then  this')).toEqual({
      kind: "message",
      text: "look  then  this",
      files: ["my brief.pdf"],
    });
  });

  it("FR-MCP-045 (QA run 3): a planning tool reply only links when it took the session", async () => {
    const root = project();
    const { call } = await host(root);
    const planId = String((await call("plan_begin", { target: { kind: "new-roadmap" }, request: "x" }))["planId"]);
    const begin = { status: "ok", message: `Planning session ${planId} started.`, planId };
    await hook(root, {
      session_id: "s-begin",
      transcript_path: "/t/s-begin.jsonl",
      tool_name: "mcp__cclinic__plan_begin",
      tool_response: [{ type: "text", text: JSON.stringify(begin) }],
    });
    // A refused plan_resume naming the session in its text, and a plan_status reply carrying planId, link nothing.
    const refusal = { status: "refused", message: `Planning session ${planId} is open in Claude Code.` };
    await hook(root, {
      session_id: "s-refused",
      transcript_path: "/t/s-refused.jsonl",
      tool_name: "mcp__cclinic__plan_resume",
      tool_input: { planId },
      tool_response: [{ type: "text", text: JSON.stringify(refusal) }],
    });
    await hook(root, {
      session_id: "s-status",
      transcript_path: "/t/s-status.jsonl",
      tool_name: "mcp__cclinic__plan_status",
      tool_input: { planId },
      tool_response: [{ type: "text", text: JSON.stringify({ status: "ok", planId }) }],
    });
    await hook(root, {
      session_id: "s-input-only",
      transcript_path: "/t/s-input-only.jsonl",
      tool_name: "mcp__cclinic__plan_resume",
      tool_input: { planId },
    });
    expect(await openPlanStore(root).read(planId)).toMatchObject({
      claudeSessionId: "s-begin",
      transcriptPath: "/t/s-begin.jsonl",
    });
  });
});
