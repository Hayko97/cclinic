/** Limits and thresholds. These defaults are this project's own estimates, so review them after real use. */

export const BYTES_PER_KIB = 1024;
export const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60_000;
/** FR-AUTO-041: the longest plan-limit status kept; Claude Code's are short words such as `allowed` or `rejected`. */
export const LIMIT_STATUS_MAX_CHARS = 40;

/** Command-line limits. Each can be changed with its flag. */
export const LIMITS = {
  maxFiles: { minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 10_000 },
  maxInputTokens: { minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 2_000_000 },
  maxFileSizeMib: { minimum: 1, maximum: 50, default: 1 },
  concurrency: { minimum: 1, maximum: 16, default: 4 },
  timeoutMinutes: { minimum: 1, maximum: 120, default: 30 },
  maxRetries: { minimum: 0, maximum: 10, default: 2 },
} as const;

export const MAX_DOCUMENT_MIB = 50;
export const MAX_DOCUMENT_BYTES = MAX_DOCUMENT_MIB * BYTES_PER_MIB;

export const MAX_CHUNK_TOKENS = 150_000;
export const FILE_OVERHEAD_CHARS = 200;

export const BUNDLE_AVERAGE_LINE_LENGTH = 500;
export const GENERATED_MARKER_LINES = 20;
export const BINARY_SNIFF_BYTES = 8192;
export const MIN_PDF_CHARS_PER_PAGE = 20;

export const EXTRACTION_CONCURRENCY = 8;
export const ESTIMATION_CONCURRENCY = 8;
/** File locks: how often to try again, how long a lock may be empty while it's written, and the longest wait. */
export const LOCK_RETRY_MS = 20;
export const LOCK_WRITE_GRACE_MS = 1_000;
export const LOCK_WAIT_MS = 10_000;
export const SHUTDOWN_TIMEOUT_MS = 5000;
export const VERSION_CHECK_TIMEOUT_MS = 5000;
export const MAX_AREA_LETTERS = 8;

export const MINIMUM_NODE = { major: 22, minor: 18 } as const;
