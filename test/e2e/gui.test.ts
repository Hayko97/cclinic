/** `cclinic gui` through the built binary (spec: gui, cli-commands). */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempFolder, writeProject } from "../support/helpers.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const BIN = path.join(REPO, "bin/cclinic.js");

function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const bin = makeTempFolder();
  symlinkSync(process.execPath, path.join(bin, "node"));
  copyFileSync(path.join(REPO, "test/fixtures/fake-claude/claude"), path.join(bin, "claude"));
  chmodSync(path.join(bin, "claude"), 0o755);
  const home = makeTempFolder();
  return { PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: path.join(home, "c"), ...extra };
}

function cclinic(args: readonly string[]) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: environment(), input: "" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const started: { child: ReturnType<typeof spawn>; exited: Promise<number | null> }[] = [];

// A GUI left running by a failed test is stopped the normal way, so it stops its own jobs too.
afterEach(async () => {
  for (const gui of started.splice(0)) {
    if (gui.child.exitCode === null && gui.child.signalCode === null) gui.child.kill("SIGTERM");
    await gui.exited;
  }
});

async function startGui(root: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [BIN, "gui", root, "--no-open", "--port", "0", "--json"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      resolve(code);
    });
  });
  started.push({ child, exited });
  const { url, port } = await vi.waitFor(
    () => {
      if (!stdout.includes("\n")) throw new Error("no link yet");
      return JSON.parse(stdout.trim()) as { url: string; port: number };
    },
    { timeout: 15_000 },
  );
  return { child, url, port, token: new URL(url).searchParams.get("token") ?? "", exited, stdout: () => stdout };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("cclinic gui", () => {
  it("TC-GUI-001: prints one JSON document with the link and port, and the link serves the page", async () => {
    const gui = await startGui(makeTempFolder(), environment());
    expect(gui.stdout().trim().split("\n")).toHaveLength(1);
    expect(gui.url).toBe(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
    expect(gui.token).toMatch(/^[\w-]{22,}$/);
    const page = await fetch(gui.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    gui.child.kill("SIGINT");
    expect(await gui.exited).toBe(130);
  });

  it("TC-GUI-004, TC-CLI-061: a port out of range, a port that isn't a number, or a file as the path exits 2", () => {
    expect(cclinic(["gui", "--no-open", "--port", "70000"]).code).toBe(2);
    expect(cclinic(["gui", "--no-open", "--port", "abc"]).code).toBe(2);
    const root = makeTempFolder();
    writeProject(root, { "file.txt": "x" });
    const result = cclinic(["gui", path.join(root, "file.txt"), "--no-open", "--port", "0"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("isn't a folder");
  });

  it("TC-CLI-060: the help lists the GUI's options", () => {
    const result = cclinic(["gui", "--help"]);
    expect(result.code).toBe(0);
    for (const option of ["-C, --dir", "--port", "--no-open", "--json"]) expect(result.stdout).toContain(option);
    expect(cclinic(["--help"]).stdout).toContain("gui [options] [path]");
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    // Closing the terminal: the job no longer gets the terminal's signals, so the GUI must stop it.
    ["SIGHUP", 143],
  ] as const)(
    "TC-GUI-009: on %s the running job is stopped, the server closes, and the GUI exits %i",
    async (signal, code) => {
      const root = makeTempFolder();
      writeProject(root, { "src/index.ts": "export const a = 1;\n" });
      const work = makeTempFolder();
      const pids = path.join(work, "pids.txt");
      const script = path.join(work, "script.json");
      writeFileSync(script, JSON.stringify([{ hang: true, times: 0 }]));
      const env = environment({ FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_PIDS: pids, CCLINIC_PROVIDER: "claude-cli" });
      const gui = await startGui(root, env);
      const started = await fetch(`http://127.0.0.1:${gui.port}/api/jobs`, {
        method: "POST",
        headers: { "x-cclinic-token": gui.token, "content-type": "application/json" },
        body: JSON.stringify({
          command: "generate",
          confirmed: true,
          options: { noGit: true, noSkills: true, environment: false },
        }),
      });
      expect(started.status).toBe(201);
      const claudePid = await vi.waitFor(
        () => {
          const pid = Number(readFileSync(pids, "utf8").trim().split("\n")[0]);
          if (!isRunning(pid)) throw new Error("not running yet");
          return pid;
        },
        { timeout: 20_000, interval: 100 },
      );
      gui.child.kill(signal);
      expect(await gui.exited).toBe(code);
      await vi.waitFor(
        () => {
          expect(isRunning(claudePid)).toBe(false);
        },
        { timeout: 10_000 },
      );
      await expect(fetch(`http://127.0.0.1:${gui.port}/`)).rejects.toThrow();
    },
  );

  it("TC-GUI-061: no production dependency was added, and the GUI's files are in the package", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@anthropic-ai/sdk",
      "@inquirer/prompts",
      "@modelcontextprotocol/sdk",
      "commander",
      "ignore",
      "mammoth",
      "pdfjs-dist",
      "zod",
    ]);
    const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: REPO, encoding: "utf8" });
    const [listing] = JSON.parse(pack.stdout) as [{ files: { path: string }[] }];
    const files = listing.files.map((file) => file.path);
    for (const name of ["index.html", "app.js", "styles.css"]) expect(files).toContain(`dist/gui/${name}`);
    expect(existsSync(path.join(REPO, "dist/gui/index.html"))).toBe(true);
  });
});
