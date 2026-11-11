/** The Claude Code hook that links sessions to changes, and its install (spec: mcp-server). */
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanFolder } from "../../src/adapters/discovery/file-walker.js";
import { installSkills } from "../../src/adapters/storage/skill-installer.js";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import { runSessionLink } from "../../src/cli/mcp-command.js";
import { STATE_LOCK_STALE_MS } from "../../src/core/constants/workflow.js";
import { beginChange, linkSession, stateKey, type WorkflowState } from "../../src/core/workflow.js";
import { makeTempFolder, writeProject } from "../support/helpers.js";

/** No process has this ID: process IDs are far smaller on every supported system. */
const ENDED_PID = 2 ** 30;
const HOOK = { matcher: "mcp__cclinic__.*", hooks: [{ type: "command", command: "npx cclinic session-link" }] };
const SETTINGS = ".claude/settings.json";

const install = async (root: string) =>
  (await installSkills({ target: root, out: path.join(root, ".cclinic/sdd"), isForced: false })).find(
    (entry) => entry.path === SETTINGS,
  )?.status;
const settings = (root: string) => readFileSync(path.join(root, SETTINGS), "utf8");

async function changeForTask(root: string, taskId: number) {
  const store = openWorkflowStore(root);
  const state = beginChange(
    { changeType: "feature", spec: "refunds", taskId },
    { key: stateKey(taskId, "main"), approverMode: "user", now: "2026-11-11T10:00:00.000Z" },
  );
  await store.save(state);
  return store;
}

// Captured once per test, so links that run at the same time all write to the same place.
let printed = "";
beforeEach(() => {
  printed = "";
  vi.spyOn(process.stdout, "write").mockImplementation((text: string | Uint8Array) => {
    printed += String(text);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function link(input: string, environment: NodeJS.ProcessEnv = {}): Promise<void> {
  await runSessionLink(Readable.from([input]), environment);
}

const hookInput = (root: string, sessionId: string) =>
  JSON.stringify({
    session_id: sessionId,
    transcript_path: `/home/me/.claude/projects/p/${sessionId}.jsonl`,
    cwd: root,
    hook_event_name: "PostToolUse",
    tool_name: "mcp__cclinic__workflow_status",
  });

describe(".claude/settings.json", () => {
  it("TC-MCP-069: adds the hook to a new file, next to other settings and hooks, and leaves a changed cclinic hook", async () => {
    const empty = makeTempFolder();
    expect(await install(empty)).toBe("installed");
    expect(JSON.parse(settings(empty))).toEqual({ hooks: { PostToolUse: [HOOK] } });
    expect(await install(empty)).toBe("unchanged");

    const other = makeTempFolder();
    const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] };
    writeProject(other, {
      [SETTINGS]: JSON.stringify({ model: "opus", hooks: { PostToolUse: [theirs], Stop: [theirs] } }),
    });
    expect(await install(other)).toBe("updated");
    expect(JSON.parse(settings(other))).toEqual({
      model: "opus",
      hooks: { PostToolUse: [theirs, HOOK], Stop: [theirs] },
    });

    const reordered = makeTempFolder();
    const sameHook = { hooks: [{ command: HOOK.hooks[0]?.command, type: "command" }], matcher: HOOK.matcher };
    writeProject(reordered, { [SETTINGS]: JSON.stringify({ hooks: { PostToolUse: [sameHook] } }) });
    expect(await install(reordered)).toBe("unchanged");

    for (const unreadable of [
      { model: "opus", hooks: "nope" },
      { hooks: [1, 2] },
      { hooks: { PostToolUse: { matcher: "x" } } },
    ]) {
      const root = makeTempFolder();
      writeProject(root, { [SETTINGS]: JSON.stringify(unreadable) });
      expect(await install(root)).toBe("skipped: not valid JSON");
      expect(JSON.parse(settings(root))).toEqual(unreadable);
    }

    const ownHook = makeTempFolder();
    const logging = { matcher: HOOK.matcher, hooks: [{ type: "command", command: "log-tool-use" }] };
    writeProject(ownHook, { [SETTINGS]: JSON.stringify({ hooks: { PostToolUse: [logging] } }) });
    expect(await install(ownHook)).toBe("updated");
    expect(JSON.parse(settings(ownHook))).toEqual({ hooks: { PostToolUse: [logging, HOOK] } });

    const lookalike = makeTempFolder();
    const linker = { matcher: HOOK.matcher, hooks: [{ type: "command", command: "./scripts/session-linker.sh" }] };
    writeProject(lookalike, { [SETTINGS]: JSON.stringify({ hooks: { PostToolUse: [linker] } }) });
    expect(await install(lookalike)).toBe("updated");
    expect(JSON.parse(settings(lookalike))).toEqual({ hooks: { PostToolUse: [linker, HOOK] } });

    const changed = makeTempFolder();
    const changedHook = { ...HOOK, hooks: [{ type: "command", command: "node ./cclinic.js session-link" }] };
    const mine = JSON.stringify({ hooks: { PostToolUse: [changedHook] } });
    writeProject(changed, { [SETTINGS]: mine });
    expect(await install(changed)).toBe("skipped: not created by cclinic");
    expect(settings(changed)).toBe(mine);
  });

  it("TC-MCP-070: a settings file with only cclinic's hook isn't analysed", async () => {
    const root = makeTempFolder();
    writeProject(root, { "index.ts": "export const a = 1;\n" });
    await install(root);
    const scan = await scanFolder({
      target: root,
      outFolder: path.join(root, ".cclinic/sdd"),
      include: [],
      exclude: [],
      maxFileSizeMib: 1,
    });
    expect(scan.included.map((file) => file.path)).toEqual(["index.ts"]);
  });
});

describe("cclinic session-link", () => {
  it("TC-MCP-071: adds each session once, moves its last-seen time, and prints nothing", async () => {
    const root = makeTempFolder();
    const store = await changeForTask(root, 3);
    await link(hookInput(root, "s1"));
    const [first] = await store.list();
    await link(hookInput(root, "s1"));
    await link(hookInput(root, "s2"));
    const [state] = await store.list();
    expect(state?.sessions.map((session) => session.sessionId)).toEqual(["s1", "s2"]);
    expect(state?.sessions[0]?.transcriptPath).toBe("/home/me/.claude/projects/p/s1.jsonl");
    expect(printed).toBe("");
    expect(state?.sessions[0]?.firstSeenAt).toBe(first?.sessions[0]?.firstSeenAt);
    expect((state?.sessions[0]?.lastSeenAt ?? "") >= (first?.sessions[0]?.lastSeenAt ?? "")).toBe(true);
  });

  it("TC-MCP-071: sessions linked at the same moment are all kept", async () => {
    const root = makeTempFolder();
    const store = await changeForTask(root, 3);
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6"];
    await Promise.all(ids.map((id) => link(hookInput(root, id))));
    const [state] = await store.list();
    expect(state?.sessions.map((session) => session.sessionId).sort()).toEqual(ids);
  });

  it("TC-MCP-071: a lock left by a process that ended is replaced, also when several links race for it", async () => {
    for (let round = 0; round < 10; round += 1) {
      const root = makeTempFolder();
      const store = await changeForTask(root, 3);
      const lock = path.join(root, ".cclinic/workflow/.state.lock");
      writeFileSync(lock, JSON.stringify({ pid: ENDED_PID, owner: "gone" }));
      const ids = Array.from({ length: 12 }, (_, index) => `s${index}`);
      await Promise.all(ids.map((id) => link(hookInput(root, id))));
      expect((await store.list())[0]?.sessions.map((session) => session.sessionId).sort()).toEqual(ids.sort());
      expect(existsSync(lock)).toBe(false);
    }
  });

  it("TC-MCP-071: a lock held for longer than any save takes is replaced, even if its process ID is in use again", async () => {
    const root = makeTempFolder();
    const store = await changeForTask(root, 3);
    const lock = path.join(root, ".cclinic/workflow/.state.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, owner: "long gone" }));
    const old = new Date(Date.now() - STATE_LOCK_STALE_MS - 1_000);
    utimesSync(lock, old, old);
    await link(hookInput(root, "s1"));
    expect((await store.list())[0]?.sessions.map((session) => session.sessionId)).toEqual(["s1"]);
    expect(existsSync(lock)).toBe(false);
  });

  it("TC-MCP-071: a save from an older state never moves a session's times back", async () => {
    const root = makeTempFolder();
    const store = await changeForTask(root, 3);
    const [state] = await store.list();
    if (state === undefined) throw new Error("no change");
    const seen = (first: string, last: string) => ({
      sessionId: "s1",
      transcriptPath: "t",
      firstSeenAt: first,
      lastSeenAt: last,
    });
    await store.save({ ...state, sessions: [seen("2026-11-11T10:00:00.000Z", "2026-11-11T12:00:00.000Z")] });
    await store.save({ ...state, sessions: [seen("2026-11-11T11:00:00.000Z", "2026-11-11T11:00:00.000Z")] });
    expect((await store.list())[0]?.sessions).toEqual([seen("2026-11-11T10:00:00.000Z", "2026-11-11T12:00:00.000Z")]);
  });

  it("TC-MCP-071: the next change on the same task starts with no sessions", async () => {
    const root = makeTempFolder();
    const store = await changeForTask(root, 3);
    await link(hookInput(root, "s1"));
    const [first] = await store.list();
    if (first === undefined) throw new Error("no change");
    await store.save({ ...first, status: "done" });
    const next = beginChange(
      { changeType: "feature", spec: "refunds", taskId: 3 },
      { key: first.key, approverMode: "user", now: "2026-11-12T10:00:00.000Z" },
    );
    await store.save(next);
    expect((await store.list())[0]?.sessions).toEqual([]);
  });

  it("TC-MCP-071: a lock held by a running process is waited for until the deadline, then given up", async () => {
    const root = makeTempFolder();
    const store = await changeForTask(root, 3);
    const lock = path.join(root, ".cclinic/workflow/.state.lock");
    const holder = JSON.stringify({ pid: process.pid, owner: "someone else" });
    writeFileSync(lock, holder);
    const change = (state: WorkflowState) => linkSession(state, { sessionId: "s1", transcriptPath: "t" }, "now");
    await expect(store.updateOpen(change, AbortSignal.timeout(50))).rejects.toThrow("Another cclinic process holds");
    expect((await store.list())[0]?.sessions).toEqual([]);
    expect(readFileSync(lock, "utf8")).toBe(holder);
  });

  it("TC-MCP-071: a session working in a subfolder, or in Claude Code's project folder, is linked to the project's change", async () => {
    const root = makeTempFolder();
    const store = await changeForTask(root, 3);
    mkdirSync(path.join(root, "packages/api"), { recursive: true });
    await link(hookInput(path.join(root, "packages/api"), "s1"));
    await link(hookInput(makeTempFolder(), "s2"), { CLAUDE_PROJECT_DIR: root });
    expect((await store.list())[0]?.sessions.map((session) => session.sessionId)).toEqual(["s1", "s2"]);
  });

  it("TC-MCP-071: a save from a state read before a session was linked keeps that session", async () => {
    const root = makeTempFolder();
    const store = await changeForTask(root, 3);
    const [before] = await store.list();
    if (before === undefined) throw new Error("no change");
    await link(hookInput(root, "s1"));
    await store.save({ ...before, step: "implement" });
    const [after] = await store.list();
    expect(after?.step).toBe("implement");
    expect(after?.sessions.map((session) => session.sessionId)).toEqual(["s1"]);
  });

  it("TC-MCP-072: with no change, invalid input, or a folder it can't write, it changes nothing and doesn't fail", async () => {
    const noChange = makeTempFolder();
    await link(hookInput(noChange, "s1"));
    await link(hookInput(noChange, "s1"), { CLAUDE_PROJECT_DIR: noChange });
    expect(existsSync(path.join(noChange, ".cclinic"))).toBe(false);

    const root = makeTempFolder();
    const store = await changeForTask(root, 3);
    await link("not json");
    await link(JSON.stringify({ cwd: root }));
    expect((await store.list())[0]?.sessions).toEqual([]);

    const folder = path.join(root, ".cclinic/workflow");
    chmodSync(folder, 0o500);
    try {
      await link(hookInput(root, "s9"));
    } finally {
      chmodSync(folder, 0o700);
    }
    expect((await store.list())[0]?.sessions).toEqual([]);
    expect(printed).toBe("");
  });

  it("TC-MCP-071: a state saved before sessions were recorded is read with none", async () => {
    const root = makeTempFolder();
    const store = await changeForTask(root, 4);
    const file = path.join(root, ".cclinic/workflow/task-4.json");
    const older = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete older["sessions"];
    writeProject(root, { ".cclinic/workflow/task-4.json": JSON.stringify(older) });
    expect((await store.list())[0]?.sessions).toEqual([]);
  });
});
