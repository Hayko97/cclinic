/** Runs the stages in order. It knows the ports, and nothing about any concrete provider or the terminal. */
import { chunkModule, groupIntoModules, type Chunk, type Module } from "../core/chunking.js";
import { MAX_CHUNK_TOKENS } from "../core/constants/limits.js";
import { CHARS_PER_TOKEN, PROMPT_VERSION } from "../core/constants/llm.js";
import { DOCUMENT_FILES } from "../core/constants/paths.js";
import { JSON_INDENT } from "../core/constants/terminal.js";
import { BudgetError, CancelledError, TruncatedError, ValidationFailedError } from "../core/errors.js";
import type { Effort, ModelChoice } from "../core/models.js";
import type { ExtractedFile, LlmRequest, PipelineDeps, ScanResult, Schema } from "../core/ports.js";
import {
  buildCombinePrompt,
  buildMergePrompt,
  buildSpecPrompt,
  buildSummaryPrompt,
  SYSTEM_PROMPT,
  withProblems,
  withSplitRequest,
} from "../core/prompts.js";
import { countRedactions, redact } from "../core/redaction.js";
import { renderDocuments, type ScanReportData } from "../core/rendering.js";
import {
  generatedSpecsSchema,
  moduleSummarySchema,
  projectDataSchema,
  specContentSchema,
  splitSpecSchema,
  type GeneratedSpec,
  type Manifest,
  type ModuleSummary,
  type ProjectData,
  type SpecContent,
  type SpecEntry,
} from "../core/schemas.js";
import {
  buildFileIndex,
  validateProject,
  validateRendered,
  validateSpec,
  validateSpecEntries,
  type FileIndex,
} from "../core/validation.js";

export interface PreparedChunk {
  readonly chunk: Chunk;
  readonly key: string;
  readonly isCached: boolean;
}

export interface PreparedRun {
  readonly scan: ScanResult;
  readonly files: readonly ExtractedFile[];
  readonly chunks: readonly PreparedChunk[];
  readonly warnings: readonly string[];
  readonly redactions: ReadonlyMap<string, number>;
}

export interface RunSettings {
  readonly model: ModelChoice;
  readonly effort: Effort;
  readonly concurrency: number;
  readonly noCache: boolean;
  readonly maxBudgetUsd?: number;
  readonly cclinicVersion: string;
  readonly history?: HistoryForRun;
}

/** Recent Git history. Cache keys use the newest commit, so ageing out of the window costs nothing (FR-GIT-019). */
export interface HistoryForRun {
  readonly newestCommit: string;
  readonly text: string;
}

export interface RunResult {
  readonly outputFiles: ReadonlyMap<string, string>;
  readonly specCount: number;
  readonly requirementCount: number;
  readonly testCaseCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
  readonly cachedChunks: number;
  readonly totalChunks: number;
  readonly warnings: readonly string[];
}

function redactFile(file: ExtractedFile): { file: ExtractedFile; removed: number } {
  if (file.positioning === "line") {
    // Joined first, because a private key spans several lines. Line numbers are preserved.
    const { text, counts } = redact(file.units.map((unit) => unit.text).join("\n"));
    const lines = text.split("\n");
    const units = file.units.map((unit, index) => ({ ref: unit.ref, text: lines[index] ?? "" }));
    return { file: { ...file, units }, removed: countRedactions(counts) };
  }
  let removed = 0;
  const units = file.units.map((unit) => {
    const { text, counts } = redact(unit.text);
    removed += countRedactions(counts);
    return { ref: unit.ref, text };
  });
  return { file: { ...file, units }, removed };
}

export interface PrepareInput {
  readonly scan: ScanResult;
  readonly extracted: readonly ExtractedFile[];
  readonly settings: Pick<RunSettings, "model" | "effort" | "noCache">;
}

export type PrepareDeps = Pick<PipelineDeps, "hash"> & { readonly cache?: PipelineDeps["cache"] };

function moduleKey(module: Module, settings: PrepareInput["settings"], hash: PrepareDeps["hash"]): string {
  const files = module.files.map((file) => `${file.path}:${file.sha256}`).join("\n");
  return hash(["summary", PROMPT_VERSION, settings.model, settings.effort, module.id, files].join("\n"));
}

/** Everything up to the first Claude call. It's local only, apart from reading the cache. */
export async function prepareRun(input: PrepareInput, deps: PrepareDeps): Promise<PreparedRun> {
  const redactions = new Map<string, number>();
  const warnings: string[] = [];
  const files = input.extracted.map((extracted) => {
    warnings.push(...extracted.warnings);
    const { file, removed } = redactFile(extracted);
    if (removed > 0) redactions.set(file.path, removed);
    return file;
  });

  const chunks: PreparedChunk[] = [];
  for (const module of groupIntoModules(files)) {
    const key = moduleKey(module, input.settings, deps.hash);
    for (const chunk of chunkModule(module)) {
      const chunkKey = `${key}-${chunk.index}`;
      const cached =
        deps.cache !== undefined && !input.settings.noCache
          ? moduleSummarySchema.safeParse(await deps.cache.get(chunkKey)).success
          : false;
      chunks.push({ chunk, key: chunkKey, isCached: cached });
    }
  }
  return { scan: input.scan, files, chunks, warnings, redactions };
}

/** The prompt for a chunk, so token estimates measure exactly what would be sent. */
export function promptForChunk(chunk: Chunk): string {
  return buildSummaryPrompt(chunk);
}

class RunAccounting {
  inputTokens = 0;
  outputTokens = 0;
  costUsd = 0;
  hasCost = false;
  inFlight = 0;
  readonly actualModels = new Set<string>();
}

/** Runs tasks with a concurrency limit. The first failure stops everything else (FR-LLM-026). */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  outerSignal: AbortSignal,
  task: (item: T, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const controller = new AbortController();
  const signal = AbortSignal.any([outerSignal, controller.signal]);
  const results = new Array<R>(items.length);
  let next = 0;
  let firstError: { error: unknown } | undefined;

  const worker = async (): Promise<void> => {
    while (next < items.length && firstError === undefined && !signal.aborted) {
      const index = next;
      next += 1;
      try {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- index is within bounds
        results[index] = await task(items[index]!, signal);
      } catch (error) {
        firstError ??= { error };
        controller.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () => worker()));

  if (firstError !== undefined) throw firstError.error;
  if (outerSignal.aborted) throw new CancelledError("Cancelled.");
  return results;
}

function mergeLocally(summaries: readonly ModuleSummary[]): ModuleSummary {
  return {
    purpose: summaries.map((summary) => summary.purpose).join(" "),
    capabilities: summaries.flatMap((summary) => summary.capabilities),
    dataAndInterfaces: summaries.flatMap((summary) => summary.dataAndInterfaces),
    businessRules: summaries.flatMap((summary) => summary.businessRules),
    technologies: summaries.flatMap((summary) => summary.technologies),
    conventions: summaries.flatMap((summary) => summary.conventions),
    commands: summaries.flatMap((summary) => summary.commands),
  };
}

const MAX_CONTENT_CHARS = MAX_CHUNK_TOKENS * CHARS_PER_TOKEN;

function batchByChars<T>(items: readonly T[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of items) {
    const size = JSON.stringify(item).length;
    if (chars + size > MAX_CONTENT_CHARS && current.length > 0) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Generates all documents. Assumes the user has already confirmed. */
export async function generateDocuments(
  prepared: PreparedRun,
  settings: RunSettings,
  deps: PipelineDeps,
): Promise<RunResult> {
  const { logger, cache, hash } = deps;
  const accounting = new RunAccounting();
  const index = buildFileIndex(prepared.files);
  const analysedPaths = prepared.files.map((file) => file.path);
  const previous = await deps.store.readManifest();
  const previousRetired = previous?.retiredIds ?? [];
  const newestCommit = settings.history?.newestCommit ?? "";
  const historyText = settings.history?.text ?? "";

  const callLlm = async <T>(prompt: string, schema: Schema<T>, signal: AbortSignal): Promise<T> => {
    if (settings.maxBudgetUsd !== undefined && accounting.costUsd >= settings.maxBudgetUsd) {
      throw new BudgetError(`Reached the budget of $${settings.maxBudgetUsd}.`);
    }
    if (signal.aborted) throw new CancelledError("Cancelled.");
    accounting.inFlight += 1;
    const remaining =
      settings.maxBudgetUsd === undefined
        ? undefined
        : (settings.maxBudgetUsd - accounting.costUsd) / accounting.inFlight;
    const request: LlmRequest<T> = {
      system: SYSTEM_PROMPT,
      prompt,
      schema,
      model: settings.model,
      effort: settings.effort,
      signal,
      ...(remaining === undefined ? {} : { maxBudgetUsd: remaining }),
    };
    try {
      const result = await deps.llm.generate(request);
      accounting.inputTokens += result.inputTokens;
      accounting.outputTokens += result.outputTokens;
      accounting.actualModels.add(result.actualModel);
      if (result.costUsd !== null) {
        accounting.costUsd += result.costUsd;
        accounting.hasCost = true;
      }
      return result.data;
    } finally {
      accounting.inFlight -= 1;
    }
  };

  const cached = async <T>(
    key: string,
    schema: Schema<T>,
    signal: AbortSignal,
    produce: (signal: AbortSignal) => Promise<T>,
    isValid: (value: T) => boolean = () => true,
  ): Promise<T> => {
    if (!settings.noCache) {
      const parsed = schema.safeParse(await cache.get(key));
      if (parsed.success && isValid(parsed.data)) return parsed.data;
    }
    const value = await produce(signal);
    // An invalid result is never saved, so a re-run can correct it instead of failing forever (FR-ANA-028).
    if (isValid(value)) await cache.set(key, value);
    return value;
  };

  const baseKey = [PROMPT_VERSION, settings.model, settings.effort].join("\n");

  // Summarise: results are saved as each finishes, so a failed run can resume (FR-ANA-023).
  let finishedChunks = 0;
  const pending = prepared.chunks.length - prepared.chunks.filter((chunk) => chunk.isCached).length;
  logger.info(`Summarising ${prepared.chunks.length} chunks (${pending} not cached)...`);
  const chunkSummaries = await mapWithLimit(
    prepared.chunks,
    settings.concurrency,
    deps.signal,
    async (item, signal) => {
      const summary = await cached(item.key, moduleSummarySchema, signal, (innerSignal) =>
        callLlm(buildSummaryPrompt(item.chunk), moduleSummarySchema, innerSignal),
      );
      finishedChunks += 1;
      logger.info(`  ${finishedChunks}/${prepared.chunks.length} ${item.chunk.moduleId}`);
      return { moduleId: item.chunk.moduleId, summary };
    },
  );

  const byModule = new Map<string, ModuleSummary[]>();
  for (const { moduleId, summary } of chunkSummaries) {
    byModule.set(moduleId, [...(byModule.get(moduleId) ?? []), summary]);
  }
  const moduleSummaries = [...byModule.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([moduleId, summaries]) => ({ moduleId, ...mergeLocally(summaries) }));

  /** Merges in stages until the content fits in one request (FR-ANA-006). */
  const reduceToLimit = async (summaries: readonly ModuleSummary[]): Promise<readonly ModuleSummary[]> => {
    let current: readonly ModuleSummary[] = summaries;
    while (JSON.stringify(current).length > MAX_CONTENT_CHARS) {
      const batches = batchByChars(current);
      // A single oversized item can't be reduced by merging with others.
      if (batches.length >= current.length) break;
      logger.info(`Combining ${current.length} summaries in stages...`);
      current = await mapWithLimit(batches, settings.concurrency, deps.signal, (batch, signal) => {
        const key = hash(["merge", baseKey, JSON.stringify(batch)].join("\n"));
        return cached(key, moduleSummarySchema, signal, (innerSignal) =>
          callLlm(buildMergePrompt(batch), moduleSummarySchema, innerSignal),
        );
      });
    }
    return current;
  };

  // Combine into project-wide data, with one retry for correctable problems.
  logger.info("Combining into project-wide data...");
  const reduced = await reduceToLimit(moduleSummaries);
  const combineInput = reduced.map((summary) => ({
    moduleId: "moduleId" in summary ? String(summary.moduleId) : "merged",
    ...summary,
  }));
  const combineKey = hash(
    ["combine", baseKey, newestCommit, JSON.stringify(combineInput), analysedPaths.join("\n")].join("\n"),
  );
  const project = await cached<ProjectData>(
    combineKey,
    projectDataSchema,
    deps.signal,
    async (signal) => {
      const prompt = buildCombinePrompt(combineInput, analysedPaths, previous, historyText);
      const first = await callLlm(prompt, projectDataSchema, signal);
      const problems = validateProject(first, index);
      if (problems.length === 0) return first;
      logger.info(`Retrying project data to fix ${problems.length} problems...`);
      for (const problem of problems) logger.debug(problem);
      return callLlm(withProblems(prompt, problems), projectDataSchema, signal);
    },
    (value) => validateProject(value, index).length === 0,
  );

  // Generate each spec in its own call (FR-ANA-025).
  logger.info(`Generating ${project.specs.length} specs...`);
  const generated = await mapWithLimit(project.specs, settings.concurrency, deps.signal, async (entry, signal) => {
    const relevant = moduleSummaries.filter((summary) => entry.modules.includes(summary.moduleId));
    const summaries = await reduceToLimit(relevant.length > 0 ? relevant : moduleSummaries);
    const key = hash(
      [
        "spec",
        baseKey,
        newestCommit,
        JSON.stringify(entry),
        JSON.stringify(project.specs),
        JSON.stringify(project.stack),
        JSON.stringify(project.openQuestions),
        JSON.stringify(summaries),
      ].join("\n"),
    );
    const specs = await cached<GeneratedSpec[]>(
      key,
      generatedSpecsSchema,
      signal,
      (innerSignal) => generateSpec(entry, project.specs, summaries, innerSignal),
      (values) => values.every((spec) => validateSpec(spec, index, previousRetired).length === 0),
    );
    logger.info(`  ${entry.name}`);
    return specs;
  });

  async function generateSpec(
    entry: SpecEntry,
    allSpecs: readonly SpecEntry[],
    summaries: readonly ModuleSummary[],
    signal: AbortSignal,
  ): Promise<GeneratedSpec[]> {
    const prompt = buildSpecPrompt(entry, allSpecs, summaries, analysedPaths, previous, project, historyText);
    const named = (content: SpecContent): GeneratedSpec => ({
      ...content,
      name: entry.name,
      area: entry.area,
    });
    let first: GeneratedSpec;
    try {
      first = named(await callLlm(prompt, specContentSchema, signal));
    } catch (error) {
      if (!(error instanceof TruncatedError)) throw error;
      logger.info(`Spec ${entry.name} was too long, so it's being split...`);
      try {
        const split = await callLlm(withSplitRequest(prompt, entry), splitSpecSchema, signal);
        return split.specs;
      } catch (splitError) {
        if (splitError instanceof TruncatedError) {
          throw new TruncatedError(`Spec "${entry.name}" is too long for one response, even after splitting.`, {
            cause: splitError,
          });
        }
        throw splitError;
      }
    }
    const problems = validateSpec(first, index, previousRetired);
    if (problems.length === 0) return [first];
    logger.info(`Retrying spec ${entry.name} to fix ${problems.length} problems...`);
    for (const problem of problems) logger.debug(problem);
    return [named(await callLlm(withProblems(prompt, problems), specContentSchema, signal))];
  }

  const specs = generated.flat();
  const reportData: ScanReportData = {
    scan: prepared.scan,
    warnings: prepared.warnings,
    redactions: prepared.redactions,
  };
  const documents = renderDocuments(project, specs, reportData);

  const manifest = buildManifest({ prepared, settings, deps, specs, documents, accounting, previous });
  documents.set(DOCUMENT_FILES.MANIFEST, `${JSON.stringify(manifest, null, JSON_INDENT)}\n`);

  logger.info("Validating documents...");
  const problems = validateAll(project, specs, documents, index, previousRetired);
  if (problems.length > 0) {
    const draftPath = await deps.store.saveFailedDraft(documents);
    throw new ValidationFailedError(
      `The generated documents failed validation, so existing documents were left unchanged. Draft saved to ${draftPath}. Valid results were kept, so re-running only redoes what failed. This run used ${(accounting.inputTokens + accounting.outputTokens).toLocaleString("en-US")} tokens.`,
      problems,
    );
  }

  await deps.store.publish(documents);

  return {
    outputFiles: documents,
    specCount: specs.length,
    requirementCount: specs.reduce((total, spec) => total + spec.requirements.length, 0),
    testCaseCount: specs.reduce((total, spec) => total + spec.testCases.length, 0),
    inputTokens: accounting.inputTokens,
    outputTokens: accounting.outputTokens,
    costUsd: accounting.hasCost ? accounting.costUsd : null,
    cachedChunks: prepared.chunks.filter((chunk) => chunk.isCached).length,
    totalChunks: prepared.chunks.length,
    warnings: prepared.warnings,
  };
}

function validateAll(
  project: ProjectData,
  specs: readonly GeneratedSpec[],
  documents: ReadonlyMap<string, string>,
  index: FileIndex,
  retiredIds: readonly string[],
): string[] {
  return [
    ...validateProject({ ...project, specs: [] }, index).filter((problem) => !problem.startsWith("specs:")),
    ...validateSpecEntries(specs),
    ...specs.flatMap((spec) => validateSpec(spec, index, retiredIds)),
    ...validateRendered(
      documents,
      specs.map((spec) => spec.name),
    ),
  ];
}

function buildManifest(input: {
  prepared: PreparedRun;
  settings: RunSettings;
  deps: PipelineDeps;
  specs: readonly GeneratedSpec[];
  documents: ReadonlyMap<string, string>;
  accounting: RunAccounting;
  previous: Manifest | undefined;
}): Manifest {
  const { prepared, settings, deps, specs, documents, accounting, previous } = input;
  const currentIds = new Set(
    specs.flatMap((spec) => [
      ...spec.requirements.map((item) => item.id),
      ...spec.acceptanceCriteria.map((item) => item.id),
      ...spec.testCases.map((item) => item.id),
    ]),
  );
  const previousIds = previous?.specs.flatMap((spec) => spec.ids.map((item) => item.id)) ?? [];
  const retiredIds = [...new Set([...(previous?.retiredIds ?? []), ...previousIds])]
    .filter((id) => !currentIds.has(id))
    .sort();
  const models = accounting.actualModels.size > 0 ? [...accounting.actualModels] : (previous?.actualModels ?? []);
  return {
    cclinicVersion: settings.cclinicVersion,
    promptVersion: PROMPT_VERSION,
    generatedAt: deps.now().toISOString(),
    provider: deps.llm.name,
    requestedModel: settings.model,
    actualModels: models.sort(),
    effort: settings.effort,
    analysedFiles: Object.fromEntries(prepared.files.map((file) => [file.path, file.sha256])),
    generatedFiles: Object.fromEntries([...documents].map(([path, content]) => [path, deps.hash(content)])),
    specs: specs
      .map((spec) => ({
        name: spec.name,
        area: spec.area,
        ids: [
          ...spec.requirements.map((item) => ({ id: item.id, title: item.statement })),
          ...spec.acceptanceCriteria.map((item) => ({ id: item.id, title: item.acceptedWhen })),
          ...spec.testCases.map((item) => ({ id: item.id, title: item.then })),
        ],
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    retiredIds,
    ...(settings.history === undefined || settings.history.newestCommit === ""
      ? {}
      : { newestCommit: settings.history.newestCommit }),
  };
}
