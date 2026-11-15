/**
 * QA for GUI stage D1 (Setup): the API against the real `luseen` binary, so the dry run's JSON, the model
 * command and the other Setup jobs are checked end to end. Nothing here reaches Claude: generate is only ever
 * asked about (its dry run), and `claude` isn't on PATH.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jobArgs, jobRequestSchema } from "../../src/core/gui.js";
import { makeTempFolder, writeProject } from "../support/helpers.js";
import { sendTo, startTestGui, type TestGui } from "../support/gui.js";

const running: TestGui[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((gui) => gui.stop()));
});

interface JobView {
  readonly id: string;
  readonly kind: string;
  readonly command: string;
  readonly isRunning: boolean;
  readonly exitCode: number | null;
  readonly output: { readonly lines: readonly { readonly stream: string; readonly text: string }[] };
}

async function open(root: string): Promise<TestGui> {
  const gui = await startTestGui(root);
  running.push(gui);
  return gui;
}

function project(files: Record<string, string> = { "src/a.ts": "export const a = 1;\n" }): string {
  const root = makeTempFolder();
  writeProject(root, files);
  return root;
}

function withGit(root: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.email=qa@example.com", "-c", "user.name=QA", "commit", "-q", "-m", "initial");
  return root;
}

const post = (gui: TestGui, body: unknown) => sendTo(gui, "POST", "/api/jobs", body);

async function jobs(gui: TestGui): Promise<JobView[]> {
  return (JSON.parse((await sendTo(gui, "GET", "/api/jobs")).body) as { jobs: JobView[] }).jobs;
}

async function finished(gui: TestGui, id: string): Promise<JobView> {
  return vi.waitFor(
    async () => {
      const { job } = JSON.parse((await sendTo(gui, "GET", `/api/jobs/${id}`)).body) as { job: JobView };
      if (job.isRunning) throw new Error("still running");
      return job;
    },
    { timeout: 20_000, interval: 50 },
  );
}

function resultOf(job: JobView): unknown {
  const line = [...job.output.lines].reverse().find((entry) => entry.stream === "stdout" && entry.text.startsWith("{"));
  return line === undefined ? undefined : JSON.parse(line.text);
}

type Questions = { questions: { id: string; text: string; answers: { value: string }[] }[]; job?: unknown };

describe("QA D1: Setup against the real luseen binary", () => {
  it("TC-GUI-116: with a Git repository, --force and the environment option set, the questions are the cost and the --force warning, and no generate job starts", async () => {
    const root = withGit(project({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" }));
    const gui = await open(root);
    const reply = await post(gui, { command: "generate", options: { force: true, environment: false } });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body) as Questions;
    expect(body.job).toBeUndefined();
    expect(body.questions.map((question) => question.id)).toEqual(["cost", "force"]);
    // The cost question carries the dry run's own numbers.
    const list = await jobs(gui);
    expect(list.map((job) => job.kind)).toEqual(["generate-preview"]);
    const dryRun = resultOf(await finished(gui, list[0]?.id ?? "")) as {
      included: unknown[];
      estimatedTokens: number;
      estimatedCostUsd: number | null;
      git: { status: string };
    };
    expect(dryRun.git.status).not.toBe("no-repository");
    expect(body.questions[0]?.text).toContain(`analyse ${dryRun.included.length} files`);
    expect(body.questions[0]?.text).toContain(`about ${dryRun.estimatedTokens.toLocaleString("en-US")} input tokens`);
    // A cost below half a cent is said as "under $0.01", so it doesn't read as free.
    const cost =
      dryRun.estimatedCostUsd === null
        ? "subscription"
        : dryRun.estimatedCostUsd < 0.005
          ? "under $0.01"
          : `$${dryRun.estimatedCostUsd.toFixed(2)}`;
    expect(body.questions[0]?.text).toContain(cost);
    expect(body.questions[1]?.text).toContain("replaces .luseen/sdd completely");
    expect(list[0]?.command).toBe("luseen --dry-run --json --force --no-environment");
    // The dry run wrote nothing.
    expect(existsSync(path.join(root, ".luseen/sdd"))).toBe(false);
  });

  it("TC-GUI-023: with no Git repository, the real dry run leads to the cost, Git and environment questions, and creates no repository", async () => {
    const root = project();
    const gui = await open(root);
    const body = JSON.parse((await post(gui, { command: "generate", options: {} })).body) as Questions;
    expect(body.questions.map((question) => question.id)).toEqual(["cost", "git", "environment"]);
    expect(existsSync(path.join(root, ".git"))).toBe(false);
    expect((await jobs(gui)).map((job) => job.kind)).toEqual(["generate-preview"]);
  });

  it("edge: a dry run the CLI refuses comes back with its own message, and no generate job starts", async () => {
    const gui = await open(project({ "a.ts": "1", "b.ts": "2", "c.ts": "3" }));
    const reply = await post(gui, { command: "generate", options: { maxFiles: 1 } });
    expect(reply.status).toBe(409);
    const { error } = JSON.parse(reply.body) as { error: string };
    expect(error).toMatch(/max-files/);
    expect((await jobs(gui)).map((job) => job.kind)).toEqual(["generate-preview"]);
  });

  it("edge: include and exclude patterns with spaces, or that look like options, stay patterns", async () => {
    const root = project({ "my docs/a.md": "# A\n", "src/b.ts": "export const b = 1;\n", "--force": "x" });
    const gui = await open(root);
    const reply = await post(gui, {
      command: "generate",
      options: { include: ["my docs/**"], exclude: ["--force", "src/**"] },
    });
    expect(reply.status).toBe(200);
    const [preview] = await jobs(gui);
    expect(preview?.command).toBe(
      'luseen --dry-run --json "--include=my docs/**" --exclude=--force "--exclude=src/**"',
    );
    const dryRun = resultOf(await finished(gui, preview?.id ?? "")) as { included: { path: string }[] };
    expect(dryRun.included.map((file) => file.path)).toEqual(["my docs/a.md"]);
    const questions = (JSON.parse(reply.body) as Questions).questions.map((question) => question.id);
    // --force was a pattern, not the option, so there is no overwrite warning.
    expect(questions).not.toContain("force");
  });

  it("TC-GUI-022: an unknown provider is refused with the CLI's exact message, and nothing runs", async () => {
    const root = project();
    const gui = await open(root);
    const reply = await post(gui, { command: "generate", options: { provider: "openai" } });
    expect(reply.status).toBe(400);
    const { error } = JSON.parse(reply.body) as { error: string };
    let cliMessage = "";
    try {
      execFileSync(process.execPath, ["bin/luseen.js", root, "--provider", "openai", "--dry-run"], {
        stdio: "pipe",
        env: { ...process.env, XDG_CONFIG_HOME: makeTempFolder() },
      });
    } catch (failure) {
      cliMessage = String((failure as { stderr: Buffer }).stderr);
    }
    expect(cliMessage).toContain(error);
    expect(await jobs(gui)).toEqual([]);
  });

  it("edge: values the CLI refuses are refused before any job, whatever their type", async () => {
    const gui = await open(project());
    for (const options of [
      { maxFiles: "abc" },
      { maxFiles: 1.5 },
      { maxRetries: -1 },
      { maxBudgetUsd: 0 },
      { maxBudgetUsd: "1" },
      { concurrency: 17 },
      { model: "gpt" },
      { effort: "huge" },
    ]) {
      const reply = await post(gui, { command: "generate", options });
      expect(reply.status, JSON.stringify(options)).toBe(400);
      expect((JSON.parse(reply.body) as { error: string }).error, JSON.stringify(options)).not.toBe("");
    }
    expect(await jobs(gui)).toEqual([]);
    // 0 retries is allowed, as in the CLI (0 to 10).
    expect((await post(gui, { command: "generate", options: { maxRetries: 0 } })).status).toBe(200);
  });

  it("TC-GUI-025, TC-GUI-118: model choice, list, reset, skills and clean have the same effect as in the terminal", async () => {
    const root = project();
    mkdirSync(path.join(root, ".luseen/sdd"), { recursive: true });
    const gui = await open(root);
    const config = path.join(gui.harness.environment.XDG_CONFIG_HOME ?? "", "luseen/config.json");
    const run = async (request: unknown) => {
      const reply = await post(gui, request);
      expect(reply.status, JSON.stringify(request)).toBe(201);
      return finished(gui, (JSON.parse(reply.body) as { job: JobView }).job.id);
    };
    const saved = await run({ command: "model-set", model: "opus", effort: "high" });
    expect(saved.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ model: "opus", effort: "high" });
    const listed = await run({ command: "model-list" });
    expect((resultOf(listed) as { current: unknown }).current).toEqual({ model: "opus", effort: "high" });
    expect((await run({ command: "model-reset" })).exitCode).toBe(0);
    expect(existsSync(config)).toBe(false);
    const after = await run({ command: "model-list" });
    expect((resultOf(after) as { current: unknown }).current).toEqual({ model: "sonnet", effort: "medium" });
    const skills = await run({ command: "skills", force: false });
    expect(skills.exitCode).toBe(0);
    expect(existsSync(path.join(root, ".mcp.json"))).toBe(true);
    const setup = JSON.parse((await sendTo(gui, "GET", "/api/setup")).body) as { mcp: { status: string } };
    expect(setup.mcp.status).toBe("installed");
    expect((await run({ command: "clean" })).exitCode).toBe(0);
  });

  it("edge: the environment job carries model, effort and budget, and is never started unconfirmed", async () => {
    const gui = await open(project());
    expect((await post(gui, { command: "environment", options: { model: "opus" } })).status).toBe(400);
    expect((await post(gui, { command: "environment", confirmed: false, options: {} })).status).toBe(400);
    expect((await post(gui, { command: "environment", confirmed: true, options: { maxBudgetUsd: -2 } })).status).toBe(
      400,
    );
    expect(await jobs(gui)).toEqual([]);
    const request = jobRequestSchema.parse({
      command: "environment",
      confirmed: true,
      options: { model: "opus", effort: "high", maxBudgetUsd: 1.5, allowBroadTarget: true },
    });
    expect(jobArgs(request)).toEqual([
      "environment",
      "--yes",
      "--model=opus",
      "--effort=high",
      "--max-budget-usd=1.5",
      "--allow-broad-target",
      "--json",
    ]);
  });

  it("edge: an invalid .mcp.json is reported, and a hand-changed entry is left as it is", async () => {
    const root = project();
    const gui = await open(root);
    const status = async () =>
      (JSON.parse((await sendTo(gui, "GET", "/api/setup")).body) as { mcp: { status: string } }).mcp.status;
    writeFileSync(path.join(root, ".mcp.json"), "{ not json");
    expect(await status()).toBe("unreadable");
    writeFileSync(
      path.join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { luseen: { command: "node", args: ["my/luseen.js", "mcp"] } } }),
    );
    expect(await status()).toBe("changed");
  });

  it("FR-GUI-016: without --force, a document folder luseen can't vouch for stops the run with the CLI's own message, before any Claude call", async () => {
    const root = project();
    writeProject(root, { ".luseen/sdd/notes.md": "# Mine\n" });
    const bin = makeTempFolder();
    copyFileSync(path.resolve("test/fixtures/fake-claude/claude"), path.join(bin, "claude"));
    chmodSync(path.join(bin, "claude"), 0o755);
    symlinkSync(process.execPath, path.join(bin, "node"));
    const record = path.join(makeTempFolder(), "calls.jsonl");
    const gui = await startTestGui(root, {}, {}, { PATH: `${bin}:/usr/bin:/bin`, FAKE_CLAUDE_RECORD: record });
    running.push(gui);
    const asked = JSON.parse(
      (await post(gui, { command: "generate", options: { environment: false } })).body,
    ) as Questions;
    // The Claude Code subscription is used, so there's no dollar estimate.
    expect(asked.questions[0]?.text).toContain("It uses your Claude Code subscription.");
    const reply = await post(gui, {
      command: "generate",
      confirmed: true,
      options: { environment: false, noGit: true },
    });
    expect(reply.status).toBe(201);
    const job = await finished(gui, (JSON.parse(reply.body) as { job: JobView }).job.id);
    expect(job.exitCode).toBe(2);
    expect(job.output.lines.map((line) => line.text).join("\n")).toContain("has files but no luseen manifest");
    expect(existsSync(record)).toBe(false);
    expect(readFileSync(path.join(root, ".luseen/sdd/notes.md"), "utf8")).toBe("# Mine\n");
  });
});
