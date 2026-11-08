/** Values for the local environment step (spec: local-environment). */
import { SECRET_NAMES } from "./discovery.js";
import { TOOL_FOLDER_NAME } from "./paths.js";

export const DEVOPS_SKILL_NAME = "devops";
export const ENVIRONMENT_FOLDER = `${TOOL_FOLDER_NAME}/environment`;
export const ENVIRONMENT_FILE = "environment.json";
export const ENVIRONMENT_FILE_VERSION = 1;
export const ENVIRONMENT_ALIAS_MAX_LENGTH = 63;
export const ENVIRONMENT_PART_TYPES = ["web", "ios", "android", "desktop", "cli", "library"] as const;

export const ENVIRONMENT_TIMEOUT_MS = 900_000;
export const ENVIRONMENT_MAX_BUDGET_USD = 2;

export const ENVIRONMENT_AGENT_TOOLS: readonly string[] = ["Read", "Glob", "Grep", "Write", "Edit", "Bash"];

const BUILD_COMMANDS = [
  "cd",
  "echo",
  "sleep",
  "docker",
  "curl",
  "lsof",
  "ls",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "python3",
  "pip3",
  "uv",
  "poetry",
  "cargo",
  "go",
  "make",
  "mvn",
  "gradle",
  "./gradlew",
  "dotnet",
  "bundle",
  "composer",
  "swift",
  "xcodebuild",
  "xcrun",
  "adb",
  "emulator",
  "flutter",
];

/** Writes are limited to the environment folder, so a project's own files, including Docker files, can't be edited. */
export const ENVIRONMENT_AGENT_ALLOWED_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  `Write(./${ENVIRONMENT_FOLDER}/**)`,
  `Edit(./${ENVIRONMENT_FOLDER}/**)`,
  ...BUILD_COMMANDS.map((command) => `Bash(${command} *)`),
];

const SECRET_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.staging",
  ".env.production",
  ".env.test",
  ...SECRET_NAMES,
];

/** Claude Code runs read-only commands such as `git status` without an allow rule, so these need explicit denial. */
export const ENVIRONMENT_AGENT_DENIED_TOOLS: readonly string[] = [
  "Bash(git *)",
  "Bash(sudo *)",
  "Bash(* .env*)",
  ...SECRET_FILES.map((file) => `Read(**/${file})`),
];
