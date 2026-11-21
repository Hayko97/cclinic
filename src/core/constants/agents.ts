/** Values for the PM, developer and QA agents (specs: roadmap-planning, automated-mode). */
import { BUILD_COMMANDS, SECRET_FILES } from "./environment.js";
import { TOOL_FOLDER_NAME } from "./paths.js";

export const READ_ONLY_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];
/** FR-PLAN-005: the PM also researches the web. */
export const PM_TOOLS: readonly string[] = [...READ_ONLY_TOOLS, "WebSearch", "WebFetch"];
export const WRITING_TOOLS: readonly string[] = [...READ_ONLY_TOOLS, "Write", "Edit", "Bash"];

/** Claude Code runs read-only commands such as `git status` without an allow rule, so these need explicit denial. */
export const AGENT_DENIED_TOOLS: readonly string[] = [
  "Bash(git *)",
  "Bash(sudo *)",
  "Bash(* .env*)",
  ...SECRET_FILES.map((file) => `Read(**/${file})`),
];

/** Developer and QA agents build and test the project, and write only inside their worktree (FR-AUTO-017). */
export const WORKTREE_AGENT_ALLOWED_TOOLS: readonly string[] = [
  ...READ_ONLY_TOOLS,
  "Write(./**)",
  "Edit(./**)",
  ...BUILD_COMMANDS.map((command) => `Bash(${command} *)`),
];

/** FR-PLAN-007, FR-PLAN-008, FR-PLAN-010, FR-PLAN-015. The limits are estimates, recorded as open questions. */
export const PLAN_LIMITS = {
  maxTurns: 40,
  emptyRepliesInARow: 2,
  maxReplyChars: 8_000,
  maxUserMessageChars: 20_000,
  maxSuggestions: 4,
  maxSuggestionChars: 200,
  maxSources: 10,
  /** The start of the first message, shown in session lists (FR-PLAN-031). */
  summaryChars: 80,
  /** A planning transcript entry is shown whole up to here: a 20,000-character message with its file list. */
  transcriptEntryChars: 40_000,
} as const;

export const BYTES_PER_MEGABYTE = 1024 * 1024;

/** FR-PLAN-022: what may be attached, and how much. */
export const ATTACHMENT_LIMITS = {
  imageMaxBytes: 5 * BYTES_PER_MEGABYTE,
  documentMaxBytes: 20 * BYTES_PER_MEGABYTE,
  perMessage: 10,
  perSession: 30,
} as const;
export const IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
export const DOCUMENT_EXTENSIONS: readonly string[] = [".pdf", ".docx", ".md", ".txt", ".csv"];

/** FR-PLAN-030: one folder per planning session. */
export const PLANS_FOLDER = `${TOOL_FOLDER_NAME}/plans`;
export const PLAN_SESSION_FILE = "session.json";
export const PLAN_ATTACHMENTS_FOLDER = "attachments";
export const PLAN_ID_PREFIX = "plan-";
/** A planning session ID, such as `plan-3` (FR-PLAN-030). */
export const PLAN_ID_SOURCE = "plan-[1-9]\\d{0,8}";
export const PLAN_ID_PATTERN = new RegExp(`^${PLAN_ID_SOURCE}$`);
/** FR-PLAN-005, FR-MCP-046: the planning tools a PM turn luseen drives may call. */
export const PLAN_DRIVEN_TOOL_NAMES = ["plan_status", "plan_suggest", "plan_propose"] as const;
/** FR-PLAN-058: the planning tools every PM turn luseen drives can't go without. */
export const PLAN_TURN_TOOL_NAMES = ["plan_suggest", "plan_propose"] as const;
/** FR-MCP-048: offered only to a new-project session. */
export const BRIEF_TOOL_NAME = "brief_propose";

/** FR-PLAN-050, FR-PLAN-051: the brief a new-project session writes, and where. */
export const BRIEF_LIMITS = { minChars: 200, maxChars: 20_000 } as const;
export const BRIEF_FILE = "README.md";
export const PROJECT_DOCS_FOLDER = "docs";
/** FR-PLAN-050: the brief's `##` sections, in order. */
export const BRIEF_SECTIONS: readonly string[] = [
  "What it is",
  "Who uses it",
  "Main features",
  "Stack",
  "How we write code",
  "Out of scope for now",
];

export const AUTO_LIMITS = {
  developers: { minimum: 1, maximum: 8, default: 2 },
  /** FR-AUTO-024: PM spec reviews, QA runs and PM implementation reviews, each per task. */
  roundsPerStage: 3,
} as const;

export const AUTO_FOLDER = `${TOOL_FOLDER_NAME}/auto`;
export const AUTO_BRANCH_PREFIX = "luseen/auto";
export const AUTO_LOCK_FILE = ".lock";
export const RUN_STATE_FILE = "run.json";
export const RUN_REPORT_FILE = "report.md";
export const RUN_LOGS_FOLDER = "logs";
/** FR-GUI-032: the most of a run's report or one log the GUI shows; a longer one shows its newest part. */
export const RUN_FILE_MAX_CHARS = 500_000;
/** FR-AUTO-039: one file per agent session, so the GUI can show it. */
export const RUN_SESSIONS_FOLDER = "sessions";
export const RUN_WORKTREES_FOLDER = "worktrees";
export const WIP_COMMIT_MARKER = "WIP";

/** Creating a worktree copies the project, which takes longer than other Git commands. */
export const AUTO_GIT_TIMEOUT_MS = 300_000;
export const AUTO_COMMIT_IDENTITY = { name: "luseen", email: "luseen@localhost" } as const;
export const MAX_REVIEW_DIFF_CHARS = 200_000;
/** The skills developer and QA agents follow. They must be committed, since agents work from HEAD. */
export const AUTO_REQUIRED_SKILLS: readonly string[] = [
  "create-spec",
  "refine-spec",
  "write-code",
  "implement-spec",
  "test-spec",
];
export const NOTIFY_TIMEOUT_MS = 10_000;
export const TERMINAL_BELL = "\u0007";
export const RUN_ID_FIELD_DIGITS = 2;
/** What `createRunId` makes: UTC `YYYYMMDD-HHMMSS`, maybe with `-2`, `-3`... */
/** A run ID, such as `20261112-150000` or `20261112-150000-2` (FR-AUTO-010). */
export const RUN_ID_SOURCE = "\\d{8}-\\d{6}(?:-\\d{1,6})?";
export const RUN_ID_PATTERN = new RegExp(`^${RUN_ID_SOURCE}$`);
/** The `YYYYMMDD-HHMMSS` part of a run ID. */
export const RUN_ID_TIME_LENGTH = 15;
/** The second run started in the same second gets `-2`. */
export const FIRST_RUN_ID_SUFFIX = 2;
