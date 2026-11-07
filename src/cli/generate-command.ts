/** The main command: scan, summarise, confirm, then generate. */
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { scanFolder } from "../adapters/discovery/file-walker.js";
import { createExtractor } from "../adapters/extraction/extract.js";
import { selectProvider, type ProviderChoice } from "../adapters/llm/select-provider.js";
import { readSavedSettings } from "../adapters/config/user-config.js";
import {
  acquireLock,
  checkOutputFolder,
  checkWritable,
  createCache,
  createDocumentStore,
  projectPaths,
  recoverInterruptedWrite,
  sha256,
} from "../adapters/storage/document-store.js";
import { installSkills, summarizeInstall, type SkillInstallEntry } from "../adapters/storage/skill-installer.js";
import {
  generateDocuments,
  mapWithLimit,
  prepareRun,
  promptForChunk,
  type PreparedRun,
} from "../application/pipeline.js";
import { ESTIMATION_CONCURRENCY, EXTRACTION_CONCURRENCY, MS_PER_SECOND } from "../core/constants/limits.js";
import { ENV_VARS, PROVIDER_CHOICES } from "../core/constants/llm.js";
import { USD_DECIMAL_PLACES } from "../core/constants/terminal.js";
import { NoProviderError, UsageError } from "../core/errors.js";
import { isBroadTarget } from "../core/exclusion-rules.js";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  estimateCostUsd,
  estimateTokensFromChars,
  labelForEffort,
  labelForModel,
  parseEffort,
  parseModel,
  resolveSetting,
  type Effort,
  type ModelChoice,
} from "../core/models.js";
import type { LlmProvider, ScanResult } from "../core/ports.js";
import { NEXT_STEPS } from "./guide.js";
import { askToConfirm, chooseEffort, chooseModel, isInteractive } from "./menus.js";
import { closestCommand, oneOf, requireEffort, requireModel } from "./options.js";
import type { Reporter } from "./reporter.js";

export interface GenerateOptions {
  readonly out?: string;
  readonly provider?: ProviderChoice;
  readonly model?: string | true;
  readonly effort?: string | true;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly yes?: boolean;
  readonly cache: boolean;
  readonly allowBroadTarget?: boolean;
  readonly maxFiles: number;
  readonly maxInputTokens: number;
  readonly maxFileSizeMib: number;
  readonly maxBudgetUsd?: number;
  readonly concurrency: number;
  readonly timeoutMinutes: number;
  readonly maxRetries: number;
  readonly json?: boolean;
  readonly skills?: boolean;
}

export interface CommandContext {
  readonly reporter: Reporter;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly version: string;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** `--model ./project` is ambiguous, because the option's value is optional (FR-MODEL-008). */
export async function resolveAmbiguousValues(
  givenPath: string | undefined,
  options: Pick<GenerateOptions, "model" | "effort">,
): Promise<{ path: string | undefined; model: string | true | undefined; effort: string | true | undefined }> {
  let { model, effort } = options;
  let target = givenPath;
  if (
    typeof model === "string" &&
    parseModel(model) === undefined &&
    target === undefined &&
    (await isDirectory(model))
  ) {
    target = model;
    model = true;
  }
  if (
    typeof effort === "string" &&
    parseEffort(effort) === undefined &&
    target === undefined &&
    (await isDirectory(effort))
  ) {
    target = effort;
    effort = true;
  }
  return { path: target, model, effort };
}

async function resolveTarget(given: string | undefined, allowBroad: boolean): Promise<string> {
  const absolute = path.resolve(given ?? process.cwd());
  if (!(await isDirectory(absolute))) {
    const suggestion = given === undefined ? undefined : closestCommand(given);
    const hint = suggestion === undefined ? "" : ` Did you mean "cclinic ${suggestion}"?`;
    throw new UsageError(`"${given ?? absolute}" isn't a folder, and isn't a command.${hint}`);
  }
  const target = await realpath(absolute);
  if (!allowBroad && isBroadTarget(target, await realpath(homedir()).catch(() => homedir()))) {
    throw new UsageError(
      `${target} is a home folder or filesystem root, which is probably not what you meant. Run cclinic on a project folder, or use --allow-broad-target.`,
    );
  }
  return target;
}

async function resolveModelAndEffort(
  values: { model: string | true | undefined; effort: string | true | undefined },
  context: CommandContext,
): Promise<{ model: ModelChoice; effort: Effort }> {
  const { environment, reporter } = context;
  const saved = await readSavedSettings(environment);
  for (const warning of saved.warnings) reporter.warn(warning);

  const envModel = environment[ENV_VARS.MODEL];
  const envEffort = environment[ENV_VARS.EFFORT];
  const resolvedModel = resolveSetting<ModelChoice>({
    option: typeof values.model === "string" ? requireModel(values.model, "--model") : undefined,
    environment: envModel === undefined || envModel === "" ? undefined : requireModel(envModel, "CCLINIC_MODEL"),
    saved: saved.model,
    fallback: DEFAULT_MODEL,
  });
  const resolvedEffort = resolveSetting<Effort>({
    option: typeof values.effort === "string" ? requireEffort(values.effort, "--effort") : undefined,
    environment: envEffort === undefined || envEffort === "" ? undefined : requireEffort(envEffort, "CCLINIC_EFFORT"),
    saved: saved.effort,
    fallback: DEFAULT_EFFORT,
  });
  const model = values.model === true ? await chooseModel(resolvedModel) : resolvedModel;
  const effort = values.effort === true ? await chooseEffort(resolvedEffort) : resolvedEffort;
  return { model, effort };
}

function resolveProviderChoice(option: ProviderChoice | undefined, environment: NodeJS.ProcessEnv): ProviderChoice {
  if (option !== undefined) return option;
  const value = environment[ENV_VARS.PROVIDER];
  if (value === undefined || value === "") return "auto";
  try {
    return oneOf(PROVIDER_CHOICES)(value);
  } catch (error) {
    throw new UsageError(`CCLINIC_PROVIDER: ${(error as Error).message}`, { cause: error });
  }
}

function skipTotals(scan: ScanResult): string {
  const totals = new Map<string, number>();
  for (const entry of scan.skipped) totals.set(entry.reason, (totals.get(entry.reason) ?? 0) + 1);
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `  ${reason}: ${count}`)
    .join("\n");
}

interface SummaryInput {
  readonly target: string;
  readonly providerName: string;
  readonly authDescription: string;
  readonly model: ModelChoice;
  readonly effort: Effort;
  readonly scan: ScanResult;
  readonly tokens: number;
  readonly cachedChunks: number;
  readonly showCost: boolean;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(USD_DECIMAL_PLACES)}`;
}

export function formatSummary(input: SummaryInput): string {
  const count = (kind: string): number => input.scan.included.filter((file) => file.kind === kind).length;
  const cost = estimateCostUsd(input.model, input.tokens);
  const lines = [
    `Target:     ${input.target}`,
    `Provider:   ${input.providerName}`,
    `Login:      ${input.authDescription}`,
    `Model:      ${labelForModel(input.model)}`,
    `Reasoning:  ${labelForEffort(input.effort)}`,
    `Files:      ${count("code")} code, ${count("config")} config, ${count("document")} documents`,
    `Skipped:    ${input.scan.skipped.length} files and folders`,
    `Tokens:     about ${input.tokens.toLocaleString("en-US")} to summarise, plus combining (${input.cachedChunks} chunks already cached)`,
  ];
  if (input.showCost && cost !== null)
    lines.push(`Cost:       about ${formatUsd(cost)} (estimate, assuming output is 25% of input)`);
  lines.push("", "Project content will be sent to Anthropic.");
  return lines.join("\n");
}

async function estimateTokens(
  prepared: PreparedRun,
  provider: LlmProvider | undefined,
  model: ModelChoice,
  signal: AbortSignal,
): Promise<number> {
  const pending = prepared.chunks.filter((chunk) => !chunk.isCached);
  const counts = await mapWithLimit(pending, ESTIMATION_CONCURRENCY, signal, (chunk) => {
    const prompt = promptForChunk(chunk.chunk);
    return provider === undefined
      ? Promise.resolve(estimateTokensFromChars(prompt))
      : provider.estimateTokens(prompt, model);
  });
  return counts.reduce((total, count) => total + count, 0);
}

function limitMessage(what: string, actual: number, limit: number, flag: string): string {
  return `This project has ${actual.toLocaleString("en-US")} ${what}, which is above the limit of ${limit.toLocaleString("en-US")}. Use ${flag} to raise the limit, or exclude files with --exclude or .cclinicignore.`;
}

export async function runGenerate(
  given: string | undefined,
  options: GenerateOptions,
  context: CommandContext,
): Promise<void> {
  const { reporter, environment, signal } = context;
  const ambiguous = await resolveAmbiguousValues(given, options);
  const target = await resolveTarget(ambiguous.path, options.allowBroadTarget === true);
  const { model, effort } = await resolveModelAndEffort(ambiguous, context);
  const paths = projectPaths(target, options.out);
  const isDryRun = options.dryRun === true;

  const providerChoice = resolveProviderChoice(options.provider, environment);
  let provider: LlmProvider | undefined;
  try {
    provider = await selectProvider({
      choice: providerChoice,
      environment,
      maxRetries: options.maxRetries,
      timeoutMinutes: options.timeoutMinutes,
      logger: reporter,
    });
  } catch (error) {
    // A preview works offline, with nothing set up (FR-CLI-003).
    if (!(error instanceof NoProviderError && isDryRun && providerChoice === "auto")) throw error;
  }

  reporter.info(`Scanning ${target}...`);
  const scan = await scanFolder({
    target,
    outFolder: paths.out,
    include: options.include,
    exclude: options.exclude,
    maxFileSizeMib: options.maxFileSizeMib,
  });
  if (scan.included.length === 0) {
    throw new UsageError(
      "No files to analyse remain after the exclusion rules. Use --dry-run --json to see what was skipped.",
    );
  }
  if (scan.included.length > options.maxFiles) {
    throw new UsageError(limitMessage("files", scan.included.length, options.maxFiles, "--max-files"));
  }

  reporter.info(`Reading ${scan.included.length} files...`);
  const extractor = createExtractor();
  const extracted = await mapWithLimit(scan.included, EXTRACTION_CONCURRENCY, signal, (file) =>
    extractor.extract(file),
  );
  const cache = createCache(paths.cache);
  const prepared = await prepareRun(
    { scan, extracted, settings: { model, effort, noCache: !options.cache } },
    { hash: sha256, cache },
  );
  const tokens = await estimateTokens(prepared, provider, model, signal);
  if (tokens > options.maxInputTokens) {
    throw new UsageError(limitMessage("estimated input tokens", tokens, options.maxInputTokens, "--max-input-tokens"));
  }

  const summary = formatSummary({
    target,
    providerName: provider?.name ?? "none available",
    authDescription: provider === undefined ? "none" : await provider.describeAuth(),
    model,
    effort,
    scan,
    tokens,
    cachedChunks: prepared.chunks.filter((chunk) => chunk.isCached).length,
    showCost: provider?.isSubscription !== true,
  });

  if (isDryRun) {
    if (options.json === true) {
      reporter.result(
        JSON.stringify({
          status: "dry-run",
          target,
          provider: provider?.name ?? null,
          model,
          effort,
          estimatedTokens: tokens,
          estimatedCostUsd: provider?.isSubscription === true ? null : estimateCostUsd(model, tokens),
          included: scan.included.map((file) => ({ path: file.path, kind: file.kind })),
          skipped: scan.skipped,
        }),
      );
    } else {
      reporter.result(
        `${summary}\n\nSkipped by reason:\n${skipTotals(scan) || "  none"}\n\nDry run: nothing was sent or written.`,
      );
    }
    return;
  }
  if (provider === undefined) throw new NoProviderError("No Claude provider is available.");

  await recoverInterruptedWrite(paths.out);
  const { overwritten } = await checkOutputFolder(paths.out, options.force === true);

  if (options.yes !== true) {
    if (!isInteractive()) {
      throw new UsageError("Confirmation needs an interactive terminal. Use --yes to run without asking.");
    }
    reporter.notice(summary);
    if (!(await askToConfirm("Continue?"))) {
      reporter.result(options.json === true ? JSON.stringify({ status: "declined" }) : "Nothing was sent.");
      return;
    }
  } else {
    reporter.info(summary);
  }

  await checkWritable(paths);
  const releaseLock = await acquireLock(paths.lock);
  try {
    const now = (): Date => new Date();
    const start = Date.now();
    const result = await generateDocuments(
      prepared,
      {
        model,
        effort,
        concurrency: options.concurrency,
        noCache: !options.cache,
        cclinicVersion: context.version,
        ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
      },
      {
        llm: provider,
        cache,
        store: createDocumentStore(paths, now),
        logger: reporter,
        hash: sha256,
        now,
        signal,
      },
    );
    const durationSeconds = Math.round((Date.now() - start) / MS_PER_SECOND);
    let skills: readonly SkillInstallEntry[] = [];
    if (options.skills !== false) {
      try {
        skills = await installSkills({ target, out: paths.out, isForced: options.force === true });
      } catch (error) {
        // The documents are already saved, so a skills problem mustn't fail the run (FR-SKILL-005).
        const reason = error instanceof Error ? error.message : "unknown error";
        reporter.warn(`Couldn't install the agent skills: ${reason}. Run "cclinic skills" to try again.`);
      }
    }
    if (options.json === true) {
      reporter.result(
        JSON.stringify({
          status: "success",
          output: paths.out,
          specs: result.specCount,
          requirements: result.requirementCount,
          testCases: result.testCaseCount,
          warnings: result.warnings,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          estimatedCostUsd: result.costUsd,
          durationSeconds,
          cachedChunks: result.cachedChunks,
          overwritten,
          skills,
        }),
      );
      return;
    }
    const cost =
      result.costUsd === null
        ? ""
        : `, about ${formatUsd(result.costUsd)} (estimate${provider.isSubscription ? ", not a charge" : ""})`;
    reporter.result(
      [
        reporter.bold(`Documents written to ${paths.out}`),
        `${result.specCount} specs, ${result.requirementCount} requirements, ${result.testCaseCount} test cases`,
        `${(result.inputTokens + result.outputTokens).toLocaleString("en-US")} tokens${cost}, ${durationSeconds}s, ${result.cachedChunks} of ${result.totalChunks} chunks from cache`,
        ...(skills.length === 0 ? [] : [summarizeInstall(skills)]),
        NEXT_STEPS,
        ...skills
          .filter((entry) => entry.status.startsWith("skipped"))
          .map((entry) => `Warning: ${entry.path} ${entry.status}`),
        ...(overwritten.length === 0 ? [] : [`Overwrote hand-edited files: ${overwritten.join(", ")}`]),
        ...result.warnings.map((warning) => `Warning: ${warning}`),
      ].join("\n"),
    );
  } finally {
    await releaseLock();
  }
}
