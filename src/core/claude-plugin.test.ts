import { describe, expect, it } from "vitest";
import { renderClaudePlugin, repositorySlug, type PackageInfo } from "./claude-plugin.js";

const INFO: PackageInfo = {
  version: "1.2.3",
  description: "Spec-driven development",
  author: "Hayko97",
  homepage: "https://github.com/o/r#readme",
  license: "MIT",
  repository: { url: "git+https://github.com/o/r.git" },
};

describe("the Claude Code plugin's files", () => {
  it("TC-PLUG-016: reads owner/repo from package.json's GitHub repository, and refuses another host", () => {
    expect(repositorySlug(INFO)).toBe("o/r");
    expect(repositorySlug({ ...INFO, repository: { url: "git@github.com:o/r.git" } })).toBe("o/r");
    expect(() => repositorySlug({ ...INFO, repository: { url: "https://gitlab.com/o/r" } })).toThrow("isn't on GitHub");
  });

  it("TC-PLUG-004 and TC-PLUG-005: no server or hooks, and the commands run the package at the plugin's version", () => {
    const files = renderClaudePlugin(INFO, () => "hash");
    expect([...files.keys()].filter((file) => file.endsWith(".mcp.json") || file.includes("/hooks/"))).toEqual([]);
    expect(files.get("plugins/luseen/.claude-plugin/plugin.json")).not.toMatch(/"(mcpServers|hooks)"/);
    expect(files.get("plugins/luseen/skills/init/SKILL.md")).toContain("npx -y luseen@1.2.3 --yes --plugin");
    expect(files.get("plugins/luseen/skills/status/SKILL.md")).toContain("npx -y luseen@1.2.3 tasks list --json");
    expect(files.get("plugins/luseen/.claude-plugin/plugin.json")).toContain('"repository": "https://github.com/o/r"');
    expect([...files.values()].every((content) => content.endsWith("\n"))).toBe(true);
  });
});
