/** Values for the MCP server and the change workflow it runs (spec: mcp-server). */
import { LEGACY_NAME, PRODUCT_NAME, TOOL_FOLDER_NAME } from "./paths.js";

export const WORKFLOW_FOLDER = `${TOOL_FOLDER_NAME}/workflow`;
export const WORKFLOW_STATE_VERSION = 1;
export const WORKFLOW_PREVIEW_LOG_PREFIX = "preview-";

/** FR-MCP-020, FR-MCP-022: QA runs and code reviews per change, before it stops. */
export const WORKFLOW_LIMITS = { qaRuns: 3, codeReviews: 3 } as const;

/** A start command still running after this is a long-running server, and is left running. */
export const PREVIEW_SETTLE_MS = 15_000;
/** How long an approval question waits for the user, who may be reading a spec or trying a preview (FR-MCP-028). */
export const APPROVAL_TIMEOUT_MS = 3_600_000;
export const PREVIEW_OUTPUT_MAX_CHARS = 4_000;

export const MCP_SERVER_NAME = PRODUCT_NAME;
export const MCP_CONFIG_FILE = ".mcp.json";
export const MCP_COMMAND = "mcp";
/** FR-MCP-004: the entry Claude Code reads from `.mcp.json`. */
export const MCP_SERVER_ENTRY = { command: "npx", args: [PRODUCT_NAME, MCP_COMMAND] } as const;
/** FR-MCP-044: Claude Code's project settings, where the hook that links sessions to changes goes. */
export const CLAUDE_SETTINGS_FILE = ".claude/settings.json";
export const SESSION_LINK_COMMAND = "session-link";
export const SESSION_LINK_HOOK = {
  matcher: `mcp__${MCP_SERVER_NAME}__.*`,
  hooks: [{ type: "command", command: `npx ${PRODUCT_NAME} ${SESSION_LINK_COMMAND}` }],
} as const;
/** FR-CLI-034: what cclinic installed, replaced by the entries above when unchanged. */
export const LEGACY_MCP_SERVER_NAME = LEGACY_NAME;
export const LEGACY_MCP_SERVER_ENTRY = { command: "npx", args: [LEGACY_NAME, "mcp"] } as const;
export const LEGACY_SESSION_LINK_HOOK = {
  matcher: `mcp__${LEGACY_NAME}__.*`,
  hooks: [{ type: "command", command: `npx ${LEGACY_NAME} ${SESSION_LINK_COMMAND}` }],
} as const;
/** FR-MCP-045: the hook gives up after this, so it never holds up the user's session. */
export const SESSION_LINK_TIMEOUT_MS = 5_000;
/** One writer of the workflow state at a time (FR-MCP-045). */
export const STATE_LOCK_FILE = ".state.lock";
/** A save takes milliseconds, so a lock held this long was left by a process that hung or whose ID is reused. */
export const STATE_LOCK_STALE_MS = 60_000;
/** The hook stops waiting for the lock this long before its own timeout, so it can let go before it exits. */
export const SESSION_LINK_LOCK_WAIT_MS = 4_000;
/** FR-MCP-005: Codex reads servers from each developer's own config, so luseen prints this instead. */
export const CODEX_MCP_CONFIG = `[mcp_servers.${MCP_SERVER_NAME}]
command = "${MCP_SERVER_ENTRY.command}"
args = [${MCP_SERVER_ENTRY.args.map((arg) => `"${arg}"`).join(", ")}]`;

export const RESOURCE_URIS = {
  specs: "luseen://specs",
  spec: "luseen://specs/{name}",
  roadmap: "luseen://roadmap",
} as const;
