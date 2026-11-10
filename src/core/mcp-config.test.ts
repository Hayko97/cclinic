import { describe, expect, it } from "vitest";
import { holdsOnlyCclinicServer, mergeMcpConfig, stripCclinicServer } from "./mcp-config.js";

const ENTRY = { command: "npx", args: ["cclinic", "mcp"] };
const config = (value: unknown): string => JSON.stringify(value);

describe("mcp config", () => {
  it("TC-MCP-005: creates the file, also when it's empty", () => {
    for (const existing of [undefined, "", "  \n"]) {
      const merged = mergeMcpConfig(existing);
      expect(merged.status).toBe("installed");
      expect("content" in merged && JSON.parse(merged.content)).toEqual({ mcpServers: { cclinic: ENTRY } });
    }
  });

  it("TC-MCP-006: adds cclinic next to other servers and top-level keys", () => {
    const merged = mergeMcpConfig(config({ other: true, mcpServers: { a: { command: "a" } } }));
    expect(merged.status).toBe("updated");
    expect("content" in merged && JSON.parse(merged.content)).toEqual({
      other: true,
      mcpServers: { a: { command: "a" }, cclinic: ENTRY },
    });
    expect(mergeMcpConfig(config({ other: true })).status).toBe("updated");
  });

  it("TC-MCP-007: leaves its own entry unchanged, and a changed one kept", () => {
    expect(mergeMcpConfig(config({ mcpServers: { cclinic: ENTRY } })).status).toBe("unchanged");
    expect(mergeMcpConfig(config({ mcpServers: { cclinic: { command: "node" } } })).status).toBe("kept");
  });

  it("refuses a file that isn't a JSON object", () => {
    for (const text of ["{oops", "[1, 2]", "null", "3"]) expect(mergeMcpConfig(text).status).toBe("unreadable");
  });

  it("TC-MCP-064: only a file with nothing but cclinic's entry counts as cclinic's own", () => {
    expect(holdsOnlyCclinicServer(config({ mcpServers: { cclinic: ENTRY } }))).toBe(true);
    expect(holdsOnlyCclinicServer(config({ mcpServers: { cclinic: ENTRY }, other: 1 }))).toBe(false);
    expect(holdsOnlyCclinicServer(config({ mcpServers: { cclinic: { command: "node" } } }))).toBe(false);
    expect(holdsOnlyCclinicServer("{oops")).toBe(false);
  });

  it("TC-MCP-064: strips cclinic's entry, keeps a changed one, and leaves unreadable text as it is", () => {
    expect(stripCclinicServer(config({ mcpServers: { cclinic: ENTRY, a: {} } }))).toBe(
      stripCclinicServer(config({ mcpServers: { a: {} } })),
    );
    expect(stripCclinicServer(config({ mcpServers: { cclinic: { command: "node" } } }))).toContain("cclinic");
    expect(stripCclinicServer(config({ other: 1 }))).toBe(`${JSON.stringify({ other: 1 }, null, 2)}\n`);
    expect(stripCclinicServer("{oops")).toBe("{oops");
  });
});
