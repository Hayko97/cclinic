/** Names in the Claude Code plugin and the marketplace that ships it (spec: claude-plugin). */
import { PLAN_DRIVEN_TOOL_NAMES } from "./agents.js";
import { DOCUMENTS_FOLDER_NAME, PRODUCT_NAME, TOOL_FOLDER_NAME } from "./paths.js";
import { MCP_SERVER_NAME } from "./workflow.js";

export const PLUGIN_NAME = PRODUCT_NAME;
export const MARKETPLACE_NAME = PRODUCT_NAME;
export const MARKETPLACE_OWNER = "Hayko97";
export const MARKETPLACE_DESCRIPTION = `${PRODUCT_NAME}: spec-driven development in Claude Code`;
export const MARKETPLACE_FILE = ".claude-plugin/marketplace.json";
/** The plugin's folder, relative to the repository root; the marketplace's `source` adds `./`. */
export const PLUGIN_FOLDER = `plugins/${PLUGIN_NAME}`;
export const PLUGIN_MANIFEST_FILE = ".claude-plugin/plugin.json";
/** FR-PLUG-015: the listing icon, copied from the repository's own logo. */
export const PLUGIN_ICON_FILE = ".claude-plugin/icon.png";
export const LOGO_FILE = "assets/luseen-icon.png";
export const PLUGIN_SKILLS_FOLDER = "skills";
export const PLUGIN_AGENTS_FOLDER = "agents";
export const PM_AGENT_NAME = "pm";
/** The plugin's skills run the package with npx, without asking to install it (FR-PLUG-009, FR-PLUG-010). */
export const PACKAGE_RUNNER = "npx";
export const PACKAGE_RUNNER_YES_FLAG = "-y";
/** The plugin serves every project, so its skills name the default documents folder. */
export const PLUGIN_DOCS_PATH = `${TOOL_FOLDER_NAME}/${DOCUMENTS_FOLDER_NAME}`;
/** FR-PLUG-011: the planning tools the plugin's PM agent may call. */
export const PM_AGENT_PLAN_TOOL_NAMES = ["plan_begin", "plan_resume", ...PLAN_DRIVEN_TOOL_NAMES] as const;
/** FR-PLUG-007: what the server's only tool answers in a project that isn't set up. */
export const NOT_SET_UP_MESSAGE = `This project isn't set up for ${PRODUCT_NAME}: it has no ${PLUGIN_DOCS_PATH}. Run /${PLUGIN_NAME}:init in Claude Code, or ${PRODUCT_NAME} in a terminal, to set it up, then reconnect the ${MCP_SERVER_NAME} server with /mcp.`;
