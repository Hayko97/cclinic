/** `luseen gui` in-process: the server, its security checks and its jobs (spec: gui). */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect, createServer, type Server } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scanFolder } from "../../src/adapters/discovery/file-walker.js";
import { startGuiServer } from "../../src/adapters/http/gui-server.js";
import { startProcess, stopRunningJobs } from "../../src/adapters/process/job-process.js";
import type { JobProcess } from "../../src/application/gui-jobs.js";
import { runGuiCommand, type GuiDependencies, type GuiOptions } from "../../src/cli/gui-command.js";
import { runClean } from "../../src/cli/other-commands.js";
import { GUI_CONTENT_SECURITY_POLICY, GUI_DEFAULT_PORT } from "../../src/core/constants/gui.js";
import { UsageError } from "../../src/core/errors.js";
import type { OutputStream } from "../../src/core/gui.js";
import { agentHarness, makeTempFolder, writeProject } from "../support/helpers.js";

/** No process has this ID: process IDs are far smaller on every supported system. */
const ENDED_PID = 2 ** 30;
const running: { stop: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((gui) => gui.stop()));
});

async function startGui(
  root: string,
  { useDefaultPort = false, ...options }: Partial<GuiOptions> & { useDefaultPort?: boolean } = {},
  dependencies: GuiDependencies = {},
) {
  const harness = agentHarness({ withClaude: false });
  const done = runGuiCommand(
    undefined,
    { dir: root, open: false, json: true, ...(useDefaultPort ? {} : { port: 0 }), ...options },
    harness.context,
    dependencies,
  );
  const failed = done.then(() => {
    throw new Error("The GUI stopped before printing its link.");
  });
  const ready = vi.waitFor(
    () => {
      const line = harness.output.out.trim();
      if (line === "") throw new Error("no link yet");
      return JSON.parse(line) as { url: string; port: number };
    },
    { timeout: 10_000 },
  );
  const { url, port } = await Promise.race([ready, failed]);
  const token = new URL(url).searchParams.get("token") ?? "";
  const gui = {
    url,
    port,
    token,
    harness,
    done,
    stop: async () => {
      harness.controller.abort();
      await done;
    },
  };
  running.push(gui);
  return gui;
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** A raw request, so the path is sent exactly as written, unlike fetch, which tidies it. */
function send(
  port: number,
  method: string,
  requestPath: string,
  options: { headers?: Record<string, string>; body?: unknown; host?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path: requestPath,
        headers: {
          host: options.host ?? `127.0.0.1:${port}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...options.headers,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

const authed = (gui: { token: string }, extra: Record<string, string> = {}) => ({
  headers: { "x-luseen-token": gui.token, ...extra },
});

/** A child process the test controls; it ends when it's interrupted, as luseen does. */
function fakeJob() {
  const outputs: ((stream: OutputStream, chunk: string) => void)[] = [];
  const exits: ((code: number) => void)[] = [];
  const exit = (code: number) => {
    for (const listener of exits.splice(0)) listener(code);
  };
  const process: JobProcess = {
    onOutput: (listener) => outputs.push(listener),
    onExit: (listener) => exits.push(listener),
    signal: () => {
      exit(130);
    },
  };
  return {
    process,
    exit,
    write: (stream: OutputStream, text: string) => {
      for (const listener of outputs) listener(stream, text);
    },
  };
}

function fakeJobs() {
  const started: { args: readonly string[]; cwd: string; job: ReturnType<typeof fakeJob> }[] = [];
  const startJob = (args: readonly string[], cwd: string) => {
    const job = fakeJob();
    started.push({ args, cwd, job });
    return job.process;
  };
  return { started, startJob };
}

function listFiles(folder: string): string[] {
  return readdirSync(folder, { recursive: true, encoding: "utf8" })
    .map((name) => path.join(folder, name))
    .filter((file) => statSync(file).isFile());
}

function occupy(port: number): Promise<Server | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(undefined);
    });
    server.listen(port, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

describe("starting the GUI", () => {
  it("TC-GUI-002: with no --port, a taken default port is replaced by a free one", async () => {
    const blocker = await occupy(GUI_DEFAULT_PORT);
    try {
      const gui = await startGui(makeTempFolder(), { useDefaultPort: true });
      expect(gui.port).not.toBe(GUI_DEFAULT_PORT);
      expect(gui.url).toBe(`http://127.0.0.1:${gui.port}/?token=${gui.token}`);
    } finally {
      blocker?.close();
    }
  });

  it("TC-GUI-003: a taken port given with --port is refused, naming the port", async () => {
    const blocker = await occupy(0);
    const address = blocker?.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const harness = agentHarness({ withClaude: false });
      const attempt = runGuiCommand(undefined, { dir: makeTempFolder(), open: false, port }, harness.context);
      await expect(attempt).rejects.toThrow(UsageError);
      await expect(attempt).rejects.toThrow(`Port ${port} is in use`);
    } finally {
      blocker?.close();
    }
  });

  it("TC-GUI-004: a path that isn't a folder is refused", async () => {
    const root = makeTempFolder();
    writeProject(root, { "file.txt": "x" });
    const harness = agentHarness({ withClaude: false });
    await expect(runGuiCommand(path.join(root, "file.txt"), { open: false, port: 0 }, harness.context)).rejects.toThrow(
      UsageError,
    );
  });

  it("TC-GUI-005: the GUI listens on 127.0.0.1 only", async () => {
    const gui = await startGui(makeTempFolder());
    const external = Object.values(networkInterfaces())
      .flat()
      .find((item) => item?.family === "IPv4" && !item.internal);
    if (external === undefined) return;
    const result = await new Promise<string>((resolve) => {
      const socket = connect(gui.port, external.address);
      socket.once("connect", () => {
        socket.destroy();
        resolve("connected");
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        resolve(error.code ?? "error");
      });
    });
    expect(result).toBe("ECONNREFUSED");
  });

  it("TC-GUI-006: the token is never written to disk", async () => {
    const root = makeTempFolder();
    const gui = await startGui(root);
    await send(gui.port, "GET", `/?token=${gui.token}`);
    await send(gui.port, "GET", "/api/jobs", authed(gui));
    await gui.stop();
    for (const file of listFiles(path.join(root, ".luseen")))
      expect(readFileSync(file, "utf8")).not.toContain(gui.token);
  });

  it(
    "TC-GUI-007: with a terminal, the browser is opened with the link as one argument; a failing opener only warns",
    { timeout: 60_000 },
    async () => {
      for (const exitCode of [0, 1]) {
        const record = path.join(makeTempFolder(), "opened.txt");
        const harness = agentHarness({ withClaude: false });
        for (const name of ["open", "xdg-open"]) {
          const script = path.join(harness.bin, name);
          writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\nexit ${exitCode}\n`);
          chmodSync(script, 0o755);
        }
        const done = runGuiCommand(
          undefined,
          { dir: makeTempFolder(), open: true, json: true, port: 0 },
          harness.context,
          { isTerminal: true },
        );
        // Starting a shell script can take a while when the whole suite runs at once.
        await vi.waitFor(
          () => {
            if (!existsSync(record)) throw new Error(`not opened yet. stderr: ${harness.output.err}`);
          },
          { timeout: 20_000 },
        );
        const { url } = JSON.parse(harness.output.out.trim()) as { url: string };
        expect(readFileSync(record, "utf8")).toBe(`${url}\n`);
        if (exitCode !== 0)
          await vi.waitFor(() => {
            expect(harness.output.err).toContain("Couldn't open your browser");
          });
        harness.controller.abort();
        await done;
      }
    },
  );

  it("TC-GUI-008: without a terminal, the browser isn't opened", async () => {
    const record = path.join(makeTempFolder(), "opened.txt");
    const harness = agentHarness({ withClaude: false });
    for (const name of ["open", "xdg-open"]) {
      const script = path.join(harness.bin, name);
      writeFileSync(script, `#!/bin/sh\necho "$@" > "${record}"\n`);
      chmodSync(script, 0o755);
    }
    const done = runGuiCommand(undefined, { dir: makeTempFolder(), open: true, json: true, port: 0 }, harness.context, {
      isTerminal: false,
    });
    await vi.waitFor(() => {
      expect(harness.output.out).toContain("url");
    });
    harness.controller.abort();
    await done;
    expect(existsSync(record)).toBe(false);
  });

  it("TC-GUI-010: a second GUI for the project is refused, naming the first one's port", async () => {
    const root = makeTempFolder();
    const gui = await startGui(root);
    const harness = agentHarness({ withClaude: false });
    const second = runGuiCommand(undefined, { dir: root, open: false, port: 0 }, harness.context);
    await expect(second).rejects.toThrow(`on port ${gui.port}`);
  });

  it.each(["", "not json", '{"pid":"x"}'])(
    "TC-GUI-011: a lock that can't be read (%j) is replaced",
    async (content) => {
      const root = makeTempFolder();
      writeProject(root, { ".luseen/gui/gui.lock": content });
      // Older than the moment a lock may take to be written.
      const old = new Date(Date.now() - 60_000);
      utimesSync(path.join(root, ".luseen/gui/gui.lock"), old, old);
      const gui = await startGui(root);
      expect(JSON.parse(readFileSync(path.join(root, ".luseen/gui/gui.lock"), "utf8"))).toMatchObject({
        pid: process.pid,
        port: gui.port,
      });
    },
  );

  it("TC-GUI-011: a lock left by a GUI that ended is replaced", async () => {
    const root = makeTempFolder();
    writeProject(root, { ".luseen/gui/gui.lock": JSON.stringify({ pid: ENDED_PID, port: 1234 }) });
    const gui = await startGui(root);
    expect(JSON.parse(readFileSync(path.join(root, ".luseen/gui/gui.lock"), "utf8"))).toMatchObject({
      pid: process.pid,
      port: gui.port,
    });
    await gui.stop();
    expect(readdirSync(path.join(root, ".luseen/gui"))).toEqual([".gitignore"]);
  });
});

describe("security", () => {
  it("TC-GUI-012: no token or a wrong one gets 401 with no project data; the header gets in", async () => {
    const root = makeTempFolder();
    const gui = await startGui(root);
    const name = path.basename(root);
    for (const headers of [{}, { "x-luseen-token": "wrong" }]) {
      const reply = await send(gui.port, "GET", "/api/project", { headers });
      expect(reply.status).toBe(401);
      expect(reply.body).not.toContain(name);
    }
    const large = await send(gui.port, "POST", "/api/jobs", { body: "x".repeat(2 * 1_048_576) });
    expect(large.status).toBe(401);
    const allowed = await send(gui.port, "GET", "/api/project", authed(gui));
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body)).toEqual({ name, folder: root, hasDocuments: false });
  });

  it("TC-GUI-013: the first page load sets an HttpOnly, SameSite=Strict cookie that then lets the API in", async () => {
    const gui = await startGui(makeTempFolder());
    const page = await send(gui.port, "GET", `/?token=${gui.token}`);
    expect(page.status).toBe(200);
    const cookie = String(page.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const reply = await send(gui.port, "GET", "/api/jobs", { headers: { cookie: cookie.split(";")[0] ?? "" } });
    expect(reply.status).toBe(200);
  });

  it("TC-GUI-014: another host name, or a change from another origin, is refused with 403", async () => {
    const gui = await startGui(makeTempFolder());
    expect(
      (await send(gui.port, "GET", "/api/jobs", { ...authed(gui), host: `evil.example:${gui.port}` })).status,
    ).toBe(403);
    const fromSite = await send(gui.port, "POST", "/api/jobs", {
      ...authed(gui, { origin: "http://evil.example" }),
      body: { command: "doctor" },
    });
    expect(fromSite.status).toBe(403);
  });

  it("TC-GUI-015: paths outside the GUI's own and malformed IDs get 404, and no file outside its assets is read", async () => {
    const root = makeTempFolder();
    writeProject(root, { ".env": "SECRET_VALUE=do-not-show\n", "package.json": '{"name":"secret-package"}' });
    const gui = await startGui(root);
    for (const requestPath of [
      "/../package.json",
      "/%2e%2e/.env",
      "/.env",
      "/assets/../../package.json",
      "/assets/%2e%2e%2f.env",
      "/api/jobs/1;rm",
      "/api/jobs/../x",
      "/api/jobs/job-99",
      "//x/api/project",
      "//127.0.0.1/api/project",
    ]) {
      const reply = await send(gui.port, "GET", requestPath, authed(gui));
      expect(reply.status, requestPath).toBe(404);
      expect(reply.body).not.toContain("do-not-show");
      expect(reply.body).not.toContain("secret-package");
    }
  });

  it("TC-GUI-016: a job's output is redacted in the API, and .env content is never returned", async () => {
    const root = makeTempFolder();
    writeProject(root, { ".env": "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n" });
    const jobs = fakeJobs();
    const gui = await startGui(root, {}, { startJob: jobs.startJob });
    await send(gui.port, "POST", "/api/jobs", { ...authed(gui), body: { command: "doctor" } });
    jobs.started[0]?.job.write("stdout", "key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n");
    for (const requestPath of ["/api/jobs/job-1", "/api/jobs", "/api/project", "/", "/assets/app.js"]) {
      const reply = await send(gui.port, "GET", requestPath, authed(gui));
      expect(reply.body).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    }
  });

  it("TC-GUI-017: every page and asset is served with the GUI's content security policy", async () => {
    const gui = await startGui(makeTempFolder());
    for (const requestPath of ["/", "/assets/app.js", "/assets/styles.css", "/api/jobs"]) {
      const reply = await send(gui.port, "GET", requestPath, authed(gui));
      expect(reply.status).toBe(200);
      expect(reply.headers["content-security-policy"]).toBe(GUI_CONTENT_SECURITY_POLICY);
    }
  });

  it("TC-GUI-019: a job starts as an argument array, with browser text only as option values", async () => {
    const root = makeTempFolder();
    const jobs = fakeJobs();
    const gui = await startGui(root, {}, { startJob: jobs.startJob });
    const reply = await send(gui.port, "POST", "/api/jobs", {
      ...authed(gui),
      body: { command: "generate", confirmed: true, options: { include: ["; rm -rf ~"], exclude: ["--force"] } },
    });
    expect(reply.status).toBe(201);
    expect(jobs.started[0]?.cwd).toBe(root);
    expect(jobs.started[0]?.args).toContain("--include=; rm -rf ~");
    expect(jobs.started[0]?.args).toContain("--exclude=--force");
    expect(jobs.started[0]?.args).not.toContain("--force");
    const refused = await send(gui.port, "POST", "/api/jobs", { ...authed(gui), body: { command: "--force" } });
    expect(refused.status).toBe(400);
  });

  it("TC-GUI-019: the process runner passes arguments unchanged, with no shell", async () => {
    const child = startProcess(
      process.execPath,
      ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "; rm -rf ~", "$(id)"],
      {
        cwd: makeTempFolder(),
        environment: process.env,
      },
    );
    let output = "";
    child.onOutput((_stream, chunk) => (output += chunk));
    await new Promise<number>((resolve) => {
      child.onExit(resolve);
    });
    expect(JSON.parse(output)).toEqual(["; rm -rf ~", "$(id)"]);
  });
});

describe("jobs", () => {
  it("TC-GUI-045: a real job has its command, times, output and exit code with its meaning", async () => {
    const script = "console.log('ready'); console.error('a note');";
    const gui = await startGui(
      makeTempFolder(),
      {},
      {
        startJob: (_args, cwd) => startProcess(process.execPath, ["-e", script], { cwd, environment: process.env }),
      },
    );
    const started = await send(gui.port, "POST", "/api/jobs", { ...authed(gui), body: { command: "doctor" } });
    expect(started.status).toBe(201);
    const job = await vi.waitFor(async () => {
      const reply = JSON.parse((await send(gui.port, "GET", "/api/jobs/job-1", authed(gui))).body) as {
        job: { isRunning: boolean };
      };
      if (reply.job.isRunning) throw new Error("still running");
      return reply.job;
    });
    expect(job).toMatchObject({
      id: "job-1",
      command: "luseen doctor --json",
      exitCode: 0,
      exitMeaning: "Finished",
    });
    const { lines } = (job as unknown as { output: { lines: { stream: string; text: string }[] } }).output;
    expect(lines).toContainEqual({ stream: "stdout", text: "ready" });
    expect(lines).toContainEqual({ stream: "stderr", text: "a note" });
    expect(job).toHaveProperty("startedAt");
    expect(job).toHaveProperty("endedAt");
  });

  it("TC-GUI-046: cancelling a real job that ignores SIGINT ends it with SIGTERM", async () => {
    const { createJobs } = await import("../../src/application/gui-jobs.js");
    const script =
      "process.on('SIGINT', () => console.log('ignored')); console.log('waiting'); setInterval(() => {}, 1000);";
    const jobs = createJobs({
      start: () => startProcess(process.execPath, ["-e", script], { cwd: makeTempFolder(), environment: process.env }),
      now: () => new Date(),
      later: (ms, run) => {
        const timer = setTimeout(run, ms);
        return () => {
          clearTimeout(timer);
        };
      },
      cancelGraceMs: 200,
    });
    jobs.start({ command: "doctor" });
    await vi.waitFor(() => {
      expect(jobs.get("job-1")?.output.lines.length).toBeGreaterThan(0);
    });
    jobs.cancel("job-1");
    await vi.waitFor(
      () => {
        expect(jobs.get("job-1")?.isRunning).toBe(false);
      },
      { timeout: 5_000 },
    );
    expect(jobs.get("job-1")).toMatchObject({ exitCode: 143, exitMeaning: "Stopped" });
  });

  it("TC-GUI-047: a stream gets the output so far, then new lines as they're written", async () => {
    const jobs = fakeJobs();
    const gui = await startGui(makeTempFolder(), {}, { startJob: jobs.startJob });
    await send(gui.port, "POST", "/api/jobs", { ...authed(gui), body: { command: "doctor" } });
    const job = jobs.started[0]?.job;
    job?.write("stdout", "1\n2\n3\n");
    const received: string[] = [];
    const stream = httpRequest({
      host: "127.0.0.1",
      port: gui.port,
      path: "/api/jobs/job-1/events",
      headers: { host: `127.0.0.1:${gui.port}`, "x-luseen-token": gui.token },
    });
    stream.on("response", (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => received.push(chunk));
    });
    stream.end();
    await vi.waitFor(() => {
      expect(received.join("")).toContain("event: job");
    });
    job?.write("stdout", "4\n5\n");
    job?.exit(0);
    await vi.waitFor(() => {
      expect(received.join("")).toContain("event: end");
    });
    stream.destroy();
    const events = received
      .join("")
      .split("\n\n")
      .filter(Boolean)
      .map((block) => ({
        event: /^event: (.+)$/m.exec(block)?.[1],
        data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "null") as unknown,
      }));
    expect(events[0]).toMatchObject({
      event: "job",
      data: { job: { output: { lines: [{ text: "1" }, { text: "2" }, { text: "3" }] } } },
    });
    expect(events.slice(1).map((item) => item.event)).toEqual(["output", "end"]);
    expect(events[1]?.data).toEqual({
      type: "output",
      lines: [
        { stream: "stdout", text: "4" },
        { stream: "stdout", text: "5" },
      ],
    });
  });

  it("TC-GUI-113: when the GUI's process exits, a job still running is sent SIGTERM", async () => {
    const child = startProcess(process.execPath, ["-e", "console.log('waiting'); setInterval(() => {}, 1000);"], {
      cwd: makeTempFolder(),
      environment: process.env,
    });
    const exited = new Promise<number>((resolve) => {
      child.onExit(resolve);
    });
    expect(process.listeners("exit")).toContain(stopRunningJobs);
    stopRunningJobs();
    expect(await exited).toBe(143);
  });

  it("TC-GUI-047: a stream the browser closes stops sending", async () => {
    const stop = vi.fn();
    const server = await startGuiServer({
      host: "127.0.0.1",
      port: 0,
      isPortFixed: false,
      // The request is read to its end first, as for any request, which is when its own "close" has passed.
      handle: async (request) => {
        await request.readBody();
        return {
          kind: "events",
          headers: {},
          open: (sendEvent) => {
            sendEvent("job", {});
            return stop;
          },
        };
      },
    });
    running.push({ stop: () => server.close() });
    await new Promise<void>((resolve) => {
      const outgoing = httpRequest({ host: "127.0.0.1", port: server.port, path: "/x" });
      outgoing.on("response", (response) => {
        response.once("data", () => {
          outgoing.destroy();
          resolve();
        });
      });
      outgoing.on("error", () => undefined);
      outgoing.end();
    });
    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledTimes(1);
    });
  });

  it("TC-GUI-047: the server ends a job's stream when the job ends, and at once for a job that already has", async () => {
    const jobs = fakeJobs();
    const gui = await startGui(makeTempFolder(), {}, { startJob: jobs.startJob });
    await send(gui.port, "POST", "/api/jobs", { ...authed(gui), body: { command: "doctor" } });
    let received = "";
    const ended = new Promise<void>((resolve) => {
      const stream = httpRequest({
        host: "127.0.0.1",
        port: gui.port,
        path: "/api/jobs/job-1/events",
        headers: { host: `127.0.0.1:${gui.port}`, "x-luseen-token": gui.token },
      });
      stream.on("response", (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (received += chunk));
        response.on("end", resolve);
      });
      stream.end();
    });
    await vi.waitFor(() => {
      expect(received).toContain("event: job");
    });
    jobs.started[0]?.job.write("stdout", "done\n");
    jobs.started[0]?.job.exit(0);
    await ended;
    expect(received).toContain("event: end");
    const finished = await send(gui.port, "GET", "/api/jobs/job-1/events", authed(gui));
    expect(finished.body).toContain("event: job");
    expect(finished.body).not.toContain("event: end");
    const cancel = await send(gui.port, "POST", "/api/jobs/job-1/cancel", authed(gui));
    expect(cancel.status).toBe(409);
  });

  it("TC-GUI-049: a job that would clash is refused with 409, naming the job that blocks it; doctor still runs", async () => {
    const jobs = fakeJobs();
    const gui = await startGui(makeTempFolder(), {}, { startJob: jobs.startJob });
    const generate = { command: "generate", confirmed: true, options: {} };
    expect((await send(gui.port, "POST", "/api/jobs", { ...authed(gui), body: generate })).status).toBe(201);
    for (const body of [{ command: "clean" }, { command: "skills" }, generate]) {
      const reply = await send(gui.port, "POST", "/api/jobs", { ...authed(gui), body });
      expect(reply.status).toBe(409);
      expect(reply.body).toContain("job-1");
    }
    for (let index = 0; index < 2; index += 1)
      expect((await send(gui.port, "POST", "/api/jobs", { ...authed(gui), body: { command: "doctor" } })).status).toBe(
        201,
      );
  });

  it("TC-GUI-050: jobs last only as long as the GUI, and their output isn't saved", async () => {
    const root = makeTempFolder();
    const jobs = fakeJobs();
    const gui = await startGui(root, {}, { startJob: jobs.startJob });
    await send(gui.port, "POST", "/api/jobs", { ...authed(gui), body: { command: "doctor" } });
    jobs.started[0]?.job.write("stdout", "unique-output-marker\n");
    jobs.started[0]?.job.exit(0);
    await gui.stop();
    const again = await startGui(root);
    expect(JSON.parse((await send(again.port, "GET", "/api/jobs", authed(again))).body)).toEqual({ jobs: [] });
    for (const file of listFiles(path.join(root, ".luseen")))
      expect(readFileSync(file, "utf8")).not.toContain("unique-output-marker");
  });
});

describe("files", () => {
  it("TC-GUI-063: the GUI adds only an ignored .luseen/gui, which clean keeps and analysis skips", async () => {
    const root = makeTempFolder();
    writeProject(root, { "index.ts": "export const a = 1;\n" });
    execFileSync("git", ["init", "-q"], { cwd: root });
    const before = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: root, encoding: "utf8" });
    const jobs = fakeJobs();
    const gui = await startGui(root, {}, { startJob: jobs.startJob });
    await send(gui.port, "POST", "/api/jobs", { ...authed(gui), body: { command: "doctor" } });
    expect(execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: root, encoding: "utf8" })).toBe(before);
    await gui.stop();
    await runClean(root, { yes: true }, agentHarness({ withClaude: false }).context);
    expect(readdirSync(path.join(root, ".luseen/gui"))).toEqual([".gitignore"]);
    const scan = await scanFolder({
      target: root,
      outFolder: path.join(root, ".luseen/sdd"),
      include: [],
      exclude: [],
      maxFileSizeMib: 1,
    });
    expect(scan.included.map((file) => file.path)).toEqual(["index.ts"]);
  });
});
