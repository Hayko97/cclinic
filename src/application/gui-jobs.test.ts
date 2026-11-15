import { describe, expect, it } from "vitest";
import type { OutputStream } from "../core/gui.js";
import { createJobs, type JobEvent, type JobProcess } from "./gui-jobs.js";

function fakeProcess(options: { ignoresInterrupt?: boolean } = {}) {
  const outputs: ((stream: OutputStream, chunk: string) => void)[] = [];
  const exits: ((code: number) => void)[] = [];
  const signals: string[] = [];
  const exit = (code: number) => {
    for (const listener of exits) listener(code);
  };
  const process: JobProcess = {
    onOutput: (listener) => outputs.push(listener),
    onExit: (listener) => exits.push(listener),
    signal: (name) => {
      signals.push(name);
      if (name === "SIGTERM" || options.ignoresInterrupt !== true) exit(name === "SIGINT" ? 130 : 143);
    },
  };
  return {
    process,
    signals,
    exit,
    write: (stream: OutputStream, text: string) => {
      for (const listener of outputs) listener(stream, text);
    },
  };
}

function setup(processes: ReturnType<typeof fakeProcess>[]) {
  const started: (readonly string[])[] = [];
  const timers: (() => void)[] = [];
  let clock = Date.parse("2026-11-11T10:00:00.000Z");
  const jobs = createJobs({
    start: (args) => {
      started.push(args);
      const next = processes[started.length - 1];
      if (next === undefined) throw new Error("no process left");
      return next.process;
    },
    now: () => new Date((clock += 1_000)),
    later: (_ms, run) => {
      timers.push(run);
      return () => undefined;
    },
    maxLines: 3,
  });
  return { jobs, started, timers };
}

describe("GUI jobs", () => {
  it("TC-GUI-045: a job has an ID, its command, start and end times, its output by stream, and its exit code's meaning", () => {
    const child = fakeProcess();
    const { jobs, started } = setup([child]);
    const job = jobs.start({ command: "doctor" });
    expect(started[0]).toEqual(["doctor", "--json"]);
    expect(job).toMatchObject({ id: "job-1", command: "luseen doctor --json", isRunning: true, endedAt: null });
    child.write("stdout", "ready\npart");
    child.write("stderr", "warning\n");
    child.exit(0);
    expect(jobs.get("job-1")).toMatchObject({
      isRunning: false,
      exitCode: 0,
      exitMeaning: "Finished",
      startedAt: "2026-11-11T10:00:01.000Z",
      endedAt: "2026-11-11T10:00:02.000Z",
      output: {
        lines: [
          { stream: "stdout", text: "ready" },
          { stream: "stderr", text: "warning" },
          { stream: "stdout", text: "part" },
        ],
      },
    });
  });

  it("TC-GUI-047: a subscriber gets the output so far, then each new line as it's written", () => {
    const child = fakeProcess();
    const { jobs } = setup([child]);
    jobs.start({ command: "doctor" });
    child.write("stdout", "one\ntwo\n");
    const events: JobEvent[] = [];
    const subscription = jobs.subscribe("job-1", (event) => events.push(event));
    expect(subscription?.job.output.lines.map((line) => line.text)).toEqual(["one", "two"]);
    child.write("stdout", "three\n");
    child.exit(0);
    expect(events.map((event) => event.type)).toEqual(["output", "end"]);
    expect(events[0]).toEqual({ type: "output", lines: [{ stream: "stdout", text: "three" }] });
    subscription?.stop();
    expect(jobs.subscribe("job-9", () => undefined)).toBeUndefined();
  });

  it("TC-GUI-016: secrets in a job's output are redacted before anyone sees them", () => {
    const child = fakeProcess();
    const { jobs } = setup([child]);
    jobs.start({ command: "doctor" });
    child.write("stdout", "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n");
    expect(JSON.stringify(jobs.get("job-1"))).not.toContain("sk-ant-api03");
  });

  it("TC-GUI-016: a private key printed over several lines and chunks is redacted, and what follows it isn't", () => {
    const child = fakeProcess();
    const { jobs } = setup([child]);
    jobs.start({ command: "doctor" });
    child.write("stdout", "before\n-----BEGIN RSA PRIVATE ");
    child.write("stdout", "KEY-----\nMIIEowIBAAKCAQEA1x2y3z\nAbCdEf");
    child.write("stdout", "123456\n-----END RSA PRIVATE KEY-----\nafter\n");
    const text = JSON.stringify(jobs.get("job-1")?.output);
    for (const secret of ["MIIEowIBAAKCAQEA1x2y3z", "AbCdEf123456", "BEGIN RSA", "END RSA"])
      expect(text).not.toContain(secret);
    // This setup keeps the newest 3 lines: the key's last two, then the line after it, untouched.
    expect(jobs.get("job-1")?.output).toEqual({
      lines: ["[REDACTED:private-key]", "[REDACTED:private-key]", "after"].map((text) => ({ stream: "stdout", text })),
      dropped: 3,
    });
  });

  it("TC-GUI-048: a job keeps only its newest lines, and says how many were dropped", () => {
    const child = fakeProcess();
    const { jobs } = setup([child]);
    jobs.start({ command: "doctor" });
    child.write("stdout", "1\n2\n3\n4\n5\n");
    expect(jobs.get("job-1")?.output).toEqual({
      lines: ["3", "4", "5"].map((text) => ({ stream: "stdout", text })),
      dropped: 2,
    });
  });

  it("TC-GUI-049: a job that would clash is refused, naming the job that blocks it", () => {
    const generate = fakeProcess();
    const { jobs } = setup([generate, fakeProcess()]);
    jobs.start({ command: "generate", confirmed: true, options: { include: [], exclude: [] } as never });
    for (const command of ["clean", "skills"] as const)
      expect(() => jobs.start({ command } as never)).toThrow(/while luseen --json --yes \(job-1\) is running/);
    expect(jobs.start({ command: "doctor" }).id).toBe("job-2");
    generate.exit(0);
    expect(() => jobs.start({ command: "clean" })).toThrow("no process left");
  });

  it("TC-GUI-049: commands that change nothing may run side by side", () => {
    const { jobs } = setup([fakeProcess(), fakeProcess()]);
    jobs.start({ command: "doctor" });
    expect(jobs.start({ command: "doctor" }).id).toBe("job-2");
  });

  it("TC-GUI-046: cancelling sends SIGINT, then SIGTERM after the grace period if the job is still running", async () => {
    const stubborn = fakeProcess({ ignoresInterrupt: true });
    const { jobs, timers } = setup([stubborn]);
    jobs.start({ command: "doctor" });
    expect(jobs.cancel("job-1")).toBe("cancelling");
    expect(jobs.cancel("job-1")).toBe("cancelling");
    expect(stubborn.signals).toEqual(["SIGINT"]);
    for (const run of timers) run();
    expect(stubborn.signals).toEqual(["SIGINT", "SIGTERM"]);
    expect(jobs.get("job-1")).toMatchObject({ exitCode: 143, exitMeaning: "Stopped" });
    expect(jobs.cancel("job-1")).toBe("ended");
    expect(jobs.cancel("job-9")).toBe("unknown");
    await expect(jobs.stopAll()).resolves.toBeUndefined();
  });

  it("TC-GUI-023 (QA D1 run 3): whenEnded resolves with the job once it has ended, and is undefined for an unknown job", async () => {
    const child = fakeProcess();
    const { jobs } = setup([child]);
    const { id } = jobs.start({ command: "doctor" });
    let settled = false;
    const waiting = jobs.whenEnded(id)?.then((job) => {
      settled = true;
      return job;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.write("stdout", '{"ok":true}\n');
    child.exit(0);
    await expect(waiting).resolves.toMatchObject({ id, isRunning: false, exitCode: 0 });
    expect(jobs.whenEnded("job-9")).toBeUndefined();
  });

  it("TC-GUI-016 (QA D1 run 3): generate that isn't confirmed is refused, and nothing starts", () => {
    const { jobs, started } = setup([fakeProcess()]);
    expect(() =>
      jobs.start({ command: "generate", confirmed: false, options: { include: [], exclude: [] } as never }),
    ).toThrow("Answer generate's questions before it starts.");
    expect(started).toEqual([]);
    expect(jobs.list()).toEqual([]);
  });

  it("TC-GUI-009: stopping the GUI cancels every running job and waits for them to end", async () => {
    const first = fakeProcess();
    const second = fakeProcess();
    const { jobs } = setup([first, second]);
    jobs.start({ command: "doctor" });
    jobs.start({ command: "model-list" });
    await jobs.stopAll();
    expect([first.signals, second.signals]).toEqual([["SIGINT"], ["SIGINT"]]);
    expect(jobs.list().every((job) => !job.isRunning)).toBe(true);
  });
});
