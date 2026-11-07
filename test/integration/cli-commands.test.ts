/** Runs the commands in-process with mocked menus, and a fake `claude` on PATH. */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, select } from "@inquirer/prompts";
import { createAnthropicApiProvider, type ApiClient } from "../../src/adapters/llm/anthropic-api.js";
import { createClaudeCliProvider } from "../../src/adapters/llm/claude-cli.js";
import { createExtractor } from "../../src/adapters/extraction/extract.js";
import { recoverInterruptedWrite, sha256 } from "../../src/adapters/storage/document-store.js";
import { generateDocuments, prepareRun } from "../../src/application/pipeline.js";
import { runGenerate, type CommandContext, type GenerateOptions } from "../../src/cli/generate-command.js";
import { checkLatestVersion, runClean, runDoctor, runModelCommand } from "../../src/cli/other-commands.js";
import { menuChoices } from "../../src/cli/menus.js";
import { createReporter, isColorEnabled } from "../../src/cli/reporter.js";
import { closestCommand, collect, editDistance, integerInRange, oneOf, positiveNumber } from "../../src/cli/options.js";
import { CancelledError, UsageError } from "../../src/core/errors.js";
import { EFFORT_OPTIONS, MODEL_OPTIONS } from "../../src/core/models.js";
import { moduleSummarySchema } from "../../src/core/schemas.js";
import { FakeLlm, makeTempFolder, silentLogger, writeProject } from "../support/helpers.js";

vi.mock("@inquirer/prompts", () => ({ select: vi.fn(), confirm: vi.fn() }));
const selectMock = vi.mocked(select);
const confirmMock = vi.mocked(confirm);

const REPO = fileURLToPath(new URL("../..", import.meta.url));

function fakeClaudePath(): string {
  const folder = makeTempFolder();
  symlinkSync(process.execPath, path.join(folder, "node"));
  copyFileSync(path.join(REPO, "test/fixtures/fake-claude/claude"), path.join(folder, "claude"));
  chmodSync(path.join(folder, "claude"), 0o755);
  return folder;
}

interface Harness {
  readonly context: CommandContext;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly environment: NodeJS.ProcessEnv;
}

function harness(extra: NodeJS.ProcessEnv = {}): Harness {
  const home = makeTempFolder();
  const environment: NodeJS.ProcessEnv = {
    PATH: fakeClaudePath(),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    ...extra,
  };
  let out = "";
  let err = "";
  const reporter = createReporter({
    quiet: false,
    debug: false,
    color: "never",
    environment,
    stdout: { write: (text: string) => (out += text) },
    stderr: { write: (text: string) => (err += text) },
  });
  return {
    context: { reporter, environment, signal: new AbortController().signal, version: "0.1.0" },
    stdout: () => out,
    stderr: () => err,
    environment,
  };
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    include: [],
    exclude: [],
    cache: true,
    maxFiles: 10_000,
    maxInputTokens: 2_000_000,
    maxFileSizeMib: 1,
    concurrency: 4,
    timeoutMinutes: 30,
    maxRetries: 2,
    ...overrides,
  };
}

function project(): string {
  const root = makeTempFolder();
  writeProject(root, { "src/a.ts": "export const a = 1;\n", "docs/b.md": "# B\n" });
  return root;
}

function savedConfig(harnessValue: Harness): unknown {
  const file = path.join(harnessValue.environment["XDG_CONFIG_HOME"] ?? "", "cclinic/config.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

const originalIsTty = process.stdin.isTTY;
beforeEach(() => {
  process.stdin.isTTY = true;
  selectMock.mockReset();
  confirmMock.mockReset();
});
afterEach(() => {
  process.stdin.isTTY = originalIsTty;
});

describe("model selection", () => {
  it("TC-MODEL-001: menus open in order, and the choice is saved with no scan", async () => {
    selectMock.mockResolvedValueOnce("opus").mockResolvedValueOnce("high");
    const test = harness();
    await runModelCommand({}, test.context);
    expect(selectMock.mock.calls.map(([config]) => config.message)).toEqual([
      "Choose a model",
      "Choose a reasoning level",
    ]);
    expect(savedConfig(test)).toEqual({ model: "opus", effort: "high" });
    expect(test.stderr()).not.toContain("Scanning");
  });

  it("TC-MODEL-002: --model applies to this run only", async () => {
    const test = harness();
    selectMock.mockResolvedValueOnce("haiku").mockResolvedValueOnce("low");
    await runModelCommand({}, test.context);
    selectMock.mockResolvedValueOnce("opus");
    await runGenerate(project(), options({ model: true, dryRun: true }), test.context);
    expect(test.stdout()).toContain("Opus 5.5");
    expect(savedConfig(test)).toMatchObject({ model: "haiku" });
  });

  it("TC-MODEL-003: --effort opens only the reasoning menu", async () => {
    selectMock.mockResolvedValueOnce("max");
    const test = harness();
    await runGenerate(project(), options({ effort: true, dryRun: true }), test.context);
    expect(selectMock).toHaveBeenCalledOnce();
    expect(test.stdout()).toContain("Max");
  });

  it("TC-MODEL-004: the model menu comes first", async () => {
    selectMock.mockResolvedValueOnce("fable").mockResolvedValueOnce("xhigh");
    const test = harness();
    await runGenerate(project(), options({ model: true, effort: true, dryRun: true }), test.context);
    expect(selectMock.mock.calls[0]?.[0].message).toBe("Choose a model");
    expect(test.stdout()).toContain("Fable 5.1");
    expect(test.stdout()).toContain("Extra high");
  });

  it("TC-MODEL-005: values open no menu", async () => {
    await runGenerate(project(), options({ model: "opus", effort: "high", dryRun: true }), harness().context);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("TC-MODEL-006: every option has its label and hint, and the current choice is preselected", async () => {
    for (const option of MODEL_OPTIONS) {
      const choice = menuChoices(MODEL_OPTIONS).find((item) => item.value === option.value);
      expect(choice?.name).toContain(option.label);
      expect(choice?.name).toContain(option.hint);
    }
    expect(menuChoices(EFFORT_OPTIONS)).toHaveLength(5);
    selectMock.mockResolvedValueOnce("sonnet").mockResolvedValueOnce("medium");
    await runModelCommand({}, harness().context);
    expect(selectMock.mock.calls[0]?.[0]).toMatchObject({ default: "sonnet" });
    expect(selectMock.mock.calls[1]?.[0]).toMatchObject({ default: "medium" });
  });

  it("TC-MODEL-007: cancelling a menu saves nothing", async () => {
    selectMock.mockRejectedValueOnce(Object.assign(new Error("closed"), { name: "ExitPromptError" }));
    const test = harness();
    await expect(runModelCommand({}, test.context)).rejects.toBeInstanceOf(CancelledError);
    expect(existsSync(path.join(test.environment["XDG_CONFIG_HOME"] ?? "", "cclinic"))).toBe(false);
  });

  it("TC-MODEL-013: --model with a folder treats it as the target", async () => {
    const root = project();
    selectMock.mockResolvedValueOnce("sonnet");
    const test = harness();
    await runGenerate(undefined, options({ model: root, dryRun: true }), test.context);
    expect(selectMock).toHaveBeenCalledOnce();
    expect(test.stdout()).toContain(path.basename(root));
  });

  it("TC-MODEL-014: --effort with a folder treats it as the target", async () => {
    const root = project();
    selectMock.mockResolvedValueOnce("low");
    const test = harness();
    await runGenerate(undefined, options({ effort: root, dryRun: true }), test.context);
    expect(selectMock.mock.calls[0]?.[0].message).toBe("Choose a reasoning level");
    expect(test.stdout()).toContain(path.basename(root));
  });

  it("TC-MODEL-017: the config goes in the right place, with only two fields", async () => {
    selectMock.mockResolvedValueOnce("opus").mockResolvedValueOnce("low");
    const withXdg = harness();
    await runModelCommand({}, withXdg.context);
    expect(savedConfig(withXdg)).toEqual({ model: "opus", effort: "low" });

    selectMock.mockResolvedValueOnce("opus").mockResolvedValueOnce("low");
    const home = makeTempFolder();
    const original = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const environment: NodeJS.ProcessEnv = { ...harness().environment, HOME: home };
      delete environment["XDG_CONFIG_HOME"];
      await runModelCommand({}, { ...harness().context, environment });
      expect(existsSync(path.join(home, ".config/cclinic/config.json"))).toBe(true);
    } finally {
      process.env["HOME"] = original;
    }
  });

  it("TC-MODEL-021: --list works in text and JSON", async () => {
    const test = harness();
    await runModelCommand({ list: true }, test.context);
    expect(test.stdout()).toContain("* sonnet");
    await runModelCommand({ list: true, json: true }, test.context);
    expect(test.stdout()).toContain('"current"');
  });

  it("TC-MODEL-022: --reset removes the saved default", async () => {
    selectMock.mockResolvedValueOnce("opus").mockResolvedValueOnce("low");
    const test = harness();
    await runModelCommand({}, test.context);
    await runModelCommand({ reset: true }, test.context);
    expect(test.stdout()).toContain("removed");
  });

  it("TC-MODEL-012: no terminal means no menu", async () => {
    process.stdin.isTTY = false;
    await expect(runModelCommand({}, harness().context)).rejects.toBeInstanceOf(UsageError);
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe("confirmation and output", () => {
  it("TC-CLI-011: declining sends nothing and writes nothing", async () => {
    confirmMock.mockResolvedValueOnce(false);
    const root = project();
    const record = path.join(makeTempFolder(), "calls.jsonl");
    const test = harness({ FAKE_CLAUDE_RECORD: record });
    await runGenerate(root, options(), test.context);
    expect(test.stdout()).toContain("Nothing was sent.");
    expect(existsSync(record)).toBe(false);
    expect(existsSync(path.join(root, ".cclinic"))).toBe(false);
  });

  it("TC-CLI-012: agreeing generates documents", async () => {
    confirmMock.mockResolvedValueOnce(true);
    const root = project();
    const test = harness();
    await runGenerate(root, options(), test.context);
    expect(existsSync(path.join(root, ".cclinic/sdd/README.md"))).toBe(true);
    expect(test.stderr()).toContain("Project content will be sent to Anthropic.");
  });

  it("TC-CLI-019: prompts write to stderr, and stdout has only the result", async () => {
    confirmMock.mockResolvedValueOnce(true);
    selectMock.mockResolvedValueOnce("sonnet");
    const test = harness();
    await runGenerate(project(), options({ model: true }), test.context);
    expect(selectMock.mock.calls[0]?.[1]).toEqual({ output: process.stderr });
    expect(confirmMock.mock.calls[0]?.[1]).toEqual({ output: process.stderr });
    expect(test.stdout()).not.toContain("sent to Anthropic");
    expect(test.stdout()).toContain("Documents written");
  });

  it("TC-CLI-002: invalid environment and values are usage errors", async () => {
    const test = harness({ CCLINIC_PROVIDER: "nope" });
    await expect(runGenerate(project(), options({ dryRun: true }), test.context)).rejects.toBeInstanceOf(UsageError);
    await expect(runGenerate("/no/such/folder", options(), harness().context)).rejects.toBeInstanceOf(UsageError);
  });

  it("TC-CLI-028: color rules apply to each stream", () => {
    const terminal = { isTTY: true, write: () => undefined };
    const pipe = { isTTY: false, write: () => undefined };
    expect(isColorEnabled("auto", terminal, {})).toBe(true);
    expect(isColorEnabled("auto", pipe, {})).toBe(false);
    expect(isColorEnabled("auto", terminal, { NO_COLOR: "1" })).toBe(false);
    expect(isColorEnabled("auto", terminal, { NO_COLOR: "" })).toBe(true);
    expect(isColorEnabled("auto", terminal, { TERM: "dumb" })).toBe(false);
    expect(isColorEnabled("always", pipe, { NO_COLOR: "1" })).toBe(true);
    expect(isColorEnabled("never", terminal, {})).toBe(false);
  });

  it("parses option values strictly", () => {
    expect(integerInRange(1, 16)("4")).toBe(4);
    expect(() => integerInRange(1, 16)("17")).toThrow();
    expect(() => integerInRange(1, 16)("1.5")).toThrow();
    expect(positiveNumber("0.5")).toBe(0.5);
    expect(() => positiveNumber("0")).toThrow();
    expect(oneOf(["a", "b"] as const)("a")).toBe("a");
    expect(() => oneOf(["a"] as const)("z")).toThrow();
    expect(collect("b", ["a"])).toEqual(["a", "b"]);
    expect(editDistance("docter", "doctor")).toBe(1);
    expect(closestCommand("docter")).toBe("doctor");
    expect(closestCommand("completely-different")).toBeUndefined();
  });
});

describe("doctor and clean", () => {
  it("TC-CLI-031: reports pass and fail states with fixes", async () => {
    const ready = harness();
    await expect(runDoctor(project(), {}, ready.context)).resolves.toBe(0);
    expect(ready.stdout()).toContain("cclinic is ready to run.");

    const notReady = harness({ PATH: makeTempFolder() });
    await expect(runDoctor(project(), { json: true }, notReady.context)).resolves.toBe(3);
    const parsed = JSON.parse(notReady.stdout()) as { ready: boolean; checks: { name: string; fix?: string }[] };
    expect(parsed.ready).toBe(false);
    expect(parsed.checks.find((check) => check.name === "Claude CLI")?.fix).toContain("Install Claude Code");
  });

  it("TC-CLI-034: the version check handles a hang, a new version and no change", async () => {
    const newer = await checkLatestVersion("0.1.0", () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ version: "9.9.9" }) }),
    );
    expect(newer.detail).toContain("9.9.9");
    const same = await checkLatestVersion("0.1.0", () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ version: "0.1.0" }) }),
    );
    expect(same.detail).toContain("latest");
    const hung = await checkLatestVersion(
      "0.1.0",
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new Error("timed out"));
          });
        }),
      20,
    );
    expect(hung.state).toBe("skipped");
    const missing = await checkLatestVersion("0.1.0", () =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    );
    expect(missing.state).toBe("skipped");
  });

  it("TC-CLI-035: clean asks first, and honours the answer", async () => {
    const root = project();
    writeProject(root, { ".cclinic/cache/a.json": "{}", ".cclinic/sdd/README.md": "keep" });
    confirmMock.mockResolvedValueOnce(false);
    const declined = harness();
    await runClean(root, {}, declined.context);
    expect(declined.stdout()).toContain("Nothing was deleted");
    expect(existsSync(path.join(root, ".cclinic/cache/a.json"))).toBe(true);
    confirmMock.mockResolvedValueOnce(true);
    const agreed = harness();
    await runClean(root, {}, agreed.context);
    expect(agreed.stdout()).toContain("Freed");
    expect(existsSync(path.join(root, ".cclinic/cache"))).toBe(false);
    expect(readFileSync(path.join(root, ".cclinic/sdd/README.md"), "utf8")).toBe("keep");
  });
});

describe("providers and pipeline details", () => {
  it("TC-OUT-002: --out writes there instead", async () => {
    const root = project();
    const out = path.join(makeTempFolder(), "docs");
    const test = harness();
    await runGenerate(root, options({ out, yes: true }), test.context);
    expect(existsSync(path.join(out, "README.md"))).toBe(true);
    expect(existsSync(path.join(root, ".cclinic/sdd"))).toBe(false);
  });

  it("TC-ANA-029: --force doesn't regenerate summaries", async () => {
    const root = project();
    await runGenerate(root, options({ yes: true }), harness().context);
    const record = path.join(makeTempFolder(), "calls.jsonl");
    await runGenerate(root, options({ yes: true, force: true }), harness({ FAKE_CLAUDE_RECORD: record }).context);
    expect(existsSync(record)).toBe(false);
  });

  it("TC-DISC-021: secrets in code don't reach prompts or the report", async () => {
    const root = project();
    writeProject(root, { "src/config.ts": 'const key = "AKIAIOSFODNN7EXAMPLE";\n' });
    const record = path.join(makeTempFolder(), "calls.jsonl");
    await runGenerate(root, options({ yes: true }), harness({ FAKE_CLAUDE_RECORD: record }).context);
    expect(readFileSync(record, "utf8")).not.toContain("AKIAIOSFODNN7EXAMPLE");
    const report = readFileSync(path.join(root, ".cclinic/sdd/scan-report.md"), "utf8");
    expect(report).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(report).toContain("| src/config.ts | 1 |");
  });

  it("TC-DISC-027: every file is either included or covered by a skip", async () => {
    const root = project();
    writeProject(root, { "vendor/a.js": "a", "a.dll": "x", ".env": "s", "package-lock.json": "{}" });
    const test = harness();
    await runGenerate(root, options({ dryRun: true, json: true }), test.context);
    const parsed = JSON.parse(test.stdout()) as { included: { path: string }[]; skipped: { path: string }[] };
    const accounted = [...parsed.included, ...parsed.skipped].map((entry) => entry.path);
    expect(accounted.sort()).toEqual([".env", "a.dll", "docs/b.md", "package-lock.json", "src/a.ts", "vendor/"].sort());
  });

  it("TC-CLI-049: a run makes no connections of its own", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await runGenerate(project(), options({ yes: true }), harness().context);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("TC-EXT-012: extraction makes no network attempts", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const root = project();
    await createExtractor().extract({
      path: "src/a.ts",
      absolutePath: path.join(root, "src/a.ts"),
      kind: "code",
      sizeBytes: 1,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("TC-LLM-006: provider imports stay inside their adapters", () => {
    const output = execFileSync(
      path.join(REPO, "node_modules/.bin/depcruise"),
      ["src", "--config", ".dependency-cruiser.cjs"],
      { cwd: REPO, encoding: "utf8" },
    );
    expect(output).toContain("no dependency violations");
  });

  it("TC-LLM-010: --bare is absent from a real process call", async () => {
    const record = path.join(makeTempFolder(), "calls.jsonl");
    await runGenerate(project(), options({ yes: true }), harness({ FAKE_CLAUDE_RECORD: record }).context);
    const first = JSON.parse(readFileSync(record, "utf8").split("\n")[0] ?? "") as { args: string[] };
    expect(first.args).not.toContain("--bare");
  });

  const generateRequest = {
    system: "s",
    prompt: "p",
    schema: moduleSummarySchema,
    model: "sonnet",
    effort: "medium",
  } as const;

  function cliProvider(environment: NodeJS.ProcessEnv, timeoutMinutes = 1, logger = silentLogger) {
    return createClaudeCliProvider({ environment, maxRetries: 2, timeoutMinutes, authMethod: "claude.ai", logger });
  }

  it.each(["TC-LLM-025", "TC-LLM-041"])("%s: a hung call times out", async () => {
    const provider = cliProvider({ PATH: fakeClaudePath(), FAKE_CLAUDE_MODE: "hang" }, 0.005);
    await expect(provider.generate(generateRequest)).rejects.toThrow(/timed out/);
  });

  it("TC-LLM-048: retry events show progress, and pause new calls", async () => {
    const lines: string[] = [];
    const logger = { ...silentLogger, info: (line: string) => lines.push(line) };
    const provider = cliProvider(
      { PATH: fakeClaudePath(), FAKE_CLAUDE_MODE: "retry-events", FAKE_CLAUDE_DELAY_MS: "400" },
      1,
      logger,
    );
    const start = Date.now();
    await provider.generate(generateRequest);
    expect(lines.join()).toContain("attempt 1 of 2");
    expect(lines.join()).toContain("rate_limit");
    expect(lines.join()).not.toContain('"prompt"');
    // The first call's retry event pauses the second call for the 400 ms it reported.
    await provider.generate(generateRequest);
    expect(Date.now() - start).toBeGreaterThanOrEqual(400);
  });

  it("TC-LLM-040: a rate limit pauses new calls", async () => {
    const started: number[] = [];
    const good = {
      model: "claude-sonnet-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const rateLimit = Anthropic.APIError.generate(
      429,
      { error: { message: "limit" } },
      "limit",
      new Headers({ "retry-after": "0.3" }),
    );
    const stream = vi.fn<ApiClient["stream"]>().mockImplementation(() => {
      started.push(Date.now());
      return started.length === 1 ? Promise.reject(rateLimit) : Promise.resolve(good);
    });
    const client: ApiClient = { stream, countTokens: () => Promise.resolve(1) };
    const provider = createAnthropicApiProvider({
      apiKey: "k",
      maxRetries: 1,
      timeoutMinutes: 1,
      logger: silentLogger,
      client,
    });
    const request = {
      system: "s",
      prompt: "p",
      schema: (await import("zod")).z.object({}),
      model: "sonnet",
      effort: "low",
    } as const;
    const first = provider.generate(request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = provider.generate(request);
    await Promise.all([first, second]);
    expect(started).toHaveLength(3);
    expect((started[1] ?? 0) - (started[0] ?? 0)).toBeGreaterThanOrEqual(250);
  });

  it("TC-ANA-006: a summary without evidence is rejected", () => {
    const summary = {
      purpose: "p",
      capabilities: [{ name: "n", description: "d" }],
      dataAndInterfaces: [],
      businessRules: [],
      technologies: [],
      conventions: [],
      commands: [],
    };
    expect(moduleSummarySchema.safeParse(summary).success).toBe(false);
  });

  it("TC-ANA-031: changing one module regenerates only the specs using it", async () => {
    const root = makeTempFolder();
    const paths = await import("../../src/adapters/storage/document-store.js");
    const cache = paths.createCache(path.join(root, "cache"));
    const store = paths.createDocumentStore(paths.projectPaths(root, path.join(root, "out")), () => new Date());
    const makeFile = (file: string, text: string) => ({
      path: file,
      kind: "code" as const,
      sha256: sha256(text),
      positioning: "line" as const,
      units: [{ ref: "1", text }],
      warnings: [],
    });
    const settings = {
      model: "sonnet",
      effort: "medium",
      concurrency: 1,
      noCache: false,
      cclinicVersion: "1",
    } as const;
    const projectData = (evidence: string[]) => ({
      overview: { purpose: "P", users: [], scope: [], nonGoals: [], glossary: [] },
      stack: [{ category: "Language", name: "TS", version: "6", evidence }],
      architecture: { parts: [], dataFlow: [], externalSystems: [], problems: [] },
      guidelines: [],
      specs: [
        { name: "alpha", area: "ALPHA", goal: "A", modules: ["a"] },
        { name: "beta", area: "BETA", goal: "B", modules: ["b"] },
      ],
      openQuestions: [],
    });
    const handler = (request: Parameters<NonNullable<ConstructorParameters<typeof FakeLlm>[0]>>[0]): unknown =>
      request.prompt.startsWith("Combine")
        ? projectData(["a/x.ts:1"])
        : request.prompt.startsWith("Summarise")
          ? {
              // Reflects the file's content, so a changed file gives a changed summary.
              purpose: request.prompt,
              capabilities: [],
              dataAndInterfaces: [],
              businessRules: [],
              technologies: [],
              conventions: [],
              commands: [],
            }
          : undefined;
    const execute = async (files: ReturnType<typeof makeFile>[], llm: FakeLlm): Promise<void> => {
      const scan = {
        included: files.map((file) => ({ path: file.path, absolutePath: file.path, kind: file.kind, sizeBytes: 1 })),
        skipped: [],
      };
      const prepared = await prepareRun({ scan, extracted: files, settings }, { hash: sha256, cache });
      await generateDocuments(prepared, settings, {
        llm,
        cache,
        store,
        logger: silentLogger,
        hash: sha256,
        now: () => new Date(),
        signal: new AbortController().signal,
      });
    };
    await execute([makeFile("a/x.ts", "one"), makeFile("b/y.ts", "two")], new FakeLlm(handler));
    const second = new FakeLlm(handler);
    await execute([makeFile("a/x.ts", "changed"), makeFile("b/y.ts", "two")], second);
    const specCalls = second.calls.filter((call) => call.prompt.startsWith("Write the full contents"));
    expect(specCalls).toHaveLength(1);
    expect(specCalls[0]?.prompt).toContain("Spec: alpha.");
  });

  it("TC-OUT-019: recovery always leaves a complete folder", async () => {
    const root = project();
    const test = harness();
    await runGenerate(root, options({ yes: true }), test.context);
    const out = path.join(root, ".cclinic/sdd");
    const { renameSync, mkdirSync, writeFileSync } = await import("node:fs");
    // A kill between the two renames leaves only the backup, plus an unfinished temp folder.
    renameSync(out, `${out}.cclinic-old-1`);
    mkdirSync(`${out}.cclinic-tmp-1`);
    writeFileSync(`${out}.cclinic-tmp-1/partial.md`, "partial");
    await recoverInterruptedWrite(out);
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")) as {
      generatedFiles: Record<string, string>;
    };
    for (const [file, hash] of Object.entries(manifest.generatedFiles)) {
      expect(sha256(readFileSync(path.join(out, file), "utf8"))).toBe(hash);
    }
    expect(readdirSync(path.dirname(out)).filter((name) => name.includes("cclinic-"))).toEqual([]);
  });
});
