/** The Claude Code plugin and its marketplace, as committed in the repository (spec: claude-plugin). */
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
import { AGENT_SKILLS, withoutStamp } from "../../src/core/agent-skills.js";
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
const SKILL_KEYS = ["name", "description"];
const AGENT_KEYS = ["name", "description", "tools"];

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
  const manifest = () => readJson(path.join(PLUGIN, ".claude-plugin/plugin.json"));

  it("TC-PLUG-004: the plugin declares no MCP server", async () => {
    const files = await buildPluginFiles(REPO);
    expect([...files.keys()].filter((file) => file.endsWith(".mcp.json"))).toEqual([]);
    expect(existsSync(path.join(PLUGIN, ".mcp.json"))).toBe(false);
    expect(manifest()).not.toHaveProperty("mcpServers");
  });

  it("TC-PLUG-005: the plugin ships no hooks", async () => {
    const files = await buildPluginFiles(REPO);
    expect([...files.keys()].filter((file) => file.includes("/hooks/") || file.endsWith("hooks.json"))).toEqual([]);
    expect(existsSync(path.join(PLUGIN, "hooks"))).toBe(false);
    expect(manifest()).not.toHaveProperty("hooks");
  });
});

describe("skills, commands and agents", () => {
  it("TC-PLUG-010, TC-DSGN-003: the ten agent skills are what luseen skills writes, without the metadata block", async () => {
    const root = makeTempFolder();
    await installSkills({ target: root, out: path.join(root, ".luseen/sdd"), isForced: false });
    expect(AGENT_SKILLS).toHaveLength(10);
    expect(read("skills/ui-design/SKILL.md")).toContain("# Design the user interface");
    for (const skill of AGENT_SKILLS) {
      const projectCopy = readFileSync(path.join(root, ".agents/skills", skill.name, "SKILL.md"), "utf8");
      expect(read(`skills/${skill.name}/SKILL.md`)).not.toMatch(/^metadata:/m);
      expect(read(`skills/${skill.name}/SKILL.md`)).toBe(withoutStamp(projectCopy));
    }
  });

  it("TC-PLUG-021: every skill and agent has frontmatter of plain key: value lines, with only allowed keys", () => {
    const files = [
      ...readdirSync(path.join(PLUGIN, "skills")).map((name) => ({
        file: `skills/${name}/SKILL.md`,
        keys: SKILL_KEYS,
      })),
      ...readdirSync(path.join(PLUGIN, "agents")).map((name) => ({ file: `agents/${name}`, keys: AGENT_KEYS })),
    ];
    expect(files.length).toBeGreaterThanOrEqual(16);
    for (const { file, keys } of files) {
      const text = read(file);
      const lines = text.split("\n");
      expect(lines[0], file).toBe("---");
      const end = lines.indexOf("---", 1);
      expect(end, file).toBeGreaterThan(1);
      for (const line of lines.slice(1, end)) {
        expect(line, file).toMatch(/^[a-z]+: \S/);
        expect(keys, `${file}: ${line}`).toContain(line.split(":")[0]);
      }
      expect(text, file).not.toMatch(/^\s*(metadata|generated-by|content-hash):/m);
    }
  });

  it("TC-PLUG-011: init, plan, status and gui say what each must", () => {
    const skills = Object.fromEntries(
      ["init", "plan", "status", "gui"].map((name) => [name, read(`skills/${name}/SKILL.md`)]),
    );
    for (const [name, text] of Object.entries(skills)) {
      expect(frontmatter(text)["name"]).toBe(name);
      expect(frontmatter(text)["description"]).toMatch(/^".+"$/);
    }
    const init = skills["init"] ?? "";
    expect(init).toContain(`npx -y ${PINNED} --yes --plugin`);
    expect(init).toContain(`npx -y ${PINNED} skills --plugin`);
    expect(init).toContain("already set up");
    expect(init).toMatch(/Ask whether to start, and wait for their answer/);
    expect(init).toMatch(/If they say no,\*\* do nothing more/);
    expect(init.match(/`\.mcp\.json`[^\n]*`\.claude\/settings\.json`[^\n]*Ask/g)).toHaveLength(2);
    expect(init).toContain("/mcp");
    expect(skills["plan"]).toMatch(/Before any other tool call, call .*`plan_begin`/);
    expect(skills["plan"]).toContain("/luseen:init");
    expect(skills["status"]).toContain("`workflow_status`");
    expect(skills["status"]).toContain("`tasks_list`");
    expect(skills["status"]).toContain(`npx -y ${PINNED} tasks list --json`);
    expect(skills["status"]).toContain("/luseen:init");
    expect(skills["gui"]).toContain(`npx -y ${PINNED} gui --no-open --json`);
  });

  it("TC-PLUG-012: the pm agent has the product-engineer instructions and only read and planning tools", () => {
    const text = read("agents/pm.md");
    const meta = frontmatter(text);
    expect(meta["name"]).toBe("pm");
    expect(meta["tools"]).not.toContain("mcp__plugin_");
    expect(new Set(meta["tools"]?.split(", "))).toEqual(
      new Set([
        "Read",
        "Grep",
        "Glob",
        "WebSearch",
        "WebFetch",
        ...["begin", "resume", "status", "suggest", "propose"].map((tool) => `mcp__luseen__plan_${tool}`),
      ]),
    );
    const productEngineer = AGENT_SKILLS.find((skill) => skill.name === "product-engineer");
    expect(text).toContain(productEngineer?.body.replaceAll("{{DOCS}}", ".luseen/sdd"));
  });

  it("TC-DSGN-050: the designer agent has the ui-design instructions, its 8 tools and the lifecycle line", async () => {
    const text = read("agents/designer.md");
    const meta = frontmatter(text);
    expect(meta["name"]).toBe("designer");
    expect(meta["description"]).toContain("design systems, UI/UX design and building UI");
    expect(meta["tools"]?.split(", ")).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Edit",
      "Bash",
      "WebSearch",
      "WebFetch",
    ]);
    expect(text).toContain("Follow the project's `AGENTS.md` lifecycle for every code change");
    const uiDesign = AGENT_SKILLS.find((skill) => skill.name === "ui-design");
    expect(text).toContain(uiDesign?.body.replaceAll("{{DOCS}}", ".luseen/sdd"));
    const root = makeTempFolder();
    await installSkills({ target: root, out: path.join(root, ".luseen/sdd"), isForced: false });
    expect(withoutStamp(readFileSync(path.join(root, ".claude/agents/designer.md"), "utf8"))).toBe(text);
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
      "plugins/luseen/skills/gui/SKILL.md",
      "plugins/luseen/skills/init/SKILL.md",
      "plugins/luseen/skills/status/SKILL.md",
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
    const pluginSection = readme.slice(readme.indexOf("### Or install the Claude Code plugin"));
    expect(pluginSection).toMatch(/`\/luseen:init` adds[\s\S]*`\.mcp\.json`[\s\S]*`\.claude\/settings\.json`/);
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
