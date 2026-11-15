/** Carries a user and a project over from cclinic, Luseen's earlier name (FR-CLI-033, FR-CLI-036, FR-CLI-037). */
import path from "node:path";
import type { Command } from "commander";
import { copyLegacyConfig } from "../adapters/config/legacy-config.js";
import { configFile } from "../adapters/config/user-config.js";
import { readRepositoryState, excludeRunFolder } from "../adapters/git/run-branches.js";
import { repairWorktrees, worktreesUnder } from "../adapters/git/legacy-worktrees.js";
import { projectPaths } from "../adapters/storage/document-store.js";
import { applyLegacyMoves, planLegacyProject, type LegacyMove } from "../adapters/storage/legacy-project.js";
import {
  findLegacyInstalls,
  installSkills,
  readLegacyDocsPath,
  type SkillInstallEntry,
} from "../adapters/storage/skill-installer.js";
import { AUTO_FOLDER } from "../core/constants/agents.js";
import { ENV_VARS } from "../core/constants/llm.js";
import { LEGACY_TOOL_FOLDER_NAME, TOOL_FOLDER_NAME } from "../core/constants/paths.js";
import { SESSION_LINK_COMMAND } from "../core/constants/workflow.js";
import type { CommandContext } from "./generate-command.js";
import type { Reporter } from "./reporter.js";

/** FR-CLI-037: each variable cclinic read, and the one Luseen reads instead. */
const RENAMED_VARIABLES = [
  [ENV_VARS.LEGACY_PROVIDER, ENV_VARS.PROVIDER],
  [ENV_VARS.LEGACY_MODEL, ENV_VARS.MODEL],
  [ENV_VARS.LEGACY_EFFORT, ENV_VARS.EFFORT],
] as const;

/** Commands that never work on a project folder. */
const WITHOUT_PROJECT: ReadonlySet<string> = new Set(["guide", "model", SESSION_LINK_COMMAND]);

export async function migrateUserSettings(environment: NodeJS.ProcessEnv, reporter: Reporter): Promise<void> {
  for (const [legacy, name] of RENAMED_VARIABLES) {
    if (environment[legacy] !== undefined && environment[name] === undefined)
      reporter.notice(`${legacy} is no longer read. Set ${name} instead.`);
  }
  const folder = path.dirname(configFile(environment));
  try {
    const from = await copyLegacyConfig(environment);
    if (from !== undefined) reporter.notice(`Copied your saved settings from ${from} to ${folder}.`);
  } catch (error) {
    // Only a convenience, so it never stops the command.
    reporter.notice(`Couldn't copy your saved cclinic settings to ${folder} (${reason(error)}).`);
  }
}

/** The folder the command will work on: `-C, --dir` wins over a path, as in `luseen gui`. */
export function projectFolderOf(command: Command): string | undefined {
  if (WITHOUT_PROJECT.has(command.name())) return undefined;
  const takesPath = command.registeredArguments[0]?.name() === "path";
  const given = takesPath ? (command.processedArgs[0] as string | undefined) : undefined;
  return path.resolve(command.opts<{ dir?: string }>().dir ?? given ?? process.cwd());
}

function describe(moves: readonly LegacyMove[]): string {
  return moves.map((move) => `${move.from} to ${move.to}`).join(" and ");
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * FR-CLI-033: auto-run worktrees and the Git exclude entry follow the folder, inside a repository. Once the folder
 * has moved, a failure here is reported and left to the user, so the command itself still runs.
 */
async function moveRuns(target: string, worktrees: readonly string[], context: CommandContext): Promise<string[]> {
  const git = { environment: context.environment };
  if (!(await readRepositoryState(target, git)).isRepository) return [];
  const problems: string[] = [];
  const moved = worktrees.map((worktree) => path.join(TOOL_FOLDER_NAME, worktree));
  if (!(await repairWorktrees(target, moved, git)))
    problems.push(`Git couldn't repair these worktrees; run \`git worktree repair\` in each: ${moved.join(", ")}`);
  try {
    await excludeRunFolder(target, git);
  } catch (error) {
    problems.push(`Couldn't add /${AUTO_FOLDER}/ to Git's info/exclude (${reason(error)}); add it by hand.`);
  }
  return problems;
}

/** FR-CLI-038, after the move: a failure is reported, with how to finish, instead of failing the command. */
async function updateInstalls(
  target: string,
  installs: ReadonlySet<string>,
  out: string,
): Promise<{ readonly entries: readonly SkillInstallEntry[]; readonly problems: readonly string[] }> {
  if (installs.size === 0) return { entries: [], problems: [] };
  try {
    return { entries: await installSkills({ target, out, isForced: false, only: installs }), problems: [] };
  } catch (error) {
    return { entries: [], problems: [`Couldn't update cclinic's files (${reason(error)}); run \`luseen skills\`.`] };
  }
}

/** Runs before every command, so the command itself only ever sees `.luseen/` and Luseen's own install. */
export async function migrateProject(command: Command, context: CommandContext): Promise<void> {
  const target = projectFolderOf(command);
  if (target === undefined) return;
  const { reporter } = context;
  const state = await planLegacyProject(target);
  if (state.status === "none") return;
  const isDryRun = command.opts<{ dryRun?: boolean }>().dryRun === true;
  if (state.status === "both") {
    const ignore = state.moves.length === 0 ? "" : ` ${isDryRun ? "Would move" : "Moved"} ${describe(state.moves)}.`;
    if (!isDryRun) await applyLegacyMoves(target, state.moves);
    reporter.notice(`${LEGACY_TOOL_FOLDER_NAME}/ is no longer read; ${TOOL_FOLDER_NAME}/ is used instead.${ignore}`);
    return;
  }
  const installs = await findLegacyInstalls(target);
  const updates = installs.size === 0 ? "" : ` and update ${[...installs].join(", ")} to Luseen's`;
  if (isDryRun) {
    reporter.notice(`Would move ${describe(state.moves)}${updates}.`);
    return;
  }
  const worktrees = state.hasRuns
    ? await worktreesUnder(target, LEGACY_TOOL_FOLDER_NAME, { environment: context.environment })
    : [];
  await applyLegacyMoves(target, state.moves);
  const runProblems = state.hasRuns ? await moveRuns(target, worktrees, context) : [];
  const out = command.opts<{ out?: string }>().out;
  const docs = out === undefined ? await readLegacyDocsPath(target, installs) : undefined;
  const { entries, problems } = await updateInstalls(
    target,
    installs,
    out === undefined && docs !== undefined ? path.join(target, docs) : projectPaths(target, out).out,
  );
  const updated = entries.filter((entry) => entry.status === "updated").map((entry) => entry.path);
  const kept = entries.filter((entry) => entry.status.startsWith("skipped"));
  reporter.notice(
    [
      `Moved ${describe(state.moves)}, as cclinic is now Luseen.`,
      ...(updated.length === 0 ? [] : [`Updated ${updated.join(", ")} to Luseen's.`]),
      ...kept.map((entry) => `Left ${entry.path}: ${entry.status}.`),
      "Commit the move.",
    ].join(" "),
  );
  for (const problem of [...runProblems, ...problems]) reporter.notice(problem);
}
