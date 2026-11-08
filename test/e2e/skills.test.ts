/** The skills commands through the built binary, with a fake `claude`. */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempFolder, writeProject } from "../support/helpers.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

function binFolder(withClaude: boolean): string {
  const folder = makeTempFolder();
  symlinkSync(process.execPath, path.join(folder, "node"));
  if (withClaude) {
    copyFileSync(path.join(REPO, "test/fixtures/fake-claude/claude"), path.join(folder, "claude"));
    chmodSync(path.join(folder, "claude"), 0o755);
  }
  return folder;
}

function cclinic(args: readonly string[], options: { noClaude?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const home = makeTempFolder();
  const result = spawnSync(process.execPath, [path.join(REPO, "bin/cclinic.js"), ...args], {
    cwd: makeTempFolder(),
    encoding: "utf8",
    env: {
      PATH: binFolder(options.noClaude !== true),
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, "c"),
      ...options.env,
    },
    input: "",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function project(extra: Readonly<Record<string, string>> = {}): string {
  const root = makeTempFolder();
  writeProject(root, { "src/a.ts": "export const a = 1;\n", ...extra });
  return root;
}

const SKILL_FILE = ".agents/skills/test-spec/SKILL.md";

describe("agent skills", () => {
  it("TC-SKILL-005: a generation run installs the skills", () => {
    const root = project();
    const { code, stdout } = cclinic([root, "--yes"]);
    expect(code).toBe(0);
    expect(existsSync(path.join(root, ".cclinic/sdd/README.md"))).toBe(true);
    expect(existsSync(path.join(root, SKILL_FILE))).toBe(true);
    expect(existsSync(path.join(root, ".claude/skills/test-spec/SKILL.md"))).toBe(true);
    expect(stdout).toContain("Agent skills: 14 installed");
    const json = cclinic([project(), "--yes", "--json"]);
    expect((JSON.parse(json.stdout) as { skills: unknown[] }).skills).toHaveLength(14);
  });

  it("TC-SKILL-006: --no-skills leaves them out", () => {
    const root = project();
    const { code, stdout } = cclinic([root, "--yes", "--no-skills"]);
    expect(code).toBe(0);
    expect(existsSync(path.join(root, ".cclinic/sdd/README.md"))).toBe(true);
    expect(existsSync(path.join(root, ".agents"))).toBe(false);
    expect(existsSync(path.join(root, ".claude"))).toBe(false);
    expect(existsSync(path.join(root, "AGENTS.md"))).toBe(false);
    expect(existsSync(path.join(root, "CLAUDE.md"))).toBe(false);
    expect(stdout).not.toContain("Agent skills");
  });

  it.skipIf(process.getuid?.() === 0)("TC-SKILL-007: an install failure warns, and keeps the documents", () => {
    const root = project();
    mkdirSync(path.join(root, ".agents"));
    chmodSync(path.join(root, ".agents"), 0o555);
    const { code, stderr } = cclinic([root, "--yes"]);
    chmodSync(path.join(root, ".agents"), 0o755);
    expect(code).toBe(0);
    expect(stderr).toContain("Couldn't install the agent skills");
    expect(existsSync(path.join(root, ".cclinic/sdd/README.md"))).toBe(true);
  });

  it("TC-SKILL-008: cclinic skills needs no provider", () => {
    const root = project();
    const { code, stdout } = cclinic(["skills", root], { noClaude: true });
    expect(code).toBe(0);
    expect(stdout).toContain("14 installed");
    expect(existsSync(path.join(root, SKILL_FILE))).toBe(true);
    expect(existsSync(path.join(root, ".cclinic"))).toBe(false);
    const missing = cclinic(["skills", "/no/such/folder"]);
    expect(missing.code).toBe(2);
  });

  it("TC-SKILL-009: --out changes the paths inside the skills", () => {
    const root = project();
    cclinic(["skills", root, "--out", path.join(root, "docs/sdd")], { noClaude: true });
    const skill = readFileSync(path.join(root, SKILL_FILE), "utf8");
    expect(skill).toContain("docs/sdd/specs/");
    expect(skill).not.toContain(".cclinic/sdd");
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("docs/sdd/README.md");
  });

  it("TC-SKILL-010: results are reported in text and JSON", () => {
    const root = project();
    expect(cclinic(["skills", root]).stdout).toContain("14 installed");
    expect(cclinic(["skills", root]).stdout).toContain("14 unchanged");
    const parsed = JSON.parse(cclinic(["skills", root, "--json"]).stdout) as {
      skills: { path: string; status: string }[];
    };
    expect(parsed.skills).toContainEqual({ path: SKILL_FILE, status: "unchanged" });
    expect(parsed.skills).toContainEqual({ path: "AGENTS.md", status: "unchanged" });
  });

  it("TC-SKILL-011: --dry-run installs nothing", () => {
    const root = project();
    expect(cclinic([root, "--dry-run"]).code).toBe(0);
    expect(readdirSync(root)).toEqual(["src"]);
  });

  it.each([
    ["with its own AGENTS.md", { "AGENTS.md": "# Our rules\n\nUse tabs.\n" }],
    ["without an AGENTS.md", {}],
  ])("TC-SKILL-023: installing doesn't invalidate the cache or change the documents, %s", (_name, files) => {
    const root = project(files);
    const out = path.join(root, ".cclinic/sdd");
    const snapshot = (): Map<string, string> =>
      new Map(
        readdirSync(out)
          .filter((name) => name.endsWith(".md"))
          .map((name) => [name, readFileSync(path.join(out, name), "utf8")]),
      );
    expect(cclinic([root, "--yes"]).code).toBe(0);
    const before = snapshot();
    expect(before.has("scan-report.md")).toBe(true);
    const record = path.join(makeTempFolder(), "calls.jsonl");
    const { code, stdout } = cclinic([root, "--yes"], { env: { FAKE_CLAUDE_RECORD: record } });
    expect(code).toBe(0);
    expect(existsSync(record)).toBe(false);
    expect(stdout).toContain("14 unchanged");
    expect(snapshot()).toEqual(before);
    if ("AGENTS.md" in files) expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("Use tabs.");
  });

  it("doctor reports whether skills are installed", () => {
    const root = project();
    expect(cclinic(["doctor", root]).stdout).toContain("Run: cclinic skills");
    cclinic(["skills", root]);
    expect(cclinic(["doctor", root]).stdout).toContain("Agent skills: installed");
  });

  it("help lists the command, and a typo is suggested", () => {
    expect(cclinic(["--help"]).stdout).toContain("skills");
    expect(cclinic(["help", "skills"]).stdout).toContain("Examples:");
    expect(cclinic(["skillz"]).stderr).toContain('"cclinic skills"');
  });
});

describe("agent instructions", () => {
  const files = (root: string): boolean[] =>
    ["AGENTS.md", "CLAUDE.md"].map((file) => existsSync(path.join(root, file)));

  it("TC-INSTR-002: the workflow follows --out", () => {
    const root = project();
    cclinic(["skills", root, "--out", path.join(root, "docs/sdd")], { noClaude: true });
    const agents = readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("docs/sdd/specs/");
    expect(agents).not.toContain(".cclinic/sdd");
  });

  it("TC-INSTR-004: installed by a run, and not with --no-skills or --dry-run", () => {
    const run = project();
    expect(cclinic([run, "--yes"]).stdout).toContain("CLAUDE.md");
    expect(files(run)).toEqual([true, true]);
    const noSkills = project();
    cclinic([noSkills, "--yes", "--no-skills"]);
    expect(files(noSkills)).toEqual([false, false]);
    const dryRun = project();
    cclinic([dryRun, "--dry-run"]);
    expect(files(dryRun)).toEqual([false, false]);
  });

  it("TC-INSTR-005: cclinic skills needs no provider", () => {
    const root = project();
    expect(cclinic(["skills", root], { noClaude: true }).code).toBe(0);
    expect(files(root)).toEqual([true, true]);
  });

  it.each([
    ["with its own CLAUDE.md", { "CLAUDE.md": "# Our rules\n\nUse tabs.\n" }],
    ["without a CLAUDE.md", {}],
  ])("TC-INSTR-013: installing causes no reprocessing, %s", (_name, extra) => {
    const root = project(extra);
    const out = path.join(root, ".cclinic/sdd");
    const snapshot = (): Map<string, string> =>
      new Map(
        readdirSync(out)
          .filter((name) => name.endsWith(".md"))
          .map((name) => [name, readFileSync(path.join(out, name), "utf8")]),
      );
    expect(cclinic([root, "--yes"]).code).toBe(0);
    const before = snapshot();
    const record = path.join(makeTempFolder(), "calls.jsonl");
    expect(cclinic([root, "--yes"], { env: { FAKE_CLAUDE_RECORD: record } }).code).toBe(0);
    expect(existsSync(record)).toBe(false);
    expect(snapshot()).toEqual(before);
  });
});
