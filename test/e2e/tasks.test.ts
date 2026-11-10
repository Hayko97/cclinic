/** The `tasks` commands through the built binary. */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
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

function cclinic(
  args: readonly string[],
  options: { withClaude?: boolean; cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const home = makeTempFolder();
  const result = spawnSync(process.execPath, [path.join(REPO, "bin/cclinic.js"), ...args], {
    cwd: options.cwd ?? makeTempFolder(),
    encoding: "utf8",
    env: {
      PATH: binFolder(options.withClaude === true),
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, "c"),
      ...options.env,
    },
    input: "",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tasks(root: string, ...args: string[]) {
  return cclinic(["tasks", ...args, "-C", root]);
}

describe("tasks commands", () => {
  it("TC-TASK-003: reading a project with no database creates nothing", () => {
    const root = makeTempFolder();
    expect(tasks(root, "list")).toMatchObject({ code: 0, stdout: "No tasks.\n" });
    expect(tasks(root, "roadmap")).toMatchObject({ code: 0, stdout: "No roadmaps or tasks.\n" });
    expect(tasks(root, "show", "1", "--json").code).toBe(2);
    expect(existsSync(path.join(root, ".cclinic"))).toBe(false);
  });

  it("TC-TASK-008: a task for a milestone exits 2 pointing to cclinic plan, and nothing is saved", () => {
    const root = makeTempFolder();
    const { code, stderr } = tasks(root, "add", "--title", "X", "--milestone", "9");
    expect(code).toBe(2);
    expect(stderr).toContain("cclinic plan");
    expect(JSON.parse(tasks(root, "list", "--all", "--json").stdout)).toEqual({ status: "success", tasks: [] });
  });

  it("TC-TASK-004, TC-TASK-029: creating a milestone or roadmap exits 2 and points to cclinic plan", () => {
    const root = makeTempFolder();
    for (const args of [
      ["milestone", "add", "--title", "M", "--goal", "G"],
      ["roadmap", "add", "--title", "Launch"],
    ]) {
      const { code, stderr } = tasks(root, ...args);
      expect(code, args.join(" ")).toBe(2);
      expect(stderr).toContain("cclinic plan");
    }
    expect(existsSync(path.join(root, ".cclinic"))).toBe(false);
  });

  it("TC-TASK-010: show prints every field as JSON", () => {
    const root = makeTempFolder();
    tasks(root, "add", "--title", "First");
    tasks(root, "add", "--title", "Lock", "--description", "After 5", "--spec", "auth", "--depends-on", "1");
    const { task } = JSON.parse(tasks(root, "show", "2", "--json").stdout) as { task: Record<string, unknown> };
    expect(Object.keys(task).sort()).toEqual(
      ["createdAt", "dependsOn", "description", "id", "milestoneId", "spec", "status", "title", "updatedAt"].sort(),
    );
    expect(task).toMatchObject({ id: 2, title: "Lock", description: "After 5", milestoneId: null, spec: "auth" });
    expect(task.dependsOn).toEqual([1]);
  });

  it("TC-TASK-023, TC-TASK-024: dependencies are added and removed, and bad ones exit 2", () => {
    const root = makeTempFolder();
    tasks(root, "add", "--title", "A");
    tasks(root, "add", "--title", "B", "--depends-on", "1");
    expect(tasks(root, "add", "--title", "C", "--depends-on", "1", "--depends-on", "2").code).toBe(0);
    expect(tasks(root, "depend", "1", "--on", "2")).toMatchObject({ code: 2 });
    expect(tasks(root, "depend", "1", "--on", "2").stderr).toContain("cycle");
    expect(tasks(root, "depend", "1", "--on", "1").stderr).toContain("itself");
    expect(tasks(root, "depend", "1", "--on", "99").stderr).toContain("99");
    expect(tasks(root, "undepend", "3", "--on", "2").code).toBe(0);
    const { task } = JSON.parse(tasks(root, "show", "3", "--json").stdout) as { task: { dependsOn: number[] } };
    expect(task.dependsOn).toEqual([1]);
  });

  it("TC-TASK-031: roadmaps with no database exits 0 and creates nothing", () => {
    const root = makeTempFolder();
    expect(tasks(root, "roadmaps")).toMatchObject({ code: 0 });
    expect(tasks(root, "roadmaps").stdout).toContain("No roadmaps");
    expect(existsSync(path.join(root, ".cclinic"))).toBe(false);
  });

  it("TC-TASK-038: roadmap show and remove with wrong IDs exit 2 and name the ID", () => {
    const root = makeTempFolder();
    tasks(root, "add", "--title", "Keep");
    for (const command of ["show", "remove"]) {
      for (const id of ["0", "-1", "abc", "1.5", "99"]) {
        const { code, stderr } = cclinic(["tasks", "roadmap", command, "-C", root, "--", id]);
        expect(code, `${command} ${id}`).toBe(2);
        expect(stderr).toContain(id);
      }
    }
  });

  it("TC-TASK-013: wrong IDs exit 2 and name the ID", () => {
    const root = makeTempFolder();
    tasks(root, "add", "--title", "Keep");
    const file = path.join(root, ".cclinic/tasks.db");
    const before = readFileSync(file);
    for (const command of [["show"], ["start"], ["done"], ["remove"], ["milestone", "remove"]]) {
      for (const id of ["0", "-1", "abc", "1.5", "99"]) {
        const { code, stderr } = cclinic(["tasks", ...command, "-C", root, "--", id]);
        expect(code, `${command.join(" ")} ${id}`).toBe(2);
        expect(stderr).toContain(id);
      }
    }
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("TC-TASK-015: every command prints one JSON document, even when it fails", () => {
    const root = makeTempFolder();
    const runs = [
      ["milestone", "add", "--title", "MVP", "--goal", "First"],
      ["roadmap", "add", "--title", "R"],
      ["add", "--title", "Lock"],
      ["add", "--title", "Next", "--depends-on", "1"],
      ["depend", "2", "--on", "1"],
      ["undepend", "2", "--on", "1"],
      ["roadmaps"],
      ["roadmap", "show", "1"],
      ["roadmap", "remove", "1"],
      ["list"],
      ["list", "--all"],
      ["show", "1"],
      ["start", "1"],
      ["done", "1"],
      ["roadmap"],
      ["remove", "1"],
      ["milestone", "remove", "1"],
      ["show", "7"],
      ["add", "--title", " "],
    ];
    for (const args of runs) {
      const { stdout } = tasks(root, ...args, "--json");
      expect(stdout).not.toContain("ExperimentalWarning");
      const parsed = JSON.parse(stdout) as { status: string; message?: string };
      expect(stdout.trim().split("\n"), args.join(" ")).toHaveLength(1);
      if (parsed.status === "error") expect(parsed.message).toBeTruthy();
    }
    expect(JSON.parse(tasks(root, "show", "7", "--json").stdout)).toMatchObject({ status: "error", exitCode: 2 });
  });

  it("TC-TASK-016: -C and --dir choose the project, not the current folder", () => {
    const root = makeTempFolder();
    const elsewhere = makeTempFolder();
    expect(cclinic(["tasks", "add", "-C", root, "--title", "There"], { cwd: elsewhere }).code).toBe(0);
    expect(cclinic(["tasks", "list", "--dir", root], { cwd: elsewhere }).stdout).toContain("There");
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("TC-TASK-017: a missing folder or a file exits 2", () => {
    const root = makeTempFolder();
    writeProject(root, { "file.txt": "x" });
    expect(tasks(path.join(root, "missing"), "list").code).toBe(2);
    expect(tasks(path.join(root, "file.txt"), "list").code).toBe(2);
  });

  it("TC-TASK-018: works with no claude, no API key and no terminal", () => {
    const root = makeTempFolder();
    for (const args of [
      ["add", "--title", "A"],
      ["list"],
      ["start", "1"],
      ["done", "1"],
      ["roadmap"],
      ["roadmaps"],
      ["remove", "1"],
    ]) {
      expect(tasks(root, ...args).code, args.join(" ")).toBe(0);
    }
  });

  it("TC-TASK-022: changing tasks doesn't make a re-run reprocess anything", () => {
    const root = makeTempFolder();
    writeProject(root, { "src/a.ts": "export const a = 1;\n" });
    expect(cclinic([root, "--yes"], { withClaude: true }).code).toBe(0);
    const out = path.join(root, ".cclinic/sdd");
    const snapshot = (): Map<string, string> =>
      new Map(
        readdirSync(out)
          .filter((name) => name.endsWith(".md"))
          .map((name) => [name, readFileSync(path.join(out, name), "utf8")]),
      );
    const before = snapshot();
    expect(tasks(root, "add", "--title", "Next").code).toBe(0);
    const record = path.join(makeTempFolder(), "calls.jsonl");
    expect(cclinic([root, "--yes"], { withClaude: true, env: { FAKE_CLAUDE_RECORD: record } }).code).toBe(0);
    expect(existsSync(record)).toBe(false);
    expect(snapshot()).toEqual(before);
  });
});
