/** Values for Git setup and history (FR-GIT-024). */
import { MANAGED_INSTRUCTION_FILES, SKILL_FOLDERS, TOOL_FOLDER_NAME } from "./paths.js";
import { MCP_CONFIG_FILE } from "./workflow.js";

export const GIT_COMMAND = "git";
export const GIT_FOLDER = ".git";
export const DEFAULT_BRANCH = "main";
export const PREFERRED_REMOTE = "origin";
export const GIT_TIMEOUT_MS = 15_000;
export const GIT_MAX_OUTPUT_BYTES = 67_108_864;

export const HISTORY_WINDOW_DAYS = 14;
export const MS_PER_DAY = 86_400_000;
export const MAX_HISTORY_COMMITS = 300;
export const MAX_HISTORY_CHARS = 100_000;

/** Commits touching only these are cclinic's own output, so they aren't project changes (FR-GIT-014). */
export const HISTORY_EXCLUDED_PATHS: readonly string[] = [
  TOOL_FOLDER_NAME,
  ...SKILL_FOLDERS.map((folder) => folder.slice(0, folder.indexOf("/"))),
  ...MANAGED_INSTRUCTION_FILES,
  MCP_CONFIG_FILE,
];

/** Stops a scanned repository's settings from running programs (FR-GIT-023). */
export const GIT_SAFE_ARGS: readonly string[] = [
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotepath=false",
  "-c",
  "log.showSignature=false",
];

/** Set by Git hooks and similar. They would redirect commands away from the target. */
export const GIT_ENV_TO_REMOVE: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_EXTERNAL_DIFF",
];

export const REMOTE_PROVIDER_LINKS: readonly string[] = [
  "https://github.com/new",
  "https://gitlab.com/projects/new",
  "https://bitbucket.org/repo/create",
];

export const GIT_INSTALL_LINK = "https://git-scm.com/downloads";

/** `git status --porcelain` puts two status letters and a space before each path. */
export const PORCELAIN_PATH_START = 3;
