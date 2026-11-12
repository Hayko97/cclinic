/** Values for the PM, developer and QA agents (specs: roadmap-planning, automated-mode). */
import { BUILD_COMMANDS, SECRET_FILES } from "./environment.js";
import { TOOL_FOLDER_NAME } from "./paths.js";

export const READ_ONLY_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];
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

/** FR-PLAN-015. The limits are estimates, recorded as an open question. */
export const PLAN_LIMITS = {
  maxTurns: 20,
  maxBudgetUsd: 2,
  maxQuestions: 5,
  invalidRepliesInARow: 2,
} as const;

export const AUTO_LIMITS = {
  developers: { minimum: 1, maximum: 8, default: 2 },
  /** FR-AUTO-024: PM spec reviews, QA runs and PM implementation reviews, each per task. */
  roundsPerStage: 3,
} as const;

export const AUTO_FOLDER = `${TOOL_FOLDER_NAME}/auto`;
export const AUTO_BRANCH_PREFIX = "cclinic/auto";
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
export const AUTO_COMMIT_IDENTITY = { name: "cclinic", email: "cclinic@localhost" } as const;
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
