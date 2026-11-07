/** Interfaces owned by the inner layers. Adapters implement them, and cli/ wires them together. */
import type { ZodType } from "zod";
import type { Effort, ModelChoice } from "./models.js";
import type { Manifest } from "./schemas.js";

export type ProviderName = "claude-cli" | "anthropic-api";

export type Schema<T> = ZodType<T>;

export interface LlmRequest<T> {
  readonly system: string;
  readonly prompt: string;
  readonly schema: ZodType<T>;
  readonly model: ModelChoice;
  readonly effort: Effort;
  readonly maxBudgetUsd?: number;
  readonly signal?: AbortSignal;
}

export interface LlmResult<T> {
  readonly data: T;
  readonly actualModel: string;
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LlmProvider {
  readonly name: ProviderName;
  /** True when spending is included in a subscription, so dollar figures are only estimates. */
  readonly isSubscription: boolean;
  describeAuth(): Promise<string>;
  estimateTokens(text: string, model: ModelChoice): Promise<number>;
  generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
}

export type FileKind = "code" | "config" | "document";

export interface ScannedFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly kind: FileKind;
  readonly sizeBytes: number;
}

export interface SkippedEntry {
  readonly path: string;
  readonly reason: string;
}

export interface ScanResult {
  readonly included: readonly ScannedFile[];
  readonly skipped: readonly SkippedEntry[];
}

export type Positioning = "line" | "page" | "heading";

export interface TextUnit {
  /** Line number, page number or heading. */
  readonly ref: string;
  readonly text: string;
}

export interface ExtractedFile {
  readonly path: string;
  readonly kind: FileKind;
  readonly sha256: string;
  readonly positioning: Positioning;
  readonly units: readonly TextUnit[];
  readonly warnings: readonly string[];
}

export interface ContentExtractor {
  extract(file: ScannedFile): Promise<ExtractedFile>;
}

export interface Cache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface DocumentStore {
  readManifest(): Promise<Manifest | undefined>;
  saveFailedDraft(files: ReadonlyMap<string, string>): Promise<string>;
  publish(files: ReadonlyMap<string, string>): Promise<void>;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export interface PipelineDeps {
  readonly llm: LlmProvider;
  readonly cache: Cache;
  readonly store: DocumentStore;
  readonly logger: Logger;
  readonly hash: (text: string) => string;
  readonly now: () => Date;
  readonly signal: AbortSignal;
}
