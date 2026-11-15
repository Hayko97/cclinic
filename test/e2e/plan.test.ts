/** `luseen plan` through the built binary, for what doesn't need a terminal. */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempFolder, writeProject } from "../support/helpers.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

function luseen(args: readonly string[], options: { withClaude?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const bin = makeTempFolder();
  symlinkSync(process.execPath, path.join(bin, "node"));
  if (options.withClaude !== false) {
    copyFileSync(path.join(REPO, "test/fixtures/fake-claude/claude"), path.join(bin, "claude"));
    chmodSync(path.join(bin, "claude"), 0o755);
  }
  const home = makeTempFolder();
  const record = path.join(makeTempFolder(), "calls.jsonl");
  const result = spawnSync(process.execPath, [path.join(REPO, "bin/luseen.js"), ...args], {
    encoding: "utf8",
    env: { PATH: bin, HOME: home, XDG_CONFIG_HOME: path.join(home, "c"), FAKE_CLAUDE_RECORD: record, ...options.env },
    input: "",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, called: existsSync(record) };
}

function project(): string {
  const root = makeTempFolder();
  writeProject(root, { ".luseen/sdd/overview.md": "# Overview\n" });
  return root;
}

describe("luseen plan", () => {
  it("TC-PLAN-001: invalid options exit 2 and call no Claude", () => {
    const root = project();
    writeProject(root, { "song.mp3": "x", "notes.md": "n" });
    for (const [args, named] of [
      [["--roadmap", "abc"], "--roadmap"],
      // Removed: a plan is limited by the Claude plan's own usage limits (FR-PLAN-015).
      [["--max-budget-usd", "1"], "--max-budget-usd"],
      [["--timeout-minutes", "0"], "--timeout-minutes"],
      [["--attach", "missing.pdf"], "missing.pdf"],
      [["--attach", "song.mp3"], "song.mp3"],
      [["--resume", "--task"], "--resume"],
      [["--resume", "plan-1", "--attach", "notes.md"], "--resume"],
      [["--resume", "seven"], "--resume"],
    ] as const) {
      const result = luseen(["plan", "-C", root, ...args]);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr, args.join(" ")).toContain(named);
      expect(result.called).toBe(false);
    }
  });

  it("TC-PLAN-002: with no terminal it exits 2 and creates no database", () => {
    const root = project();
    const result = luseen(["plan", "-C", root]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("interactive terminal");
    expect(existsSync(path.join(root, ".luseen/tasks.db"))).toBe(false);
  });

  it("TC-PLAN-003: the provider, claude and the documents are checked, naming the fix", () => {
    const root = project();
    const api = luseen(["plan", "-C", root], { env: { LUSEEN_PROVIDER: "anthropic-api" } });
    expect(api).toMatchObject({ code: 2 });
    expect(api.stderr).toContain("LUSEEN_PROVIDER");
    const noClaude = luseen(["plan", "-C", root], { withClaude: false });
    expect(noClaude.code).toBe(2);
    expect(noClaude.stderr).toContain("Install Claude Code");
    const noDocs = luseen(["plan", "-C", makeTempFolder()]);
    expect(noDocs.code).toBe(2);
    expect(noDocs.stderr).toContain("Run luseen in the project folder first");
  });

  it("TC-PLAN-025: roadmaps, milestones and milestone tasks can't be created by hand", () => {
    const root = project();
    for (const args of [
      ["roadmap", "add", "--title", "X"],
      ["milestone", "add", "--title", "M"],
      ["add", "--title", "T", "--milestone", "1"],
    ]) {
      const result = luseen(["tasks", ...args, "-C", root]);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr).toContain("luseen plan");
    }
    expect(existsSync(path.join(root, ".luseen/tasks.db"))).toBe(false);
  });
});
