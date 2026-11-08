/** The `model`, `doctor` and `clean` commands. */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { configFile, readSavedSettings, resetSettings, saveSettings } from "../adapters/config/user-config.js";
import { detectGit } from "../adapters/git/git-repository.js";
import { decideProvider, hasApiKey, probeClaude } from "../adapters/llm/select-provider.js";
import { checkWritable, cleanProject, projectPaths } from "../adapters/storage/document-store.js";
import { hasInstalledSkills, installSkills, summarizeInstall } from "../adapters/storage/skill-installer.js";
import { BYTES_PER_KIB, BYTES_PER_MIB, MINIMUM_NODE, VERSION_CHECK_TIMEOUT_MS } from "../core/constants/limits.js";
import { LIST_LABEL_WIDTH, LIST_VALUE_WIDTH, SIZE_DECIMAL_PLACES } from "../core/constants/terminal.js";
import { GIT_INSTALL_LINK } from "../core/constants/git.js";
import { EXIT_CODES, UsageError } from "../core/errors.js";
import type { GitStatus } from "../core/git-history.js";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORT_OPTIONS,
  labelForEffort,
  labelForModel,
  MODEL_OPTIONS,
} from "../core/models.js";
import { isClaudeVersionUntested, isSupportedNode, TESTED_CLAUDE_VERSION_TEXT } from "../core/node-version.js";
import type { CommandContext } from "./generate-command.js";
import { askToConfirm, chooseEffort, chooseModel, isInteractive, requireTerminal } from "./menus.js";

export interface ModelCommandOptions {
  readonly list?: boolean;
  readonly reset?: boolean;
  readonly json?: boolean;
}

export async function runModelCommand(options: ModelCommandOptions, context: CommandContext): Promise<void> {
  const { environment, reporter } = context;
  if (options.reset === true) {
    await resetSettings(environment);
    reporter.result(
      `The saved default was removed. Using ${labelForModel(DEFAULT_MODEL)} at ${labelForEffort(DEFAULT_EFFORT)}.`,
    );
    return;
  }
  const saved = await readSavedSettings(environment);
  for (const warning of saved.warnings) reporter.warn(warning);
  const model = saved.model ?? DEFAULT_MODEL;
  const effort = saved.effort ?? DEFAULT_EFFORT;

  if (options.list === true) {
    if (options.json === true) {
      reporter.result(JSON.stringify({ current: { model, effort }, models: MODEL_OPTIONS, efforts: EFFORT_OPTIONS }));
      return;
    }
    const row = (isCurrent: boolean, value: string, label: string, hint: string): string =>
      `${isCurrent ? "*" : " "} ${value.padEnd(LIST_VALUE_WIDTH)}${label.padEnd(LIST_LABEL_WIDTH)}${hint}`;
    reporter.result(
      [
        "Models (--model):",
        ...MODEL_OPTIONS.map((option) => row(option.value === model, option.value, option.label, option.hint)),
        "",
        "Reasoning levels (--effort):",
        ...EFFORT_OPTIONS.map((option) => row(option.value === effort, option.value, option.label, option.hint)),
        "",
        "* is the current choice.",
      ].join("\n"),
    );
    return;
  }

  requireTerminal();
  const chosenModel = await chooseModel(model);
  const chosenEffort = await chooseEffort(effort);
  await saveSettings(environment, { model: chosenModel, effort: chosenEffort });
  reporter.result(
    `Saved: ${labelForModel(chosenModel)} at ${labelForEffort(chosenEffort)} reasoning (${configFile(environment)}).`,
  );
}

type CheckState = "passed" | "failed" | "skipped";

export interface DoctorCheck {
  readonly name: string;
  readonly state: CheckState;
  readonly detail: string;
  readonly fix?: string;
}

export async function checkLatestVersion(
  current: string,
  fetcher: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }> = fetch,
  timeoutMs: number = VERSION_CHECK_TIMEOUT_MS,
): Promise<DoctorCheck> {
  const name = "cclinic version";
  try {
    const response = await fetcher("https://registry.npmjs.org/cclinic/latest", {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { name, state: "skipped", detail: `${current}. Couldn't check for a newer version` };
    const { version } = (await response.json()) as { version?: unknown };
    if (typeof version === "string" && version !== current) {
      return {
        name,
        state: "passed",
        detail: `${current}. Version ${version} is on npm`,
        fix: "Run: npm update -g cclinic",
      };
    }
    return { name, state: "passed", detail: `${current}, which is the latest` };
  } catch {
    return { name, state: "skipped", detail: `${current}. Couldn't check for a newer version` };
  }
}

/** Git is optional, so these never make cclinic "not ready" (FR-GIT-003). */
function gitChecks(status: GitStatus): readonly DoctorCheck[] {
  switch (status.kind) {
    case "not-installed":
      return [{ name: "Git", state: "skipped", detail: "not installed", fix: `Install it from ${GIT_INSTALL_LINK}` }];
    case "unavailable":
      return [{ name: "Git", state: "skipped", detail: status.reason }];
    case "repository":
      return [
        { name: "Git repository", state: "passed", detail: status.root },
        status.remote === undefined
          ? {
              name: "Git remote",
              state: "skipped",
              detail: "none",
              fix: "Run: git remote add origin <repository-url>",
            }
          : { name: "Git remote", state: "passed", detail: `${status.remote.name} (${status.remote.host})` },
      ];
    default:
      return [
        {
          name: "Git repository",
          state: "skipped",
          detail: "none",
          fix: "Run cclinic to create one, or run: git init",
        },
      ];
  }
}

export async function runDoctor(
  given: string | undefined,
  options: { readonly json?: boolean },
  context: CommandContext,
): Promise<number> {
  const { environment, reporter, version } = context;
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck): void => {
    checks.push(check);
  };

  const nodeVersion = process.versions.node;
  add(
    isSupportedNode(nodeVersion)
      ? { name: "Node.js", state: "passed", detail: nodeVersion }
      : {
          name: "Node.js",
          state: "failed",
          detail: nodeVersion,
          fix: `Install Node.js ${MINIMUM_NODE.major}.${MINIMUM_NODE.minor} or newer.`,
        },
  );

  const claude = await probeClaude(environment);
  add(
    claude.isInstalled
      ? {
          name: "Claude CLI",
          state: "passed",
          detail: isClaudeVersionUntested(claude.version)
            ? `${claude.version || "unknown version"} (older than the tested version ${TESTED_CLAUDE_VERSION_TEXT})`
            : claude.version,
        }
      : {
          name: "Claude CLI",
          state: "failed",
          detail: "not found",
          fix: "Install Claude Code, or set ANTHROPIC_API_KEY.",
        },
  );
  add(
    claude.isInstalled
      ? claude.isLoggedIn
        ? { name: "Claude CLI login", state: "passed", detail: claude.authMethod }
        : { name: "Claude CLI login", state: "failed", detail: "not logged in", fix: "Run: claude auth login" }
      : { name: "Claude CLI login", state: "skipped", detail: "the Claude CLI isn't installed" },
  );

  const hasKey = hasApiKey(environment);
  add({ name: "ANTHROPIC_API_KEY", state: hasKey ? "passed" : "skipped", detail: hasKey ? "set" : "not set" });

  const resolved = decideProvider("auto", claude, hasKey);
  add(
    resolved.kind === "none"
      ? {
          name: "Provider",
          state: "failed",
          detail: "none available",
          fix: 'Run "claude auth login", or set ANTHROPIC_API_KEY.',
        }
      : { name: "Provider", state: "passed", detail: resolved.kind },
  );

  const saved = await readSavedSettings(environment);
  add({
    name: "Saved model and reasoning",
    state: "passed",
    detail: `${labelForModel(saved.model ?? DEFAULT_MODEL)} at ${labelForEffort(saved.effort ?? DEFAULT_EFFORT)}`,
  });
  add(
    saved.warnings.length === 0
      ? { name: "Config", state: "passed", detail: configFile(environment) }
      : { name: "Config", state: "failed", detail: saved.warnings.join(" "), fix: "Run: cclinic model --reset" },
  );

  const target = path.resolve(given ?? process.cwd());
  try {
    await stat(target);
    await checkWritable(projectPaths(await realpath(target), undefined));
    add({ name: "Output folder", state: "passed", detail: `${target} is writable` });
  } catch {
    add({
      name: "Output folder",
      state: "failed",
      detail: `Can't write to ${target}`,
      fix: "Check the folder and its permissions.",
    });
  }
  add(
    (await hasInstalledSkills(target))
      ? { name: "Agent skills", state: "passed", detail: "installed" }
      : { name: "Agent skills", state: "skipped", detail: "not installed", fix: "Run: cclinic skills" },
  );
  for (const check of gitChecks(await detectGit(target, { environment }))) add(check);
  add(await checkLatestVersion(version));

  const isReady = resolved.kind !== "none";
  if (options.json === true) {
    reporter.result(JSON.stringify({ ready: isReady, checks }));
  } else {
    const symbols: Record<CheckState, string> = { passed: "ok  ", failed: "FAIL", skipped: "skip" };
    const lines = checks.flatMap((check) => [
      `${symbols[check.state]} ${check.name}: ${check.detail}`,
      ...(check.fix === undefined ? [] : [`     ${check.fix}`]),
    ]);
    reporter.result([...lines, "", isReady ? "cclinic is ready to run." : "cclinic isn't ready yet."].join("\n"));
  }
  return isReady ? EXIT_CODES.success : EXIT_CODES.noProvider;
}

function formatBytes(bytes: number): string {
  if (bytes < BYTES_PER_KIB) return `${bytes} bytes`;
  if (bytes < BYTES_PER_MIB) return `${(bytes / BYTES_PER_KIB).toFixed(SIZE_DECIMAL_PLACES)} KB`;
  return `${(bytes / BYTES_PER_MIB).toFixed(SIZE_DECIMAL_PLACES)} MB`;
}

export interface SkillsCommandOptions {
  readonly out?: string;
  readonly force?: boolean;
  readonly json?: boolean;
}

/** Installs the skills without calling Claude, so it needs no provider (FR-SKILL-006). */
export async function runSkillsCommand(
  given: string | undefined,
  options: SkillsCommandOptions,
  context: CommandContext,
): Promise<void> {
  const absolute = path.resolve(given ?? process.cwd());
  const isFolder = await stat(absolute).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!isFolder) throw new UsageError(`"${given ?? absolute}" isn't a folder.`);
  const target = await realpath(absolute);
  const paths = projectPaths(target, options.out);
  const entries = await installSkills({ target, out: paths.out, isForced: options.force === true });
  if (options.json === true) {
    context.reporter.result(JSON.stringify({ status: "success", skills: entries }));
    return;
  }
  context.reporter.result(
    [
      summarizeInstall(entries),
      ...entries
        .filter((entry) => entry.status.startsWith("skipped"))
        .map((entry) => `  ${entry.path} ${entry.status}`),
    ].join("\n"),
  );
}

export async function runClean(
  given: string | undefined,
  options: { readonly yes?: boolean },
  context: CommandContext,
): Promise<void> {
  const target = path.resolve(given ?? process.cwd());
  const paths = projectPaths(target, undefined);
  if (options.yes !== true) {
    if (!isInteractive()) {
      throw new UsageError("Confirmation needs an interactive terminal. Use --yes to clean without asking.");
    }
    if (
      !(await askToConfirm(
        `Delete the cache and failed drafts in ${paths.tool}? Rebuilding cached results uses Claude usage.`,
      ))
    ) {
      context.reporter.result("Nothing was deleted.");
      return;
    }
  }
  const freed = await cleanProject(paths);
  context.reporter.result(`Freed ${formatBytes(freed)}. Generated documents were not touched.`);
}
