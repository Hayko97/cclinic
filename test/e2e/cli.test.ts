/** Runs the built binary against a fake `claude`. It uses no real usage and no network, apart from the npm check. */
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempFolder, writeProject } from "../support/helpers.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const BIN = path.join(REPO, "bin/luseen.js");
const FAKE = path.join(REPO, "test/fixtures/fake-claude/claude");

interface RunOutput {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly noClaude?: boolean;
  readonly timeoutMs?: number;
  readonly onStart?: (child: ReturnType<typeof spawn>) => void;
}

function pathFolder(includeClaude: boolean): string {
  const folder = makeTempFolder();
  symlinkSync(process.execPath, path.join(folder, "node"));
  if (includeClaude) {
    copyFileSync(FAKE, path.join(folder, "claude"));
    chmodSync(path.join(folder, "claude"), 0o755);
  }
  return folder;
}

function luseen(args: readonly string[], options: RunOptions = {}): Promise<RunOutput> {
  const home = makeTempFolder();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: options.cwd ?? makeTempFolder(),
      env: {
        PATH: pathFolder(options.noClaude !== true),
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
    child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out. stdout: ${stdout} stderr: ${stderr}`));
    }, options.timeoutMs ?? 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    options.onStart?.(child);
  });
}

function sampleProject(extra: Readonly<Record<string, string>> = {}): string {
  const root = makeTempFolder();
  writeProject(root, {
    "src/app.ts": "export const a = 1;\n",
    "docs/readme.md": "# Hello\n",
    "package.json": "{}\n",
    ...extra,
  });
  return root;
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("Condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("running", () => {
  it("TC-CLI-001: uses the current folder by default", async () => {
    const root = sampleProject();
    const { code, stdout } = await luseen(["--dry-run"], { cwd: root });
    expect(code).toBe(0);
    expect(stdout).toContain(path.basename(root));
  });

  it("TC-CLI-002: uses a given path", async () => {
    const root = sampleProject();
    const { code, stdout } = await luseen([root, "--dry-run"]);
    expect(code).toBe(0);
    expect(stdout).toContain(path.basename(root));
  });

  it("TC-CLI-003: a missing path or file exits 2, naming it", async () => {
    const root = sampleProject();
    for (const target of ["/no/such/path", path.join(root, "package.json")]) {
      const { code, stderr } = await luseen([target]);
      expect(code).toBe(2);
      expect(stderr).toContain(target);
    }
  });

  it("TC-CLI-004: help lists model and every option", async () => {
    const { code, stdout } = await luseen(["--help"]);
    expect(code).toBe(0);
    for (const text of [
      "model",
      "doctor",
      "clean",
      "--out",
      "--provider",
      "--model",
      "--effort",
      "--include",
      "--exclude",
      "--dry-run",
      "--force",
      "--yes",
      "--no-cache",
      "--allow-broad-target",
      "--max-files",
      "--max-input-tokens",
      "--max-file-size-mib",
      "--max-budget-usd",
      "--concurrency",
      "--timeout-minutes",
      "--max-retries",
      "--quiet",
      "--debug",
      "--debug-file",
      "--json",
      "--color",
    ]) {
      expect(stdout).toContain(text);
    }
  });

  it("TC-CLI-005: the version matches package.json", async () => {
    const expected = (JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { version: string }).version;
    for (const flag of ["--version", "-v"]) expect((await luseen([flag])).stdout.trim()).toBe(expected);
  });

  it.each([
    ["--provider", "nope"],
    ["--concurrency", "0"],
    ["--concurrency", "17"],
    ["--max-budget-usd", "-1"],
    ["--unknown"],
  ])("TC-CLI-006: rejects %s %s", async (...args) => {
    const { code, stdout } = await luseen([
      ...args.filter((item): item is string => typeof item === "string"),
      "--dry-run",
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
  });

  it("TC-CLI-007: options reach the pipeline", async () => {
    const root = sampleProject({ "vendor/kept.ts": "x", "src/drop.ts": "y" });
    const { stdout } = await luseen([
      root,
      "--dry-run",
      "--json",
      "--include",
      "vendor/**",
      "--exclude",
      "src/drop.ts",
    ]);
    const paths = (JSON.parse(stdout) as { included: { path: string }[] }).included.map((file) => file.path);
    expect(paths).toContain("vendor/kept.ts");
    expect(paths).not.toContain("src/drop.ts");
  });

  it("TC-CLI-008: --dry-run makes no generation calls or files", async () => {
    const root = sampleProject();
    const record = path.join(makeTempFolder(), "calls.jsonl");
    const { code } = await luseen([root, "--dry-run"], { env: { FAKE_CLAUDE_RECORD: record } });
    expect(code).toBe(0);
    expect(existsSync(record)).toBe(false);
    expect(existsSync(path.join(root, ".luseen"))).toBe(false);
  });

  it("TC-CLI-009: the summary has all fields, and says content goes to Anthropic", async () => {
    const { stdout } = await luseen([sampleProject(), "--dry-run"]);
    for (const text of [
      "Target:",
      "Provider:   claude-cli",
      "claude.ai",
      "Sonnet 5.5",
      "Medium",
      "Files:",
      "Skipped:",
      "Tokens:",
      "sent to Anthropic",
    ]) {
      expect(stdout).toContain(text);
    }
  });

  it("TC-CLI-010: the API shows a cost, and a subscription shows tokens only", async () => {
    const api = await luseen([sampleProject(), "--dry-run", "--provider", "anthropic-api"], {
      noClaude: true,
      env: { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" },
    });
    expect(api.stdout).toContain("Cost:");
    expect(api.stdout).toContain("for summarising only");
    expect(api.stdout).toContain("Combining and writing specs use more");
    expect(api.stderr).toContain("estimated from characters");
    expect((await luseen([sampleProject(), "--dry-run"])).stdout).not.toContain("Cost:");
  });

  it("TC-CLI-013: with no terminal and no --yes, exits 2 without waiting", async () => {
    const record = path.join(makeTempFolder(), "calls.jsonl");
    const { code, stderr } = await luseen([sampleProject()], {
      env: { FAKE_CLAUDE_RECORD: record },
      timeoutMs: 10_000,
    });
    expect(code).toBe(2);
    expect(stderr).toContain("--yes");
    expect(existsSync(record)).toBe(false);
  });

  it("TC-CLI-014: --yes runs a full generation without prompting", async () => {
    const root = sampleProject();
    const { code, stdout } = await luseen([root, "--yes"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Documents written to");
    expect(stdout).toContain("1 specs, 1 requirements, 1 test cases");
    expect(existsSync(path.join(root, ".luseen/sdd/specs/core-feature/verification.md"))).toBe(true);
  });

  it("TC-CLI-015: progress is on stderr, and content appears in neither stream", async () => {
    const { stdout, stderr } = await luseen([sampleProject({ "src/m.ts": "MARKER-CONTENT-123\n" }), "--yes"]);
    expect(stderr).toContain("Scanning");
    expect(stdout).not.toContain("Scanning");
    expect(stdout + stderr).not.toContain("MARKER-CONTENT-123");
  });

  it.each<[string, string[], Record<string, string>, number, boolean]>([
    ["success", ["--yes"], {}, 0, false],
    ["usage error", ["--bad"], {}, 2, false],
    ["no provider", ["--yes"], {}, 3, true],
    ["LLM failure", ["--yes"], { FAKE_CLAUDE_MODE: "auth-error" }, 4, false],
  ])("TC-CLI-016: %s exits with its code", async (_name, args, env, expected, noClaude) => {
    const { code } = await luseen([sampleProject(), ...args], { env, noClaude });
    expect(code).toBe(expected);
  });

  it("TC-CLI-018: an option beats LUSEEN_PROVIDER, which beats the default", async () => {
    const env = {
      LUSEEN_PROVIDER: "anthropic-api",
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
    };
    expect((await luseen([sampleProject(), "--dry-run"], { env })).stdout).toContain("anthropic-api");
    expect((await luseen([sampleProject(), "--dry-run", "--provider", "claude-cli"], { env })).stdout).toContain(
      "Provider:   claude-cli",
    );
    expect((await luseen([sampleProject(), "--dry-run"], { env: { LUSEEN_PROVIDER: "nope" } })).code).toBe(2);
  });
});

describe("help and output", () => {
  it.each(["model", "doctor", "clean"])(
    "TC-CLI-020: help for %s has description, examples and link, in both forms",
    async (command) => {
      const { stdout } = await luseen([command, "--help"]);
      expect(stdout).toContain("Examples:");
      expect(stdout).toContain("luseen guide");
      expect((await luseen(["help", command])).stdout).toBe(stdout);
    },
  );

  it("TC-CLI-021: help wins over other flags", async () => {
    const root = sampleProject();
    const { code, stdout, stderr } = await luseen([root, "--dry-run", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stderr).not.toContain("Scanning");
  });

  it("TC-CLI-022: typos get suggestions, and run nothing", async () => {
    const command = await luseen(["docter"]);
    expect(command.code).toBe(2);
    expect(command.stderr).toContain('"luseen doctor"');
    const option = await luseen(["--dry-rn"]);
    expect(option.code).toBe(2);
    expect(option.stderr).toContain("--dry-run");
  });

  it("TC-CLI-023: --quiet shows only the result", async () => {
    const { code, stdout, stderr } = await luseen([sampleProject(), "--yes", "--quiet"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Documents written");
  });

  it("TC-CLI-024: --debug shows timings, but no content", async () => {
    const { stderr } = await luseen([sampleProject({ "src/m.ts": "MARKER-CONTENT-123\n" }), "--yes", "--debug"]);
    expect(stderr).toMatch(/\[\+\d+ms\]/);
    expect(stderr).not.toContain("MARKER-CONTENT-123");
  });

  it("TC-CLI-025: --quiet with --debug exits 2", async () => {
    expect((await luseen(["--quiet", "--debug"])).code).toBe(2);
  });

  it("TC-CLI-026: --json gives one object, for success and failure", async () => {
    const success = await luseen([sampleProject(), "--yes", "--json"]);
    expect(JSON.parse(success.stdout)).toMatchObject({
      status: "success",
      specs: 1,
      requirements: 1,
      testCases: 1,
      cachedChunks: 0,
    });
    const failure = await luseen([sampleProject(), "--yes", "--json"], { env: { FAKE_CLAUDE_MODE: "auth-error" } });
    expect(failure.code).toBe(4);
    expect(JSON.parse(failure.stdout)).toMatchObject({ status: "error", exitCode: 4, errorType: "AuthError" });
    const usage = await luseen(["--json", "--concurrency", "99"]);
    expect(JSON.parse(usage.stdout)).toMatchObject({ status: "error", exitCode: 2 });
  });

  it("TC-CLI-027: --dry-run --json lists every path with reasons", async () => {
    const { stdout } = await luseen([sampleProject({ "vendor/x.ts": "x", "a.dll": "x" }), "--dry-run", "--json"]);
    const parsed = JSON.parse(stdout) as { included: { path: string }[]; skipped: { path: string; reason: string }[] };
    expect(parsed.included.map((file) => file.path)).toContain("src/app.ts");
    expect(parsed.skipped).toContainEqual({ path: "vendor/", reason: "dependency or build folder" });
    expect(parsed.skipped).toContainEqual({ path: "a.dll", reason: "binary file" });
  });

  it("TC-CLI-028: color appears only with --color always, and isn't printed in logs", async () => {
    const ANSI = "\u001b[";
    expect((await luseen(["--bad"])).stderr).not.toContain(ANSI);
    const forced = await luseen([sampleProject(), "--yes", "--color", "always"], {
      env: { FAKE_CLAUDE_MODE: "auth-error" },
    });
    expect(forced.stderr).toContain(ANSI);
    const never = await luseen([sampleProject(), "--yes", "--color", "never"], {
      env: { FAKE_CLAUDE_MODE: "auth-error", TERM: "xterm" },
    });
    expect(never.stderr).not.toContain(ANSI);
    const noColor = await luseen([sampleProject(), "--yes"], {
      env: { FAKE_CLAUDE_MODE: "auth-error", NO_COLOR: "1" },
    });
    expect(noColor.stderr).not.toContain(ANSI);
  });

  it("TC-CLI-030: a failure says re-running continues", async () => {
    const { code, stderr } = await luseen([sampleProject(), "--yes", "--concurrency", "1"], {
      env: { FAKE_CLAUDE_MODE: "fail-after-1", FAKE_CLAUDE_RECORD: path.join(makeTempFolder(), "c.jsonl") },
    });
    expect(code).toBe(4);
    expect(stderr).toContain("continues from where it stopped");
  });

  it("TC-CLI-051: --debug-file has timings, but no content", async () => {
    const file = path.join(makeTempFolder(), "debug.log");
    await luseen([sampleProject({ "src/m.ts": "MARKER-CONTENT-123\n" }), "--yes", "--debug-file", file]);
    const log = readFileSync(file, "utf8");
    expect(log).toMatch(/\[\+\d+ms\]/);
    expect(log).not.toContain("MARKER-CONTENT-123");
  });
});

describe("help page and guide", () => {
  it("TC-CLI-052: the main help explains how it works, with grouped options", async () => {
    const { code, stdout } = await luseen(["--help"]);
    expect(code).toBe(0);
    for (const text of [
      "How it works:",
      "Get started:",
      "Examples:",
      "Output options:",
      "Generation options:",
      "Limits:",
      "Commands:",
    ]) {
      expect(stdout).toContain(text);
    }
    for (const command of ["guide", "model", "skills", "doctor", "clean", "help"])
      expect(stdout).toContain(`\n  ${command}`);
  });

  it("TC-CLI-053: the guide works with no provider, and covers everything", async () => {
    const { code, stdout } = await luseen(["guide"], { noClaude: true });
    expect(code).toBe(0);
    for (const text of [
      "STEP 1",
      "STEP 2",
      "STEP 3",
      "STEP 4",
      "STEP 5",
      "STEP 6",
      "COMMANDS",
      "WHAT'S SKIPPED",
      "LIMITS",
      "COMMON PROBLEMS",
      "EXIT CODES",
      "create-spec",
      "refine-spec",
      "write-code",
      "implement-spec",
      "test-spec",
      "luseen doctor",
      "luseen skills",
      "luseen clean",
      "luseen model",
    ]) {
      expect(stdout).toContain(text);
    }
    expect((await luseen(["guid"])).stderr).toContain('"luseen guide"');
  });

  it("TC-CLI-054: the guide's limits match the real defaults", async () => {
    const root = sampleProject();
    const { stdout } = await luseen(["guide"]);
    const help = (await luseen(["--help"], { cwd: root })).stdout.replace(/\s+/g, " ");
    for (const [flag, value] of [
      ["--max-files", "10000"],
      ["--max-input-tokens", "2000000"],
      ["--max-file-size-mib", "1"],
      ["--concurrency", "4"],
      ["--timeout-minutes", "30"],
      ["--max-retries", "2"],
    ] as const) {
      expect(stdout).toMatch(new RegExp(`${flag} <n>\\s+${value}\\b`));
      expect(help).toMatch(new RegExp(`${flag} <n> [^-]*\\(default: ${value}\\)`));
    }
  });

  it("TC-CLI-055: a successful run says what to do next", async () => {
    const { stdout } = await luseen([sampleProject(), "--yes"]);
    expect(stdout).toContain("Next:");
    expect(stdout).toContain("luseen guide");
  });
});

describe("doctor and clean", () => {
  it("TC-CLI-031: each failure has a fix", async () => {
    const { stdout } = await luseen(["doctor"], { noClaude: true });
    expect(stdout).toContain("FAIL Claude CLI: not found");
    expect(stdout).toContain("Install Claude Code");
    const loggedOut = await luseen(["doctor"], { env: { FAKE_CLAUDE_LOGGED_OUT: "1" } });
    expect(loggedOut.stdout).toContain("claude auth login");
  });

  it("TC-CLI-032: doctor never shows the key or calls Claude", async () => {
    const record = path.join(makeTempFolder(), "calls.jsonl");
    const env = { ANTHROPIC_API_KEY: "MARKER-KEY-123", FAKE_CLAUDE_RECORD: record };
    const { stdout } = await luseen(["doctor"], { env });
    expect(stdout).toContain("ANTHROPIC_API_KEY: set");
    expect(stdout).not.toContain("MARKER-KEY-123");
    expect(JSON.parse((await luseen(["doctor", "--json"], { env })).stdout)).toMatchObject({ ready: true });
    expect(existsSync(record)).toBe(false);
  });

  it("TC-CLI-033: exits 0 when usable, and 3 when not", async () => {
    expect((await luseen(["doctor"])).code).toBe(0);
    expect((await luseen(["doctor"], { noClaude: true })).code).toBe(3);
  });

  it("TC-CLI-035: clean removes only the cache and failed drafts", async () => {
    const root = sampleProject();
    await luseen([root, "--yes"]);
    const readme = path.join(root, ".luseen/sdd/README.md");
    const before = readFileSync(readme, "utf8");
    const { code, stdout } = await luseen(["clean", root, "--yes"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Freed");
    expect(existsSync(path.join(root, ".luseen/cache"))).toBe(false);
    expect(readFileSync(readme, "utf8")).toBe(before);
  });

  it("TC-CLI-036: clean with no terminal and no --yes exits 2", async () => {
    const root = sampleProject();
    await luseen([root, "--yes"]);
    expect((await luseen(["clean", root])).code).toBe(2);
    expect(existsSync(path.join(root, ".luseen/cache"))).toBe(true);
  });
});

describe("safety and limits", () => {
  it.each<[string, number]>([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ])("TC-CLI-038: %s exits with %i, leaving no process", async (signal, expected) => {
    const record = path.join(makeTempFolder(), "c.jsonl");
    const root = sampleProject();
    const start = Date.now();
    const { code, stderr } = await luseen([root, "--yes"], {
      env: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RECORD: record },
      onStart: (child) => {
        void waitFor(() => existsSync(record)).then(() => child.kill(signal as NodeJS.Signals));
      },
    });
    expect(code).toBe(expected);
    expect(stderr).toContain("Stopping");
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(existsSync(path.join(root, ".luseen/.lock"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("TC-CLI-040: a read-only output folder exits 2 before any call", async () => {
    const root = sampleProject();
    mkdirSync(path.join(root, "readonly"));
    chmodSync(path.join(root, "readonly"), 0o555);
    const record = path.join(makeTempFolder(), "c.jsonl");
    const { code, stderr } = await luseen([root, "--yes", "--out", path.join(root, "readonly/sdd")], {
      env: { FAKE_CLAUDE_RECORD: record },
    });
    chmodSync(path.join(root, "readonly"), 0o755);
    expect(code).toBe(2);
    expect(stderr).toContain("Can't write");
    expect(existsSync(record)).toBe(false);
  });

  it("TC-CLI-041: a second run is refused while the first works", async () => {
    const root = sampleProject();
    const lock = path.join(root, ".luseen/.lock");
    let second: RunOutput | undefined;
    const first = await luseen([root, "--yes"], {
      env: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DELAY_MS: "1500" },
      onStart: () => {
        void waitFor(() => existsSync(lock)).then(async () => {
          second = await luseen([root, "--yes"]);
        });
      },
    });
    await waitFor(() => second !== undefined);
    expect(first.code).toBe(0);
    expect(second?.code).toBe(2);
    expect(second?.stderr).toContain("already working");
  });

  it("TC-CLI-042: a lock from a dead process is replaced", async () => {
    const root = sampleProject();
    writeProject(root, { ".luseen/.lock": "999999" });
    expect((await luseen([root, "--yes"])).code).toBe(0);
    expect(existsSync(path.join(root, ".luseen/.lock"))).toBe(false);
  });

  it("TC-CLI-043: --dry-run and doctor don't need the lock", async () => {
    const root = sampleProject();
    writeProject(root, { ".luseen/.lock": String(process.pid) });
    expect((await luseen([root, "--dry-run"])).code).toBe(0);
    expect((await luseen(["doctor", root])).code).toBe(0);
    expect((await luseen([root, "--yes"])).code).toBe(2);
  });

  it("TC-CLI-044: a home folder needs --allow-broad-target", async () => {
    const home = makeTempFolder();
    writeProject(home, { "a.ts": "a" });
    const refused = await luseen([home, "--yes"], { env: { HOME: home } });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("--allow-broad-target");
    expect((await luseen([home, "--allow-broad-target", "--dry-run"], { env: { HOME: home } })).code).toBe(0);
  });

  it.each([
    ["--max-files", "0"],
    ["--max-input-tokens", "0"],
    ["--max-file-size-mib", "0"],
    ["--max-file-size-mib", "51"],
    ["--timeout-minutes", "0"],
    ["--timeout-minutes", "121"],
    ["--max-retries", "-1"],
    ["--max-retries", "11"],
    ["--max-budget-usd", "0"],
  ])("TC-CLI-046: rejects %s %s", async (flag, value) => {
    expect((await luseen([sampleProject(), flag, value, "--dry-run"])).code).toBe(2);
  });

  it.each([
    ["--max-files", "1"],
    ["--max-file-size-mib", "50"],
    ["--timeout-minutes", "120"],
    ["--max-retries", "0"],
    ["--max-retries", "10"],
    ["--concurrency", "16"],
  ])("TC-CLI-046: accepts %s %s", async (flag, value) => {
    const root = makeTempFolder();
    writeProject(root, { "a.ts": "a\n" });
    expect((await luseen([root, flag, value, "--dry-run"])).code).toBe(0);
  });

  it("TC-CLI-047: limits stop the run before any call, and explain why", async () => {
    const record = path.join(makeTempFolder(), "c.jsonl");
    const env = { FAKE_CLAUDE_RECORD: record };
    const files = await luseen([sampleProject(), "--yes", "--max-files", "1"], { env });
    expect(files.code).toBe(2);
    expect(files.stderr).toContain("--max-files");
    expect(files.stderr).toContain("--exclude");
    const tokens = await luseen([sampleProject(), "--yes", "--max-input-tokens", "1"], { env });
    expect(tokens.code).toBe(2);
    expect(tokens.stderr).toContain("--max-input-tokens");
    expect(existsSync(record)).toBe(false);
  });

  it("TC-CLI-048: cached modules don't count toward the token limit", async () => {
    const root = sampleProject();
    await luseen([root, "--yes"]);
    expect((await luseen([root, "--yes", "--max-input-tokens", "1"])).code).toBe(0);
  });

  it("TC-DISC-020, TC-CLI-084: nothing to analyse exits 2, says how to start a new project, with no calls", async () => {
    const root = makeTempFolder();
    writeProject(root, { "node_modules/a.js": "a" });
    const { code, stderr } = await luseen([root, "--yes"]);
    expect(code).toBe(2);
    expect(stderr).toContain(`Nothing to analyse in ${realpathSync(root)}.`);
    expect(stderr).toContain("`luseen gui` to start a new project with the PM");
  });

  it("TC-CLI-085: an empty folder's dry run is empty, exits 0, and writes nothing", async () => {
    const root = makeTempFolder();
    const { code, stdout } = await luseen([root, "--dry-run", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ status: "dry-run", empty: true, included: [] });
    expect(readdirSync(root)).toEqual([]);
  });

  it("TC-CLI-032: a set-up project whose files are all excluded still says no files remain", async () => {
    const root = sampleProject();
    await luseen([root, "--yes"]);
    const { code, stderr } = await luseen([root, "--yes", "--exclude", "**/*"]);
    expect(code).toBe(2);
    expect(stderr).toContain("No files to analyse remain after the exclusion rules");
  });

  it("TC-CLI-084 (QA): an empty folder with only .git, with --yes, exits 2 naming luseen and luseen gui, with no calls", async () => {
    const root = makeTempFolder();
    mkdirSync(path.join(root, ".git"));
    const record = path.join(makeTempFolder(), "c.jsonl");
    const { code, stderr } = await luseen([root, "--yes"], { env: { FAKE_CLAUDE_RECORD: record } });
    expect(code).toBe(2);
    expect(stderr).toContain(`Nothing to analyse in ${realpathSync(root)}.`);
    expect(stderr).toContain("Run `luseen` in a terminal or `luseen gui` to start a new project with the PM");
    expect(existsSync(record)).toBe(false);
    expect(readdirSync(root)).toEqual([".git"]);
  });

  it("TC-DISC-020 (QA): a folder with only node_modules prints Nothing to analyse, exits 2, and never calls claude", async () => {
    const root = makeTempFolder();
    writeProject(root, { "node_modules/a.js": "a" });
    const record = path.join(makeTempFolder(), "c.jsonl");
    const { code, stderr } = await luseen([root, "--yes"], { env: { FAKE_CLAUDE_RECORD: record } });
    expect(code).toBe(2);
    expect(stderr).toContain(`Nothing to analyse in ${realpathSync(root)}.`);
    expect(existsSync(record)).toBe(false);
    expect(existsSync(path.join(root, ".luseen"))).toBe(false);
  });

  it("TC-CLI-032 (QA): a set-up project whose files are all excluded exits 2 before sending", async () => {
    const root = sampleProject();
    await luseen([root, "--yes"]);
    const record = path.join(makeTempFolder(), "c.jsonl");
    const { code, stderr } = await luseen([root, "--yes", "--exclude", "**/*"], {
      env: { FAKE_CLAUDE_RECORD: record },
    });
    expect(code).toBe(2);
    expect(stderr).toContain("No files to analyse remain after the exclusion rules");
    expect(stderr).not.toContain("Nothing to analyse");
    expect(existsSync(record)).toBe(false);
  });

  it("TC-CLI-085 (QA): the empty dry run's JSON has 0 files, and --dry-run alone, --json alone and --quiet don't ask", async () => {
    const root = makeTempFolder();
    writeProject(root, { "node_modules/a.js": "a" });
    const dry = await luseen([root, "--dry-run", "--json"]);
    expect(dry.code).toBe(0);
    const parsed = JSON.parse(dry.stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({ status: "dry-run", empty: true, included: [], estimatedTokens: 0 });
    expect(parsed["target"]).toBe(realpathSync(root));
    for (const flags of [["--dry-run"], ["--json"], ["--quiet"]]) {
      const run = await luseen([root, ...flags]);
      expect(run.code, flags.join(" ")).toBe(2);
      expect(run.stderr + run.stdout, flags.join(" ")).toContain("Nothing to analyse");
    }
    expect(readdirSync(root)).toEqual(["node_modules"]);
  });

  it("TC-OUT-021: a hand edit exits 2 before any call", async () => {
    const root = sampleProject();
    await luseen([root, "--yes"]);
    writeFileSync(path.join(root, ".luseen/sdd/overview.md"), "edited");
    const record = path.join(makeTempFolder(), "c.jsonl");
    const { code, stderr } = await luseen([root, "--yes"], { env: { FAKE_CLAUDE_RECORD: record } });
    expect(code).toBe(2);
    expect(stderr).toContain("overview.md");
    expect(existsSync(record)).toBe(false);
  });
});

describe("interruptions", () => {
  it("TC-CLI-039: a second Ctrl+C exits immediately", async () => {
    const record = path.join(makeTempFolder(), "c.jsonl");
    const { code } = await luseen([sampleProject(), "--yes"], {
      env: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RECORD: record },
      onStart: (child) => {
        void waitFor(() => existsSync(record)).then(() => {
          child.kill("SIGINT");
          child.kill("SIGINT");
        });
      },
    });
    expect(code).toBe(130);
  });
});

describe("model selection", () => {
  it("TC-MODEL-010: defaults to Sonnet 5.5 at Medium", async () => {
    const { stdout } = await luseen([sampleProject(), "--dry-run"]);
    expect(stdout).toContain("Sonnet 5.5");
    expect(stdout).toContain("Medium");
  });

  it("TC-MODEL-005: values skip the menu", async () => {
    const { code, stdout } = await luseen([sampleProject(), "--model", "opus", "--effort", "high", "--dry-run"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Opus 5.5");
    expect(stdout).toContain("High");
  });

  it("TC-MODEL-011: invalid values print the options and exit 2", async () => {
    for (const args of [
      ["--model", "nope"],
      ["--effort", "nope"],
    ]) {
      const { code, stderr } = await luseen([sampleProject(), ...args]);
      expect(code).toBe(2);
      expect(stderr).toContain("sonnet");
      expect(stderr).toContain("xhigh");
    }
  });

  it("TC-MODEL-012: a menu with no terminal prints the options and exits 2", async () => {
    for (const args of [["--model"], ["--effort"], ["model"]]) {
      const { code, stderr } = await luseen(args, { cwd: sampleProject(), timeoutMs: 10_000 });
      expect(code).toBe(2);
      expect(stderr).toContain("sonnet");
    }
  });

  it("TC-MODEL-016: the full API ID is accepted", async () => {
    const { code, stdout } = await luseen([sampleProject(), "--model", "claude-opus-5-5", "--dry-run"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Opus 5.5");
  });

  it("TC-MODEL-020: invalid environment values exit 2", async () => {
    expect((await luseen([sampleProject(), "--dry-run"], { env: { LUSEEN_MODEL: "nope" } })).code).toBe(2);
    expect((await luseen([sampleProject(), "--dry-run"], { env: { LUSEEN_EFFORT: "nope" } })).code).toBe(2);
  });

  it("TC-MODEL-021: --list works with no terminal, and in JSON", async () => {
    const config = makeTempFolder();
    writeProject(config, { "luseen/config.json": '{"model":"haiku","effort":"low"}' });
    const env = { XDG_CONFIG_HOME: config };
    const text = await luseen(["model", "--list"], { env });
    expect(text.stdout).toMatch(/\* haiku/);
    const parsed = JSON.parse((await luseen(["model", "--list", "--json"], { env })).stdout) as {
      current: unknown;
      models: unknown[];
    };
    expect(parsed.current).toEqual({ model: "haiku", effort: "low" });
    expect(parsed.models).toHaveLength(4);
  });

  it("TC-MODEL-022: --reset goes back to the defaults, even with nothing saved", async () => {
    const config = makeTempFolder();
    writeProject(config, { "luseen/config.json": '{"model":"haiku"}' });
    const env = { XDG_CONFIG_HOME: config };
    expect((await luseen(["model", "--reset"], { env })).code).toBe(0);
    expect((await luseen(["model", "--reset"], { env })).code).toBe(0);
    expect(readdirSync(path.join(config, "luseen"))).toEqual([]);
    expect((await luseen([sampleProject(), "--dry-run"], { env })).stdout).toContain("Sonnet 5.5");
  });

  it("TC-MODEL-018: a bad config warns, and keeps the valid setting", async () => {
    const config = makeTempFolder();
    writeProject(config, { "luseen/config.json": '{"model":"gone","effort":"high"}' });
    const { stdout, stderr } = await luseen([sampleProject(), "--dry-run"], { env: { XDG_CONFIG_HOME: config } });
    expect(stderr).toContain("Warning");
    expect(stdout).toContain("Sonnet 5.5");
    expect(stdout).toContain("High");
    writeProject(config, { "luseen/config.json": "{corrupt" });
    expect((await luseen([sampleProject(), "--dry-run"], { env: { XDG_CONFIG_HOME: config } })).stderr).toContain(
      "Warning",
    );
  });
});

describe("Codex models", () => {
  it("TC-LLM-056: they can't be selected yet", async () => {
    const chosen = await luseen([sampleProject(), "--model", "gpt-6.1-sol", "--dry-run"]);
    expect(chosen.code).toBe(2);
    expect(chosen.stderr).toContain("isn't a known model");
    // The error repeats what was typed, but must not offer Codex models as options.
    expect(chosen.stderr).not.toContain("Astra");
    expect(chosen.stderr).not.toContain("Sol:");
    const { stdout } = await luseen(["model", "--list"]);
    expect(stdout).toContain("Sonnet 5.5");
    expect(stdout).not.toContain("gpt-6");
    expect(stdout).not.toContain("Astra");
  });
});

describe("providers through the real process", () => {
  function records(
    file: string,
  ): { args: string[]; cwd: string; cwdEntries: string[]; env: Record<string, string | null>; prompt: string }[] {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as never);
  }

  it("TC-LLM-002: no provider exits 3, and explains both options", async () => {
    const { code, stderr } = await luseen([sampleProject(), "--yes"], { noClaude: true });
    expect(code).toBe(3);
    expect(stderr).toContain("claude auth login");
    expect(stderr).toContain("ANTHROPIC_API_KEY");
  });

  it("TC-LLM-004: an explicit provider doesn't fall back", async () => {
    expect(
      (
        await luseen([sampleProject(), "--yes", "--provider", "claude-cli"], {
          noClaude: true,
          env: { ANTHROPIC_API_KEY: "k" },
        })
      ).code,
    ).toBe(3);
    expect((await luseen([sampleProject(), "--yes", "--provider", "anthropic-api"])).code).toBe(3);
  });

  it("TC-LLM-003: an empty key counts as missing", async () => {
    expect((await luseen([sampleProject(), "--yes"], { noClaude: true, env: { ANTHROPIC_API_KEY: "" } })).code).toBe(3);
  });

  it("TC-LLM-005: a mid-run CLI failure doesn't switch to the API", async () => {
    const { code } = await luseen([sampleProject(), "--yes", "--concurrency", "1"], {
      env: {
        FAKE_CLAUDE_MODE: "fail-after-1",
        FAKE_CLAUDE_RECORD: path.join(makeTempFolder(), "c.jsonl"),
        ANTHROPIC_API_KEY: "k",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      },
    });
    expect(code).toBe(4);
  });

  it("TC-LLM-007: arguments match, and the prompt arrives on stdin", async () => {
    const record = path.join(makeTempFolder(), "c.jsonl");
    await luseen([sampleProject({ "src/m.ts": "MARKER-CONTENT-123\n" }), "--yes"], {
      env: { FAKE_CLAUDE_RECORD: record },
    });
    const calls = records(record);
    for (const flag of [
      "-p",
      "--model",
      "--effort",
      "--system-prompt-file",
      "--verbose",
      "--json-schema",
      "--tools",
      "--no-session-persistence",
      "--safe-mode",
      "--max-turns",
    ]) {
      expect(calls[0]?.args).toContain(flag);
    }
    expect(calls[0]?.args).toContain("stream-json");
    expect(calls[0]?.args.join(" ")).not.toContain("MARKER-CONTENT-123");
    expect(calls.some((call) => call.prompt.includes("MARKER-CONTENT-123"))).toBe(true);
  });

  it("TC-LLM-009: runs from an empty folder outside the target, and removes it", async () => {
    const root = sampleProject({ "CLAUDE.md": "project instructions" });
    const record = path.join(makeTempFolder(), "c.jsonl");
    await luseen([root, "--yes"], { env: { FAKE_CLAUDE_RECORD: record } });
    for (const call of records(record)) {
      expect(call.cwdEntries).toEqual([]);
      expect(call.cwd.startsWith(root)).toBe(false);
      expect(existsSync(call.cwd)).toBe(false);
    }
  });

  it("TC-LLM-014: the summary shows authMethod, and the manifest has the actual model", async () => {
    const root = sampleProject();
    const { stderr } = await luseen([root, "--yes"]);
    expect(stderr).toContain("claude.ai");
    const manifest = JSON.parse(readFileSync(path.join(root, ".luseen/sdd/manifest.json"), "utf8")) as {
      actualModels: string[];
      effort: string;
    };
    expect(manifest.actualModels).toEqual(["claude-sonnet-5-5"]);
    expect(manifest.effort).toBe("medium");
  });

  it("TC-LLM-026: Ctrl+C stops a hanging call", async () => {
    const record = path.join(makeTempFolder(), "c.jsonl");
    const { code } = await luseen([sampleProject(), "--yes"], {
      env: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RECORD: record },
      onStart: (child) => {
        void waitFor(() => existsSync(record)).then(() => child.kill("SIGINT"));
      },
    });
    expect(code).toBe(130);
  });

  it("TC-LLM-034: the CLI gets no tools", async () => {
    const record = path.join(makeTempFolder(), "c.jsonl");
    await luseen([sampleProject(), "--yes"], { env: { FAKE_CLAUDE_RECORD: record } });
    const args = records(record)[0]?.args ?? [];
    expect(args[args.indexOf("--tools") + 1]).toBe("");
  });

  it("TC-LLM-035: a key and prompt never reach output files or errors", async () => {
    const root = sampleProject({ "src/m.ts": "MARKER-CONTENT-123\n" });
    const { stdout, stderr } = await luseen([root, "--yes", "--debug"], {
      env: { ANTHROPIC_API_KEY: "MARKER-KEY-123" },
    });
    expect(stdout + stderr).not.toContain("MARKER-KEY-123");
    expect(stdout + stderr).not.toContain("MARKER-CONTENT-123");
    const failed = await luseen([root, "--yes", "--no-cache", "--force"], {
      env: { FAKE_CLAUDE_MODE: "auth-error", ANTHROPIC_API_KEY: "MARKER-KEY-123" },
    });
    expect(failed.stdout + failed.stderr).not.toContain("MARKER-KEY-123");
  });

  it("TC-LLM-046: a key in the shell is removed from claude's environment", async () => {
    const record = path.join(makeTempFolder(), "c.jsonl");
    await luseen([sampleProject(), "--yes", "--max-retries", "5"], {
      env: { FAKE_CLAUDE_RECORD: record, ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t" },
    });
    expect(records(record)[0]?.env).toEqual({
      ANTHROPIC_API_KEY: null,
      ANTHROPIC_AUTH_TOKEN: null,
      CLAUDE_CODE_MAX_RETRIES: "5",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
  });

  it("TC-LLM-027: invalid output gets one retry, then fails", async () => {
    const record = path.join(makeTempFolder(), "c.jsonl");
    const { code } = await luseen([sampleProject({}), "--yes", "--concurrency", "1"], {
      env: { FAKE_CLAUDE_MODE: "invalid-output", FAKE_CLAUDE_RECORD: record },
    });
    expect(code).toBe(4);
    expect(records(record).length).toBeLessThanOrEqual(2 + 1);
  });

  it("TC-LLM-043: a usage limit exits 4, and explains how to continue", async () => {
    const { code, stderr } = await luseen([sampleProject(), "--yes"], { env: { FAKE_CLAUDE_MODE: "usage-limit" } });
    expect(code).toBe(4);
    expect(stderr).toContain("session limit");
    expect(stderr).toContain("continues from where it stopped");
  });

  it("TC-LLM-050: an unavailable model suggests luseen model", async () => {
    const { code, stderr } = await luseen([sampleProject(), "--yes", "--model", "opus"], {
      env: { FAKE_CLAUDE_MODE: "invalid-model" },
    });
    expect(code).toBe(4);
    expect(stderr).toContain("luseen model");
  });
});
