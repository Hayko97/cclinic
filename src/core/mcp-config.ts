/** cclinic's server entry in `.mcp.json` (FR-MCP-004, FR-MCP-042). Pure. */
import { JSON_INDENT } from "./constants/terminal.js";
import { MCP_SERVER_ENTRY, MCP_SERVER_NAME, SESSION_LINK_COMMAND, SESSION_LINK_HOOK } from "./constants/workflow.js";

const SERVERS_KEY = "mcpServers";

type JsonObject = Record<string, unknown>;

export type McpConfigMerge =
  | { readonly status: "installed" | "updated"; readonly content: string }
  | { readonly status: "unchanged" | "kept" | "unreadable" };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(content: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function serversOf(config: JsonObject): JsonObject {
  const servers = config[SERVERS_KEY];
  return isObject(servers) ? servers : {};
}

function isCclinicEntry(value: unknown): boolean {
  if (!isObject(value) || Object.keys(value).length !== Object.keys(MCP_SERVER_ENTRY).length) return false;
  return (
    value["command"] === MCP_SERVER_ENTRY.command &&
    JSON.stringify(value["args"]) === JSON.stringify(MCP_SERVER_ENTRY.args)
  );
}

/** JSON with object keys sorted, so two values compare equal whatever order their keys were written in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isObject(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item,
  );
}

function render(config: JsonObject): string {
  return `${JSON.stringify(config, null, JSON_INDENT)}\n`;
}

const HOOKS_KEY = "hooks";

/** Runs cclinic's session-link command, however cclinic is started, such as `npx cclinic` or `node ./cclinic.js`. */
const SESSION_LINK_PATTERN = new RegExp(`\\bcclinic\\S*\\s+${SESSION_LINK_COMMAND}\\b`);

/** cclinic's entry is the one that runs session-link, even if changed; another hook on the same tools is the user's own. */
function isSessionLinkEntry(entry: unknown): boolean {
  const hooks = isObject(entry) ? entry[HOOKS_KEY] : undefined;
  return (
    Array.isArray(hooks) &&
    hooks.some(
      (hook) => isObject(hook) && typeof hook["command"] === "string" && SESSION_LINK_PATTERN.test(hook["command"]),
    )
  );
}
const HOOK_EVENT = "PostToolUse";

/** FR-MCP-044: adds the session-link hook, keeping every other setting and hook, and leaves a changed one alone. */
export function mergeClaudeSettings(existing: string | undefined): McpConfigMerge {
  if (existing === undefined || existing.trim() === "")
    return { status: "installed", content: render({ [HOOKS_KEY]: { [HOOK_EVENT]: [SESSION_LINK_HOOK] } }) };
  const config = parseConfig(existing);
  if (config === undefined) return { status: "unreadable" };
  const hooks = config[HOOKS_KEY] ?? {};
  if (!isObject(hooks)) return { status: "unreadable" };
  const event = hooks[HOOK_EVENT] ?? [];
  // Never replace hooks cclinic can't read, so the user's own are kept (FR-MCP-044).
  if (!Array.isArray(event)) return { status: "unreadable" };
  const entries: readonly unknown[] = event;
  const own: unknown = entries.find(isSessionLinkEntry);
  if (own !== undefined) return { status: canonical(own) === canonical(SESSION_LINK_HOOK) ? "unchanged" : "kept" };
  return {
    status: "updated",
    content: render({ ...config, [HOOKS_KEY]: { ...hooks, [HOOK_EVENT]: [...entries, SESSION_LINK_HOOK] } }),
  };
}

/** Adds cclinic's server, keeping every other one, and leaves a cclinic entry the user changed alone. */
export function mergeMcpConfig(existing: string | undefined): McpConfigMerge {
  if (existing === undefined || existing.trim() === "")
    return { status: "installed", content: render({ [SERVERS_KEY]: { [MCP_SERVER_NAME]: MCP_SERVER_ENTRY } }) };
  const config = parseConfig(existing);
  if (config === undefined) return { status: "unreadable" };
  const servers = serversOf(config);
  if (servers[MCP_SERVER_NAME] !== undefined)
    return { status: isCclinicEntry(servers[MCP_SERVER_NAME]) ? "unchanged" : "kept" };
  return {
    status: "updated",
    content: render({ ...config, [SERVERS_KEY]: { ...servers, [MCP_SERVER_NAME]: MCP_SERVER_ENTRY } }),
  };
}

/** The file holds nothing but cclinic's own entry, so it isn't part of the project. */
export function holdsOnlyCclinicServer(content: string): boolean {
  const config = parseConfig(content);
  if (config === undefined || Object.keys(config).length !== 1) return false;
  const servers = serversOf(config);
  return Object.keys(servers).length === 1 && isCclinicEntry(servers[MCP_SERVER_NAME]);
}

/**
 * The content to analyse: cclinic's entry removed, and always re-rendered, so the file reads the same
 * before and after cclinic adds itself.
 */
export function stripCclinicServer(content: string): string {
  const config = parseConfig(content);
  if (config === undefined) return content;
  const servers = Object.fromEntries(
    Object.entries(serversOf(config)).filter(([name, entry]) => name !== MCP_SERVER_NAME || !isCclinicEntry(entry)),
  );
  return render(SERVERS_KEY in config ? { ...config, [SERVERS_KEY]: servers } : config);
}
