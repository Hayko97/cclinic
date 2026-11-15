/** The Claude Code plugin and its marketplace, as committed in the repository (spec: claude-plugin). */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPluginFiles,
  findPluginDrift,
  readPackageInfo,
  writePluginFiles,
} from "../../src/adapters/storage/plugin-files.js";
import { installSkills } from "../../src/adapters/storage/skill-installer.js";
import { AGENT_SKILLS } from "../../src/core/agent-skills.js";
import { makeTempFolder, writeProject } from "../support/helpers.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PLUGIN = path.join(REPO, "plugins/luseen");
const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as {
  version: string;
  description: string;
  author: string;
  homepage: string;
  license: string;
  repository: { url: string };
};
const PINNED = `luseen@${pkg.version}`;

const read = (relative: string) => readFileSync(path.join(PLUGIN, relative), "utf8");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

/** The frontmatter of a skill or agent file, as `key: value` lines. */
function frontmatter(text: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
  return Object.fromEntries(
    block
      .split("\n")
      .filter((line) => /^\w[\w-]*:/.test(line))
      .map((line) => {
        const [key = "", ...rest] = line.split(":");
        return [key, rest.join(":").trim()];
      }),
  );
}

describe("marketplace and manifest", () => {
  it("TC-PLUG-001: the marketplace lists the one plugin in ./plugins/luseen", () => {
    const marketplace = readJson(path.join(REPO, ".claude-plugin/marketplace.json"));
    expect(marketplace).toMatchObject({ name: "luseen", owner: { name: "Hayko97" } });
    const plugins = marketplace["plugins"] as Record<string, string>[];
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ name: "luseen", source: "./plugins/luseen" });
    expect(plugins[0]?.["description"]).not.toBe("");
  });

  it("TC-PLUG-002: plugin.json carries package.json's version and metadata", () => {
    const manifest = readJson(path.join(PLUGIN, ".claude-plugin/plugin.json"));
    expect(manifest).toEqual({
      name: "luseen",
      version: pkg.version,
      description: pkg.description,
      author: { name: pkg.author },
      homepage: pkg.homepage,
      repository: pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""),
      license: pkg.license,
    });
  });
});

describe("what the plugin runs", () => {
  it("TC-PLUG-004: one MCP server, luseen, runs the pinned package in the project folder", () => {
    expect(JSON.parse(read(".mcp.json"))).toEqual({
      mcpServers: { luseen: { command: "npx", args: ["-y", PINNED, "mcp", "-C", "${CLAUDE_PROJECT_DIR}"] } },
    });
  });

  it("TC-PLUG-005: one PostToolUse hook matches only the plugin's luseen tools", () => {
    const hooks = JSON.parse(read("hooks/hooks.json")) as {
      hooks: Record<string, { matcher: string; hooks: { type: string; command: string }[] }[]>;
    };
    expect(Object.keys(hooks.hooks)).toEqual(["PostToolUse"]);
    const [entry] = hooks.hooks["PostToolUse"] ?? [];
    expect(hooks.hooks["PostToolUse"]).toHaveLength(1);
    expect(entry?.matcher).toBe("mcp__plugin_luseen_luseen__.*");
    expect(entry?.hooks).toEqual([{ type: "command", command: `npx -y ${PINNED} session-link` }]);
    const matcher = new RegExp(`^${entry?.matcher ?? ""}$`);
    expect(matcher.test("mcp__plugin_luseen_luseen__workflow_status")).toBe(true);
    expect(matcher.test("mcp__luseen__workflow_status")).toBe(false);
    expect(matcher.test("mcp__plugin_other_x__y")).toBe(false);
  });
});

describe("skills, commands and agents", () => {
  it("TC-PLUG-010: the nine agent skills are byte-identical to what luseen skills writes", async () => {
    const root = makeTempFolder();
    await installSkills({ target: root, out: path.join(root, ".luseen/sdd"), isForced: false });
    expect(AGENT_SKILLS).toHaveLength(9);
    for (const skill of AGENT_SKILLS)
      expect(read(`skills/${skill.name}/SKILL.md`)).toBe(
        readFileSync(path.join(root, ".agents/skills", skill.name, "SKILL.md"), "utf8"),
      );
  });

  it("TC-PLUG-011: init, plan, status and gui say what each must", () => {
    const skills = Object.fromEntries(
      ["init", "plan", "status", "gui"].map((name) => [name, read(`skills/${name}/SKILL.md`)]),
    );
    for (const [name, text] of Object.entries(skills)) {
      expect(frontmatter(text)["name"]).toBe(name);
      expect(frontmatter(text)["description"]).toMatch(/^".+"$/);
    }
    expect(skills["init"]).toContain(`npx -y ${PINNED} --yes --plugin`);
    expect(skills["init"]).toContain("already set up");
    expect(skills["init"]).toMatch(/Ask whether to start, and wait for their answer/);
    expect(skills["init"]).toMatch(/If they say no,\*\* do nothing more/);
    expect(skills["plan"]).toMatch(/Before any other tool call, call .*`plan_begin`/);
    expect(skills["status"]).toContain("`workflow_status`");
    expect(skills["status"]).toContain("`tasks_list`");
    expect(skills["gui"]).toContain(`npx -y ${PINNED} gui --no-open --json`);
  });

  it("TC-PLUG-012: the pm agent has the product-engineer instructions and only read and planning tools", () => {
    const text = read("agents/pm.md");
    const meta = frontmatter(text);
    expect(meta["name"]).toBe("pm");
    expect(new Set(meta["tools"]?.split(", "))).toEqual(
      new Set([
        "Read",
        "Grep",
        "Glob",
        "WebSearch",
        "WebFetch",
        ...["begin", "resume", "status", "suggest", "propose"].map((tool) => `mcp__plugin_luseen_luseen__plan_${tool}`),
      ]),
    );
    const productEngineer = AGENT_SKILLS.find((skill) => skill.name === "product-engineer");
    expect(text).toContain(productEngineer?.body.replaceAll("{{DOCS}}", ".luseen/sdd"));
  });
});

describe("generation", () => {
  it("TC-PLUG-013: the committed files are what the build writes, and a version change is caught by file", async () => {
    const info = await readPackageInfo(REPO);
    const files = await buildPluginFiles(REPO);
    expect(await findPluginDrift(REPO, files)).toEqual([]);

    const copy = makeTempFolder();
    await writePluginFiles(copy, files);
    expect(await findPluginDrift(copy, files)).toEqual([]);
    const bumped = await buildPluginFiles(REPO, { ...info, version: "99.0.0" });
    expect(await findPluginDrift(copy, bumped)).toEqual([
      "plugins/luseen/.claude-plugin/plugin.json",
      "plugins/luseen/.mcp.json",
      "plugins/luseen/hooks/hooks.json",
      "plugins/luseen/skills/gui/SKILL.md",
      "plugins/luseen/skills/init/SKILL.md",
    ]);
  });

  it("TC-PLUG-013: a file the build no longer writes is drift, and the next build removes it", async () => {
    const files = await buildPluginFiles(REPO);
    const copy = makeTempFolder();
    await writePluginFiles(copy, files);
    writeProject(copy, { "plugins/luseen/skills/old/SKILL.md": "old\n" });
    expect(await findPluginDrift(copy, files)).toEqual(["plugins/luseen/skills/old/SKILL.md"]);
    await writePluginFiles(copy, files);
    expect(await findPluginDrift(copy, files)).toEqual([]);
  });
});

describe("README", () => {
  it("TC-PLUG-016: gives the marketplace, install and init commands", () => {
    const readme = readFileSync(path.join(REPO, "README.md"), "utf8");
    const slug = /github\.com\/([^/]+\/[^/.]+)/.exec(pkg.repository.url)?.[1] ?? "";
    expect(readme).toContain(`/plugin marketplace add ${slug}`);
    expect(readme).toContain("/plugin install luseen@luseen");
    expect(readme).toContain("/luseen:init");
  });
});

describe("icon", () => {
  it("TC-PLUG-018: the plugin's icon is the repository's logo, a square PNG of 512 to 2048 px under 2 MB", () => {
    const icon = readFileSync(path.join(PLUGIN, ".claude-plugin/icon.png"));
    expect(icon.equals(readFileSync(path.join(REPO, "assets/luseen-icon.png")))).toBe(true);
    expect(icon.subarray(1, 4).toString()).toBe("PNG");
    const width = icon.readUInt32BE(16);
    expect(icon.readUInt32BE(20)).toBe(width);
    expect(width).toBeGreaterThanOrEqual(512);
    expect(width).toBeLessThanOrEqual(2048);
    expect(icon.length).toBeLessThan(2 * 1024 * 1024);
  });
});
