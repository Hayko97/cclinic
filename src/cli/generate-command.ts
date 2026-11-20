/** The main command: scan, summarise, confirm, then generate. */
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createPathFilter, scanFolder } from "../adapters/discovery/file-walker.js";
import { createExtractor } from "../adapters/extraction/extract.js";
import { createRepository, detectGit, hasGitignore, readRawHistory } from "../adapters/git/git-repository.js";
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
import { openPlanStore } from "../adapters/storage/plan-store.js";
import { installSkills, summarizeInstall, type SkillInstallEntry } from "../adapters/storage/skill-installer.js";
import {
  generateDocuments,
  mapWithLimit,
  prepareRun,
  promptForChunk,
  type PreparedRun,
} from "../application/pipeline.js";
import { skillSourceOf } from "../core/agent-skills.js";
import { GIT_INSTALL_LINK } from "../core/constants/git.js";
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
import {
  buildHistoryContext,
  describeGitStatus,
  formatRemoteAlert,
  type GitStatus,
  type HistoryContext,
} from "../core/git-history.js";
import type { LlmProvider, ScanResult } from "../core/ports.js";
import type { CommandContext } from "./command-context.js";
import { formatDesignOutcome, setUpDesignAfterGenerate } from "./design-step.js";
import { formatEnvironmentOutcome, setUpAfterGenerate } from "./environment-step.js";
import { NEXT_STEPS } from "./guide.js";
import { askToConfirm, chooseEffort, chooseModel, isInteractive } from "./menus.js";
import { openNewProjectSession } from "./new-project-ports.js";
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
  readonly plugin?: boolean;
  readonly environment?: boolean;
  readonly design?: boolean;
  readonly git?: boolean;
  readonly quiet?: boolean;
}

export type { CommandContext } from "./command-context.js";

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

export async function resolveTarget(given: string | undefined, allowBroad: boolean): Promise<string> {
  const absolute = path.resolve(given ?? process.cwd());
  if (!(await isDirectory(absolute))) {
    const suggestion = given === undefined ? undefined : closestCommand(given);
    const hint = suggestion === undefined ? "" : ` Did you mean "luseen ${suggestion}"?`;
    throw new UsageError(`"${given ?? absolute}" isn't a folder, and isn't a command.${hint}`);
  }
  const target = await realpath(absolute);
  if (!allowBroad && isBroadTarget(target, await realpath(homedir()).catch(() => homedir()))) {
    throw new UsageError(
      `${target} is a home folder or filesystem root, which is probably not what you meant. Run luseen on a project folder, or use --allow-broad-target.`,
    );
  }
  return target;
}

export async function resolveModelAndEffort(
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
    environment: envModel === undefined || envModel === "" ? undefined : requireModel(envModel, "LUSEEN_MODEL"),
    saved: saved.model,
    fallback: DEFAULT_MODEL,
  });
  const resolvedEffort = resolveSetting<Effort>({
    option: typeof values.effort === "string" ? requireEffort(values.effort, "--effort") : undefined,
    environment: envEffort === undefined || envEffort === "" ? undefined : requireEffort(envEffort, "LUSEEN_EFFORT"),
    saved: saved.effort,
    fallback: DEFAULT_EFFORT,
  });
  const model = values.model === true ? await chooseModel(resolvedModel) : resolvedModel;
  const effort = values.effort === true ? await chooseEffort(resolvedEffort) : resolvedEffort;
  return { model, effort };
}

export function resolveProviderChoice(
  option: ProviderChoice | undefined,
  environment: NodeJS.ProcessEnv,
): ProviderChoice {
  if (option !== undefined) return option;
  const value = environment[ENV_VARS.PROVIDER];
  if (value === undefined || value === "") return "auto";
  try {
    return oneOf(PROVIDER_CHOICES)(value);
  } catch (error) {
    throw new UsageError(`LUSEEN_PROVIDER: ${(error as Error).message}`, { cause: error });
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
  readonly gitDescription: string;
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
    `Git:        ${input.gitDescription}`,
    `Tokens:     about ${input.tokens.toLocaleString("en-US")} to summarise (${input.cachedChunks} chunks already cached). Combining and writing specs use more, often several times this`,
  ];
  if (input.showCost && cost !== null)
    lines.push(
      `Cost:       about ${formatUsd(cost)} for summarising only (estimate). Use --max-budget-usd to set a limit`,
    );
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

function warnAboutGit(status: GitStatus, reporter: Reporter): void {
  if (status.kind === "not-installed") {
    reporter.warn(`Git isn't installed, so history can't be used. Install it from ${GIT_INSTALL_LINK}.`);
  } else if (status.kind === "unavailable") {
    reporter.warn(`Git can't be used here, so continuing without history: ${status.reason}.`);
  } else if (status.kind === "repository" && status.isShallow) {
    reporter.warn("This is a shallow clone, so Git history may be incomplete.");
  }
}

interface LoadedHistory {
  readonly newestCommit: string;
  readonly context: HistoryContext;
}

/** Git problems never stop a run (FR-GIT-022). */
async function loadHistory(
  status: GitStatus,
  target: string,
  outFolder: string,
  options: GenerateOptions,
  { environment, reporter }: CommandContext,
): Promise<LoadedHistory | undefined> {
  if (status.kind !== "repository" || !status.hasCommits) return undefined;
  const relativeOut = path.relative(target, outFolder).split(path.sep).join("/");
  const raw = await readRawHistory(target, {
    environment,
    now: new Date(),
    ...(relativeOut.startsWith("..") ? {} : { outFolder: relativeOut }),
  });
  if (raw === undefined) {
    reporter.warn("Couldn't read the Git history, so continuing without it.");
    return undefined;
  }
  const isPathAllowed = createPathFilter({ target, outFolder, include: options.include, exclude: options.exclude });
  const context = buildHistoryContext(raw.commits, raw.totalInWindow, isPathAllowed);
  if (context.omittedCount > 0) {
    reporter.warn(`Git history is above the limit, so ${context.omittedCount} older commits were left out.`);
  }
  return { newestCommit: raw.newestCommit, context };
}

function limitMessage(what: string, actual: number, limit: number, flag: string): string {
  return `This project has ${actual.toLocaleString("en-US")} ${what}, which is above the limit of ${limit.toLocaleString("en-US")}. Use ${flag} to raise the limit, or exclude files with --exclude or .luseenignore.`;
}

/** Starts a new project's setup in the folder, or continues the open one (roadmap-planning FR-PLAN-047, FR-PLAN-048). */
export type NewProjectStarter = (target: string, resume: string | undefined) => Promise<void>;

/** FR-CLI-040: an empty folder offers a new project, previews as empty, or stops saying how to start one. */
async function handleEmptyFolder(
  options: GenerateOptions,
  context: CommandContext,
  run: {
    readonly preview: Record<string, unknown> & { readonly target: string };
    readonly startNewProject: NewProjectStarter | undefined;
  },
): Promise<void> {
  const { target } = run.preview;
  const { startNewProject } = run;
  if (options.dryRun === true && options.json === true) {
    context.reporter.result(
      JSON.stringify({
        status: "dry-run",
        empty: true,
        ...run.preview,
        estimatedTokens: 0,
        estimatedCostUsd: null,
        included: [],
      }),
    );
    return;
  }
  if (startNewProject !== undefined && canAsk(options)) {
    if (!(await askToConfirm("This folder is empty. Start a new project with the PM?", true))) {
      context.reporter.result("Nothing was written.");
      return;
    }
    await startNewProject(target, undefined);
    return;
  }
  throw new UsageError(
    `Nothing to analyse in ${target}. Run \`luseen\` in a terminal or \`luseen gui\` to start a new project with the PM, or write a README.md that describes the project.`,
  );
}

function canAsk(options: GenerateOptions): boolean {
  return (
    isInteractive() &&
    options.yes !== true &&
    options.json !== true &&
    options.quiet !== true &&
    options.dryRun !== true
  );
}

export async function runGenerate(
  given: string | undefined,
  options: GenerateOptions,
  context: CommandContext,
  startNewProject?: NewProjectStarter,
): Promise<void> {
  const { reporter, environment, signal } = context;
  const ambiguous = await resolveAmbiguousValues(given, options);
  const target = await resolveTarget(ambiguous.path, options.allowBroadTarget === true);
  const { model, effort } = await resolveModelAndEffort(ambiguous, context);
  const paths = projectPaths(target, options.out);
  const isDryRun = options.dryRun === true;
  // FR-PLAN-048: running luseen again continues a new project's setup, at whichever step it stopped.
  if (startNewProject !== undefined && canAsk(options)) {
    const open = (await openNewProjectSession(openPlanStore(target)))?.id;
    if (open !== undefined) {
      reporter.notice(`Continuing the new project's setup (${open}).`);
      await startNewProject(target, open);
      return;
    }
  }

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

  let gitStatus: GitStatus = options.git === false ? { kind: "disabled" } : await detectGit(target, { environment });
  warnAboutGit(gitStatus, reporter);

  reporter.info(`Scanning ${target}...`);
  const scan = await scanFolder({
    target,
    outFolder: paths.out,
    include: options.include,
    exclude: options.exclude,
    maxFileSizeMib: options.maxFileSizeMib,
  });
  if (scan.included.length === 0 && !existsSync(paths.out)) {
    await handleEmptyFolder(options, context, {
      preview: {
        target,
        provider: provider?.name ?? null,
        model,
        effort,
        skipped: scan.skipped,
        git: { status: gitStatus.kind, commitsUsed: 0 },
      },
      startNewProject,
    });
    return;
  }
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
  const history = await loadHistory(gitStatus, target, paths.out, options, context);
  const previousManifest = await createDocumentStore(paths, () => new Date()).readManifest();
  // Unchanged history is already in cached results, so it costs nothing to re-run (FR-GIT-019).
  const isHistoryNew = history !== undefined && history.newestCommit !== previousManifest?.newestCommit;
  const historyTokens = isHistoryNew ? estimateTokensFromChars(history.context.text) : 0;
  const tokens = (await estimateTokens(prepared, provider, model, signal)) + historyTokens;
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
    gitDescription: describeGitStatus(gitStatus, history?.context.commitCount ?? 0),
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
          git: { status: gitStatus.kind, commitsUsed: history?.context.commitCount ?? 0 },
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
    let wasRepositoryCreated = false;
    if (gitStatus.kind === "no-repository") {
      wasRepositoryCreated = await createRepository(target, { environment });
      if (wasRepositoryCreated) {
        reporter.info("Created a local Git repository.");
        gitStatus = await detectGit(target, { environment });
      } else {
        reporter.warn("Couldn't create a Git repository, so continuing without one.");
      }
    }
    const now = (): Date => new Date();
    const start = Date.now();
    const result = await generateDocuments(
      prepared,
      {
        model,
        effort,
        concurrency: options.concurrency,
        noCache: !options.cache,
        luseenVersion: context.version,
        ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
        ...(history === undefined
          ? {}
          : { history: { newestCommit: history.newestCommit, text: history.context.text } }),
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
        skills = await installSkills({
          target,
          out: paths.out,
          isForced: options.force === true,
          skillSource: skillSourceOf(options),
        });
      } catch (error) {
        // The documents are already saved, so a skills problem mustn't fail the run (FR-SKILL-005).
        const reason = error instanceof Error ? error.message : "unknown error";
        reporter.warn(`Couldn't install the agent skills: ${reason}. Run "luseen skills" to try again.`);
      }
    }
    const remoteAlert =
      gitStatus.kind === "repository" && gitStatus.remote === undefined
        ? formatRemoteAlert({
            hasCommits: gitStatus.hasCommits,
            hasGitignore: await hasGitignore(gitStatus.root),
            wasCreated: wasRepositoryCreated,
          })
        : undefined;
    const gitResult = {
      status: gitStatus.kind,
      createdRepository: wasRepositoryCreated,
      remote: gitStatus.kind === "repository" ? (gitStatus.remote ?? null) : null,
      commitsUsed: history?.context.commitCount ?? 0,
      ...(remoteAlert === undefined ? {} : { remoteAlert }),
    };
    const setUpEnvironment = () =>
      setUpAfterGenerate(
        {
          target,
          out: paths.out,
          model,
          effort,
          maxBudgetUsd: options.maxBudgetUsd,
          isClaudeCli: provider.name === "claude-cli",
          wereSkillsInstalled: skills.length > 0,
          requested: options.environment,
          mayAsk: options.yes !== true && options.quiet !== true && options.json !== true,
        },
        context,
      );
    const setUpDesign = () =>
      setUpDesignAfterGenerate(
        {
          target,
          out: paths.out,
          model,
          effort,
          maxBudgetUsd: options.maxBudgetUsd,
          isClaudeCli: provider.name === "claude-cli",
          wereSkillsInstalled: skills.length > 0,
          requested: options.design,
          mayAsk: options.yes !== true && options.quiet !== true && options.json !== true,
        },
        context,
      );
    if (options.json === true) {
      const environmentOutcome = await setUpEnvironment();
      const designOutcome = await setUpDesign();
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
          git: gitResult,
          environment: environmentOutcome,
          design: designOutcome,
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
        ...(skills.length === 0 ? [] : [summarizeInstall(skills, skillSourceOf(options))]),
        NEXT_STEPS,
        ...skills
          .filter((entry) => entry.status.startsWith("skipped"))
          .map((entry) => `Warning: ${entry.path} ${entry.status}`),
        ...(overwritten.length === 0 ? [] : [`Overwrote hand-edited files: ${overwritten.join(", ")}`]),
        ...result.warnings.map((warning) => `Warning: ${warning}`),
        ...(gitResult.commitsUsed === 0
          ? []
          : [`Git context: ${gitResult.commitsUsed} recent ${gitResult.commitsUsed === 1 ? "commit" : "commits"}.`]),
        ...(remoteAlert === undefined || options.quiet === true ? [] : ["", remoteAlert]),
      ].join("\n"),
    );
    const environmentText = formatEnvironmentOutcome(await setUpEnvironment());
    if (environmentText !== undefined) reporter.result(`\n${environmentText}`);
    const designText = formatDesignOutcome(await setUpDesign());
    if (designText !== undefined) reporter.result(`\n${designText}`);
  } finally {
    await releaseLock();
  }
}
