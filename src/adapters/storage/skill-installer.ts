/** Writes the agent skills and the AGENTS.md section, without touching anyone else's work. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_SKILLS,
  classifySkill,
  holdsLegacyInstall,
  isSameSkill,
  legacyDocsPath,
  mergeManagedSection,
  renderAgentsBlock,
  renderClaudeBlock,
  renderSkill,
  type SkillSource,
} from "../../core/agent-skills.js";
import { AGENTS_FILE, CLAUDE_FILE, LEGACY_NAME, SKILL_FILE, SKILL_FOLDERS } from "../../core/constants/paths.js";
import { CLAUDE_SETTINGS_FILE, CODEX_MCP_CONFIG, MCP_CONFIG_FILE } from "../../core/constants/workflow.js";
import { holdsLegacyEntry, mergeClaudeSettings, mergeMcpConfig, type McpConfigMerge } from "../../core/mcp-config.js";
import { sha256 } from "./document-store.js";

export type SkillStatus =
  | "installed"
  | "updated"
  | "unchanged"
  | "skipped: not created by luseen"
  | "skipped: edited, use --force to replace"
  | "skipped: damaged markers"
  | "skipped: not valid JSON"
  | "skipped: cclinic entry changed by hand";

export interface SkillInstallEntry {
  readonly path: string;
  readonly status: SkillStatus;
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomically(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}

async function installSkillFile(file: string, rendered: string, isForced: boolean): Promise<SkillStatus> {
  const existing = await readIfExists(file);
  if (existing === undefined) {
    await writeAtomically(file, rendered);
    return "installed";
  }
  if (isSameSkill(existing, rendered)) return "unchanged";
  const state = classifySkill(existing, sha256);
  if (state === "foreign") return "skipped: not created by luseen";
  if (state === "edited" && !isForced) return "skipped: edited, use --force to replace";
  await writeAtomically(file, rendered);
  return "updated";
}

async function installInstructionFile(file: string, section: string): Promise<SkillStatus> {
  const existing = await readIfExists(file);
  const merged = mergeManagedSection(existing, section);
  if (merged === undefined) return "skipped: damaged markers";
  if (merged === existing) return "unchanged";
  await writeAtomically(file, merged);
  return existing === undefined ? "installed" : "updated";
}

/**
 * FR-MCP-004, FR-MCP-044: luseen's server in `.mcp.json` and its hook in `.claude/settings.json`, next to
 * everything else there, and never over a luseen entry the user changed.
 */
async function installJsonEntry(
  target: string,
  relative: string,
  merge: (existing: string | undefined) => McpConfigMerge,
): Promise<readonly SkillInstallEntry[]> {
  const file = path.join(target, relative);
  const merged = merge(await readIfExists(file));
  // FR-CLI-034: a cclinic entry changed by hand is left in place, and reported on its own line.
  const legacy: readonly SkillInstallEntry[] =
    merged.legacyKept === true
      ? [{ path: `${relative} (${LEGACY_NAME})`, status: "skipped: cclinic entry changed by hand" }]
      : [];
  if ("content" in merged) {
    await writeAtomically(file, merged.content);
    return [{ path: relative, status: merged.status }, ...legacy];
  }
  const statuses = {
    kept: "skipped: not created by luseen",
    unreadable: "skipped: not valid JSON",
    unchanged: "unchanged",
  } as const;
  return [{ path: relative, status: statuses[merged.status] }, ...legacy];
}

export interface InstallOptions {
  readonly target: string;
  readonly out: string;
  readonly isForced: boolean;
  /** Install only into these files, relative to the target (FR-CLI-038). */
  readonly only?: ReadonlySet<string>;
  /** With the plugin, it brings the skills, so no skill folders go in; the sections, server and hook do (FR-PLUG-013). */
  readonly skillSource?: SkillSource;
}

function skillPaths(): string[] {
  return SKILL_FOLDERS.flatMap((folder) => AGENT_SKILLS.map((skill) => `${folder}/${skill.name}/${SKILL_FILE}`));
}

/** FR-CLI-038: the documents folder cclinic's install names, if any of those files names one. */
export async function readLegacyDocsPath(target: string, installs: ReadonlySet<string>): Promise<string | undefined> {
  for (const relative of installs) {
    const docs = legacyDocsPath((await readIfExists(path.join(target, relative))) ?? "");
    if (docs !== undefined) return docs;
  }
  return undefined;
}

/** FR-CLI-038: the files that still hold a section, skill, server entry or hook cclinic installed. */
export async function findLegacyInstalls(target: string): Promise<ReadonlySet<string>> {
  const found = new Set<string>();
  const checks: readonly [readonly string[], (content: string) => boolean][] = [
    [[...skillPaths(), AGENTS_FILE, CLAUDE_FILE], holdsLegacyInstall],
    [[MCP_CONFIG_FILE, CLAUDE_SETTINGS_FILE], holdsLegacyEntry],
  ];
  for (const [files, holdsLegacy] of checks)
    for (const relative of files) {
      const content = await readIfExists(path.join(target, relative));
      if (content !== undefined && holdsLegacy(content)) found.add(relative);
    }
  return found;
}

/** The documents folder as the agent should refer to it: relative to the project, with forward slashes. */
export function relativeDocsPath(target: string, out: string): string {
  return path.relative(target, out).split(path.sep).join("/");
}

export async function installSkills(options: InstallOptions): Promise<readonly SkillInstallEntry[]> {
  const { target, out, isForced, only, skillSource = "project" } = options;
  const isIncluded = (relative: string): boolean => only === undefined || only.has(relative);
  const docsPath = relativeDocsPath(target, out);
  const instructions = [
    [AGENTS_FILE, renderAgentsBlock(docsPath, skillSource)],
    [CLAUDE_FILE, renderClaudeBlock()],
  ] as const;
  const entries: SkillInstallEntry[] = [];
  for (const folder of skillSource === "plugin" ? [] : SKILL_FOLDERS) {
    for (const skill of AGENT_SKILLS) {
      const relative = `${folder}/${skill.name}/${SKILL_FILE}`;
      if (!isIncluded(relative)) continue;
      const status = await installSkillFile(
        path.join(target, relative),
        renderSkill(skill, docsPath, sha256),
        isForced,
      );
      entries.push({ path: relative, status });
    }
  }
  for (const [relative, section] of instructions)
    if (isIncluded(relative))
      entries.push({ path: relative, status: await installInstructionFile(path.join(target, relative), section) });
  const jsonEntries = [
    [MCP_CONFIG_FILE, mergeMcpConfig],
    [CLAUDE_SETTINGS_FILE, mergeClaudeSettings],
  ] as const;
  for (const [relative, merge] of jsonEntries)
    if (isIncluded(relative)) entries.push(...(await installJsonEntry(target, relative, merge)));
  return entries;
}

export function summarizeInstall(entries: readonly SkillInstallEntry[], skillSource: SkillSource = "project"): string {
  const counts = new Map<string, number>();
  for (const { status } of entries) {
    const label = status.startsWith("skipped") ? "skipped" : status;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const summary = ["installed", "updated", "unchanged", "skipped"]
    .filter((label) => counts.has(label))
    .map((label) => `${counts.get(label) ?? 0} ${label}`)
    .join(", ");
  if (skillSource === "plugin")
    return `Agent instructions: ${summary}. Locations: ${AGENTS_FILE}, ${CLAUDE_FILE}, ${MCP_CONFIG_FILE}, ${CLAUDE_SETTINGS_FILE}. The skills come from the luseen Claude Code plugin.`;
  return `Agent skills: ${summary}. Locations: ${SKILL_FOLDERS.join(", ")}, ${AGENTS_FILE}, ${CLAUDE_FILE}, ${MCP_CONFIG_FILE}, ${CLAUDE_SETTINGS_FILE}
For Codex, add the luseen MCP server to ~/.codex/config.toml:
${CODEX_MCP_CONFIG}`;
}

export async function hasInstalledSkills(target: string): Promise<boolean> {
  const first = AGENT_SKILLS[0];
  if (first === undefined) return false;
  const file = path.join(target, SKILL_FOLDERS[0], first.name, SKILL_FILE);
  return (await readIfExists(file)) !== undefined;
}
