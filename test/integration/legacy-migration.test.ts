/** Installing over what cclinic left in a project, and reading its manifest (FR-CLI-034, FR-CLI-035). */
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  checkOutputFolder,
  createDocumentStore,
  projectPaths,
  sha256,
} from "../../src/adapters/storage/document-store.js";
import { scanFolder } from "../../src/adapters/discovery/file-walker.js";
import { readRawHistory } from "../../src/adapters/git/git-repository.js";
import { applyLegacyMoves, planLegacyProject } from "../../src/adapters/storage/legacy-project.js";
import { installSkills } from "../../src/adapters/storage/skill-installer.js";
import { migrateUserSettings, projectFolderOf } from "../../src/cli/legacy-migration.js";
import type { Reporter } from "../../src/cli/reporter.js";
import { AGENT_SKILLS, mergeManagedSection, renderSkill } from "../../src/core/agent-skills.js";
import { makeTempFolder, writeProject } from "../support/helpers.js";

const HASH_LINE = /^ {2}content-hash: "[^"]*"$/m;

/** A skill exactly as cclinic stamped it: its mark, and a hash of the text with that mark. */
function cclinicSkill(name: string): string {
  const skill = AGENT_SKILLS.find((candidate) => candidate.name === name);
  if (skill === undefined) throw new Error(name);
  const unstamped = renderSkill(skill, ".cclinic/sdd", sha256)
    .replace("generated-by: luseen", "generated-by: cclinic")
    .replace(HASH_LINE, '  content-hash: ""');
  return unstamped.replace(HASH_LINE, `  content-hash: "${sha256(unstamped)}"`);
}

const CCLINIC_SECTION = "<!-- cclinic:start -->\nold workflow\n<!-- cclinic:end -->";
const CCLINIC_HOOK = {
  matcher: "mcp__cclinic__.*",
  hooks: [{ type: "command", command: "npx cclinic session-link" }],
};
const OTHER_HOOK = { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] };

function cclinicProject(server: unknown = { command: "npx", args: ["cclinic", "mcp"] }): string {
  const root = makeTempFolder();
  const skills = Object.fromEntries(
    AGENT_SKILLS.flatMap((skill) =>
      [".agents/skills", ".claude/skills"].map((folder) => [
        `${folder}/${skill.name}/SKILL.md`,
        cclinicSkill(skill.name),
      ]),
    ),
  );
  writeProject(root, {
    ...skills,
    "AGENTS.md": `# Mine\n\n${CCLINIC_SECTION}\n\nAfter.\n`,
    "CLAUDE.md": `Top.\n\n<!-- cclinic:start -->\n@AGENTS.md\n<!-- cclinic:end -->\n`,
    ".mcp.json": JSON.stringify({ mcpServers: { cclinic: server, other: { command: "other" } } }),
    ".claude/settings.json": JSON.stringify({ hooks: { PostToolUse: [CCLINIC_HOOK, OTHER_HOOK] } }),
  });
  return root;
}

function install(root: string, isForced = false) {
  return installSkills({ target: root, out: path.join(root, ".luseen/sdd"), isForced });
}

function read(root: string, file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

describe("installing over cclinic's files", () => {
  it("TC-CLI-071: cclinic's sections, skills, server and hook are replaced, and everything else is kept", async () => {
    const root = cclinicProject();
    await install(root);
    const agents = read(root, "AGENTS.md");
    expect(agents.startsWith("# Mine\n\n<!-- luseen:start -->")).toBe(true);
    expect(agents.endsWith("<!-- luseen:end -->\n\nAfter.\n")).toBe(true);
    expect(agents.match(/<!-- luseen:start -->/g)).toHaveLength(1);
    expect(agents).not.toContain("cclinic");
    const claude = read(root, "CLAUDE.md");
    expect(claude).toBe("Top.\n\n<!-- luseen:start -->\n@AGENTS.md\n<!-- luseen:end -->\n");
    for (const skill of AGENT_SKILLS)
      for (const folder of [".agents/skills", ".claude/skills"]) {
        const text = read(root, `${folder}/${skill.name}/SKILL.md`);
        expect(text).toContain("generated-by: luseen");
        expect(text).not.toContain("cclinic");
      }
    expect(JSON.parse(read(root, ".mcp.json"))).toEqual({
      mcpServers: { other: { command: "other" }, luseen: { command: "npx", args: ["luseen", "mcp"] } },
    });
    const settings = JSON.parse(read(root, ".claude/settings.json")) as { hooks: { PostToolUse: unknown[] } };
    expect(settings.hooks.PostToolUse).toEqual([
      OTHER_HOOK,
      { matcher: "mcp__luseen__.*", hooks: [{ type: "command", command: "npx luseen session-link" }] },
    ]);
  });

  it("TC-CLI-072: an edited cclinic skill and a changed cclinic server are kept and reported", async () => {
    const changed = { command: "node", args: ["./dev.js", "mcp"] };
    const root = cclinicProject(changed);
    const edited = ".agents/skills/write-code/SKILL.md";
    const editedText = `${cclinicSkill("write-code")}\nMy own note.\n`;
    writeProject(root, { [edited]: editedText });

    const entries = await install(root);
    expect(read(root, edited)).toBe(editedText);
    expect(entries.find((entry) => entry.path === edited)?.status).toBe("skipped: edited, use --force to replace");
    expect(entries).toContainEqual({ path: ".mcp.json (cclinic)", status: "skipped: cclinic entry changed by hand" });
    expect(
      (JSON.parse(read(root, ".mcp.json")) as { mcpServers: Record<string, unknown> }).mcpServers["cclinic"],
    ).toEqual(changed);

    await install(root, true);
    expect(read(root, edited)).toContain("generated-by: luseen");
    expect(
      (JSON.parse(read(root, ".mcp.json")) as { mcpServers: Record<string, unknown> }).mcpServers["cclinic"],
    ).toEqual(changed);
  });
});

describe("cclinic's manifest", () => {
  it("TC-CLI-073: a manifest with cclinicVersion is read as Luseen's, with no hand edits", async () => {
    const root = makeTempFolder();
    const readme = "# Specs\n";
    writeProject(root, {
      ".luseen/sdd/README.md": readme,
      ".luseen/sdd/manifest.json": JSON.stringify({
        cclinicVersion: "0.1.1",
        promptVersion: "2",
        generatedAt: "",
        provider: "claude-cli",
        requestedModel: "sonnet",
        actualModels: [],
        effort: "medium",
        analysedFiles: {},
        generatedFiles: { "README.md": sha256(readme) },
        specs: [],
        retiredIds: [],
      }),
    });
    const paths = projectPaths(root, undefined);
    await expect(checkOutputFolder(paths.out, false)).resolves.toEqual({ overwritten: [] });
    const manifest = await createDocumentStore(paths, () => new Date()).readManifest();
    expect(manifest?.luseenVersion).toBe("0.1.1");
    expect(manifest).not.toHaveProperty("cclinicVersion");
  });
});

describe("moving cclinic's folder", () => {
  it("TC-CLI-066: the folder and ignore file move, and a dry run only plans it", async () => {
    const root = makeTempFolder();
    writeProject(root, { ".cclinic/sdd/README.md": "# Specs\n", ".cclinicignore": "docs/\n" });
    const moves = [
      { from: ".cclinic", to: ".luseen" },
      { from: ".cclinicignore", to: ".luseenignore" },
    ];
    await expect(planLegacyProject(root)).resolves.toEqual({ status: "planned", moves, hasRuns: false });
    expect(existsSync(path.join(root, ".cclinic"))).toBe(true);
    await applyLegacyMoves(root, moves);
    expect(read(root, ".luseen/sdd/README.md")).toBe("# Specs\n");
    expect(read(root, ".luseenignore")).toBe("docs/\n");
    await expect(planLegacyProject(root)).resolves.toEqual({ status: "none" });
  });

  it("TC-CLI-068: a live lock stops the move, naming the lock", async () => {
    const root = makeTempFolder();
    writeProject(root, { ".cclinic/auto/.lock": JSON.stringify({ pid: process.pid }) });
    const plan = await planLegacyProject(root);
    expect(plan).toMatchObject({ status: "planned", hasRuns: true });
    if (plan.status !== "planned") throw new Error(plan.status);
    await expect(applyLegacyMoves(root, plan.moves)).rejects.toThrow(".cclinic/auto/.lock");
    expect(existsSync(path.join(root, ".cclinic/auto/.lock"))).toBe(true);
    expect(existsSync(path.join(root, ".luseen"))).toBe(false);
  });

  it("TC-CLI-070: with both folders nothing moves, and the ignore file stays when both exist", async () => {
    const root = makeTempFolder();
    writeProject(root, { ".cclinic/a": "", ".luseen/b": "" });
    await expect(planLegacyProject(root)).resolves.toEqual({ status: "both", moves: [] });
    const ignores = makeTempFolder();
    writeProject(ignores, { ".cclinic/a": "", ".cclinicignore": "old\n", ".luseenignore": "new\n" });
    await expect(planLegacyProject(ignores)).resolves.toEqual({
      status: "planned",
      moves: [{ from: ".cclinic", to: ".luseen" }],
      hasRuns: false,
    });
    expect(read(ignores, ".cclinicignore")).toBe("old\n");
    expect(read(ignores, ".luseenignore")).toBe("new\n");
  });

  it.skipIf(process.getuid?.() === 0)("TC-CLI-077: when the ignore file can't be renamed, nothing moves", async () => {
    const root = makeTempFolder();
    writeProject(root, { ".cclinic/a": "", ".cclinicignore": "docs/\n" });
    const plan = await planLegacyProject(root);
    if (plan.status !== "planned") throw new Error(plan.status);
    chmodSync(root, 0o555);
    try {
      await expect(applyLegacyMoves(root, plan.moves)).rejects.toThrow(".cclinicignore");
    } finally {
      chmodSync(root, 0o755);
    }
    expect(existsSync(path.join(root, ".cclinic/a"))).toBe(true);
    expect(read(root, ".cclinicignore")).toBe("docs/\n");
    expect(existsSync(path.join(root, ".luseen"))).toBe(false);
  });

  it("TC-CLI-083: with both folders, a lone .cclinicignore still moves, and the folders don't", async () => {
    const root = makeTempFolder();
    writeProject(root, { ".cclinic/a": "old", ".luseen/b": "new", ".cclinicignore": "secrets/\n" });
    const plan = await planLegacyProject(root);
    expect(plan).toEqual({ status: "both", moves: [{ from: ".cclinicignore", to: ".luseenignore" }] });
    if (plan.status !== "both") throw new Error(plan.status);
    await applyLegacyMoves(root, plan.moves);
    expect(read(root, ".luseenignore")).toBe("secrets/\n");
    expect(existsSync(path.join(root, ".cclinicignore"))).toBe(false);
    expect(read(root, ".cclinic/a")).toBe("old");
    expect(read(root, ".luseen/b")).toBe("new");
  });

  it("FR-CLI-033 review: two processes moving at once both carry on", async () => {
    const root = makeTempFolder();
    writeProject(root, { ".cclinic/sdd/README.md": "# Specs\n", ".cclinicignore": "docs/\n" });
    const plan = await planLegacyProject(root);
    if (plan.status !== "planned") throw new Error(plan.status);
    await Promise.all([applyLegacyMoves(root, plan.moves), applyLegacyMoves(root, plan.moves)]);
    expect(read(root, ".luseen/sdd/README.md")).toBe("# Specs\n");
    expect(read(root, ".luseenignore")).toBe("docs/\n");
  });

  it("FR-CLI-033 QA (DEF-3): a .cclinic that is a file isn't moved", async () => {
    const root = makeTempFolder();
    writeProject(root, { ".cclinic": "not a folder\n" });
    await expect(planLegacyProject(root)).resolves.toEqual({ status: "none" });
    expect(read(root, ".cclinic")).toBe("not a folder\n");
    expect(existsSync(path.join(root, ".luseen"))).toBe(false);
  });

  it("FR-CLI-033 QA (DEF-1): -C wins over a path, as luseen gui does", () => {
    const gui = new Command("gui")
      .argument("[path]")
      .option("-C, --dir <path>")
      .action(() => undefined);
    gui.parse(["a", "-C", "b"], { from: "user" });
    expect(projectFolderOf(gui)).toBe(path.resolve("b"));
    const skills = new Command("skills").argument("[path]").action(() => undefined);
    skills.parse(["a"], { from: "user" });
    expect(projectFolderOf(skills)).toBe(path.resolve("a"));
  });
});

describe("cclinic's section next to Luseen's", () => {
  it("FR-CLI-034 QA (DEF-2): the cclinic section goes, and Luseen's is replaced", () => {
    const existing = `Top.\n\n<!-- luseen:start -->\nold\n<!-- luseen:end -->\n\n${CCLINIC_SECTION}\n\nAfter.\n`;
    expect(mergeManagedSection(existing, "<!-- luseen:start -->\nnew\n<!-- luseen:end -->")).toBe(
      "Top.\n\n<!-- luseen:start -->\nnew\n<!-- luseen:end -->\n\nAfter.\n",
    );
  });
});

describe("cclinic's leftovers in analysis", () => {
  it("TC-CLI-080: cclinic's folder, section and server entry aren't project content", async () => {
    const root = makeTempFolder();
    writeProject(root, {
      "src/a.ts": "a",
      ".cclinic/sdd/a.md": "# Old\n",
      ".luseen/sdd/README.md": "# Specs\n",
      "AGENTS.md": `${CCLINIC_SECTION}\n`,
      ".mcp.json": JSON.stringify({ mcpServers: { cclinic: { command: "npx", args: ["cclinic", "mcp"] } } }),
    });
    const result = await scanFolder({
      target: root,
      outFolder: path.join(root, ".luseen/sdd"),
      include: ["**"],
      exclude: [],
      maxFileSizeMib: 1,
    });
    expect(result.included.map((file) => file.path)).toEqual(["src/a.ts"]);
  });

  it("TC-CLI-081: commits that only touch or move cclinic's folder aren't project changes", async () => {
    const root = makeTempFolder();
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
        cwd: root,
      });
    git("init", "-q");
    writeProject(root, { "src/a.ts": "a" });
    git("add", ".");
    git("commit", "-qm", "project");
    const project = git("rev-parse", "HEAD").toString().trim();
    writeProject(root, { ".cclinic/sdd/a.md": "# Old\n" });
    git("add", ".");
    git("commit", "-qm", "cclinic output");
    git("mv", ".cclinic", ".luseen");
    git("commit", "-qm", "move to luseen");
    const history = await readRawHistory(root, { environment: process.env, now: new Date() });
    expect(history?.newestCommit).toBe(project);
  });
});

describe("carrying settings over", () => {
  it("FR-CLI-036 review: a copy that fails is reported, and never stops the command", async () => {
    const base = makeTempFolder();
    // A read-only config folder, so the copy can't create Luseen's folder in it.
    writeProject(base, { "cclinic/config.json": '{"model":"opus"}\n' });
    const notices: string[] = [];
    const reporter = { notice: (message: string) => notices.push(message) } as unknown as Reporter;
    chmodSync(base, 0o555);
    try {
      await expect(migrateUserSettings({ XDG_CONFIG_HOME: base }, reporter)).resolves.toBeUndefined();
    } finally {
      chmodSync(base, 0o755);
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^Couldn't copy your saved cclinic settings to /);
  });
});
