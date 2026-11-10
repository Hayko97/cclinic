import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanFolder } from "../../src/adapters/discovery/file-walker.js";
import { createExtractor } from "../../src/adapters/extraction/extract.js";
import { sha256 } from "../../src/adapters/storage/document-store.js";
import {
  hasInstalledSkills,
  installSkills,
  relativeDocsPath,
  summarizeInstall,
} from "../../src/adapters/storage/skill-installer.js";
import { AGENT_SKILLS, renderAgentsBlock, renderSkill } from "../../src/core/agent-skills.js";
import { REASONS } from "../../src/core/constants/discovery.js";
import { makeTempFolder, writeProject } from "../support/helpers.js";

function install(target: string, isForced = false) {
  return installSkills({ target, out: path.join(target, ".cclinic/sdd"), isForced });
}

function statusOf(entries: Awaited<ReturnType<typeof install>>, file: string): string | undefined {
  return entries.find((entry) => entry.path === file)?.status;
}

const AGENTS_COPY = ".agents/skills/write-code/SKILL.md";
const CLAUDE_COPY = ".claude/skills/write-code/SKILL.md";

describe("installing", () => {
  it("TC-SKILL-003: each skill is in both folders, with identical content", async () => {
    const root = makeTempFolder();
    const entries = await install(root);
    for (const { name } of AGENT_SKILLS) {
      const shared = readFileSync(path.join(root, ".agents/skills", name, "SKILL.md"), "utf8");
      expect(readFileSync(path.join(root, ".claude/skills", name, "SKILL.md"), "utf8")).toBe(shared);
      expect(shared).toContain(`name: ${name}\n`);
    }
    expect(entries).toHaveLength(AGENT_SKILLS.length * 2 + 2);
    expect(entries.every((entry) => entry.status === "installed")).toBe(true);
    await expect(hasInstalledSkills(root)).resolves.toBe(true);
    await expect(hasInstalledSkills(makeTempFolder())).resolves.toBe(false);
  });

  it("TC-SKILL-004: AGENTS.md is created", async () => {
    const root = makeTempFolder();
    await install(root);
    const agents = readFileSync(path.join(root, "AGENTS.md"), "utf8");
    for (const { name } of AGENT_SKILLS) expect(agents).toContain(name);
    expect(agents).toContain(".cclinic/sdd/README.md");
  });

  it("TC-SKILL-009: paths are relative to the project", () => {
    expect(relativeDocsPath("/repo", "/repo/docs/sdd")).toBe("docs/sdd");
  });

  it("TC-SKILL-010: the summary counts each outcome", async () => {
    const root = makeTempFolder();
    expect(summarizeInstall(await install(root))).toContain("20 installed");
    expect(summarizeInstall(await install(root))).toContain("20 unchanged");
    writeFileSync(path.join(root, AGENTS_COPY), "mine");
    expect(summarizeInstall(await install(root))).toContain("1 skipped");
  });
});

describe("protecting existing work", () => {
  it("TC-SKILL-012: someone else's skill is never replaced", async () => {
    const root = makeTempFolder();
    const mine = "---\nname: write-code\ndescription: My own skill\n---\nMine\n";
    writeProject(root, { [AGENTS_COPY]: mine });
    expect(statusOf(await install(root), AGENTS_COPY)).toBe("skipped: not created by cclinic");
    expect(statusOf(await install(root, true), AGENTS_COPY)).toBe("skipped: not created by cclinic");
    expect(readFileSync(path.join(root, AGENTS_COPY), "utf8")).toBe(mine);
    expect(statusOf(await install(root), CLAUDE_COPY)).toBe("unchanged");
  });

  it("TC-SKILL-014: an edited copy is kept, unless forced", async () => {
    const root = makeTempFolder();
    await install(root);
    const file = path.join(root, AGENTS_COPY);
    const edited = `${readFileSync(file, "utf8")}\nOur team's extra rule.\n`;
    writeFileSync(file, edited);
    expect(statusOf(await install(root), AGENTS_COPY)).toBe("skipped: edited, use --force to replace");
    expect(readFileSync(file, "utf8")).toBe(edited);
    expect(statusOf(await install(root, true), AGENTS_COPY)).toBe("updated");
    expect(readFileSync(file, "utf8")).not.toContain("extra rule");
  });

  it("TC-SKILL-015: an up-to-date file isn't rewritten", async () => {
    const root = makeTempFolder();
    await install(root);
    const file = path.join(root, AGENTS_COPY);
    const old = new Date("2020-01-01");
    utimesSync(file, old, old);
    expect(statusOf(await install(root), AGENTS_COPY)).toBe("unchanged");
    expect(statusOf(await install(root), "AGENTS.md")).toBe("unchanged");
    expect(statSync(file).mtime).toEqual(old);
  });

  it("TC-SKILL-016: an unedited older version is updated", async () => {
    const root = makeTempFolder();
    const older = { name: "write-code", description: "An older description. Use whenever.", body: "Older body\n" };
    writeProject(root, { [AGENTS_COPY]: renderSkill(older, ".cclinic/sdd", sha256) });
    expect(statusOf(await install(root), AGENTS_COPY)).toBe("updated");
    expect(readFileSync(path.join(root, AGENTS_COPY), "utf8")).not.toContain("Older body");
  });

  it("TC-SKILL-019: existing AGENTS.md text is preserved exactly", async () => {
    const root = makeTempFolder();
    const original = "# Our rules\n\nAlways use tabs.\n";
    writeProject(root, { "AGENTS.md": original });
    expect(statusOf(await install(root), "AGENTS.md")).toBe("updated");
    const merged = readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(merged.startsWith(original)).toBe(true);
    expect(merged).toContain("create-spec");
    expect(statusOf(await install(root), "AGENTS.md")).toBe("unchanged");
  });

  it("TC-SKILL-020: damaged markers leave the file alone", async () => {
    const root = makeTempFolder();
    const damaged = "# Ours\n<!-- cclinic:start -->\nno end marker\n";
    writeProject(root, { "AGENTS.md": damaged });
    expect(statusOf(await install(root), "AGENTS.md")).toBe("skipped: damaged markers");
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe(damaged);
  });
});

describe("staying out of the analysis", () => {
  it("TC-SKILL-021: skills aren't analysed as project content", async () => {
    const root = makeTempFolder();
    writeProject(root, { "src/a.ts": "a" });
    await install(root);
    const result = await scanFolder({
      target: root,
      outFolder: path.join(root, ".cclinic/sdd"),
      include: ["**"],
      exclude: [],
      maxFileSizeMib: 1,
    });
    expect(result.included.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(result.skipped).toContainEqual({ path: ".agents/", reason: REASONS.tool });
    expect(result.skipped).toContainEqual({ path: ".claude/", reason: REASONS.tool });
  });

  it("TC-SKILL-022: installing doesn't change AGENTS.md's hash or text for analysis", async () => {
    const root = makeTempFolder();
    writeProject(root, { "AGENTS.md": "# Our rules\n" });
    const file = {
      path: "AGENTS.md",
      absolutePath: path.join(root, "AGENTS.md"),
      kind: "document" as const,
      sizeBytes: 1,
    };
    const extractor = createExtractor();
    const before = await extractor.extract(file);
    await install(root);
    expect(readFileSync(file.absolutePath, "utf8")).toContain(renderAgentsBlock(".cclinic/sdd"));
    const after = await extractor.extract(file);
    expect(after.sha256).toBe(before.sha256);
    expect(after.units).toEqual(before.units);
  });

  it("only the root AGENTS.md is treated specially", async () => {
    const root = makeTempFolder();
    const text = `Nested\n${renderAgentsBlock("x")}\n`;
    writeProject(root, { "sub/AGENTS.md": text });
    const result = await createExtractor().extract({
      path: "sub/AGENTS.md",
      absolutePath: path.join(root, "sub/AGENTS.md"),
      kind: "document",
      sizeBytes: 1,
    });
    expect(result.units.map((unit) => unit.text).join("\n")).toContain("cclinic:start");
    expect(existsSync(path.join(root, "AGENTS.md"))).toBe(false);
  });
});

describe("agent instructions", () => {
  const CLAUDE = "CLAUDE.md";
  const AGENTS = "AGENTS.md";

  it("TC-INSTR-001: AGENTS.md has the lifecycle and the skills", async () => {
    const root = makeTempFolder();
    await install(root);
    const agents = readFileSync(path.join(root, AGENTS), "utf8");
    for (const stage of ["1. Understand the prompt", "2. Refine the spec", "3. Implement", "4. Ask to commit"]) {
      expect(agents).toContain(stage);
    }
    for (const { name } of AGENT_SKILLS) expect(agents).toContain(`| \`${name}\` |`);
    expect(agents).toContain(".cclinic/sdd/specs/");
  });

  it("TC-INSTR-003: CLAUDE.md only imports AGENTS.md", async () => {
    const root = makeTempFolder();
    await install(root);
    const claude = readFileSync(path.join(root, CLAUDE), "utf8");
    expect(claude).toMatch(/^@AGENTS\.md$/m);
    expect(claude).not.toContain("`@AGENTS.md`");
    expect(claude).not.toContain("lifecycle");
  });

  it("TC-INSTR-007: only the sections change when the documents folder moves", async () => {
    const root = makeTempFolder();
    await installSkills({ target: root, out: path.join(root, ".cclinic/sdd"), isForced: false });
    for (const file of [AGENTS, CLAUDE]) {
      const section = readFileSync(path.join(root, file), "utf8").trim();
      writeFileSync(path.join(root, file), `# Before ${file}\n\n${section}\n\nAfter ${file}\n`);
    }
    const entries = await installSkills({ target: root, out: path.join(root, "docs/sdd"), isForced: false });
    const agents = readFileSync(path.join(root, AGENTS), "utf8");
    expect(agents.startsWith(`# Before ${AGENTS}\n\n`)).toBe(true);
    expect(agents.endsWith(`\n\nAfter ${AGENTS}\n`)).toBe(true);
    expect(agents).toContain("docs/sdd/specs/");
    expect(agents).not.toContain(".cclinic/sdd");
    expect(statusOf(entries, AGENTS)).toBe("updated");
    expect(statusOf(entries, CLAUDE)).toBe("unchanged");
  });

  it("TC-INSTR-008: an existing CLAUDE.md is preserved, with the section after it", async () => {
    const root = makeTempFolder();
    const original = "# Our rules\n\nUse tabs.\n";
    writeProject(root, { [CLAUDE]: original });
    expect(statusOf(await install(root), CLAUDE)).toBe("updated");
    const merged = readFileSync(path.join(root, CLAUDE), "utf8");
    expect(merged.startsWith(original)).toBe(true);
    expect(merged).toMatch(/^@AGENTS\.md$/m);
  });

  it("TC-INSTR-009: damaged markers leave only that file alone", async () => {
    const root = makeTempFolder();
    const damaged = "<!-- cclinic:start -->\nno end\n";
    writeProject(root, { [CLAUDE]: damaged });
    const entries = await install(root);
    expect(statusOf(entries, CLAUDE)).toBe("skipped: damaged markers");
    expect(readFileSync(path.join(root, CLAUDE), "utf8")).toBe(damaged);
    expect(statusOf(entries, AGENTS)).toBe("installed");
  });

  it("TC-INSTR-010: up-to-date files aren't rewritten", async () => {
    const root = makeTempFolder();
    await install(root);
    const old = new Date("2020-01-01");
    for (const file of [AGENTS, CLAUDE]) utimesSync(path.join(root, file), old, old);
    const entries = await install(root);
    for (const file of [AGENTS, CLAUDE]) {
      expect(statusOf(entries, file)).toBe("unchanged");
      expect(statSync(path.join(root, file)).mtime).toEqual(old);
    }
  });

  it("TC-INSTR-011: the CLAUDE.md section doesn't affect its hash or text for analysis", async () => {
    const root = makeTempFolder();
    writeProject(root, { [CLAUDE]: "# Our rules\n" });
    const file = { path: CLAUDE, absolutePath: path.join(root, CLAUDE), kind: "document" as const, sizeBytes: 1 };
    const before = await createExtractor().extract(file);
    await install(root);
    expect(readFileSync(file.absolutePath, "utf8")).toContain("@AGENTS.md");
    const after = await createExtractor().extract(file);
    expect(after.sha256).toBe(before.sha256);
    expect(after.units).toEqual(before.units);
  });

  it("TC-INSTR-012: a CLAUDE.md holding only the section isn't scanned or listed", async () => {
    const root = makeTempFolder();
    writeProject(root, { "src/a.ts": "a" });
    await install(root);
    const result = await scanFolder({
      target: root,
      outFolder: path.join(root, ".cclinic/sdd"),
      include: [],
      exclude: [],
      maxFileSizeMib: 1,
    });
    expect(result.included.map((item) => item.path)).toEqual(["src/a.ts"]);
    expect(result.skipped.map((item) => item.path)).not.toContain(CLAUDE);
  });
});

describe("review-code skill", () => {
  const SHARED_REVIEWER = ".agents/skills/review-code/SKILL.md";
  const CLAUDE_REVIEWER = ".claude/skills/review-code/SKILL.md";

  it("TC-CREV-001: review-code is installed in both folders and listed in AGENTS.md", async () => {
    const root = makeTempFolder();
    await install(root);
    const shared = readFileSync(path.join(root, SHARED_REVIEWER), "utf8");
    expect(readFileSync(path.join(root, CLAUDE_REVIEWER), "utf8")).toBe(shared);
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("| `review-code` |");
  });

  it("TC-CREV-003: an edited or someone else's review-code skill is protected", async () => {
    const edited = makeTempFolder();
    await install(edited);
    const file = path.join(edited, SHARED_REVIEWER);
    writeFileSync(file, `${readFileSync(file, "utf8")}\nOur extra rule.\n`);
    expect(statusOf(await install(edited), SHARED_REVIEWER)).toBe("skipped: edited, use --force to replace");
    expect(readFileSync(file, "utf8")).toContain("Our extra rule.");
    expect(statusOf(await install(edited, true), SHARED_REVIEWER)).toBe("updated");
    expect(readFileSync(file, "utf8")).not.toContain("Our extra rule.");

    const foreign = makeTempFolder();
    const mine = "---\nname: review-code\ndescription: Our own reviewer\n---\nMine\n";
    writeProject(foreign, { [SHARED_REVIEWER]: mine });
    expect(statusOf(await install(foreign), SHARED_REVIEWER)).toBe("skipped: not created by cclinic");
    expect(readFileSync(path.join(foreign, SHARED_REVIEWER), "utf8")).toBe(mine);
    expect(statusOf(await install(foreign, true), SHARED_REVIEWER)).toBe("skipped: not created by cclinic");
    expect(readFileSync(path.join(foreign, SHARED_REVIEWER), "utf8")).toBe(mine);
  });
});
