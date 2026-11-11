/** Writes the agent skills and the AGENTS.md section, without touching anyone else's work. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_SKILLS,
  classifySkill,
  isSameSkill,
  mergeManagedSection,
  renderAgentsBlock,
  renderClaudeBlock,
  renderSkill,
} from "../../core/agent-skills.js";
import { AGENTS_FILE, CLAUDE_FILE, SKILL_FILE, SKILL_FOLDERS } from "../../core/constants/paths.js";
import { CLAUDE_SETTINGS_FILE, CODEX_MCP_CONFIG, MCP_CONFIG_FILE } from "../../core/constants/workflow.js";
import { mergeClaudeSettings, mergeMcpConfig, type McpConfigMerge } from "../../core/mcp-config.js";
import { sha256 } from "./document-store.js";

export type SkillStatus =
  | "installed"
  | "updated"
  | "unchanged"
  | "skipped: not created by cclinic"
  | "skipped: edited, use --force to replace"
  | "skipped: damaged markers"
  | "skipped: not valid JSON";

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
  if (state === "foreign") return "skipped: not created by cclinic";
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
 * FR-MCP-004, FR-MCP-044: cclinic's server in `.mcp.json` and its hook in `.claude/settings.json`, next to
 * everything else there, and never over a cclinic entry the user changed.
 */
async function installJsonEntry(
  file: string,
  merge: (existing: string | undefined) => McpConfigMerge,
): Promise<SkillStatus> {
  const merged = merge(await readIfExists(file));
  if ("content" in merged) {
    await writeAtomically(file, merged.content);
    return merged.status;
  }
  const statuses = {
    kept: "skipped: not created by cclinic",
    unreadable: "skipped: not valid JSON",
    unchanged: "unchanged",
  } as const;
  return statuses[merged.status];
}

export interface InstallOptions {
  readonly target: string;
  readonly out: string;
  readonly isForced: boolean;
}

/** The documents folder as the agent should refer to it: relative to the project, with forward slashes. */
export function relativeDocsPath(target: string, out: string): string {
  return path.relative(target, out).split(path.sep).join("/");
}

export async function installSkills(options: InstallOptions): Promise<readonly SkillInstallEntry[]> {
  const { target, out, isForced } = options;
  const docsPath = relativeDocsPath(target, out);
  const entries: SkillInstallEntry[] = [];
  for (const folder of SKILL_FOLDERS) {
    for (const skill of AGENT_SKILLS) {
      const relative = `${folder}/${skill.name}/${SKILL_FILE}`;
      const status = await installSkillFile(
        path.join(target, relative),
        renderSkill(skill, docsPath, sha256),
        isForced,
      );
      entries.push({ path: relative, status });
    }
  }
  entries.push({
    path: AGENTS_FILE,
    status: await installInstructionFile(path.join(target, AGENTS_FILE), renderAgentsBlock(docsPath)),
  });
  entries.push({
    path: CLAUDE_FILE,
    status: await installInstructionFile(path.join(target, CLAUDE_FILE), renderClaudeBlock()),
  });
  entries.push({
    path: MCP_CONFIG_FILE,
    status: await installJsonEntry(path.join(target, MCP_CONFIG_FILE), mergeMcpConfig),
  });
  entries.push({
    path: CLAUDE_SETTINGS_FILE,
    status: await installJsonEntry(path.join(target, CLAUDE_SETTINGS_FILE), mergeClaudeSettings),
  });
  return entries;
}

export function summarizeInstall(entries: readonly SkillInstallEntry[]): string {
  const counts = new Map<string, number>();
  for (const { status } of entries) {
    const label = status.startsWith("skipped") ? "skipped" : status;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const summary = ["installed", "updated", "unchanged", "skipped"]
    .filter((label) => counts.has(label))
    .map((label) => `${counts.get(label) ?? 0} ${label}`)
    .join(", ");
  return `Agent skills: ${summary}. Locations: ${SKILL_FOLDERS.join(", ")}, ${AGENTS_FILE}, ${CLAUDE_FILE}, ${MCP_CONFIG_FILE}, ${CLAUDE_SETTINGS_FILE}
For Codex, add the cclinic MCP server to ~/.codex/config.toml:
${CODEX_MCP_CONFIG}`;
}

export async function hasInstalledSkills(target: string): Promise<boolean> {
  const first = AGENT_SKILLS[0];
  if (first === undefined) return false;
  const file = path.join(target, SKILL_FOLDERS[0], first.name, SKILL_FILE);
  return (await readIfExists(file)) !== undefined;
}
