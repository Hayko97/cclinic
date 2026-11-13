/** `cclinic plan` through the built binary, for what doesn't need a terminal. */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempFolder, writeProject } from "../support/helpers.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

function cclinic(args: readonly string[], options: { withClaude?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const bin = makeTempFolder();
  symlinkSync(process.execPath, path.join(bin, "node"));
  if (options.withClaude !== false) {
    copyFileSync(path.join(REPO, "test/fixtures/fake-claude/claude"), path.join(bin, "claude"));
    chmodSync(path.join(bin, "claude"), 0o755);
  }
  const home = makeTempFolder();
  const record = path.join(makeTempFolder(), "calls.jsonl");
  const result = spawnSync(process.execPath, [path.join(REPO, "bin/cclinic.js"), ...args], {
    encoding: "utf8",
    env: { PATH: bin, HOME: home, XDG_CONFIG_HOME: path.join(home, "c"), FAKE_CLAUDE_RECORD: record, ...options.env },
    input: "",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, called: existsSync(record) };
}

function project(): string {
  const root = makeTempFolder();
  writeProject(root, { ".cclinic/sdd/overview.md": "# Overview\n" });
  return root;
}

describe("cclinic plan", () => {
  it("TC-PLAN-001: invalid options exit 2 and call no Claude", () => {
    const root = project();
    for (const args of [
      ["--roadmap", "abc"],
      // Removed: a plan is limited by the Claude plan's own usage limits (FR-PLAN-015).
      ["--max-budget-usd", "1"],
      ["--timeout-minutes", "0"],
    ]) {
      const result = cclinic(["plan", "-C", root, ...args]);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr).toContain(args[0]);
      expect(result.called).toBe(false);
    }
  });

  it("TC-PLAN-002: with no terminal it exits 2 and creates no database", () => {
    const root = project();
    const result = cclinic(["plan", "-C", root]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("interactive terminal");
    expect(existsSync(path.join(root, ".cclinic/tasks.db"))).toBe(false);
  });

  it("TC-PLAN-003: the provider, claude and the documents are checked, naming the fix", () => {
    const root = project();
    const api = cclinic(["plan", "-C", root], { env: { CCLINIC_PROVIDER: "anthropic-api" } });
    expect(api).toMatchObject({ code: 2 });
    expect(api.stderr).toContain("CCLINIC_PROVIDER");
    const noClaude = cclinic(["plan", "-C", root], { withClaude: false });
    expect(noClaude.code).toBe(2);
    expect(noClaude.stderr).toContain("Install Claude Code");
    const noDocs = cclinic(["plan", "-C", makeTempFolder()]);
    expect(noDocs.code).toBe(2);
    expect(noDocs.stderr).toContain("Run cclinic in the project folder first");
  });

  it("TC-PLAN-025: roadmaps, milestones and milestone tasks can't be created by hand", () => {
    const root = project();
    for (const args of [
      ["roadmap", "add", "--title", "X"],
      ["milestone", "add", "--title", "M"],
      ["add", "--title", "T", "--milestone", "1"],
    ]) {
      const result = cclinic(["tasks", ...args, "-C", root]);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr).toContain("cclinic plan");
    }
    expect(existsSync(path.join(root, ".cclinic/tasks.db"))).toBe(false);
  });
});
