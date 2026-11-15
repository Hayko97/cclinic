import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobProcess } from "../../src/application/gui-jobs.js";
import { makeTempFolder } from "../support/helpers.js";
import { sendTo, startTestGui, type TestGui } from "../support/gui.js";

const running: TestGui[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((gui) => gui.stop()));
});

const DRY_RUN = {
  status: "dry-run",
  target: "/p",
  provider: "anthropic-api",
  model: "sonnet",
  effort: "medium",
  estimatedTokens: 2_000,
  estimatedCostUsd: 0.05,
  included: [{ path: "a.ts", kind: "code" }],
  skipped: [],
  git: { status: "no-repository", commitsUsed: 0 },
};

/** Jobs that print `result` as their JSON line and exit with `code`, recording their arguments. */
function scriptedJobs(result: unknown = DRY_RUN, code = 0) {
  const started: string[][] = [];
  const startJob = (args: readonly string[]): JobProcess => {
    started.push([...args]);
    let print: ((stream: "stdout" | "stderr", chunk: string) => void) | undefined;
    return {
      onOutput: (listener) => {
        print = listener;
      },
      onExit: (listener) => {
        void Promise.resolve().then(() => {
          print?.("stdout", `${JSON.stringify(result)}\n`);
          listener(code);
        });
      },
      signal: () => undefined,
    };
  };
  return { started, startJob };
}

async function open(root: string, jobs = scriptedJobs()): Promise<TestGui> {
  const gui = await startTestGui(root, {}, { startJob: jobs.startJob, every: () => () => undefined });
  running.push(gui);
  return gui;
}

const post = (gui: TestGui, body: unknown) => sendTo(gui, "POST", "/api/jobs", body);

describe("Setup through the API", () => {
  it("TC-GUI-023: generate without answers gets the CLI's questions from a dry run, and no generate job starts", async () => {
    const jobs = scriptedJobs();
    const gui = await open(makeTempFolder(), jobs);
    const reply = await post(gui, { command: "generate", options: { maxFiles: 50 } });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body) as { questions: { id: string; text: string }[]; job?: unknown };
    expect(body.job).toBeUndefined();
    expect(body.questions.map((question) => question.id)).toEqual(["cost", "git", "environment"]);
    expect(body.questions[0]?.text).toContain("analyse 1 file, about 2,000 input tokens");
    expect(jobs.started).toEqual([["--dry-run", "--json", "--max-files=50"]]);
  });

  it("TC-GUI-024, TC-GUI-117: answered, generate runs once with --yes and the answers as options", async () => {
    const jobs = scriptedJobs({ status: "success" });
    const gui = await open(makeTempFolder(), jobs);
    const reply = await post(gui, {
      command: "generate",
      confirmed: true,
      options: { noGit: true, environment: false },
    });
    expect(reply.status).toBe(201);
    expect(jobs.started).toEqual([["--json", "--yes", "--no-git", "--no-environment"]]);
    const yes = await post(gui, { command: "generate", confirmed: true, options: { environment: true } });
    expect(yes.status).toBe(201);
    await vi.waitFor(() => {
      expect(jobs.started.at(-1)).toEqual(["--json", "--yes", "--environment"]);
    });
  });

  it("TC-GUI-022: a value the CLI would refuse is refused with its message, and nothing runs", async () => {
    const jobs = scriptedJobs();
    const gui = await open(makeTempFolder(), jobs);
    const reply = await post(gui, { command: "generate", options: { maxFiles: 0 } });
    expect(reply.status).toBe(400);
    expect(JSON.stringify(JSON.parse(reply.body))).toContain(
      "option '--max-files <n>' argument '0' is invalid. It must be a whole number from 1 or more.",
    );
    expect(jobs.started).toEqual([]);
  });

  it("TC-GUI-022: when the dry run fails, its own message comes back and generate doesn't start", async () => {
    const message = "No files to analyse remain after the exclusion rules.";
    const jobs = scriptedJobs({ status: "error", exitCode: 2, message }, 2);
    const gui = await open(makeTempFolder(), jobs);
    const reply = await post(gui, { command: "generate", options: {} });
    expect(reply.status).toBe(409);
    expect(JSON.parse(reply.body)).toEqual({ error: message });
    expect(jobs.started).toEqual([["--dry-run", "--json"]]);
  });

  it("TC-GUI-025, TC-GUI-118: model choice, environment and the other Setup commands run with the CLI's options", async () => {
    const jobs = scriptedJobs({ status: "success" });
    const gui = await open(makeTempFolder(), jobs);
    for (const request of [
      { command: "model-set", model: "opus", effort: "high" },
      { command: "model-reset" },
      { command: "model-list" },
      { command: "skills", force: false },
      { command: "environment", confirmed: true, options: { maxBudgetUsd: 2 } },
    ]) {
      const reply = await post(gui, request);
      expect(reply.status).toBe(201);
      await vi.waitFor(async () => {
        const list = JSON.parse((await sendTo(gui, "GET", "/api/jobs")).body) as { jobs: { isRunning: boolean }[] };
        expect(list.jobs.every((job) => !job.isRunning)).toBe(true);
      });
    }
    expect(jobs.started).toEqual([
      ["model", "--model=opus", "--effort=high", "--json"],
      ["model", "--reset", "--json"],
      ["model", "--list", "--json"],
      ["skills", "--json"],
      ["environment", "--yes", "--max-budget-usd=2", "--json"],
    ]);
    expect((await post(gui, { command: "model-set", model: "gpt", effort: "high" })).status).toBe(400);
    expect((await post(gui, { command: "environment", options: {} })).status).toBe(400);
  });

  it("TC-GUI-026: Setup says whether .mcp.json has luseen's entry, and starts no luseen mcp", async () => {
    const root = makeTempFolder();
    const jobs = scriptedJobs();
    const gui = await open(root, jobs);
    const setup = async () =>
      JSON.parse((await sendTo(gui, "GET", "/api/setup")).body) as {
        hasDocuments: boolean;
        environmentConsent: string;
        mcp: { status: string; entry: string; file: string };
      };
    const before = await setup();
    expect(before.mcp.status).toBe("missing");
    expect(before.mcp.file).toBe(".mcp.json");
    writeFileSync(path.join(root, ".mcp.json"), before.mcp.entry);
    expect((await setup()).mcp.status).toBe("installed");
    expect(jobs.started).toEqual([]);
  });

  it("TC-GUI-026: a .mcp.json that can't be read is said so, and Setup still loads", async () => {
    const root = makeTempFolder();
    mkdirSync(path.join(root, ".mcp.json"));
    const gui = await open(root);
    const reply = await sendTo(gui, "GET", "/api/setup");
    expect(reply.status).toBe(200);
    expect((JSON.parse(reply.body) as { mcp: { status: string; entry: string } }).mcp).toMatchObject({
      status: "unreadable",
    });
  });

  it("TC-GUI-021: Setup gets the CLI's own defaults and providers for the form", async () => {
    const gui = await open(makeTempFolder());
    const { defaults } = JSON.parse((await sendTo(gui, "GET", "/api/setup")).body) as {
      defaults: { limits: Record<string, number>; environmentBudgetUsd: number; providers: string[] };
    };
    expect(defaults.limits).toMatchObject({ maxFiles: 10_000, concurrency: 4, maxRetries: 2 });
    expect(defaults.environmentBudgetUsd).toBe(2);
    expect(defaults.providers).toEqual(["auto", "claude-cli", "anthropic-api"]);
  });

  it("TC-GUI-020: a project that isn't set up says so, and the canvas suggests generating instead of failing", async () => {
    const gui = await open(makeTempFolder());
    expect((JSON.parse((await sendTo(gui, "GET", "/api/setup")).body) as { hasDocuments: boolean }).hasDocuments).toBe(
      false,
    );
    const canvas = await sendTo(gui, "GET", "/api/canvas");
    expect(canvas.status).toBe(200);
    expect((JSON.parse(canvas.body) as { nextStep: unknown }).nextStep).toEqual({ kind: "generate" });
  });
});
