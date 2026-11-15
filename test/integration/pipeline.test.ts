import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateDocuments, prepareRun, type RunSettings } from "../../src/application/pipeline.js";
import {
  checkOutputFolder,
  createCache,
  createDocumentStore,
  projectPaths,
  recoverInterruptedWrite,
  sha256,
} from "../../src/adapters/storage/document-store.js";
import {
  BudgetError,
  RateLimitError,
  TruncatedError,
  UsageError,
  ValidationFailedError,
} from "../../src/core/errors.js";
import { GUIDELINE_BASELINE } from "../../src/core/guidelines-baseline.js";
import type { ExtractedFile, LlmRequest, ScannedFile } from "../../src/core/ports.js";
import { manifestSchema, projectDataSchema, specContentSchema, splitSpecSchema } from "../../src/core/schemas.js";
import { defaultResponse, FakeLlm, makeSpecContent, makeTempFolder, silentLogger } from "../support/helpers.js";

function codeFile(relative: string, content = "line one\nline two"): ExtractedFile {
  return {
    path: relative,
    kind: "code",
    sha256: sha256(content),
    positioning: "line",
    units: content.split("\n").map((text, index) => ({ ref: String(index + 1), text })),
    warnings: [],
  };
}

const FILES = [codeFile("a/one.ts"), codeFile("b/two.ts"), codeFile("c/three.ts")];

async function run(
  root: string,
  llm: FakeLlm,
  overrides: { files?: readonly ExtractedFile[]; settings?: Partial<RunSettings>; signal?: AbortSignal } = {},
) {
  const paths = projectPaths(root, undefined);
  const cache = createCache(paths.cache);
  const settings: RunSettings = {
    model: "sonnet",
    effort: "medium",
    concurrency: 4,
    noCache: false,
    luseenVersion: "0.1.0",
    ...overrides.settings,
  };
  const files = overrides.files ?? FILES;
  const scan = {
    included: files.map((file): ScannedFile => ({
      path: file.path,
      absolutePath: file.path,
      kind: file.kind,
      sizeBytes: 1,
    })),
    skipped: [{ path: "vendor/", reason: "dependency or build folder" }],
  };
  const prepared = await prepareRun({ scan, extracted: files, settings }, { hash: sha256, cache });
  const now = (): Date => new Date();
  const result = await generateDocuments(prepared, settings, {
    llm,
    cache,
    store: createDocumentStore(paths, now),
    logger: silentLogger,
    hash: sha256,
    now,
    signal: overrides.signal ?? new AbortController().signal,
  });
  return { paths, result, prepared };
}

function read(root: string, relative: string): string {
  return readFileSync(path.join(root, ".luseen", "sdd", relative), "utf8");
}

const isSpecCall = (request: LlmRequest<unknown>): boolean => request.schema === specContentSchema;
const isCombineCall = (request: LlmRequest<unknown>): boolean => request.schema === projectDataSchema;

describe("analysis pipeline", () => {
  it("TC-ANA-003: stays within the concurrency limit, with repeatable inputs", async () => {
    const delayed = (): FakeLlm =>
      new FakeLlm(async () => {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 15));
        return undefined;
      });
    const first = delayed();
    const second = delayed();
    await run(makeTempFolder(), first, { settings: { concurrency: 3 } });
    await run(makeTempFolder(), second, { settings: { concurrency: 3 } });
    expect(first.maxActive).toBeLessThanOrEqual(3);
    expect(first.calls.find(isCombineCall)?.prompt).toBe(second.calls.find(isCombineCall)?.prompt);
  });

  it("TC-ANA-005: chunks of one module merge into one summary", async () => {
    const big = codeFile("a/big.ts", Array.from({ length: 16_000 }, () => "x".repeat(50)).join("\n"));
    const llm = new FakeLlm();
    await run(makeTempFolder(), llm, { files: [big] });
    const summaryCalls = llm.calls.filter((call) => !isCombineCall(call) && !isSpecCall(call));
    expect(summaryCalls.length).toBeGreaterThan(1);
    const combine = llm.calls.find(isCombineCall)?.prompt ?? "";
    expect(combine.match(/"moduleId":"a"/g)).toHaveLength(1);
  });

  it("TC-ANA-007: an oversized set of summaries is combined in stages", async () => {
    const files = Array.from({ length: 6 }, (_unused, index) => codeFile(`m${index}/f.ts`));
    const llm = new FakeLlm((request) => {
      if (isCombineCall(request) || isSpecCall(request)) return undefined;
      const response = defaultResponse(request) as Record<string, unknown>;
      return { ...response, purpose: "x".repeat(150_000) };
    });
    await run(makeTempFolder(), llm, { files });
    const merged = llm.calls.filter((call) => call.prompt.startsWith("Merge these summaries"));
    expect(merged.length).toBeGreaterThan(0);
    const combine = llm.calls.find(isCombineCall)?.prompt.length ?? 0;
    expect(combine).toBeLessThan(620_000);
  });

  it("TC-ANA-019: tailoring can't remove baseline text", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const guidelines = read(root, "developer-guidelines.md");
    for (const text of Object.values(GUIDELINE_BASELINE)) expect(guidelines).toContain(text);
    expect(guidelines).toContain("**Observed:** Use camelCase.");
  });

  it("TC-ANA-022: a removed ID is retired, and not reused", async () => {
    const root = makeTempFolder();
    const twoSpecs = new FakeLlm();
    await run(root, twoSpecs);
    const oneSpec = new FakeLlm((request) => {
      if (!isCombineCall(request)) return undefined;
      const data = defaultResponse(request) as { specs: unknown[] };
      return { ...data, specs: data.specs.slice(0, 1) };
    });
    await run(root, oneSpec, { settings: { noCache: true } });
    const manifest = manifestSchema.parse(JSON.parse(read(root, "manifest.json")));
    expect(manifest.retiredIds).toContain("FR-BETA-001");
    expect(oneSpec.calls.find(isSpecCall)?.prompt).toContain("FR-ALPHA-001");
    const reuse = new FakeLlm((request) => {
      if (!isCombineCall(request)) return undefined;
      return defaultResponse(request);
    });
    await expect(run(root, reuse, { settings: { noCache: true } })).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it("TC-ANA-025: re-runs are cached, and each change re-analyses", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const unchanged = new FakeLlm();
    await run(root, unchanged);
    expect(unchanged.calls).toHaveLength(0);

    const changedFile = new FakeLlm();
    await run(root, changedFile, {
      files: [codeFile("a/one.ts", "changed"), FILES[1] as ExtractedFile, FILES[2] as ExtractedFile],
    });
    const summaries = changedFile.calls.filter((call) => !isCombineCall(call) && !isSpecCall(call));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.prompt).toContain("a/one.ts");
  });

  it.each<[string, Partial<RunSettings>]>([
    ["model", { model: "opus" }],
    ["reasoning level", { effort: "high" }],
  ])("TC-ANA-025: changing the %s re-analyses all modules", async (_name, settings) => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const llm = new FakeLlm();
    await run(root, llm, { settings });
    expect(llm.calls.filter((call) => !isCombineCall(call) && !isSpecCall(call))).toHaveLength(3);
  });

  it("TC-ANA-026: a corrupt cache entry is replaced", async () => {
    const root = makeTempFolder();
    const { paths } = await run(root, new FakeLlm());
    const entry = readdirSync(paths.cache).find((name) => name.endsWith(".json")) ?? "";
    writeFileSync(path.join(paths.cache, entry), "{corrupt");
    const llm = new FakeLlm();
    await run(root, llm);
    expect(llm.calls.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(path.join(paths.cache, entry), "utf8"))).toBeTruthy();
  });

  it("TC-ANA-027: a failed run resumes without repeating finished work", async () => {
    const root = makeTempFolder();
    const failing = new FakeLlm((request) => {
      if (request.prompt.includes("c/three.ts") && !isCombineCall(request) && !isSpecCall(request)) {
        throw new RateLimitError("Limit reached");
      }
      return undefined;
    });
    await expect(run(root, failing, { settings: { concurrency: 1 } })).rejects.toBeInstanceOf(RateLimitError);
    const resumed = new FakeLlm();
    await run(root, resumed);
    const summaries = resumed.calls.filter((call) => !isCombineCall(call) && !isSpecCall(call));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.prompt).toContain("c/three.ts");
  });

  it("TC-ANA-028: an unchanged run skips combine", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const llm = new FakeLlm();
    await run(root, llm);
    expect(llm.calls.some(isCombineCall)).toBe(false);
  });

  it("TC-ANA-030: there's one call per spec, each with the spec list", async () => {
    const llm = new FakeLlm();
    await run(makeTempFolder(), llm);
    const calls = llm.calls.filter(isSpecCall);
    expect(calls).toHaveLength(2);
    expect(calls.find((call) => call.prompt.includes("Spec: alpha."))?.prompt).toContain('"name":"beta"');
  });

  it("TC-ANA-032: a cut-off spec is split once", async () => {
    const root = makeTempFolder();
    const llm = new FakeLlm((request) => {
      if (isSpecCall(request) && request.prompt.includes("Spec: alpha.")) throw new TruncatedError("cut off");
      if (request.schema === splitSpecSchema) {
        const evidence = ["a/one.ts:1"];
        return {
          specs: [
            { name: "alpha-a", area: "ALPHAA", ...makeSpecContent("ALPHAA", evidence) },
            { name: "alpha-b", area: "ALPHAB", ...makeSpecContent("ALPHAB", evidence) },
          ],
        };
      }
      return undefined;
    });
    const { result } = await run(root, llm);
    expect(result.specCount).toBe(3);
    expect(existsSync(path.join(root, ".luseen/sdd/specs/alpha-a/spec.md"))).toBe(true);
    expect(existsSync(path.join(root, ".luseen/sdd/specs/alpha-b/spec.md"))).toBe(true);
  });

  it("TC-ANA-033: a second cut-off stops the run and names the spec", async () => {
    const llm = new FakeLlm((request) => {
      if ((isSpecCall(request) && request.prompt.includes("Spec: alpha.")) || request.schema === splitSpecSchema) {
        throw new TruncatedError("cut off");
      }
      return undefined;
    });
    await expect(run(makeTempFolder(), llm)).rejects.toThrow(/alpha/);
  });

  it("TC-ANA-035: --no-cache re-analyses, and still saves", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const fresh = new FakeLlm();
    await run(root, fresh, { settings: { noCache: true } });
    expect(fresh.calls.length).toBeGreaterThanOrEqual(6);
    const after = new FakeLlm();
    await run(root, after);
    expect(after.calls).toHaveLength(0);
  });

  it("TC-ANA-036: a bad citation gets one correction attempt", async () => {
    const root = makeTempFolder();
    const llm = new FakeLlm((request) => {
      if (
        isSpecCall(request) &&
        request.prompt.includes("Spec: alpha.") &&
        !request.prompt.includes("had these problems")
      ) {
        return makeSpecContent("ALPHA", ["missing/file.ts:1"]);
      }
      return undefined;
    });
    await run(root, llm);
    const retry = llm.calls.find((call) => call.prompt.includes("had these problems"));
    expect(retry?.prompt).toContain("missing/file.ts:1");
    expect(read(root, "specs/alpha/spec.md")).not.toContain("missing/file.ts");
  });

  it("TC-LLM-029: stops at the budget, and passes on the remainder", async () => {
    const root = makeTempFolder();
    const llm = new FakeLlm();
    await expect(run(root, llm, { settings: { maxBudgetUsd: 0.02, concurrency: 1 } })).rejects.toBeInstanceOf(
      BudgetError,
    );
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]?.maxBudgetUsd).toBeCloseTo(0.02);
    expect(llm.calls[1]?.maxBudgetUsd).toBeCloseTo(0.01);
    expect(readdirSync(projectPaths(root, undefined).cache).filter((name) => name.endsWith(".json"))).toHaveLength(2);
  });

  it("TC-LLM-043: a usage limit stops further calls, and re-running continues", async () => {
    const root = makeTempFolder();
    let calls = 0;
    const limited = new FakeLlm(() => {
      calls += 1;
      if (calls > 2) throw new RateLimitError("Limit reached");
      return undefined;
    });
    await expect(run(root, limited, { settings: { concurrency: 1 } })).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toBe(3);
    const resumed = new FakeLlm();
    await run(root, resumed);
    expect(resumed.calls.filter((call) => !isCombineCall(call) && !isSpecCall(call))).toHaveLength(1);
  });

  it("TC-CLI-029: the result has counts, tokens, cost and cached chunks", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const { result } = await run(root, new FakeLlm());
    expect(result).toMatchObject({
      specCount: 2,
      requirementCount: 2,
      testCaseCount: 2,
      cachedChunks: 3,
      totalChunks: 3,
    });
    const fresh = await run(makeTempFolder(), new FakeLlm());
    expect(fresh.result.inputTokens).toBeGreaterThan(0);
    expect(fresh.result.costUsd).toBeCloseTo(0.06);
  });
});

describe("generated output", () => {
  const PROJECT_FILES = [
    "README.md",
    "overview.md",
    "stack.md",
    "architecture.md",
    "developer-guidelines.md",
    "open-questions.md",
    "scan-report.md",
    "manifest.json",
  ];

  it("TC-OUT-001: all files exist, and TC-OUT-003: no questions is stated", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    for (const file of PROJECT_FILES) expect(existsSync(path.join(root, ".luseen/sdd", file))).toBe(true);
    expect(read(root, "open-questions.md")).toContain("There are no open questions.");
  });

  it("TC-OUT-004: the README covers everything readers need", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const readme = read(root, "README.md");
    for (const text of [
      "specs/alpha/spec.md",
      "specs/beta/spec.md",
      "Reading order",
      "FR-<AREA>-NNN",
      "docs-only",
      "open-questions.md",
      "developer-guidelines.md",
      "verification.md",
    ]) {
      expect(readme).toContain(text);
    }
  });

  it("TC-OUT-005: stack items have versions and evidence, and missing categories are stated", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const stack = read(root, "stack.md");
    expect(stack).toContain("| Language | TypeScript | 6 | `a/one.ts:1` |");
    expect(stack).toContain("Not found in the project");
    expect(stack).toContain("Database");
  });

  it("TC-OUT-006: architecture has all required parts", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const architecture = read(root, "architecture.md");
    for (const heading of ["Main parts", "Data flow", "External systems", "Structural problems"])
      expect(architecture).toContain(heading);
  });

  it("TC-OUT-007: guidelines have every section, and labelled guidance", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const guidelines = read(root, "developer-guidelines.md");
    for (const heading of ["SOLID", "Naming", "Testing", "Code review", "Sources"])
      expect(guidelines).toContain(`## ${heading}`);
    expect(guidelines).toContain("**Observed:**");
  });

  it("TC-OUT-008: no detected language still gives the baseline, with a note", async () => {
    const root = makeTempFolder();
    const llm = new FakeLlm((request) => {
      if (!isCombineCall(request)) return undefined;
      return { ...(defaultResponse(request) as object), stack: [], guidelines: [] };
    });
    await run(root, llm);
    const guidelines = read(root, "developer-guidelines.md");
    expect(guidelines).toContain("## SOLID");
    expect(guidelines).toContain("stack-specific guidance wasn't possible");
  });

  it("TC-OUT-009: the scan report has totals, skips, warnings and counts, but no secret", async () => {
    const root = makeTempFolder();
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const withSecret = { ...codeFile("a/one.ts", `key = ${secret}`), warnings: ["a/one.ts: a warning"] };
    const llm = new FakeLlm();
    await run(root, llm, { files: [withSecret] });
    const report = read(root, "scan-report.md");
    expect(report).toContain("Included: code");
    expect(report).toContain("vendor/");
    expect(report).toContain("a/one.ts: a warning");
    expect(report).toContain("| a/one.ts | 1 |");
    expect(report).not.toContain(secret);
    for (const call of llm.calls) expect(call.prompt).not.toContain(secret);
  });

  it("TC-OUT-010: the manifest is complete, and its hashes match", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const manifest = manifestSchema.parse(JSON.parse(read(root, "manifest.json")));
    expect(manifest).toMatchObject({
      provider: "claude-cli",
      requestedModel: "sonnet",
      effort: "medium",
      actualModels: ["claude-sonnet-5-5"],
    });
    expect(Object.keys(manifest.analysedFiles)).toEqual(FILES.map((file) => file.path));
    for (const [file, hash] of Object.entries(manifest.generatedFiles)) expect(sha256(read(root, file))).toBe(hash);
    expect(manifest.specs.flatMap((spec) => spec.ids.map((item) => item.id))).toContain("TC-ALPHA-001");
  });

  it("TC-OUT-011: the cache and failed folders stay out of git", async () => {
    const root = makeTempFolder();
    execFileSync("git", ["init", "-q"], { cwd: root });
    const invalid = new FakeLlm((request, index) => {
      if (index >= 0 && isSpecCall(request)) return makeSpecContent("WRONG", ["a/one.ts:1"]);
      return undefined;
    });
    await expect(run(root, invalid)).rejects.toBeInstanceOf(ValidationFailedError);
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(status).not.toContain(".luseen/cache");
    expect(status).not.toContain(".luseen/failed");
  });

  it("TC-OUT-012: one folder per spec, with exactly three files", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const specs = path.join(root, ".luseen/sdd/specs");
    expect(readdirSync(specs).sort()).toEqual(["alpha", "beta"]);
    expect(readdirSync(path.join(specs, "alpha")).sort()).toEqual(["spec.md", "validation.md", "verification.md"]);
  });

  it("TC-OUT-013: spec.md has a goal and full requirements", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const spec = read(root, "specs/alpha/spec.md");
    expect(spec).toContain("## Goal");
    expect(spec).toContain("| FR-ALPHA-001 | It must do ALPHA. | code-only | `a/one.ts:1` |");
  });

  it("TC-OUT-014: validation.md has the four columns", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const validation = read(root, "specs/alpha/validation.md");
    expect(validation).toContain("| ID | Covers | User need | Accepted when |");
    expect(validation).toContain("| VAL-ALPHA-001 | FR-ALPHA-001 | I need it | It happens |");
  });

  it("TC-OUT-015: verification.md has setup first, then the six columns", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const verification = read(root, "specs/alpha/verification.md");
    expect(verification.indexOf("## Test setup")).toBeLessThan(verification.indexOf("## Test cases"));
    expect(verification).toContain("| ID | Covers | Level | Given | When | Then |");
    expect(verification).toContain("| TC-ALPHA-001 | FR-ALPHA-001 | unit | Setup | Runs | Happens |");
  });

  it("TC-OUT-018: a failure keeps existing documents, and saves a draft", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const before = read(root, "README.md");
    const invalid = new FakeLlm((request) =>
      isSpecCall(request) ? makeSpecContent("WRONG", ["a/one.ts:1"]) : undefined,
    );
    const error = await run(root, invalid, { settings: { noCache: true } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationFailedError);
    expect((error as ValidationFailedError).problems.join()).toContain("malformed ID");
    expect(read(root, "README.md")).toBe(before);
    const failed = path.join(root, ".luseen/failed");
    expect(readdirSync(failed).filter((name) => name !== ".gitignore")).toHaveLength(1);
  });

  it("TC-OUT-020: leftovers of a killed run are cleaned or restored", async () => {
    const root = makeTempFolder();
    const { paths } = await run(root, new FakeLlm());
    const { renameSync, mkdirSync } = await import("node:fs");
    mkdirSync(`${paths.out}.luseen-tmp-999`);
    await recoverInterruptedWrite(paths.out);
    expect(existsSync(`${paths.out}.luseen-tmp-999`)).toBe(false);
    renameSync(paths.out, `${paths.out}.luseen-old-999`);
    await recoverInterruptedWrite(paths.out);
    expect(existsSync(path.join(paths.out, "README.md"))).toBe(true);
  });

  it("TC-OUT-022: a hand edit needs --force, and is reported", async () => {
    const root = makeTempFolder();
    const { paths } = await run(root, new FakeLlm());
    writeFileSync(path.join(paths.out, "overview.md"), "edited");
    await expect(checkOutputFolder(paths.out, false)).rejects.toBeInstanceOf(UsageError);
    await expect(checkOutputFolder(paths.out, false)).rejects.toThrow("overview.md");
    await expect(checkOutputFolder(paths.out, true)).resolves.toEqual({ overwritten: ["overview.md"] });
  });

  it("TC-OUT-023: an unrelated folder needs --force", async () => {
    const root = makeTempFolder();
    writeFileSync(path.join(root, "notes.txt"), "mine");
    await expect(checkOutputFolder(root, false)).rejects.toThrow("no luseen manifest");
    expect(readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("mine");
    await expect(checkOutputFolder(root, true)).resolves.toEqual({ overwritten: ["notes.txt"] });
  });

  it("TC-OUT-024: an unchanged re-run gives byte-identical Markdown", async () => {
    const root = makeTempFolder();
    await run(root, new FakeLlm());
    const first = new Map(PROJECT_FILES.filter((file) => file.endsWith(".md")).map((file) => [file, read(root, file)]));
    const firstManifest = manifestSchema.parse(JSON.parse(read(root, "manifest.json")));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await run(root, new FakeLlm());
    for (const [file, content] of first) expect(read(root, file)).toBe(content);
    const secondManifest = manifestSchema.parse(JSON.parse(read(root, "manifest.json")));
    expect({ ...secondManifest, generatedAt: "" }).toEqual({ ...firstManifest, generatedAt: "" });
    expect(secondManifest.generatedAt).not.toBe(firstManifest.generatedAt);
  });
});

describe("recovering from invalid results", () => {
  const stillInvalid = (request: LlmRequest<unknown>): unknown =>
    isSpecCall(request) && request.prompt.includes("Spec: alpha.")
      ? makeSpecContent("ALPHA", ["missing/file.ts:1"])
      : undefined;

  it("TC-ANA-038: a failed run keeps valid results, and only redoes what failed", async () => {
    const root = makeTempFolder();
    await expect(run(root, new FakeLlm(stillInvalid), { settings: { concurrency: 1 } })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    const second = new FakeLlm();
    const { result } = await run(root, second);
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.prompt).toContain("Spec: alpha.");
    expect(result.specCount).toBe(2);
  });

  it("TC-ANA-039: an invalid result already in the cache is regenerated", async () => {
    const root = makeTempFolder();
    const llm = new FakeLlm();
    const { paths } = await run(root, llm);
    const invalid = [{ name: "alpha", area: "ALPHA", ...makeSpecContent("ALPHA", ["missing/file.ts:1"]) }];
    let replaced = 0;
    for (const entry of readdirSync(paths.cache).filter((name) => name.endsWith(".json"))) {
      const file = path.join(paths.cache, entry);
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(value) && (value[0] as { name?: string } | undefined)?.name === "alpha") {
        writeFileSync(file, JSON.stringify(invalid));
        replaced += 1;
      }
    }
    expect(replaced).toBe(1);
    const second = new FakeLlm();
    await run(root, second);
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.prompt).toContain("Spec: alpha.");
  });
});
