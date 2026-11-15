/** `luseen auto` in-process, on real Git repositories, with a scripted fake `claude`. */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { confirm, select } from "@inquirer/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyUser } from "../../src/adapters/notify/desktop-notifier.js";
import { openTaskStore, tasksDatabaseFile, type TaskStore } from "../../src/adapters/storage/task-store.js";
import { runAutoCommand, type AutoOptions } from "../../src/cli/auto-command.js";
import { runClean } from "../../src/cli/other-commands.js";
import { agentSessionSchema, type RunState } from "../../src/core/automation.js";
import { AUTO_REQUIRED_SKILLS } from "../../src/core/constants/agents.js";
import { exitCodeFor, UsageError } from "../../src/core/errors.js";
import type { RoadmapPlan } from "../../src/core/tasks.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn(), input: vi.fn() }));
const confirmMock = vi.mocked(confirm);
const selectMock = vi.mocked(select);

const isTty = process.stdin.isTTY;
beforeEach(() => {
  process.stdin.isTTY = false;
});
afterEach(() => {
  process.stdin.isTTY = isTty;
  vi.resetAllMocks();
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A committed project with documents and the skills agents need. */
function repository(files: Record<string, string> = {}): string {
  const root = makeTempFolder();
  writeProject(root, {
    "README.md": "# App\n",
    "src/shared.txt": "base\n",
    ".luseen/sdd/README.md": "# Specs\n",
    ...Object.fromEntries(AUTO_REQUIRED_SKILLS.map((skill) => [`.claude/skills/${skill}/SKILL.md`, `# ${skill}\n`])),
    ...files,
  });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "dev@example.com");
  git(root, "config", "user.name", "Dev");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  return root;
}

function openStore(root: string): TaskStore {
  const store = openTaskStore(path.join(root, ".luseen"), "create");
  if (store === undefined) throw new Error("No store");
  return store;
}

const planned = (key: string, dependsOn: (string | number)[] = []) => ({
  key,
  title: `Task ${key}`,
  description: "",
  spec: null,
  dependsOn,
});

function savePlan(root: string, plan: RoadmapPlan) {
  const store = openStore(root);
  const saved = store.savePlan(plan);
  store.close();
  return saved;
}

/** A roadmap with one milestone holding the given tasks. */
function roadmap(root: string, ...tasks: ReturnType<typeof planned>[]) {
  return savePlan(root, {
    roadmap: { title: "Launch", goal: "Ship" },
    milestones: [{ title: "M1", goal: "Start", tasks }],
  });
}

/** Agents that approve everything. Each task's developer writes its own files. */
function happyRules(taskIds: readonly number[], overrides: FakeClaudeRule[] = []): FakeClaudeRule[] {
  return [
    ...overrides,
    ...taskIds.flatMap((id): FakeClaudeRule[] => [
      {
        match: `developer agent.*Task #${id}:.*## Stage: spec`,
        times: 0,
        write: { [`.luseen/sdd/specs/t${id}.md`]: `# t${id}\n` },
      },
      {
        match: `developer agent.*Task #${id}:.*## Stage: (implement|fix)`,
        times: 0,
        write: { [`src/t${id}.txt`]: `task ${id}\n` },
      },
    ]),
    { match: "QA agent", times: 0, output: { result: "pass", failures: [], summary: "ok" } },
    { match: "reviewing a spec change", times: 0, output: { verdict: "approve", feedback: "" } },
    {
      match: "reviewing finished work",
      times: 0,
      output: { verdict: "approve", feedback: "", requirementIds: ["FR-CORE-001"] },
    },
  ];
}

async function auto(root: string, harness: ReturnType<typeof agentHarness>, options: Partial<AutoOptions> = {}) {
  return runAutoCommand(
    {
      dir: root,
      roadmap: 1,
      developers: 2,
      timeoutMinutes: 30,
      yes: true,
      model: "haiku",
      effort: "low",
      ...options,
    },
    harness.context,
  );
}

function runFolderOf(root: string): string {
  const folder = path.join(root, ".luseen/auto");
  const [runId] = readdirSync(folder).filter((name) => name !== ".lock");
  return path.join(folder, runId ?? "");
}

describe("luseen auto on a real repository", () => {
  it("TC-AUTO-001: the whole roadmap runs; done, other-roadmap and unplanned tasks don't; in-progress ones are left alone", async () => {
    const root = repository();
    savePlan(root, {
      roadmap: { title: "Launch", goal: "" },
      milestones: [
        { title: "M1", goal: "", tasks: [planned("a"), planned("b")] },
        { title: "M2", goal: "", tasks: [planned("c"), planned("d"), planned("e")] },
      ],
    });
    savePlan(root, {
      roadmap: { title: "Other", goal: "" },
      milestones: [{ title: "X", goal: "", tasks: [planned("f")] }],
    });
    const store = openStore(root);
    store.setStatus(3, "blocked");
    store.setStatus(4, "done");
    store.setStatus(5, "in-progress");
    store.addTask({ title: "No milestone" });
    store.close();
    const harness = agentHarness({ rules: happyRules([1, 2, 3]) });
    expect(await auto(root, harness)).toBe(0);
    const worked = new Set(harness.calls().map((call) => Number(/Task #(\d+):/.exec(call.prompt)?.[1])));
    expect([...worked].sort()).toEqual([1, 2, 3]);
    const after = openStore(root);
    expect(after.getTask(5)?.status).toBe("in-progress");
    expect(after.getTask(6)?.status).toBe("open");
    expect(after.getTask(7)?.status).toBe("open");
    after.close();
    expect(readFileSync(path.join(runFolderOf(root), "report.md"), "utf8")).toContain("#5 Task e");
  });

  it("TC-AUTO-004, TC-AUTO-016, TC-AUTO-018: branches, worktrees and commits, with untracked files left alone", async () => {
    const root = repository();
    writeFileSync(path.join(root, "notes.txt"), "mine\n");
    roadmap(root, planned("a"), planned("b"));
    const start = git(root, "rev-parse", "main");
    const harness = agentHarness({ rules: happyRules([1, 2]) });
    expect(await auto(root, harness)).toBe(0);
    const runId = path.basename(runFolderOf(root));
    const runBranch = `luseen/auto/${runId}/run`;
    expect(git(root, "merge-base", runBranch, "main")).toBe(start);
    for (const id of [1, 2]) {
      const branch = `luseen/auto/${runId}/task-${id}`;
      expect(git(root, "log", "-1", "--format=%B", branch)).toBe(
        `#${id} Task ${String.fromCharCode(96 + id)}\n\nRequirements: FR-CORE-001`,
      );
      expect(git(root, "show", "--name-only", "--format=", branch)).toContain(`src/t${id}.txt`);
    }
    const merges = git(root, "log", "--merges", "--format=%P", runBranch).split("\n");
    expect(merges).toHaveLength(2);
    for (const parents of merges) expect(parents.split(" ")).toHaveLength(2);
    for (const call of harness.calls()) {
      const id = /Task #(\d+):/.exec(call.prompt)?.[1];
      expect(path.basename(call.cwd)).toBe(`task-${id}`);
      expect(call.cwd).toContain(path.join(".luseen/auto", runId, "worktrees"));
    }
    expect(readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("mine\n");
    expect(git(root, "log", "--all", "--name-only", "--format=")).not.toContain("notes.txt");
  });

  it("TC-AUTO-017: the user's branch, index and status are unchanged, and nothing is pushed", async () => {
    const root = repository();
    const remote = makeTempFolder();
    git(remote, "init", "-q", "--bare");
    git(root, "remote", "add", "origin", remote);
    writeFileSync(path.join(root, "staged.txt"), "staged\n");
    git(root, "add", "staged.txt");
    roadmap(root, planned("a"));
    const before = {
      head: git(root, "rev-parse", "main"),
      branch: git(root, "branch", "--show-current"),
      status: git(root, "status", "--porcelain"),
    };
    expect(await auto(root, agentHarness({ rules: happyRules([1]) }), { yes: true })).toBe(0);
    expect(git(root, "rev-parse", "main")).toBe(before.head);
    expect(git(root, "branch", "--show-current")).toBe(before.branch);
    expect(git(root, "status", "--porcelain")).toBe(before.status);
    expect(git(remote, "for-each-ref")).toBe("");
    const branches = git(root, "branch", "--format=%(refname:short)").split("\n");
    expect(branches.filter((branch) => branch !== "main").every((branch) => branch.startsWith("luseen/auto/"))).toBe(
      true,
    );
  });

  it("TC-AUTO-050: a committed tasks.db doesn't stop the next run, and is the only tracked change", async () => {
    const root = repository();
    roadmap(root, planned("a"), planned("b"));
    git(root, "add", "-f", ".luseen/tasks.db");
    git(root, "commit", "-q", "-m", "share the roadmap");
    expect(await auto(root, agentHarness({ rules: happyRules([1]) }), { developers: 1 })).not.toBe(2);
    const store = openStore(root);
    store.setStatus(2, "open");
    store.close();
    expect(await auto(root, agentHarness({ rules: happyRules([2]) }))).toBe(0);
    expect(git(root, "status", "--porcelain", "--untracked-files=no")).toBe("M .luseen/tasks.db");
  });

  it("TC-AUTO-009: a dependent task's branch starts from the run branch with its dependency merged", async () => {
    const root = repository();
    roadmap(root, planned("a"), planned("b", ["a"]));
    expect(await auto(root, agentHarness({ rules: happyRules([1, 2]) }))).toBe(0);
    const runId = path.basename(runFolderOf(root));
    expect(git(root, "show", `luseen/auto/${runId}/task-2:src/t1.txt`)).toBe("task 1");
  });

  it("TC-AUTO-010: a task whose dependency is already done starts at once", async () => {
    const root = repository();
    roadmap(root, planned("a"), planned("b", ["a"]));
    const store = openStore(root);
    store.setStatus(1, "done");
    store.close();
    const harness = agentHarness({ rules: happyRules([2]) });
    expect(await auto(root, harness)).toBe(0);
    expect(harness.calls()[0]?.prompt).toContain("Task #2:");
  });

  it("TC-AUTO-019: a merge conflict blocks one task and leaves the run branch clean", async () => {
    const root = repository();
    roadmap(root, planned("a"), planned("b"));
    const rules = happyRules(
      [1, 2],
      [1, 2].map((id) => ({
        match: `developer agent.*Task #${id}:.*## Stage: implement`,
        times: 0,
        write: { "src/shared.txt": `from ${id}\n` },
      })),
    );
    expect(await auto(root, agentHarness({ rules }))).toBe(1);
    const state = JSON.parse(readFileSync(path.join(runFolderOf(root), "run.json"), "utf8")) as {
      tasks: { status: string; reason: string | null }[];
    };
    expect(state.tasks.map((item) => item.status).sort()).toEqual(["blocked", "done"]);
    expect(state.tasks.find((item) => item.status === "blocked")?.reason).toContain("src/shared.txt");
    const runBranch = `luseen/auto/${path.basename(runFolderOf(root))}/run`;
    expect(git(root, "show", `${runBranch}:src/shared.txt`)).not.toContain("<<<<<<<");
  });

  it("TC-AUTO-020, TC-AUTO-045: worktrees are removed, branches kept, and a blocked task is retried later on a new branch", async () => {
    const root = repository();
    roadmap(root, planned("a"), planned("b"));
    const failingQa: FakeClaudeRule = {
      match: "QA agent.*Task #2:",
      times: 0,
      output: { result: "fail", failures: [{ testCase: "TC-X-1", output: "no" }], summary: "bad" },
    };
    expect(await auto(root, agentHarness({ rules: happyRules([1, 2], [failingQa]) }))).toBe(1);
    expect(git(root, "worktree", "list").split("\n")).toHaveLength(1);
    const firstRun = path.basename(runFolderOf(root));
    const blocked = `luseen/auto/${firstRun}/task-2`;
    expect(git(root, "log", "-1", "--format=%s", blocked)).toContain("WIP");
    const oldTip = git(root, "rev-parse", blocked);
    const store = openStore(root);
    expect(store.getTask(2)?.status).toBe("blocked");
    store.close();
    const harness = agentHarness({ rules: happyRules([2]) });
    expect(await auto(root, harness)).toBe(0);
    const runs = readdirSync(path.join(root, ".luseen/auto")).filter((name) => name !== ".lock" && name !== firstRun);
    expect(git(root, "rev-parse", "--verify", `luseen/auto/${runs[0]}/task-2`)).not.toBe("");
    expect(git(root, "rev-parse", blocked)).toBe(oldTip);
  });

  it("TC-AUTO-022: developers and QA can write and build in their worktree; the PM only reads; none can use Git", async () => {
    const root = repository();
    roadmap(root, planned("a"));
    const harness = agentHarness({ rules: happyRules([1]) });
    await auto(root, harness);
    const between = (args: readonly string[], from: string, to: string) =>
      args.slice(args.indexOf(from) + 1, args.indexOf(to));
    for (const call of harness.calls()) {
      const isPm = call.prompt.includes("You are the PM agent");
      const tools = between(call.args, "--tools", "--allowedTools");
      const allowed = between(call.args, "--allowedTools", "--disallowedTools");
      const denied = between(call.args, "--disallowedTools", "--permission-mode");
      expect(denied).toEqual(expect.arrayContaining(["Bash(git *)", "Bash(sudo *)", "Read(**/.env)"]));
      if (isPm) {
        expect(tools).toEqual(["Read", "Glob", "Grep"]);
      } else {
        expect(tools).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
        expect(allowed).toEqual(expect.arrayContaining(["Write(./**)", "Edit(./**)", "Bash(npm *)"]));
      }
      expect(call.args).toContain("--safe-mode");
    }
  });

  it("TC-AUTO-021: every agent call is non-interactive, keeps its own session, uses the run's model and effort, and passes no dollar limit", async () => {
    const root = repository();
    roadmap(root, planned("a"));
    const harness = agentHarness({ rules: happyRules([1]).map((rule) => ({ ...rule, cost: 0.5 })) });
    expect(await auto(root, harness, { model: "sonnet", effort: "high", developers: 1 })).toBe(0);
    const calls = harness.calls();
    expect(calls).toHaveLength(5);
    const after = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1];
    calls.forEach((call) => {
      expect(call.args[0]).toBe("-p");
      expect(after(call.args, "--permission-mode")).toBe("dontAsk");
      expect(call.args).toContain("--safe-mode");
      expect(call.args).not.toContain("--no-session-persistence");
      expect(after(call.args, "--session-id")).toMatch(/^[0-9a-f-]{36}$/);
      expect(after(call.args, "--model")).toBe("sonnet");
      expect(after(call.args, "--effort")).toBe("high");
      expect(call.args).not.toContain("--max-budget-usd");
    });
    expect(new Set(calls.map((call) => after(call.args, "--session-id"))).size).toBe(calls.length);
  });

  it("TC-AUTO-057: each agent call has a session file with its task, role, step, folder and transcript, and no prompt or output", async () => {
    const root = repository();
    roadmap(root, planned("a"), planned("b"));
    const harness = agentHarness({ rules: happyRules([1, 2]) });
    expect(await auto(root, harness, { developers: 1 })).toBe(0);
    const folder = path.join(runFolderOf(root), "sessions");
    const calls = harness.calls();
    const ids = calls.map((call) => call.args[call.args.indexOf("--session-id") + 1]);
    expect(readdirSync(folder).sort()).toEqual(ids.map((id) => `${id}.json`).sort());
    const home = harness.environment["HOME"] ?? "";
    for (const [index, call] of calls.entries()) {
      const text = readFileSync(path.join(folder, `${ids[index]}.json`), "utf8");
      const session = agentSessionSchema.parse(JSON.parse(text));
      expect(session.taskId).toBe(Number(/Task #(\d+):/.exec(call.prompt)?.[1]));
      expect(["developer", "pm", "qa"]).toContain(session.role);
      expect(session.step).toMatch(/^[a-z-]+-\d+$/);
      // The worktree is gone by now, so the real path is worked out from the project's.
      expect(path.join(realpathSync(root), path.relative(root, session.cwd))).toBe(call.cwd);
      const projectFolder = call.cwd.replace(/[^a-zA-Z0-9]/g, "-");
      expect(session.transcriptPath).toBe(
        path.join(home, ".claude", "projects", projectFolder, `${session.sessionId}.jsonl`),
      );
      expect(session.endedAt).not.toBeNull();
      expect(session.exitCode).toBe(0);
      expect(text).not.toContain(call.prompt.slice(0, 40));
      expect(text).not.toContain("Done.");
    }
  });

  it("TC-AUTO-058: the session file exists before the agent starts, and a crashed agent gets its end time and exit code", async () => {
    const root = repository();
    roadmap(root, planned("a"));
    const crash: FakeClaudeRule = { match: "QA agent", times: 1, exitCode: 3 };
    const harness = agentHarness({ rules: happyRules([1], [crash]) });
    await auto(root, harness);
    const calls = harness.calls();
    expect(calls.every((call) => call.sessionRecorded === true)).toBe(true);
    const sessions = readdirSync(path.join(runFolderOf(root), "sessions")).map((name) =>
      agentSessionSchema.parse(JSON.parse(readFileSync(path.join(runFolderOf(root), "sessions", name), "utf8"))),
    );
    const crashed = sessions.find((session) => session.role === "qa" && session.exitCode !== 0);
    expect(crashed?.exitCode).toBe(3);
    expect(crashed?.endedAt).not.toBeNull();
  });

  it("TC-AUTO-060: a session file records the cost the agent reported, or null when it reported none", async () => {
    const root = repository();
    roadmap(root, planned("a"));
    const priced: FakeClaudeRule = {
      match: "reviewing a spec change",
      times: 1,
      cost: 0.12,
      output: { verdict: "approve", feedback: "" },
    };
    const crash: FakeClaudeRule = { match: "QA agent", times: 1, exitCode: 3, silent: true };
    const harness = agentHarness({ rules: happyRules([1], [priced, crash]) });
    await auto(root, harness);
    const folder = path.join(runFolderOf(root), "sessions");
    const sessions = readdirSync(folder).map((name) =>
      agentSessionSchema.parse(JSON.parse(readFileSync(path.join(folder, name), "utf8"))),
    );
    expect(sessions.find((session) => session.step === "spec-review-1")?.costUsd).toBe(0.12);
    const crashed = sessions.find((session) => session.step === "qa-1");
    expect(crashed).toMatchObject({ costUsd: null, exitCode: 3 });
    expect(crashed?.endedAt).not.toBeNull();
  });

  it("TC-AUTO-032, TC-AUTO-033: run.json, logs and the report are written, with secrets redacted", async () => {
    const root = repository();
    roadmap(root, planned("a"));
    const secret: FakeClaudeRule = {
      match: "developer agent.*## Stage: spec",
      times: 0,
      message: "Set ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 to run it.",
    };
    await auto(root, agentHarness({ rules: happyRules([1], [secret]) }));
    const folder = runFolderOf(root);
    const state = JSON.parse(readFileSync(path.join(folder, "run.json"), "utf8")) as {
      tasks: Record<string, unknown>[];
    };
    expect(state.tasks[0]).toMatchObject({
      status: "done",
      rounds: { specReviews: 1, qaRuns: 1, implementationReviews: 1 },
    });
    expect(state.tasks[0]?.branch).toContain("task-1");
    const logs = readdirSync(path.join(folder, "logs"));
    expect(logs).toEqual(expect.arrayContaining(["task-1-spec-1.txt", "task-1-qa-1.txt", "task-1-review-1.txt"]));
    for (const file of [...logs.map((name) => path.join("logs", name)), "run.json", "report.md"]) {
      expect(readFileSync(path.join(folder, file), "utf8"), file).not.toContain("sk-ant-api03-abcdefghijklmnop");
    }
    const report = readFileSync(path.join(folder, "report.md"), "utf8");
    for (const part of ["Roadmap: #1 Launch", "Outcome: completed", "git merge luseen/auto/"])
      expect(report).toContain(part);
  });

  it("TC-AUTO-061: a dry run prints the plan as JSON and starts nothing", async () => {
    const root = repository();
    roadmap(root, planned("a"), planned("b", ["a"]));
    const harness = agentHarness({ rules: happyRules([1, 2]) });
    const branchesBefore = git(root, "branch", "--list");
    expect(await auto(root, harness, { dryRun: true, json: true, yes: false })).toBe(0);
    const result = JSON.parse(harness.output.out.trim()) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "plan", roadmapId: 1, runnable: [1, 2], blocked: [] });
    expect(result["plan"]).toContain("Roadmap #1: Launch");
    expect(harness.calls()).toEqual([]);
    expect(existsSync(path.join(root, ".luseen/auto"))).toBe(false);
    expect(git(root, "branch", "--list")).toBe(branchesBefore);
  });

  it("TC-AUTO-062: a dry run is refused for the same reasons as a run, with the same message, creating nothing", async () => {
    const root = repository();
    roadmap(root, planned("a"));
    writeProject(root, { "src/shared.txt": "changed\n" });
    const real = await auto(root, agentHarness()).catch((caught: unknown) => caught);
    const dry = await auto(root, agentHarness(), { dryRun: true }).catch((caught: unknown) => caught);
    expect(dry).toBeInstanceOf(UsageError);
    expect((dry as Error).message).toBe((real as Error).message);

    const locked = repository();
    roadmap(locked, planned("a"));
    writeProject(locked, { ".luseen/auto/.lock": JSON.stringify({ pid: process.pid, runId: "20261112-100000" }) });
    const refused = await auto(locked, agentHarness(), { dryRun: true }).catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as Error).message).toContain("Automated run 20261112-100000");
    expect(readdirSync(path.join(locked, ".luseen/auto"))).toEqual([".lock"]);
  });

  it("TC-AUTO-062: a dry run refuses a model the run would refuse, without opening a menu", async () => {
    const root = repository();
    roadmap(root, planned("a"));
    // No --model or --effort, so the run reads them from the environment.
    const run = (dryRun: boolean) =>
      runAutoCommand(
        { dir: root, roadmap: 1, developers: 1, timeoutMinutes: 30, yes: true, dryRun },
        agentHarness({ env: { LUSEEN_MODEL: "not-a-model" } }).context,
      ).catch((caught: unknown) => caught);
    const dry = await run(true);
    const real = await run(false);
    expect(dry).toBeInstanceOf(UsageError);
    expect((dry as Error).message).toBe((real as Error).message);
    expect(existsSync(path.join(root, ".luseen/auto"))).toBe(false);
  });

  it("TC-AUTO-063: Claude's plan limits are saved in the user config folder, and a malformed report changes nothing", async () => {
    const limitEvent = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1794532800,
        unifiedWindows: {
          five_hour: { utilization: 0.25, resetsAt: 1794532800, status: "allowed" },
          seven_day: { utilization: 0.4, resetsAt: 1794927600, status: "allowed" },
        },
      },
    };
    const root = repository();
    roadmap(root, planned("a"));
    const harness = agentHarness({ rules: happyRules([1]).map((rule) => ({ ...rule, events: [limitEvent] })) });
    expect(await auto(root, harness)).toBe(0);
    const file = path.join(harness.environment["XDG_CONFIG_HOME"] ?? "", "luseen", "limits.json");
    const saved = readFileSync(file, "utf8");
    expect(JSON.parse(saved)).toMatchObject({
      status: "allowed",
      session: { used: 0.25, resetsAt: new Date(1794532800 * 1000).toISOString() },
      week: { used: 0.4, resetsAt: new Date(1794927600 * 1000).toISOString() },
    });
    expect(saved).not.toContain("Task #1");

    const again = repository();
    roadmap(again, planned("a"));
    const malformed = { type: "rate_limit_event", rate_limit_info: { status: 7 } };
    const second = agentHarness({
      rules: happyRules([1]).map((rule) => ({ ...rule, events: [malformed] })),
      env: { XDG_CONFIG_HOME: harness.environment["XDG_CONFIG_HOME"] ?? "" },
    });
    expect(await auto(again, second)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(saved);
  });

  it("TC-AUTO-030: a plan usage limit ends the run limit-reached, with the reset time in the report, exit 1", async () => {
    const resetsAt = 1794532800;
    const rejected = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt,
        unifiedWindows: { five_hour: { utilization: 1, resetsAt, status: "rejected" } },
      },
    };
    const root = repository();
    roadmap(root, planned("a"), planned("b"), planned("c"));
    const limit: FakeClaudeRule = {
      match: "reviewing a spec change",
      times: 1,
      events: [rejected],
      exitCode: 1,
      message: "You've hit your session limit · resets 4am",
    };
    const harness = agentHarness({ rules: happyRules([1, 2, 3], [limit]) });
    expect(await auto(root, harness, { developers: 1 })).toBe(1);
    const state = JSON.parse(readFileSync(path.join(runFolderOf(root), "run.json"), "utf8")) as RunState;
    expect(state.outcome).toBe("limit-reached");
    expect(state.tasks.map((item) => item.status)).toEqual(["open", "open", "open"]);
    expect(harness.calls()).toHaveLength(2);
    const report = readFileSync(path.join(runFolderOf(root), "report.md"), "utf8");
    expect(report).toContain(`It resets ${new Date(resetsAt * 1000).toISOString()}`);
    expect(report).not.toContain("$");
  });

  it("FR-AUTO-025: a plain HTTP 429 with no usage-limit message or event fails the round, not the run", async () => {
    const root = repository();
    roadmap(root, planned("a"), planned("b"));
    const throttled: FakeClaudeRule = {
      match: "reviewing a spec change",
      times: 1,
      exitCode: 1,
      apiErrorStatus: 429,
      message: "API Error: 429 rate_limit_error",
    };
    const harness = agentHarness({ rules: happyRules([1, 2], [throttled]) });
    await auto(root, harness, { developers: 1 });
    const state = JSON.parse(readFileSync(path.join(runFolderOf(root), "run.json"), "utf8")) as RunState;
    expect(state.outcome).not.toBe("limit-reached");
    expect(state.limitResetsAt).toBeNull();
    expect(state.tasks[1]?.status).toBe("done");
  });

  it("TC-AUTO-039: a lock left by a process that has ended is replaced", async () => {
    const root = repository();
    roadmap(root, planned("a"));
    writeProject(root, { ".luseen/auto/.lock": JSON.stringify({ pid: 999_999_999, runId: "old" }) });
    expect(await auto(root, agentHarness({ rules: happyRules([1]) }))).toBe(0);
  });

  it("TC-AUTO-040: luseen clean keeps run folders", async () => {
    const root = repository();
    roadmap(root, planned("a"));
    await auto(root, agentHarness({ rules: happyRules([1]) }));
    const report = path.join(runFolderOf(root), "report.md");
    const before = readFileSync(report, "utf8");
    const harness = agentHarness();
    await runClean(root, { yes: true }, harness.context);
    expect(readFileSync(report, "utf8")).toBe(before);
  });

  it("TC-AUTO-005: a dependency cycle exits 2, naming the tasks, before anything starts", async () => {
    const root = repository();
    roadmap(root, planned("a"), planned("b", ["a"]), planned("c", ["b"]));
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(tasksDatabaseFile(path.join(root, ".luseen")));
    database.exec("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (1, 3)");
    database.close();
    const harness = agentHarness();
    const error = await auto(root, harness).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    expect(String(error)).toContain("#1 -> #3 -> #2 -> #1");
    expect(harness.calls()).toEqual([]);
    expect(existsSync(path.join(root, ".luseen/auto"))).toBe(false);
  });

  it("TC-AUTO-006: a task depending on an unfinished task in another roadmap is blocked before the run", async () => {
    const root = repository();
    savePlan(root, {
      roadmap: { title: "Other", goal: "" },
      milestones: [{ title: "X", goal: "", tasks: [planned("x")] }],
    });
    savePlan(root, {
      roadmap: { title: "Launch", goal: "" },
      milestones: [{ title: "M", goal: "", tasks: [planned("a", [1])] }],
    });
    const harness = agentHarness({ rules: happyRules([2]) });
    expect(await auto(root, harness, { roadmap: 2 })).toBe(1);
    expect(harness.calls()).toEqual([]);
    expect(harness.output.out).toContain("#2 Task a: skipped (Blocked by task #1");
  });

  it("TC-AUTO-008: without --yes, the plan is shown and declining starts nothing", async () => {
    const root = repository();
    roadmap(root, planned("a"), planned("b", ["a"]));
    process.stdin.isTTY = true;
    confirmMock.mockResolvedValueOnce(false);
    const harness = agentHarness();
    const error = await auto(root, harness, { yes: false }).catch((caught: unknown) => caught);
    expect(exitCodeFor(error)).toBe(2);
    for (const part of ["Roadmap #1: Launch", "#2 Task b (after #1)", "Run branch: luseen/auto/", "Developers: 2"]) {
      expect(harness.output.err, part).toContain(part);
    }
    expect(git(root, "branch", "--list", "luseen/*")).toBe("");
  });

  it("TC-AUTO-042: without --roadmap, the menu lists roadmaps and the chosen one runs", async () => {
    const root = repository();
    roadmap(root, planned("a"));
    savePlan(root, {
      roadmap: { title: "Second", goal: "" },
      milestones: [{ title: "X", goal: "", tasks: [planned("b"), planned("c")] }],
    });
    process.stdin.isTTY = true;
    selectMock.mockResolvedValueOnce(2);
    const harness = agentHarness({ rules: happyRules([2, 3]) });
    expect(
      await runAutoCommand(
        { dir: root, developers: 2, timeoutMinutes: 30, model: "haiku", effort: "low", yes: true },
        harness.context,
      ),
    ).toBe(0);
    const menu = selectMock.mock.calls[0]?.[0] as unknown as { choices: { name: string }[] };
    expect(menu.choices.map((choice) => choice.name)).toEqual([
      "#1 Launch [planned] - 1 tasks to run",
      "#2 Second [planned] - 2 tasks to run",
    ]);
    expect(harness.output.out).toContain("#2 Task b: done");
  });
});

describe("notifications", () => {
  function notifier(name: string, exitCode = 0) {
    const bin = makeTempFolder();
    const record = path.join(bin, "calls.txt");
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$@" >> "${record}"\nexit ${exitCode}\n`);
    chmodSync(path.join(bin, name), 0o755);
    return { environment: { PATH: `${bin}:/usr/bin:/bin` }, record };
  }

  const message = { title: "luseen: Launch", message: "Run completed: 2 done, 0 blocked." };

  it("TC-AUTO-034: macOS uses osascript, Linux notify-send, and otherwise the terminal bell", async () => {
    const mac = notifier("osascript");
    expect(
      await notifyUser({
        ...message,
        platform: "darwin",
        environment: mac.environment,
        writeTerminal: () => undefined,
      }),
    ).toBe("osascript");
    expect(readFileSync(mac.record, "utf8")).toContain("Run completed: 2 done, 0 blocked.");
    const linux = notifier("notify-send");
    expect(
      await notifyUser({
        ...message,
        platform: "linux",
        environment: linux.environment,
        writeTerminal: () => undefined,
      }),
    ).toBe("notify-send");
    expect(readFileSync(linux.record, "utf8")).toContain("luseen: Launch");
    let written = "";
    expect(
      await notifyUser({
        ...message,
        platform: "linux",
        environment: { PATH: makeTempFolder() },
        writeTerminal: (text) => (written += text),
      }),
    ).toBe("terminal");
    expect(written).toBe("\u0007luseen: Launch: Run completed: 2 done, 0 blocked.\n");
  });

  it("TC-AUTO-035: a failing notifier falls back to the terminal, without failing", async () => {
    const broken = notifier("osascript", 1);
    let written = "";
    expect(
      await notifyUser({
        ...message,
        platform: "darwin",
        environment: broken.environment,
        writeTerminal: (text) => (written += text),
      }),
    ).toBe("terminal");
    expect(written).toContain("Run completed");
  });
});
