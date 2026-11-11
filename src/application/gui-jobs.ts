/** The commands the GUI runs, each a `cclinic` child process whose output is kept while the GUI runs (spec: gui). */
import { JOB_CANCEL_GRACE_MS, JOB_OUTPUT_MAX_LINES } from "../core/constants/gui.js";
import { UsageError } from "../core/errors.js";
import {
  appendOutput,
  blockingJob,
  describeJob,
  exitMeaning,
  jobArgs,
  NO_OUTPUT,
  splitLines,
  type JobKind,
  type JobOutput,
  type JobRequest,
  type OutputLine,
  type OutputStream,
} from "../core/gui.js";
import { createLineRedactor } from "../core/redaction.js";

/** A started child process. */
export interface JobProcess {
  onOutput(listener: (stream: OutputStream, chunk: string) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  signal(name: "SIGINT" | "SIGTERM"): void;
}

export interface JobPorts {
  /** Starts `cclinic` with these arguments in the project's folder, never through a shell (FR-GUI-013). */
  readonly start: (args: readonly string[]) => JobProcess;
  readonly now: () => Date;
  /** Runs `run` after `ms`, and returns what cancels it. */
  readonly later: (ms: number, run: () => void) => () => void;
  readonly maxLines?: number;
  readonly cancelGraceMs?: number;
}

export interface JobSummary {
  readonly id: string;
  readonly kind: JobKind;
  readonly command: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly exitMeaning: string | null;
  readonly isRunning: boolean;
}

export interface JobView extends JobSummary {
  readonly output: JobOutput;
}

export type JobEvent =
  | { readonly type: "output"; readonly lines: readonly OutputLine[] }
  | { readonly type: "end"; readonly job: JobSummary };

export interface Jobs {
  /** FR-GUI-035: refused with the job that blocks it. */
  start(request: JobRequest): JobSummary;
  list(): readonly JobSummary[];
  get(id: string): JobView | undefined;
  /** The output so far, then each change as it happens (FR-GUI-034). */
  subscribe(
    id: string,
    listener: (event: JobEvent) => void,
  ): { readonly job: JobView; readonly stop: () => void } | undefined;
  /** FR-GUI-033: SIGINT, then SIGTERM if it's still running after the grace period. Sent once per job. */
  cancel(id: string): "cancelling" | "ended" | "unknown";
  /** FR-GUI-005: cancels every running job, and resolves once all have ended. */
  stopAll(): Promise<void>;
}

interface JobRecord {
  summary: JobSummary;
  /** A second SIGINT makes cclinic exit at once, so a job is only ever interrupted once. */
  isCancelling: boolean;
  output: JobOutput;
  readonly process: JobProcess;
  readonly listeners: Set<(event: JobEvent) => void>;
  readonly ended: Promise<void>;
}

export function createJobs(ports: JobPorts): Jobs {
  const maxLines = ports.maxLines ?? JOB_OUTPUT_MAX_LINES;
  const graceMs = ports.cancelGraceMs ?? JOB_CANCEL_GRACE_MS;
  const records = new Map<string, JobRecord>();
  let nextId = 1;

  const running = () => [...records.values()].filter((record) => record.summary.isRunning);
  const view = (record: JobRecord): JobView => ({ ...record.summary, output: record.output });
  const emit = (record: JobRecord, event: JobEvent): void => {
    for (const listener of record.listeners) listener(event);
  };

  const cancelRecord = (record: JobRecord): void => {
    if (!record.summary.isRunning || record.isCancelling) return;
    record.isCancelling = true;
    record.process.signal("SIGINT");
    const stopTimer = ports.later(graceMs, () => {
      if (record.summary.isRunning) record.process.signal("SIGTERM");
    });
    void record.ended.then(stopTimer);
  };

  return {
    start: (request) => {
      const blocker = blockingJob(
        request.command,
        running().map((record) => record.summary),
      );
      if (blocker !== undefined)
        throw new UsageError(`Can't start this while ${blocker.command} (${blocker.id}) is running.`);
      const args = jobArgs(request);
      const id = `job-${nextId}`;
      nextId += 1;
      const process = ports.start(args);
      let resolveEnded = (): void => undefined;
      const record: JobRecord = {
        summary: {
          id,
          kind: request.command,
          command: describeJob(args),
          startedAt: ports.now().toISOString(),
          endedAt: null,
          exitCode: null,
          exitMeaning: null,
          isRunning: true,
        },
        isCancelling: false,
        output: NO_OUTPUT,
        process,
        listeners: new Set(),
        ended: new Promise((resolve) => {
          resolveEnded = resolve;
        }),
      };
      records.set(id, record);
      const carries: Record<OutputStream, string> = { stdout: "", stderr: "" };
      const redactors: Record<OutputStream, (line: string) => string> = {
        stdout: createLineRedactor(),
        stderr: createLineRedactor(),
      };
      const add = (stream: OutputStream, texts: readonly string[]): void => {
        if (texts.length === 0) return;
        // FR-GUI-011: secrets never reach the browser.
        const lines = texts.map((text) => ({ stream, text: redactors[stream](text) }));
        record.output = appendOutput(record.output, lines, maxLines);
        emit(record, { type: "output", lines });
      };
      process.onOutput((stream, chunk) => {
        const split = splitLines(carries[stream], chunk);
        carries[stream] = split.carry;
        add(stream, split.lines);
      });
      process.onExit((exitCode) => {
        for (const stream of ["stdout", "stderr"] as const)
          add(stream, carries[stream] === "" ? [] : [carries[stream]]);
        record.summary = {
          ...record.summary,
          endedAt: ports.now().toISOString(),
          exitCode,
          exitMeaning: exitMeaning(exitCode),
          isRunning: false,
        };
        emit(record, { type: "end", job: record.summary });
        resolveEnded();
      });
      return record.summary;
    },
    list: () => [...records.values()].map((record) => record.summary),
    get: (id) => {
      const record = records.get(id);
      return record === undefined ? undefined : view(record);
    },
    subscribe: (id, listener) => {
      const record = records.get(id);
      if (record === undefined) return undefined;
      record.listeners.add(listener);
      return { job: view(record), stop: () => record.listeners.delete(listener) };
    },
    cancel: (id) => {
      const record = records.get(id);
      if (record === undefined) return "unknown";
      if (!record.summary.isRunning) return "ended";
      cancelRecord(record);
      return "cancelling";
    },
    stopAll: async () => {
      const active = running();
      for (const record of active) cancelRecord(record);
      await Promise.all(active.map((record) => record.ended));
    },
  };
}
