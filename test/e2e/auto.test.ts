/** `cclinic auto` through the built binary, with a scripted fake `claude`. */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { AUTO_REQUIRED_SKILLS } from "../../src/core/constants/agents.js";
import { makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

function git(root: string, ...args: string[]): string {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();
}

function environment(
  rules: readonly FakeClaudeRule[],
  options: { withClaude?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  const bin = makeTempFolder();
  symlinkSync(process.execPath, path.join(bin, "node"));
  if (options.withClaude !== false) {
    copyFileSync(path.join(REPO, "test/fixtures/fake-claude/claude"), path.join(bin, "claude"));
    chmodSync(path.join(bin, "claude"), 0o755);
  }
  const work = makeTempFolder();
  const script = path.join(work, "script.json");
  writeFileSync(script, JSON.stringify(rules));
  const home = makeTempFolder();
  return {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, "c"),
      FAKE_CLAUDE_SCRIPT: script,
      FAKE_CLAUDE_RECORD: path.join(work, "calls.jsonl"),
      FAKE_CLAUDE_PIDS: path.join(work, "pids"),
      ...options.env,
    },
    record: path.join(work, "calls.jsonl"),
    pids: path.join(work, "pids"),
  };
}

function cclinic(args: readonly string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [path.join(REPO, "bin/cclinic.js"), ...args], {
    encoding: "utf8",
    env,
    input: "",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function project(taskCount = 1): string {
  const root = makeTempFolder();
  writeProject(root, {
    "src/app.txt": "app\n",
    ".cclinic/sdd/README.md": "# Specs\n",
    ...Object.fromEntries(AUTO_REQUIRED_SKILLS.map((skill) => [`.claude/skills/${skill}/SKILL.md`, `# ${skill}\n`])),
  });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "dev@example.com");
  git(root, "config", "user.name", "Dev");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  const store = openTaskStore(path.join(root, ".cclinic"), "create");
  store?.savePlan({
    roadmap: { title: "Launch", goal: "Ship" },
    milestones: [
      {
        title: "M",
        goal: "",
        tasks: Array.from({ length: taskCount }, (_unused, index) => ({
          key: `t${index + 1}`,
          title: `Task ${index + 1}`,
          description: "",
          spec: null,
          dependsOn: [],
        })),
      },
    ],
  });
  store?.close();
  return root;
}

const approving: FakeClaudeRule[] = [
  { match: "developer agent", times: 0 },
  { match: "QA agent", times: 0, output: { result: "pass", failures: [], summary: "ok" } },
  { match: "reviewing a spec change", times: 0, output: { verdict: "approve", feedback: "" } },
  { match: "reviewing finished work", times: 0, output: { verdict: "approve", feedback: "", requirementIds: [] } },
];

const base = (root: string): string[] => ["auto", "-C", root, "--roadmap", "1", "--yes"];

describe("cclinic auto", () => {
  it("TC-AUTO-002, TC-AUTO-064: invalid options, and the removed --max-budget-usd, exit 2, and nothing starts", () => {
    const root = project();
    const { env, record } = environment(approving);
    for (const args of [
      ["--developers", "0"],
      ["--developers", "9"],
      ["--max-budget-usd", "5"],
      ["--roadmap", "abc"],
    ]) {
      const result = cclinic([...base(root), ...args], env);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr).toContain(args[0]);
    }
    const unknown = cclinic([...base(root), "--roadmap", "99"], env);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Roadmap 99");
    expect(existsSync(record)).toBe(false);
    expect(git(root, "branch", "--list", "cclinic/*")).toBe("");
  });

  it("TC-AUTO-003: each failed check exits 2, names it, and creates nothing", () => {
    const cases: [string, (root: string) => NodeJS.ProcessEnv | undefined, string][] = [
      ["provider", () => ({ CCLINIC_PROVIDER: "anthropic-api" }), "CCLINIC_PROVIDER"],
      ["no claude", () => undefined, "Install Claude Code"],
      [
        "not a repository",
        (root) => (rmSync(path.join(root, ".git"), { recursive: true }), undefined),
        "isn't a Git repository",
      ],
      [
        "tracked change",
        (root) => (writeFileSync(path.join(root, "src/app.txt"), "changed\n"), undefined),
        "uncommitted changes",
      ],
      [
        "skills",
        (root) => {
          git(root, "rm", "-rq", ".claude");
          git(root, "commit", "-qm", "drop skills");
          return undefined;
        },
        "cclinic skills",
      ],
      [
        "nothing to run",
        (root) => {
          const store = openTaskStore(path.join(root, ".cclinic"), "update");
          store?.setStatus(1, "done");
          store?.close();
          return undefined;
        },
        "no open or blocked tasks",
      ],
    ];
    for (const [name, change, message] of cases) {
      const root = project();
      const extra = change(root);
      const { env, record } = environment(approving, {
        withClaude: name !== "no claude",
        ...(extra === undefined ? {} : { env: extra }),
      });
      const result = cclinic(base(root), env);
      expect(result.code, name).toBe(2);
      expect(result.stderr, name).toContain(message);
      expect(existsSync(record), name).toBe(false);
      expect(existsSync(path.join(root, ".cclinic/auto")), name).toBe(false);
    }
  });

  it("TC-AUTO-007: with no terminal and no --yes, it exits 2", () => {
    const root = project();
    const { env } = environment(approving);
    const result = cclinic(["auto", "-C", root, "--roadmap", "1"], env);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--yes");
  });

  it("TC-AUTO-036, TC-AUTO-064: with no budget, --json prints one document, exit 0 when all is done, 1 when a task is blocked", () => {
    const done = project();
    const ok = cclinic([...base(done), "--json"], environment(approving).env);
    expect(ok.code).toBe(0);
    expect(ok.stdout).not.toContain("costUsd");
    const parsed = JSON.parse(ok.stdout) as {
      outcome: string;
      runBranch: string;
      report: string;
      tasks: { status: string }[];
    };
    expect(parsed).toMatchObject({ outcome: "completed" });
    expect(parsed.runBranch).toMatch(/^cclinic\/auto\/\d{8}-\d{6}\/run$/);
    expect(existsSync(parsed.report)).toBe(true);
    expect(parsed.tasks.map((task) => task.status)).toEqual(["done"]);

    const blocked = project();
    const failing = [
      { match: "QA agent", times: 0, output: { result: "fail", failures: [], summary: "no" } },
      ...approving,
    ];
    const partial = cclinic([...base(blocked), "--json"], environment(failing).env);
    expect(partial.code).toBe(1);
    expect(JSON.parse(partial.stdout)).toMatchObject({ outcome: "partial", tasks: [{ status: "blocked" }] });

    const usage = cclinic([...base(blocked), "--json", "--developers", "0"], environment(approving).env);
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.stdout)).toMatchObject({ status: "error", exitCode: 2 });
  });

  it("TC-AUTO-043, TC-AUTO-044: without --roadmap and a terminal, it lists the roadmaps or points to cclinic plan", () => {
    const root = project();
    const store = openTaskStore(path.join(root, ".cclinic"), "update");
    store?.savePlan({ roadmap: { title: "Second", goal: "" }, milestones: [] });
    store?.close();
    const { env } = environment(approving);
    const listed = cclinic(["auto", "-C", root, "--yes"], env);
    expect(listed.code).toBe(2);
    expect(listed.stderr).toContain("Roadmaps: 1, 2");
    expect(listed.stderr).toContain("cclinic tasks roadmaps");
    const empty = project();
    const removing = openTaskStore(path.join(empty, ".cclinic"), "update");
    removing?.removeRoadmap(1);
    removing?.close();
    const none = cclinic(["auto", "-C", empty, "--yes"], env);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("cclinic plan");
  });

  it("TC-AUTO-049: --task is not an option", () => {
    const root = project();
    const result = cclinic(["auto", "-C", root, "--task", "1", "--yes"], environment(approving).env);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown option");
  });

  it("TC-AUTO-038: a second run on the same project exits 2 and names the first", async () => {
    const root = project();
    const slow = [{ match: "developer agent", times: 0, delayMs: 3000 }, ...approving];
    const first = environment(slow);
    const running = spawn(process.execPath, [path.join(REPO, "bin/cclinic.js"), ...base(root)], { env: first.env });
    const finished = new Promise<number | null>((resolve) => running.on("close", resolve));
    await waitFor(() => existsSync(first.pids));
    const second = cclinic(base(root), environment(approving).env);
    expect(second.code).toBe(2);
    expect(second.stderr).toMatch(/Automated run \d{8}-\d{6} \(process \d+\) is already working/);
    expect(await finished).toBe(0);
  });

  it("TC-AUTO-037: Ctrl+C stops the agents, keeps branches, reopens tasks, writes the report and exits 130", async () => {
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const root = project(2);
      const hanging = [{ match: "developer agent.*Task #2:", times: 0, hang: true }, ...approving];
      const { env, pids } = environment(hanging);
      const child = spawn(process.execPath, [path.join(REPO, "bin/cclinic.js"), ...base(root), "--developers", "1"], {
        env,
      });
      const finished = new Promise<number | null>((resolve) => child.on("close", resolve));
      await waitFor(() => existsSync(pids) && readFileSync(pids, "utf8").trim().split("\n").length >= 6);
      child.kill(signal);
      expect(await finished).toBe(code);
      for (const pid of readFileSync(pids, "utf8").trim().split("\n").map(Number)) {
        expect(() => process.kill(pid, 0), String(pid)).toThrow();
      }
      const runs = git(root, "branch", "--list", "cclinic/*", "--format=%(refname:short)").split("\n");
      expect(runs.some((branch) => branch.endsWith("/run"))).toBe(true);
      expect(runs.some((branch) => branch.endsWith("/task-2"))).toBe(true);
      expect(git(root, "worktree", "list").split("\n")).toHaveLength(1);
      const store = openTaskStore(path.join(root, ".cclinic"), "read");
      expect(store?.getTask(1)?.status).toBe("done");
      expect(store?.getTask(2)?.status).toBe("open");
      store?.close();
      const runId = runs[0]?.split("/")[2] ?? "";
      const runBranch = `cclinic/auto/${runId}/run`;
      expect(git(root, "log", "--format=%s", runBranch)).not.toContain("#2");
      expect(readFileSync(path.join(root, ".cclinic/auto", runId, "report.md"), "utf8")).toContain(
        "Outcome: interrupted",
      );
    }
  });
});

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
