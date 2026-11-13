/** Names of the files and folders cclinic reads and writes. */

export const TOOL_FOLDER_NAME = ".cclinic";
export const DOCUMENTS_FOLDER_NAME = "sdd";
export const CACHE_FOLDER_NAME = "cache";
export const FAILED_FOLDER_NAME = "failed";
export const LOCK_FILE_NAME = ".lock";
/** Held for a moment by the one process removing an abandoned lock. */
export const LOCK_BREAKER_SUFFIX = ".break";
export const TASKS_DB_FILE = "tasks.db";
/** Visual review docs written by the review-doc skill, outside the documents folder (FR-SKILL-033). */
export const REVIEWS_FOLDER = `${TOOL_FOLDER_NAME}/reviews`;
export const REVIEW_DOC_SKILL_NAME = "review-doc";
/** Not "code-review", so a project skill doesn't hide Claude Code's built-in one (FR-CREV-001). */
export const REVIEW_CODE_SKILL_NAME = "review-code";
export const BUILT_IN_REVIEW_SKILL_NAME = "code-review";
/** Passed explicitly: with no level, the built-in review reuses the last one the user typed, such as max (FR-CREV-008). */
export const BUILT_IN_REVIEW_LEVEL = "medium";
export const TEMP_FOLDER_SUFFIX = ".cclinic-tmp-";
export const BACKUP_FOLDER_SUFFIX = ".cclinic-old-";

export const GITIGNORE_FILE = ".gitignore";
export const CCLINIC_IGNORE_FILE = ".cclinicignore";
export const AGENTS_FILE = "AGENTS.md";
export const CLAUDE_FILE = "CLAUDE.md";
/** Root files where cclinic owns a marked section, which is removed before analysis (FR-INSTR-007). */
export const MANAGED_INSTRUCTION_FILES: readonly string[] = [AGENTS_FILE, CLAUDE_FILE];
export const SKILL_FILE = "SKILL.md";
export const SKILL_FOLDERS = [".agents/skills", ".claude/skills"] as const;

export const USER_CONFIG_BASE_FOLDER = ".config";
export const USER_CONFIG_FOLDER = "cclinic";
export const USER_CONFIG_FILE = "config.json";
/** FR-AUTO-041: the newest Claude plan limits, next to the saved model. */
export const LIMITS_FILE = "limits.json";

/** The generated project documents. */
export const DOCUMENT_FILES = {
  README: "README.md",
  OVERVIEW: "overview.md",
  STACK: "stack.md",
  ARCHITECTURE: "architecture.md",
  GUIDELINES: "developer-guidelines.md",
  OPEN_QUESTIONS: "open-questions.md",
  SCAN_REPORT: "scan-report.md",
  MANIFEST: "manifest.json",
} as const;

/** The three files in every spec folder. */
export const SPEC_FILES = {
  SPEC: "spec.md",
  VALIDATION: "validation.md",
  VERIFICATION: "verification.md",
} as const;

export const SPECS_FOLDER_NAME = "specs";
