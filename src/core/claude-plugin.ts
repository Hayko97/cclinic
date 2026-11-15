/**
 * The Claude Code plugin and its marketplace, as files (spec: claude-plugin). The plugin holds no logic of its own:
 * it runs the `luseen` package at its own version, and its skills are the ones `luseen skills` installs.
 */
import { z } from "zod";
import { PM_TOOLS } from "./constants/agents.js";
import { PRODUCT_NAME, SKILL_FILE } from "./constants/paths.js";
import {
  MARKETPLACE_DESCRIPTION,
  MARKETPLACE_FILE,
  MARKETPLACE_NAME,
  MARKETPLACE_OWNER,
  PLUGIN_AGENTS_FOLDER,
  PLUGIN_DOCS_PATH,
  PLUGIN_FOLDER,
  PLUGIN_HOOKS_FILE,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  PLUGIN_NAME,
  PLUGIN_SKILLS_FOLDER,
  PLUGIN_TOOL_PREFIX,
  PACKAGE_RUNNER,
  PACKAGE_RUNNER_YES_FLAG,
  PM_AGENT_NAME,
  PM_AGENT_PLAN_TOOL_NAMES,
} from "./constants/plugin.js";
import { JSON_INDENT } from "./constants/terminal.js";
import { MCP_COMMAND, MCP_SERVER_NAME, SESSION_LINK_COMMAND } from "./constants/workflow.js";
import { AGENT_SKILLS, renderSkill, type AgentSkill } from "./agent-skills.js";

export const packageInfoSchema = z.object({
  version: z.string().min(1),
  description: z.string().min(1),
  author: z.string().min(1),
  homepage: z.url(),
  license: z.string().min(1),
  repository: z.object({ url: z.string().min(1) }),
});

export type PackageInfo = z.infer<typeof packageInfoSchema>;

const GITHUB_REPOSITORY = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/;

/** `owner/repo` from package.json's repository URL, such as `git+https://github.com/owner/repo.git`. */
export function repositorySlug(info: PackageInfo): string {
  const slug = GITHUB_REPOSITORY.exec(info.repository.url)?.[1];
  if (slug === undefined) throw new Error(`package.json's repository isn't on GitHub: ${info.repository.url}`);
  return slug;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, JSON_INDENT)}\n`;
}

/** The package at the plugin's own version, so the plugin and the CLI it runs never drift (FR-PLUG-004). */
function pinnedRun(info: PackageInfo): readonly string[] {
  return [PACKAGE_RUNNER, PACKAGE_RUNNER_YES_FLAG, `${PRODUCT_NAME}@${info.version}`];
}

/** Skills that only the plugin has, run as `/luseen:<name>`. {{RUN}} is the pinned `npx` command. */
const PLUGIN_SKILLS: readonly AgentSkill[] = [
  {
    name: "init",
    description: `Sets up ${PRODUCT_NAME} in this project: analyses it with Claude, writes its specs to ${PLUGIN_DOCS_PATH}, and adds ${PRODUCT_NAME}'s section to AGENTS.md and CLAUDE.md. Use when the user asks to set up ${PRODUCT_NAME}, or a ${PRODUCT_NAME} tool says the project isn't set up.`,
    body: `# Set up ${PRODUCT_NAME} in this project

1. **Check whether it's set up.** If \`${PLUGIN_DOCS_PATH}\` exists in the project root, tell the user the project is already set up, and stop. Change nothing.
2. **Ask first.** Tell the user that setup analyses the whole project with Claude, using their Claude usage, and can take several minutes. It writes the specs to \`${PLUGIN_DOCS_PATH}\` and adds ${PRODUCT_NAME}'s section to \`AGENTS.md\` and \`CLAUDE.md\`. Ask whether to start, and wait for their answer.
3. **If they say no,** do nothing more.
4. **If they say yes,** run \`{{RUN}} --yes --plugin\` in the project root. It can take longer than a command's usual time limit, so run it in the background if you can, and wait for it to finish. Report its result: the specs and requirements it wrote, or the error it printed and the fix it gives, such as installing the \`claude\` executable.
5. **Connect the tools.** Once it succeeds, tell the user to run \`/mcp\` and reconnect the \`${MCP_SERVER_NAME}\` server, so ${PRODUCT_NAME}'s tools work with the new documents.
`,
  },
  {
    name: "plan",
    description: `Plans a roadmap of milestones and tasks, or one concrete task, with ${PRODUCT_NAME}'s PM, in a conversation with the user. Use when the user wants to plan, build a roadmap, create or refine tasks, or decide what to build next.`,
    body: `# Plan with ${PRODUCT_NAME}

The user's request: $ARGUMENTS

1. **Know what to plan.** If the request doesn't say whether to plan a new roadmap, more milestones for a roadmap, or one task, ask the user, and wait.
2. **Begin the planning session.** Before any other tool call, call the ${PRODUCT_NAME} MCP tool \`plan_begin\` with the target and the user's request in their words. Use the planning ID it returns with every other plan tool.
3. **Plan as the \`product-engineer\` skill says,** from its steps, skipping how it begins a session.
`,
  },
  {
    name: "status",
    description: `Shows where the current change stands in ${PRODUCT_NAME}'s workflow, and the open tasks. Use when the user asks for the status, the current change, or what's waiting for them.`,
    body: `# Show the status

1. Call the ${PRODUCT_NAME} MCP tool \`workflow_status\`. If it says the project isn't set up, tell the user to run \`/${PLUGIN_NAME}:init\`, and stop.
2. Call \`tasks_list\`.
3. Sum up in a few lines: the open change, with its step, spec and task, and the approval it's waiting for, if any; then the open tasks, with their ID, title and status. Say so when there's no open change or no open task.
`,
  },
  {
    name: "gui",
    description: `Starts ${PRODUCT_NAME}'s local board of roadmaps, tasks, automated runs and Claude sessions, and gives the user its link. Use when the user asks for the GUI, the board or the dashboard.`,
    body: `# Open the board

1. Start \`{{RUN}} gui --no-open --json\` in the background in the project root. It keeps running while the board is open.
2. Its first line of output is JSON with the board's \`url\`. Give the user that link.
3. If it fails, show the user its error.
4. Tell the user that stopping the background command closes the board.
`,
  },
];

function renderPluginSkill(skill: AgentSkill, info: PackageInfo): string {
  return `---
name: ${skill.name}
description: ${JSON.stringify(skill.description)}
---

${skill.body.replaceAll("{{RUN}}", pinnedRun(info).join(" "))}`;
}

/** FR-PLUG-011: the PM as an agent with the `product-engineer` instructions, that can't edit files or run commands. */
function renderPmAgent(): string {
  const productEngineer = AGENT_SKILLS.find((skill) => skill.name === "product-engineer");
  if (productEngineer === undefined) throw new Error("The product-engineer skill is missing.");
  const tools = [...PM_TOOLS, ...PM_AGENT_PLAN_TOOL_NAMES.map((name) => `${PLUGIN_TOOL_PREFIX}${name}`)];
  return `---
name: ${PM_AGENT_NAME}
description: ${JSON.stringify(`${PRODUCT_NAME}'s PM. ${productEngineer.description}`)}
tools: ${tools.join(", ")}
---

${productEngineer.body.replaceAll("{{DOCS}}", PLUGIN_DOCS_PATH)}`;
}

/** Every file of the plugin and its marketplace, by path from the repository root (FR-PLUG-012). */
export function renderClaudePlugin(info: PackageInfo, hash: (text: string) => string): ReadonlyMap<string, string> {
  const [runner, ...runnerArgs] = pinnedRun(info);
  const files = new Map<string, string>();
  const add = (relative: string, content: string): void => {
    files.set(`${PLUGIN_FOLDER}/${relative}`, content);
  };
  files.set(
    MARKETPLACE_FILE,
    json({
      name: MARKETPLACE_NAME,
      description: MARKETPLACE_DESCRIPTION,
      owner: { name: MARKETPLACE_OWNER },
      plugins: [{ name: PLUGIN_NAME, source: `./${PLUGIN_FOLDER}`, description: info.description }],
    }),
  );
  add(
    PLUGIN_MANIFEST_FILE,
    json({
      name: PLUGIN_NAME,
      version: info.version,
      description: info.description,
      author: { name: info.author },
      homepage: info.homepage,
      repository: `https://github.com/${repositorySlug(info)}`,
      license: info.license,
    }),
  );
  add(
    PLUGIN_MCP_FILE,
    json({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: runner,
          args: [...runnerArgs, MCP_COMMAND],
        },
      },
    }),
  );
  add(
    PLUGIN_HOOKS_FILE,
    json({
      hooks: {
        PostToolUse: [
          {
            matcher: `${PLUGIN_TOOL_PREFIX}.*`,
            hooks: [{ type: "command", command: runner, args: [...runnerArgs, SESSION_LINK_COMMAND] }],
          },
        ],
      },
    }),
  );
  for (const skill of AGENT_SKILLS)
    add(`${PLUGIN_SKILLS_FOLDER}/${skill.name}/${SKILL_FILE}`, renderSkill(skill, PLUGIN_DOCS_PATH, hash));
  for (const skill of PLUGIN_SKILLS)
    add(`${PLUGIN_SKILLS_FOLDER}/${skill.name}/${SKILL_FILE}`, renderPluginSkill(skill, info));
  add(`${PLUGIN_AGENTS_FOLDER}/${PM_AGENT_NAME}.md`, renderPmAgent());
  return files;
}
