/** Values for the MCP server and the change workflow it runs (spec: mcp-server). */
import { TOOL_FOLDER_NAME } from "./paths.js";

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

export const MCP_SERVER_NAME = "cclinic";
export const MCP_CONFIG_FILE = ".mcp.json";
/** FR-MCP-004: the entry Claude Code reads from `.mcp.json`. */
export const MCP_SERVER_ENTRY = { command: "npx", args: ["cclinic", "mcp"] } as const;
/** FR-MCP-005: Codex reads servers from each developer's own config, so cclinic prints this instead. */
export const CODEX_MCP_CONFIG = `[mcp_servers.${MCP_SERVER_NAME}]
command = "${MCP_SERVER_ENTRY.command}"
args = [${MCP_SERVER_ENTRY.args.map((arg) => `"${arg}"`).join(", ")}]`;

export const RESOURCE_URIS = {
  specs: "cclinic://specs",
  spec: "cclinic://specs/{name}",
  roadmap: "cclinic://roadmap",
} as const;
