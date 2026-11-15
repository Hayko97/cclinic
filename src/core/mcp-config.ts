/** luseen's server entry in `.mcp.json` (FR-MCP-004, FR-MCP-042). Pure. */
import { JSON_INDENT } from "./constants/terminal.js";
import { LEGACY_NAME, PRODUCT_NAME } from "./constants/paths.js";
import {
  LEGACY_MCP_SERVER_ENTRY,
  LEGACY_MCP_SERVER_NAME,
  LEGACY_SESSION_LINK_HOOK,
  MCP_SERVER_ENTRY,
  MCP_SERVER_NAME,
  SESSION_LINK_COMMAND,
  SESSION_LINK_HOOK,
} from "./constants/workflow.js";

const SERVERS_KEY = "mcpServers";

type JsonObject = Record<string, unknown>;

/** `legacyKept`: cclinic's entry was changed by hand, so it stays, and is reported (FR-CLI-034). */
export type McpConfigMerge = (
  | { readonly status: "installed" | "updated"; readonly content: string }
  | { readonly status: "unchanged" | "kept" | "unreadable" }
) & { readonly legacyKept?: boolean };

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

function isLuseenEntry(value: unknown): boolean {
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

/** Runs luseen's session-link command, however luseen is started, such as `npx luseen` or `node ./luseen.js`. */
function sessionLinkPattern(name: string): RegExp {
  return new RegExp(`\\b${name}\\S*\\s+${SESSION_LINK_COMMAND}\\b`);
}
const SESSION_LINK_PATTERN = sessionLinkPattern(PRODUCT_NAME);
const LEGACY_SESSION_LINK_PATTERN = sessionLinkPattern(LEGACY_NAME);

function runsCommand(entry: unknown, pattern: RegExp): boolean {
  const hooks = isObject(entry) ? entry[HOOKS_KEY] : undefined;
  return (
    Array.isArray(hooks) &&
    hooks.some((hook) => isObject(hook) && typeof hook["command"] === "string" && pattern.test(hook["command"]))
  );
}

/** luseen's entry is the one that runs session-link, even if changed; another hook on the same tools is the user's own. */
function isSessionLinkEntry(entry: unknown): boolean {
  return runsCommand(entry, SESSION_LINK_PATTERN);
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
  // Never replace hooks luseen can't read, so the user's own are kept (FR-MCP-044).
  if (!Array.isArray(event)) return { status: "unreadable" };
  const given: readonly unknown[] = event;
  // FR-CLI-034: cclinic's hook goes, unless it was changed by hand.
  const entries = given.filter((entry) => canonical(entry) !== canonical(LEGACY_SESSION_LINK_HOOK));
  const legacyKept = entries.some((entry) => runsCommand(entry, LEGACY_SESSION_LINK_PATTERN));
  const own: unknown = entries.find(isSessionLinkEntry);
  const withEntries = (list: readonly unknown[]) =>
    render({ ...config, [HOOKS_KEY]: { ...hooks, [HOOK_EVENT]: list } });
  if (own === undefined)
    return { status: "updated", content: withEntries([...entries, SESSION_LINK_HOOK]), legacyKept };
  if (entries.length !== given.length) return { status: "updated", content: withEntries(entries), legacyKept };
  return { status: canonical(own) === canonical(SESSION_LINK_HOOK) ? "unchanged" : "kept", legacyKept };
}

/** Adds luseen's server, keeping every other one, and leaves a luseen entry the user changed alone. */
export function mergeMcpConfig(existing: string | undefined): McpConfigMerge {
  if (existing === undefined || existing.trim() === "")
    return { status: "installed", content: render({ [SERVERS_KEY]: { [MCP_SERVER_NAME]: MCP_SERVER_ENTRY } }) };
  const config = parseConfig(existing);
  if (config === undefined) return { status: "unreadable" };
  const given = serversOf(config);
  // FR-CLI-034: cclinic's server goes, unless it was changed by hand.
  const legacy = given[LEGACY_MCP_SERVER_NAME];
  const isLegacyDefault = legacy !== undefined && canonical(legacy) === canonical(LEGACY_MCP_SERVER_ENTRY);
  const legacyKept = legacy !== undefined && !isLegacyDefault;
  const servers = Object.fromEntries(
    Object.entries(given).filter(([name]) => !isLegacyDefault || name !== LEGACY_MCP_SERVER_NAME),
  );
  const withServers = (list: JsonObject) => render({ ...config, [SERVERS_KEY]: list });
  if (servers[MCP_SERVER_NAME] === undefined)
    return { status: "updated", content: withServers({ ...servers, [MCP_SERVER_NAME]: MCP_SERVER_ENTRY }), legacyKept };
  if (isLegacyDefault) return { status: "updated", content: withServers(servers), legacyKept };
  return { status: isLuseenEntry(servers[MCP_SERVER_NAME]) ? "unchanged" : "kept", legacyKept };
}

/** Luseen's entry, or cclinic's unchanged one (FR-CLI-039), which analysis leaves out. */
function isOwnEntry(name: string, entry: unknown): boolean {
  if (name === MCP_SERVER_NAME) return isLuseenEntry(entry);
  return name === LEGACY_MCP_SERVER_NAME && canonical(entry) === canonical(LEGACY_MCP_SERVER_ENTRY);
}

/** The file holds nothing but luseen's own entry, so it isn't part of the project. */
export function holdsOnlyLuseenServer(content: string): boolean {
  const config = parseConfig(content);
  if (config === undefined || Object.keys(config).length !== 1) return false;
  const entries = Object.entries(serversOf(config));
  return entries.length > 0 && entries.every(([name, entry]) => isOwnEntry(name, entry));
}

/** FR-CLI-038: the file holds cclinic's server entry, or its hook. */
export function holdsLegacyEntry(content: string): boolean {
  const config = parseConfig(content);
  if (config === undefined) return false;
  if (serversOf(config)[LEGACY_MCP_SERVER_NAME] !== undefined) return true;
  const hooks = config[HOOKS_KEY];
  const event = isObject(hooks) ? hooks[HOOK_EVENT] : undefined;
  return Array.isArray(event) && event.some((entry) => runsCommand(entry, LEGACY_SESSION_LINK_PATTERN));
}

/**
 * The content to analyse: luseen's entry removed, and always re-rendered, so the file reads the same
 * before and after luseen adds itself.
 */
export function stripLuseenServer(content: string): string {
  const config = parseConfig(content);
  if (config === undefined) return content;
  const servers = Object.fromEntries(
    Object.entries(serversOf(config)).filter(([name, entry]) => !isOwnEntry(name, entry)),
  );
  return render(SERVERS_KEY in config ? { ...config, [SERVERS_KEY]: servers } : config);
}
