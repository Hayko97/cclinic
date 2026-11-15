/// <reference lib="dom" />
/**
 * Plan with the PM from the GUI: a chat in the side panel, on the same planning sessions as `cclinic plan` and
 * Claude Code, mirrored from the session's Claude transcript (spec: roadmap-planning FR-PLAN-033 to FR-PLAN-043,
 * gui FR-GUI-023 to FR-GUI-026).
 */
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { input, select } from "@inquirer/prompts";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import type { PlanPanelView } from "../../src/application/gui-planning.js";
import { runPlanCommand } from "../../src/cli/plan-command.js";
import type { PlanChatItem } from "../../src/core/gui.js";
import { answerLastMessage, newPlanSession, type PlanSession, type RoadmapProposal } from "../../src/core/planning.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";
import { openStream, sendTo, startTestGui, type TestGui } from "../support/gui.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn(), input: vi.fn() }));

/** Starting the fake `claude`, and its `cclinic mcp --plan` server, can take a few seconds on a busy machine. */
const WAIT = { timeout: 30_000, interval: 100 };
const SLOW = 90_000;

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

const planned = (key: string, dependsOn: string[] = [], spec: string | null = null) => ({
  key,
  title: `Task ${key}`,
  description: `About ${key}`,
  spec,
  dependsOn,
});

const roadmapProposal: RoadmapProposal = {
  roadmap: { title: "Checkout", goal: "Pay online" },
  milestones: [
    { title: "Cards", goal: "Pay by card", tasks: [planned("a", [], "auth"), planned("b", ["a"])] },
    { title: "Wallets", goal: "Pay by wallet", tasks: [planned("c", ["b"])] },
  ],
  openQuestions: ["Which provider?"],
};

const replying = (message: string, extra: Partial<FakeClaudeRule> = {}): FakeClaudeRule => ({ message, ...extra });
const proposing = (message: string, proposal: unknown): FakeClaudeRule => ({
  message,
  tools: [{ name: "plan_propose", input: { proposal } }],
});

/** A project with documents, and roadmap 1 "Launch" with tasks 1 and 2. */
function project(): string {
  const root = makeTempFolder();
  writeProject(root, { ".cclinic/sdd/overview.md": "# Overview\n", ".cclinic/sdd/README.md": "# Specs\n" });
  const store = openTaskStore(path.join(root, ".cclinic"), "create");
  if (store === undefined) throw new Error("No store");
  store.savePlan({
    roadmap: { title: "Launch", goal: "Ship" },
    milestones: [{ title: "One", goal: "", tasks: [planned("x"), planned("y")] }],
  });
  store.close();
  return root;
}

function roadmapTitles(root: string): string[] {
  const store = openTaskStore(path.join(root, ".cclinic"), "read");
  try {
    return store?.listRoadmaps().map((roadmap) => roadmap.title) ?? [];
  } finally {
    store?.close();
  }
}

/** Checks for changes made elsewhere, as the real GUI does, but often. */
function every(ms: number, run: () => Promise<void>): () => void {
  const timer = setInterval(() => void run(), Math.min(ms, 200));
  return () => {
    clearInterval(timer);
  };
}

async function startGui(root: string, rules: FakeClaudeRule[], options: { isPolling?: boolean } = {}) {
  const harness = agentHarness({ rules });
  const gui = await startTestGui(
    root,
    {},
    { every: options.isPolling === true ? every : () => () => undefined },
    harness.environment,
  );
  running.push(gui);
  return { gui, harness };
}

/** A reply's error message, or another of its text fields. */
const errorOf = (reply: { readonly body: string }, field = "error"): string => {
  const value = (JSON.parse(reply.body) as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
};

const post = (gui: TestGui, route: string, body: unknown = {}) => sendTo(gui, "POST", route, body);
const viewOf = async (gui: TestGui) =>
  (JSON.parse((await sendTo(gui, "GET", "/api/plan")).body) as { plan: PlanPanelView }).plan;

/** Waits until no turn is running, and returns the panel then. */
async function settled(gui: TestGui): Promise<PlanPanelView> {
  return vi.waitFor(async () => {
    const view = await viewOf(gui);
    if (view.turn !== null) throw new Error("the PM is still working");
    return view;
  }, WAIT);
}

const NEW_ROADMAP = { target: { kind: "new-roadmap" }, model: "sonnet", effort: "low", text: "Add checkout" };

function readSession(root: string, id: string): Promise<PlanSession | undefined> {
  return openPlanStore(root).read(id);
}

/** Claude Code's transcript file for a session in this project, as the GUI looks for it. */
function transcriptFile(home: string, root: string, sessionId: string): string {
  const folder = path.join(home, ".claude", "projects", realpathSync(root).replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(folder, { recursive: true });
  return path.join(folder, `${sessionId}.jsonl`);
}

const line = (type: "user" | "assistant", content: unknown) =>
  `${JSON.stringify({ type, timestamp: new Date().toISOString(), message: { content } })}\n`;

/** A session started elsewhere, with a transcript, held by `holder`. */
async function sessionFromElsewhere(
  root: string,
  home: string,
  holder: PlanSession["holder"],
  lines: readonly string[] = [],
): Promise<{ session: PlanSession; file: string }> {
  const claudeSessionId = randomUUID();
  const file = transcriptFile(home, root, claudeSessionId);
  writeFileSync(file, lines.join(""));
  const session = await openPlanStore(root).create((id) => ({
    ...newPlanSession({
      id,
      target: { kind: "new-roadmap" },
      summary: "A patient portal",
      holder: holder ?? { place: "terminal", pid: process.pid },
      claudeSessionId,
      transcriptPath: file,
      now: new Date().toISOString(),
    }),
    holder,
  }));
  return { session, file };
}

/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** Copies files into a session, as a message with them would, and records them (FR-PLAN-023). */
async function addAttachments(root: string, id: string, files: Record<string, Buffer>): Promise<void> {
  const folder = makeTempFolder();
  const sources = Object.entries(files).map(([name, bytes]) => {
    const file = path.join(folder, name);
    writeFileSync(file, bytes);
    return { file, name };
  });
  const store = openPlanStore(root);
  const stored = await store.copyAttachments(id, sources);
  await store.update(id, (session) => ({
    save: { ...session, attachments: [...session.attachments, ...stored] },
    value: undefined,
  }));
}

/**
 * A POST that reports the status even when the server answers before reading the whole body and closes the
 * connection, as it does for a body that's too large.
 */
function postLarge(gui: TestGui, requestPath: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: gui.port,
        method: "POST",
        path: requestPath,
        headers: {
          host: `127.0.0.1:${gui.port}`,
          "x-cclinic-token": gui.token,
          "content-type": "application/json",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    // The server may close the connection while the rest of a refused body is still being sent.
    outgoing.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") reject(error);
    });
    outgoing.end(JSON.stringify(body));
  });
}

/** A GET whose body is kept as bytes. */
function getBytes(
  gui: TestGui,
  requestPath: string,
): Promise<{ status: number; type: string; nosniff: string; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: gui.port,
        path: requestPath,
        headers: { host: `127.0.0.1:${gui.port}`, "x-cclinic-token": gui.token },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            type: response.headers["content-type"] ?? "",
            nosniff: String(response.headers["x-content-type-options"] ?? ""),
            bytes: Buffer.concat(chunks),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function itemsIn(stream: ReturnType<typeof openStream>): PlanChatItem[] {
  let items: PlanChatItem[] = [];
  for (const event of stream.events) {
    const data = event.data as { items?: PlanChatItem[] };
    if (event.event === "plan-transcript") items = data.items ?? [];
    if (event.event === "plan-entries") items = [...items, ...(data.items ?? [])];
  }
  return items;
}

describe("Plan through the API", () => {
  it(
    "TC-GUI-032: Plan starts the same session as cclinic plan: the same arguments and first prompt, in a persistent Claude session",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [replying("Who pays?")]);
      expect((await post(gui, "/api/plan", NEW_ROADMAP)).status).toBe(201);
      const view = await settled(gui);
      expect(view.open).toMatchObject({
        id: "plan-1",
        isHeldHere: true,
        status: "open",
        target: { kind: "new-roadmap" },
      });
      const first = harness.calls()[0];
      expect(first?.args).toContain("--session-id");
      expect(first?.args.join(" ")).toContain("--strict-mcp-config");
      expect(first?.prompt.startsWith("## The user's first message\n\nAdd checkout\n")).toBe(true);

      // The CLI, with the same choices in another project of the same shape, sends the PM the same.
      const other = project();
      const cli = agentHarness({ rules: [replying("Who pays?")] });
      vi.mocked(select).mockResolvedValueOnce("new");
      vi.mocked(input).mockResolvedValueOnce("Add checkout").mockRejectedValueOnce(new Error("stop here"));
      await runPlanCommand({ dir: other, timeoutMinutes: 30, model: "sonnet", effort: "low" }, cli.context).catch(
        () => undefined,
      );
      const same = (text: string) =>
        text
          .replaceAll(realpathSync(root), "ROOT")
          .replaceAll(realpathSync(other), "ROOT")
          .replaceAll(root, "ROOT")
          .replaceAll(other, "ROOT")
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "ID")
          .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "TIME");
      expect(same((first?.args ?? []).join(" "))).toBe(same((cli.calls()[0]?.args ?? []).join(" ")));
      expect(same(first?.prompt ?? "")).toBe(same(cli.calls()[0]?.prompt ?? ""));
    },
    SLOW,
  );

  it(
    "TC-GUI-033, TC-GUI-034, TC-PLAN-058: a reply and feedback reach the PM in the same session, the proposal waits in full, and approve saves it",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        replying("Who pays?", { tools: [{ name: "plan_suggest", input: { suggestions: ["Shoppers", "Shops"] } }] }),
        proposing("Here it is", roadmapProposal),
        proposing("Split it", roadmapProposal),
      ]);
      await post(gui, "/api/plan", NEW_ROADMAP);
      expect((await settled(gui)).open?.suggestions).toEqual(["Shoppers", "Shops"]);
      expect((await post(gui, "/api/plan/message", { text: "Shoppers, by card" })).status).toBe(200);
      const proposed = await settled(gui);
      expect(proposed.open?.proposal).toMatchObject({
        kind: "roadmap",
        roadmap: { title: "Checkout" },
        milestones: [{ title: "Cards", tasks: [{ spec: "auth" }, { dependsOn: ["a"] }] }, { title: "Wallets" }],
        openQuestions: ["Which provider?"],
      });
      const calls = harness.calls();
      const firstArgs = calls[0]?.args ?? [];
      const sessionId = firstArgs[firstArgs.indexOf("--session-id") + 1];
      expect(calls[1]?.args).toContain("--resume");
      expect(calls[1]?.args).toContain(sessionId);
      expect(calls[1]?.prompt).toBe("Shoppers, by card");

      await post(gui, "/api/plan/message", { text: "split task b" });
      await settled(gui);
      expect(harness.calls()[2]?.prompt).toBe("split task b");
      const approved = await post(gui, "/api/plan/approve", { planId: "plan-1" });
      expect(approved.status).toBe(200);
      expect(errorOf(approved, "message")).toContain("Saved roadmap #2");
      expect(roadmapTitles(root)).toEqual(["Launch", "Checkout"]);
      expect((await readSession(root, "plan-1"))?.status).toBe("approved");
    },
    SLOW,
  );

  it(
    "TC-GUI-035: cancel and a stopped GUI save nothing; a stop keeps the session, and cancel closes it",
    async () => {
      const root = project();
      const { gui } = await startGui(root, [replying("Who pays?"), replying("Slow", { delayMs: 20_000 })]);
      await post(gui, "/api/plan", NEW_ROADMAP);
      await settled(gui);
      expect((await post(gui, "/api/plan/cancel", { planId: "plan-1" })).status).toBe(200);
      expect((await readSession(root, "plan-1"))?.status).toBe("cancelled");

      await post(gui, "/api/plan", { ...NEW_ROADMAP, text: "Again" });
      await vi.waitFor(async () => {
        if ((await viewOf(gui)).turn === null) throw new Error("not working yet");
      }, WAIT);
      await gui.stop();
      running.splice(running.indexOf(gui), 1);
      const kept = await readSession(root, "plan-2");
      expect(kept).toMatchObject({ status: "open", holder: null, isAwaitingReply: true });
      expect(roadmapTitles(root)).toEqual(["Launch"]);
    },
    SLOW,
  );

  it(
    "TC-GUI-036, TC-PLAN-053: a session held in a terminal is shown, not driven, and a new client sees the open session",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, []);
      const home = harness.environment.HOME ?? "";
      const { session } = await sessionFromElsewhere(root, home, { place: "terminal", pid: process.pid }, [
        line("user", "Plan a portal"),
        line("assistant", [{ type: "text", text: "Who uses it?" }]),
      ]);
      expect((await post(gui, "/api/plan/open", { planId: session.id })).status).toBe(200);
      const view = await viewOf(gui);
      expect(view.open).toMatchObject({ id: session.id, heldBy: "terminal", isHeldHere: false });
      const refused = await post(gui, "/api/plan/message", { text: "Patients" });
      expect(refused.status).toBe(409);
      expect(errorOf(refused)).toContain("a terminal");
      expect(harness.calls()).toHaveLength(0);

      const stream = openStream(gui, "/api/plan/events");
      await vi.waitFor(() => {
        expect(itemsIn(stream).map((item) => [item.kind, item.text])).toEqual([
          ["user", "Plan a portal"],
          ["pm", "Who uses it?"],
        ]);
      }, WAIT);
      stream.close();
    },
    SLOW,
  );

  it("FR-GUI-023: what cclinic plan refuses is refused with its words, and a message with nothing in it too", async () => {
    const root = project();
    const { gui, harness } = await startGui(root, []);
    const bad = await post(gui, "/api/plan", { ...NEW_ROADMAP, timeoutMinutes: 0 });
    expect(bad.status).toBe(400);
    expect(errorOf(bad)).toContain("--timeout-minutes");
    const empty = await post(gui, "/api/plan", { ...NEW_ROADMAP, text: "  " });
    expect(empty.status).toBe(409);
    expect(errorOf(empty)).toBe("Write a message or attach a file.");
    expect((await post(gui, "/api/plan/message", { text: "hello" })).status).toBe(409);
    expect(harness.calls()).toHaveLength(0);
  });

  it("FR-GUI-023: a project with no documents is refused as cclinic plan refuses it", async () => {
    const root = makeTempFolder();
    const { gui } = await startGui(root, []);
    const refused = await post(gui, "/api/plan", NEW_ROADMAP);
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toContain("Run cclinic in the project folder first");
  });

  it("TC-PLAN-051: uploads of the wrong type, too large or without the token are refused, and nothing is added", async () => {
    const root = project();
    const { gui } = await startGui(root, []);
    const song = await post(gui, "/api/plan/uploads", { name: "song.mp3", contentBase64: "AAAA" });
    expect(song.status).toBe(409);
    expect(errorOf(song)).toContain("song.mp3 can't be attached");
    const big = Buffer.alloc(6 * 1024 * 1024).toString("base64");
    const large = await post(gui, "/api/plan/uploads", { name: "big.png", contentBase64: big });
    expect(large.status).toBe(409);
    expect(errorOf(large)).toContain("big.png is too large");
    const noToken = await sendTo({ ...gui, token: "wrong" }, "POST", "/api/plan/uploads", {
      name: "mock.png",
      contentBase64: "AAAA",
    });
    expect(noToken.status).toBeGreaterThanOrEqual(400);
    const control = await post(gui, "/api/plan/uploads", { name: "a\nb.png", contentBase64: "AAAA" });
    expect(control.status).toBe(400);
    const fine = await post(gui, "/api/plan/uploads", { name: "mock.png", contentBase64: "iVBORw0KGgo=" });
    expect(fine.status).toBe(201);
    expect((JSON.parse(fine.body) as { upload: unknown }).upload).toMatchObject({ name: "mock.png", kind: "image" });
  });

  it(
    "FR-PLAN-037: a session's image is served with its type, and unknown names, documents, other sessions and paths outside are refused",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, []);
      const home = harness.environment.HOME ?? "";
      const { session } = await sessionFromElsewhere(root, home, null);
      const { session: other } = await sessionFromElsewhere(root, home, null);
      await addAttachments(root, session.id, { "mock.png": PNG, "notes.md": Buffer.from("# Notes") });
      await addAttachments(root, other.id, { "theirs.png": PNG });
      const served = await getBytes(gui, `/api/plan/sessions/${session.id}/attachments/mock.png`);
      expect(served).toMatchObject({ status: 200, type: "image/png", nosniff: "nosniff" });
      expect(served.bytes.equals(PNG)).toBe(true);
      const base = `/api/plan/sessions/${session.id}/attachments`;
      for (const refused of [
        `${base}/missing.png`,
        `${base}/notes.md`,
        `${base}/theirs.png`,
        `${base}/..%2Fsession.json`,
        `${base}/%2e%2e`,
        `${base}/..%2F..%2F..%2Ftasks.db`,
        `/api/plan/sessions/${session.id}/session.json`,
        `/api/plan/sessions/plan-99/attachments/mock.png`,
      ])
        expect((await getBytes(gui, refused)).status, refused).toBe(404);
    },
    SLOW,
  );

  it("FR-PLAN-033: other routes keep the 1 MB body limit, and only an upload may be larger", async () => {
    const root = project();
    const { gui } = await startGui(root, []);
    expect(await postLarge(gui, "/api/plan/message", { text: "x".repeat(2 * 1024 * 1024) })).toBe(413);
    const document = Buffer.alloc(15 * 1024 * 1024, 1).toString("base64");
    expect(await postLarge(gui, "/api/plan/uploads", { name: "brief.pdf", contentBase64: document })).toBe(201);
  });

  it(
    "TC-PLAN-052: a session started in the terminal and not held is continued here with the same Claude session",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [replying("Noted.")]);
      const home = harness.environment.HOME ?? "";
      const { session } = await sessionFromElsewhere(root, home, null, [
        line("user", "Plan a portal"),
        line("assistant", [{ type: "text", text: "Who uses it?" }]),
      ]);
      await post(gui, "/api/plan/open", { planId: session.id });
      expect((await viewOf(gui)).open).toMatchObject({ id: session.id, isHeldHere: true });
      expect((await viewOf(gui)).sessions.map((item) => item.id)).toEqual([session.id]);
      await post(gui, "/api/plan/message", { text: "Patients" });
      await settled(gui);
      const call = harness.calls()[0];
      expect(call?.args).toContain("--resume");
      expect(call?.args).toContain(session.claudeSessionId);
      expect(call?.prompt).toBe("Patients");
    },
    SLOW,
  );

  it(
    "TC-PLAN-057: Stop ends the PM's turn and keeps the session; Retry asks the PM to answer again",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        replying("Who pays?"),
        replying("Late", { delayMs: 20_000 }),
        replying("Back."),
      ]);
      await post(gui, "/api/plan", NEW_ROADMAP);
      await settled(gui);
      await post(gui, "/api/plan/message", { text: "Shoppers" });
      const transcript = (await readSession(root, "plan-1"))?.transcriptPath ?? "";
      await vi.waitFor(() => {
        if (harness.calls().length < 2) throw new Error("not started");
        if (!existsSync(transcript) || !readFileSync(transcript, "utf8").includes("Shoppers"))
          throw new Error("not written");
      }, WAIT);
      expect((await post(gui, "/api/plan/stop")).status).toBe(200);
      const stopped = await settled(gui);
      expect(stopped.notice).toMatchObject({ action: "retry" });
      expect((await readSession(root, "plan-1"))?.isAwaitingReply).toBe(true);
      await post(gui, "/api/plan/retry");
      await settled(gui);
      expect(harness.calls()[2]?.args).toContain("--resume");
      // FR-PLAN-014: Claude Code wrote "Shoppers" before the stop, so Retry doesn't repeat it.
      expect(harness.calls()[2]?.prompt).toBe(answerLastMessage(null));
    },
    SLOW,
  );

  it(
    "TC-PLAN-073 (Retry): a Retry after the stopped turn was answered elsewhere asks the PM nothing",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        replying("Who pays?"),
        replying("Late", { delayMs: 20_000 }),
        replying("Never asked."),
      ]);
      await post(gui, "/api/plan", NEW_ROADMAP);
      await settled(gui);
      await post(gui, "/api/plan/message", { text: "Shoppers" });
      const transcript = (await readSession(root, "plan-1"))?.transcriptPath ?? "";
      await vi.waitFor(() => {
        if (harness.calls().length < 2) throw new Error("not started");
        if (!existsSync(transcript) || !readFileSync(transcript, "utf8").includes("Shoppers"))
          throw new Error("not written");
      }, WAIT);
      await post(gui, "/api/plan/stop");
      expect((await settled(gui)).notice).toMatchObject({ action: "retry" });
      // Answered in Claude Code before the GUI shows it, then Retry is pressed in the gap.
      appendFileSync(transcript, line("assistant", [{ type: "text", text: "Shoppers pay at checkout." }]));
      expect((await post(gui, "/api/plan/retry")).status).toBe(200);
      const view = await settled(gui);
      expect(harness.calls()).toHaveLength(2);
      expect(view.turn).toBeNull();
      expect(view.notice).toBeNull();
    },
    SLOW,
  );

  it(
    "TC-PLAN-060: a usage limit ends the turn with its words and Resume, keeping the session",
    async () => {
      const root = project();
      const { gui } = await startGui(root, [
        replying("Who pays?"),
        { message: "You've hit your session limit. Resets at 5pm.", exitCode: 1, apiErrorStatus: 429 },
      ]);
      await post(gui, "/api/plan", NEW_ROADMAP);
      await settled(gui);
      await post(gui, "/api/plan/message", { text: "Shoppers" });
      const view = await vi.waitFor(async () => {
        const current = await settled(gui);
        if (current.notice === null) throw new Error("no notice yet");
        return current;
      }, WAIT);
      expect(view.notice).toMatchObject({ action: "resume" });
      expect(view.notice?.message).toContain("usage limit");
      expect((await readSession(root, "plan-1"))?.status).toBe("open");
    },
    SLOW,
  );

  it(
    "TC-PLAN-061: a session Claude Code holds is mirrored live: messages, tool calls as activity rows, results folded, secrets redacted",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [], { isPolling: true });
      const home = harness.environment.HOME ?? "";
      const { session, file } = await sessionFromElsewhere(root, home, { place: "claude-code", pid: process.pid });
      await post(gui, "/api/plan/open", { planId: session.id });
      const stream = openStream(gui, "/api/plan/events");
      appendFileSync(file, line("user", "Plan a portal for clinics"));
      appendFileSync(
        file,
        line("assistant", [{ type: "tool_use", name: "Read", input: { file_path: "/x/brief.pdf" } }]),
      );
      appendFileSync(
        file,
        line("user", [
          { type: "tool_result", content: Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n") },
        ]),
      );
      appendFileSync(
        file,
        line("assistant", [{ type: "tool_use", name: "WebSearch", input: { query: "patient portal GDPR" } }]),
      );
      appendFileSync(
        file,
        line("assistant", [{ type: "text", text: "Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 found" }]),
      );
      await vi.waitFor(
        () => {
          const items = itemsIn(stream);
          expect(items.map((item) => item.kind)).toEqual(["user", "activity", "result", "activity", "pm"]);
          expect(items[1]?.text).toBe("Read brief.pdf");
          expect(items[3]?.text).toBe("Searched the web: patient portal GDPR");
          expect(items[4]?.text).not.toContain("abcdefghijklmnop");
        },
        { timeout: 5_000, interval: 100 },
      );
      expect((await viewOf(gui)).open).toMatchObject({ heldBy: "claude-code", isHeldHere: false });
      stream.close();
    },
    SLOW,
  );

  it(
    "TC-PLAN-062: a transcript replaced by a shorter file replaces what's shown, never mixing old and new",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [], { isPolling: true });
      const home = harness.environment.HOME ?? "";
      const { session, file } = await sessionFromElsewhere(root, home, { place: "claude-code", pid: process.pid }, [
        line("user", "First"),
        line("assistant", [{ type: "text", text: "One" }]),
        line("assistant", [{ type: "text", text: "Two" }]),
      ]);
      await post(gui, "/api/plan/open", { planId: session.id });
      const stream = openStream(gui, "/api/plan/events");
      await vi.waitFor(
        () => {
          expect(itemsIn(stream)).toHaveLength(3);
        },
        { timeout: 5_000, interval: 100 },
      );
      writeFileSync(`${file}.new`, line("user", "Fresh"));
      renameSync(`${file}.new`, file);
      await vi.waitFor(
        () => {
          expect(itemsIn(stream).map((item) => item.text)).toEqual(["Fresh"]);
        },
        {
          timeout: 5_000,
          interval: 100,
        },
      );
      stream.close();
    },
    SLOW,
  );
});

describe("Plan in the browser", () => {
  async function openPage(
    gui: TestGui,
    viewport = { width: 1280, height: 900 },
    colorScheme: "light" | "dark" = "light",
  ) {
    const context = await browser.newContext({ viewport, colorScheme });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
    await page.locator('[data-key="task-1"]').waitFor();
    return page;
  }

  const panel = (page: Page) => page.locator("#plan-panel");

  it(
    "TC-GUI-130: New roadmap opens the chat; the PM's message shows, Needs you counts it, a suggestion sends, and Approve saves",
    async () => {
      const root = project();
      const { gui } = await startGui(root, [
        replying("Who pays?", { tools: [{ name: "plan_suggest", input: { suggestions: ["Shoppers", "Shops"] } }] }),
        proposing("Here it is", roadmapProposal),
      ]);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await expect.poll(() => panel(page).isVisible()).toBe(true);
      await page.locator("#plan-text").fill("Add checkout");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => panel(page).locator(".plan-pm .plan-md").first().textContent(), WAIT).toBe("Who pays?");
      await expect.poll(() => page.locator("#needs-count").textContent()).toBe("1");
      await panel(page).getByRole("button", { name: "Shoppers" }).click();
      await expect.poll(() => panel(page).locator(".plan-card h3").textContent(), WAIT).toBe("Checkout");
      expect(await panel(page).locator(".plan-card").textContent()).toContain("new spec");
      expect(await panel(page).locator(".plan-card").textContent()).toContain("Which provider?");
      await panel(page).locator('[data-plan-decide="approve"]').click();
      await expect.poll(() => roadmapTitles(root), WAIT).toEqual(["Launch", "Checkout"]);
      await expect.poll(() => page.locator("#needs-count").textContent()).toBe("0");
    },
    SLOW,
  );

  it(
    "TC-PLAN-050: the chat is in the side panel, full width at 768 px, with the GUI's own tokens in light and dark",
    async () => {
      const root = project();
      const { gui } = await startGui(root, []);
      for (const scheme of ["light", "dark"] as const) {
        const page = await openPage(gui, { width: 1280, height: 900 }, scheme);
        await page.locator("#plan-open").click();
        const box = await panel(page).boundingBox();
        expect(box?.width).toBeLessThan(700);
        const colours = await page.evaluate(() => {
          const probe = document.createElement("div");
          document.body.append(probe);
          const token = (name: string) => {
            probe.style.color = `var(${name})`;
            return getComputedStyle(probe).color;
          };
          const result = {
            panel: getComputedStyle(document.getElementById("plan-panel") as HTMLElement).backgroundColor,
            surface: token("--surface"),
            text: getComputedStyle(document.getElementById("plan-title") as HTMLElement).color,
            textToken: token("--text"),
          };
          probe.remove();
          return result;
        });
        expect(colours.panel).toBe(colours.surface);
        expect(colours.text).toBe(colours.textToken);
        await page.setViewportSize({ width: 768, height: 900 });
        await expect.poll(async () => (await panel(page).boundingBox())?.width).toBe(768);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);
      }
    },
    SLOW,
  );

  /** A second roadmap, "Payments", for the target menu. */
  function addRoadmap(root: string): void {
    const store = openTaskStore(path.join(root, ".cclinic"), "create");
    store?.savePlan({
      roadmap: { title: "Payments", goal: "Pay" },
      milestones: [{ title: "One", goal: "", tasks: [planned("p")] }],
    });
    store?.close();
  }

  /** The panel at the width the spec measures it at. */
  async function widen(page: Page): Promise<void> {
    await page.evaluate(() => {
      (document.getElementById("plan-panel") as HTMLElement).style.width = "520px";
    });
  }

  it(
    "TC-PLAN-054: the empty state is centred with no form, nothing wraps at 520 px, and the target and model are chosen in the toolbar",
    async () => {
      const root = project();
      addRoadmap(root);
      const { gui, harness } = await startGui(root, [replying("Noted.")]);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await widen(page);
      const empty = panel(page).locator(".plan-empty");
      expect(await empty.locator("h2").textContent()).toBe("What do you want to build?");
      expect(await empty.textContent()).toContain("Attach");
      const log = await page.locator("#plan-log").boundingBox();
      const box = await empty.boundingBox();
      const middle = (log?.y ?? 0) + (log?.height ?? 0) / 2;
      expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) / 2 - middle)).toBeLessThan(24);
      // No form controls outside the toolbar's menus, and no label on two lines.
      const visibleControls = await panel(page)
        .locator('input:not([type="file"]):visible, select:visible, details.plan-advanced')
        .count();
      expect(visibleControls).toBe(0);
      const wrapped = await panel(page).evaluate((root) =>
        [...root.querySelectorAll(".plan-head button, .plan-head h1, .plan-toolbar button")]
          .filter(
            (node) =>
              (node as HTMLElement).offsetParent !== null && ((node.textContent as string | null) ?? "").trim() !== "",
          )
          .filter((node) => {
            const style = getComputedStyle(node);
            const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.3;
            const label = node.querySelector("span") ?? node;
            return label.getBoundingClientRect().height > lineHeight * 1.5;
          })
          .map((node) => node.textContent),
      );
      expect(wrapped).toEqual([]);

      await page.locator("#plan-target").click();
      await page.getByRole("menuitem", { name: /Extend roadmap #2/ }).click();
      expect(await page.locator("#plan-target").textContent()).toContain("Extend #2");
      await page.locator("#plan-model").click();
      await page.locator('#plan-model-menu select[name="effort"]').waitFor();
      await expect
        .poll(() => page.locator('#plan-model-menu select[name="effort"] option').count(), WAIT)
        .toBeGreaterThan(1);
      await page.locator('#plan-model-menu select[name="effort"]').selectOption("high");
      await page.keyboard.press("Escape");
      expect(await page.locator("#plan-model-menu").isHidden()).toBe(true);
      expect(await page.locator("#plan-model").textContent()).toContain("High");
      await page.locator("#plan-text").fill("Add exports");
      await page.locator("#plan-text").press("Enter");
      await expect.poll(() => harness.calls().length, WAIT).toBe(1);
      expect(await empty.count()).toBe(0);
      expect(await page.locator("#plan-target").isDisabled()).toBe(true);
      expect(harness.calls()[0]?.prompt).toContain("EXTEND roadmap 2");
      const args = harness.calls()[0]?.args ?? [];
      expect(args[args.indexOf("--effort") + 1]).toBe("high");
    },
    SLOW,
  );

  it(
    "TC-PLAN-055: the message box: Shift+Enter, growing to 40 %, chips above the text, a round arrow Send that becomes Stop, controls at most 32 px, and Propose now after the first message",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [replying("Late", { delayMs: 3_000 })]);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await widen(page);
      const send = page.locator("#plan-send");
      expect(await send.isDisabled()).toBe(true);
      expect(await send.getAttribute("aria-label")).toBe("Send");
      expect(await send.locator("svg").count()).toBe(1);
      const sendBox = await send.boundingBox();
      expect(sendBox?.width).toBe(sendBox?.height);
      expect(await send.evaluate((node) => getComputedStyle(node).borderRadius)).not.toBe("0px");
      expect(await page.locator("#plan-attach").getAttribute("aria-label")).toBe("Attach files");
      expect((await page.locator("#plan-attach").textContent())?.trim()).toBe("");
      expect(await page.locator("#plan-propose").isHidden()).toBe(true);
      const heights = await panel(page).evaluate((root) =>
        [...root.querySelectorAll(".plan-toolbar button")]
          .filter((node) => (node as HTMLElement).offsetParent !== null)
          .map((node) => node.getBoundingClientRect().height),
      );
      expect(heights.length).toBeGreaterThanOrEqual(4);
      expect(Math.max(...heights)).toBeLessThanOrEqual(32);

      const text = page.locator("#plan-text");
      await text.fill("Line 1");
      await text.press("Shift+Enter");
      await text.pressSequentially("Line 2");
      expect(await text.inputValue()).toBe("Line 1\nLine 2");
      const before = (await text.boundingBox())?.height ?? 0;
      await text.fill(Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n"));
      await text.dispatchEvent("input");
      const after = (await text.boundingBox())?.height ?? 0;
      const panelHeight = (await panel(page).boundingBox())?.height ?? 0;
      expect(after).toBeGreaterThan(before);
      expect(after).toBeLessThanOrEqual(Math.ceil(panelHeight * 0.4) + 1);
      // A pasted image becomes a chip above the text, which can be removed before sending.
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" }));
        document.getElementById("plan-text")?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
      });
      await expect.poll(() => panel(page).locator("#plan-chips .plan-chip").count()).toBe(1);
      const chips = await page.locator("#plan-chips").boundingBox();
      expect((chips?.y ?? 0) + (chips?.height ?? 0)).toBeLessThanOrEqual((await text.boundingBox())?.y ?? 0);
      await panel(page).getByRole("button", { name: "Remove pasted.png" }).click();
      expect(await panel(page).locator("#plan-chips .plan-chip").count()).toBe(0);
      await text.fill("Add exports");
      await text.press("Enter");
      await expect.poll(() => page.locator("#plan-stop").isVisible(), WAIT).toBe(true);
      expect(await page.locator("#plan-stop").getAttribute("aria-label")).toBe("Stop");
      expect(await send.isVisible()).toBe(false);
      await expect.poll(() => page.locator("#plan-propose").isVisible(), WAIT).toBe(true);
      expect(harness.calls()).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "TC-PLAN-052 (browser), TC-PLAN-057 (browser): a one-line header with the sessions and ⋯ menus, and a working row with a spinner and its activity",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        replying("Late", { delayMs: 4_000, toolUses: [{ name: "Read", input: { file_path: "/x/brief.pdf" } }] }),
      ]);
      const home = harness.environment.HOME ?? "";
      const { session } = await sessionFromElsewhere(root, home, null, [line("user", "Older idea")]);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await widen(page);
      const head = await panel(page).locator(".plan-head").boundingBox();
      expect(head?.height).toBeLessThanOrEqual(56);
      await page.locator("#plan-text").fill("Add checkout");
      await page.locator("#plan-text").press("Enter");
      const working = panel(page).locator(".plan-working");
      await expect.poll(() => working.count(), WAIT).toBe(1);
      expect(await working.locator(".plan-spinner").count()).toBe(1);
      expect(await working.textContent()).toMatch(/Working · \d+s/);
      expect((await working.boundingBox())?.height).toBeLessThan(28);

      await page.locator("#plan-sessions-button").click();
      const items = page.locator("#plan-sessions-menu [role=menuitem]");
      expect(await items.first().textContent()).toContain("New session");
      await expect.poll(() => items.count(), WAIT).toBe(3);
      expect(await page.locator('#plan-sessions-menu [aria-current="true"]').textContent()).toContain("plan-2");
      expect(await page.locator(`#plan-sessions-menu [data-plan-id="${session.id}"]`).textContent()).toContain(
        "A patient portal",
      );
      await page.keyboard.press("Escape");
      expect(await page.locator("#plan-sessions-menu").isHidden()).toBe(true);
      expect(await panel(page).isVisible()).toBe(true);
      await page.locator("#plan-more").click();
      expect(await page.locator("#plan-cancel-session").isVisible()).toBe(true);
      const commands = await page.locator("#plan-resume code").allTextContents();
      expect(commands[0]).toBe("cclinic plan --resume plan-2");
      expect(commands[1]).toMatch(/^claude --resume /);
      expect(await page.locator("#plan-resume").getByRole("button", { name: "Copy" }).count()).toBe(2);
    },
    SLOW,
  );

  it(
    "TC-PLAN-056, TC-PLAN-059: the PM's Markdown, HTML shown as text, copy, a live log, and Escape keeping the session",
    async () => {
      const root = project();
      const reply = [
        "Some **bold** text and `code`.",
        "",
        "- one",
        "- two",
        "",
        "```",
        "block",
        "```",
        "",
        'See [docs](https://example.com/docs) <img src=x onerror="window.hacked=1">',
      ].join("\n");
      const { gui } = await startGui(root, [
        replying(reply, {
          tools: [
            {
              name: "plan_suggest",
              input: { suggestions: ["Web"], sources: [{ title: "Docs", url: "https://example.com/docs" }] },
            },
          ],
        }),
      ]);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-text").fill("Hello");
      await page.locator("#plan-text").press("Enter");
      const message = panel(page).locator(".plan-pm").first();
      await expect.poll(() => message.locator("strong").textContent(), WAIT).toBe("bold");
      expect(await message.locator("ul li").count()).toBe(2);
      expect(await message.locator("pre").textContent()).toBe("block");
      const link = message.locator('.plan-md a[href="https://example.com/docs"]');
      expect(await link.getAttribute("target")).toBe("_blank");
      expect(await link.getAttribute("rel")).toContain("noopener");
      expect(await message.locator("img").count()).toBe(0);
      expect(await message.textContent()).toContain("<img src=x");
      expect(await page.evaluate(() => (window as unknown as { hacked?: number }).hacked)).toBeUndefined();
      expect(await message.locator(".plan-sources").textContent()).toContain("example.com · Docs");
      await message.getByRole("button", { name: "Copy" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(reply);
      expect(await page.locator("#plan-log").getAttribute("role")).toBe("log");
      expect(await page.locator("#plan-log").getAttribute("aria-live")).toBe("polite");
      await page.keyboard.press("Escape");
      expect(await panel(page).isHidden()).toBe(true);
      expect((await viewOf(gui)).open).toMatchObject({ id: "plan-1", isHeldHere: true });
      await page.locator("#plan-open").click();
      expect(await page.locator("#plan-subtitle").textContent()).toContain("plan-1");
      await expect.poll(() => panel(page).locator(".plan-pm").count()).toBe(1);
      // A reload starts the page empty, so what shows after reopening is redrawn from the server.
      await page.reload();
      await page.locator('[data-key="task-1"]').waitFor();
      await page.locator("#plan-open").click();
      await expect.poll(() => page.locator("#plan-subtitle").textContent(), WAIT).toContain("plan-1");
      await expect.poll(() => panel(page).locator(".plan-pm strong").textContent(), WAIT).toBe("bold");
      expect(await panel(page).locator(".plan-user").textContent()).toContain("Hello");
    },
    SLOW,
  );

  it(
    "FR-PLAN-037: a message mirrored from another place shows its image from the server",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, []);
      const home = harness.environment.HOME ?? "";
      const { session, file } = await sessionFromElsewhere(root, home, { place: "claude-code", pid: process.pid });
      await addAttachments(root, session.id, { "mock.png": PNG });
      appendFileSync(
        file,
        line(
          "user",
          `Here it is\n\nAttached (new in this message):\n- mock.png (image): .cclinic/plans/${session.id}/attachments/mock.png`,
        ),
      );
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-sessions-button").click();
      await page.locator(`#plan-sessions-menu [data-plan-id="${session.id}"] [role=menuitem]`).click();
      const image = panel(page).locator(".plan-user img.plan-thumb");
      await expect.poll(() => image.getAttribute("alt"), WAIT).toBe("mock.png");
      await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth), WAIT).toBe(1);
    },
    SLOW,
  );

  it(
    "FR-PLAN-007, FR-PLAN-037: a PM reply longer than a canvas transcript entry shows whole, and Copy copies all of it",
    async () => {
      const root = project();
      const reply = `${"A".repeat(5_000)} middle ${"B".repeat(2_500)} end`;
      const { gui } = await startGui(root, [replying(reply)]);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-text").fill("Hello");
      await page.locator("#plan-text").press("Enter");
      const message = panel(page).locator(".plan-pm").first();
      await expect.poll(() => message.locator(".plan-md").textContent(), WAIT).toBe(reply);
      await message.getByRole("button", { name: "Copy" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(reply);
    },
    SLOW,
  );

  it(
    "TC-PLAN-072 (GUI): through Stop, Retry, a Stop before Claude wrote anything and Retry again, the message shows once and the old suggestions stay gone",
    async () => {
      const root = project();
      const { gui, harness } = await startGui(root, [
        replying("Who uses it?", { tools: [{ name: "plan_suggest", input: { suggestions: ["Patients", "Staff"] } }] }),
        { hang: true },
        { hang: true, beforeTranscript: true },
        replying("Patients, noted."),
      ]);
      const page = await openPage(gui);
      await page.locator("#plan-open").click();
      await page.locator("#plan-text").fill("A patient portal");
      await page.locator("#plan-text").press("Enter");
      const buttons = panel(page).locator("#plan-suggestions button");
      await expect.poll(() => buttons.count(), WAIT).toBe(2);
      await buttons.first().click();
      const stop = page.locator("#plan-stop");
      const retry = panel(page).getByRole("button", { name: "Retry" });
      const patients = async () =>
        (await panel(page).locator(".plan-user").allTextContents()).filter((text) => text.includes("Patients")).length;
      const transcript = (await readSession(root, "plan-1"))?.transcriptPath ?? "";
      const written = () =>
        readFileSync(transcript, "utf8")
          .split("\n")
          .filter(Boolean)
          .some((item) => {
            const entry = JSON.parse(item) as { type: string; message: { content: unknown } };
            return entry.type === "user" && entry.message.content === "Patients";
          });
      for (const call of [2, 3]) {
        await expect.poll(() => harness.calls().length, WAIT).toBe(call);
        // The first stop comes after Claude Code wrote "Patients"; the second, before it wrote anything.
        if (call === 2) await expect.poll(written, WAIT).toBe(true);
        await expect.poll(() => stop.isVisible(), WAIT).toBe(true);
        await stop.click();
        await expect.poll(() => retry.isVisible(), WAIT).toBe(true);
        expect(await patients()).toBe(1);
        expect(await buttons.count()).toBe(0);
        await retry.click();
      }
      await expect.poll(() => panel(page).locator(".plan-pm").count(), WAIT).toBe(2);
      expect(await patients()).toBe(1);
      expect(await buttons.count()).toBe(0);
      // FR-PLAN-014: "Patients" was in the transcript before both Retries, so neither repeats it.
      expect(
        harness
          .calls()
          .map((item) => item.prompt)
          .slice(2),
      ).toEqual([answerLastMessage(null), answerLastMessage(null)]);
      expect(await panel(page).locator(".plan-note").first().textContent()).toBe(
        "Asked the PM to answer your last message.",
      );
    },
    SLOW,
  );

  it("TC-GUI-104: a frame's Plan a task and the canvas's New roadmap open Plan for what they say", async () => {
    const root = project();
    const { gui } = await startGui(root, []);
    const page = await openPage(gui);
    const frame = page.locator('[data-frame="roadmap-1"]');
    await frame.locator('button[data-action="plan-task"]').click();
    expect(await page.locator("#plan-subtitle").textContent()).toBe("One task in roadmap #1");
    expect(await page.locator("#plan-start-heading").textContent()).toBe("What's the change?");
    await page.locator("#plan-close").click();
    await page.locator("#plan-open").click();
    expect(await page.locator("#plan-subtitle").textContent()).toBe("New roadmap");
    await page.locator("#plan-close").click();
    await frame.locator('button[data-action="run-ai"]').click();
    expect(await page.locator("#auto-roadmap").textContent()).toBe("Roadmap #1: Launch");
    await page.locator("#auto-cancel").click();
    await frame.locator('button[data-action="open-roadmap"]').click();
    expect(await page.locator("#panel-title").textContent()).toBe("Roadmap #1");
  });
});
