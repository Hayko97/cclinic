import { describe, expect, it } from "vitest";
import { holdsOnlyLuseenServer, mergeMcpConfig, stripLuseenServer } from "./mcp-config.js";

const ENTRY = { command: "npx", args: ["luseen", "mcp"] };
const config = (value: unknown): string => JSON.stringify(value);

describe("mcp config", () => {
  it("TC-MCP-005: creates the file, also when it's empty", () => {
    for (const existing of [undefined, "", "  \n"]) {
      const merged = mergeMcpConfig(existing);
      expect(merged.status).toBe("installed");
      expect("content" in merged && JSON.parse(merged.content)).toEqual({ mcpServers: { luseen: ENTRY } });
    }
  });

  it("TC-MCP-006: adds luseen next to other servers and top-level keys", () => {
    const merged = mergeMcpConfig(config({ other: true, mcpServers: { a: { command: "a" } } }));
    expect(merged.status).toBe("updated");
    expect("content" in merged && JSON.parse(merged.content)).toEqual({
      other: true,
      mcpServers: { a: { command: "a" }, luseen: ENTRY },
    });
    expect(mergeMcpConfig(config({ other: true })).status).toBe("updated");
  });

  it("TC-MCP-007: leaves its own entry unchanged, and a changed one kept", () => {
    expect(mergeMcpConfig(config({ mcpServers: { luseen: ENTRY } })).status).toBe("unchanged");
    expect(mergeMcpConfig(config({ mcpServers: { luseen: { command: "node" } } })).status).toBe("kept");
  });

  it("refuses a file that isn't a JSON object", () => {
    for (const text of ["{oops", "[1, 2]", "null", "3"]) expect(mergeMcpConfig(text).status).toBe("unreadable");
  });

  it("TC-MCP-064: only a file with nothing but luseen's entry counts as luseen's own", () => {
    expect(holdsOnlyLuseenServer(config({ mcpServers: { luseen: ENTRY } }))).toBe(true);
    expect(holdsOnlyLuseenServer(config({ mcpServers: { luseen: ENTRY }, other: 1 }))).toBe(false);
    expect(holdsOnlyLuseenServer(config({ mcpServers: { luseen: { command: "node" } } }))).toBe(false);
    expect(holdsOnlyLuseenServer("{oops")).toBe(false);
  });

  it("TC-MCP-064: strips luseen's entry, keeps a changed one, and leaves unreadable text as it is", () => {
    expect(stripLuseenServer(config({ mcpServers: { luseen: ENTRY, a: {} } }))).toBe(
      stripLuseenServer(config({ mcpServers: { a: {} } })),
    );
    expect(stripLuseenServer(config({ mcpServers: { luseen: { command: "node" } } }))).toContain("luseen");
    expect(stripLuseenServer(config({ other: 1 }))).toBe(`${JSON.stringify({ other: 1 }, null, 2)}\n`);
    expect(stripLuseenServer("{oops")).toBe("{oops");
  });
});
