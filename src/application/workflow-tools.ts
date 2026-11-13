/** The MCP server's tools and resources: the change workflow and the tasks (spec: mcp-server). */
import { SPEC_FILES } from "../core/constants/paths.js";
import { RESOURCE_URIS } from "../core/constants/workflow.js";
import { UsageError } from "../core/errors.js";
import { specNameSchema, taskInputSchema, type Task, type TaskInput, type TaskStatus } from "../core/tasks.js";
import {
  advanceInputSchema,
  applyAnswer,
  autoStatusInputSchema,
  beginChange,
  beginInputSchema,
  checkAdvance,
  checkPreview,
  checkSkip,
  CONFIRM_ANSWERS,
  enterStep,
  gateQuestion,
  isNotesAnswer,
  isOpenChange,
  qaReportInputSchema,
  recordBlockReason,
  recordPreview,
  recordQaRun,
  recordReview,
  resetInputSchema,
  resetToSpec,
  endStoppedChange,
  resumeChange,
  reviewReportInputSchema,
  skipInputSchema,
  skipStep,
  stateKey,
  summarizeState,
  taskBlockInputSchema,
  taskIdInputSchema,
  tasksListInputSchema,
  withPending,
  type Approver,
  type AskedGate,
  type InputSchema,
  type Outcome,
  type PendingQuestion,
  type WorkflowState,
} from "../core/workflow.js";

export interface WorkflowTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  run(input: unknown): Promise<{ readonly text: string; readonly isError: boolean }>;
}

export interface WorkflowResource {
  readonly name: string;
  readonly uri: string;
  readonly description: string;
  read(variables: Readonly<Record<string, string>>): Promise<string>;
}

export type UserReply =
  | { readonly kind: "answered"; readonly answer: string; readonly notes: string | null }
  | { readonly kind: "declined" }
  | { readonly kind: "unsupported" };

/** The task store's methods the tools use. */
export interface TaskRecords {
  listTasks(includeDone: boolean): readonly Task[];
  getTask(id: number): Task | undefined;
  addTask(input: TaskInput): Task;
  setStatus(id: number, status: TaskStatus): Task;
}

export interface RunSummary {
  readonly runId: string;
  readonly outcome: string | null;
  readonly spentUsd: number;
  readonly tasks: readonly {
    readonly taskId: number;
    readonly title: string;
    readonly status: string;
    readonly rounds: unknown;
    readonly costUsd: number;
    readonly reason: string | null;
  }[];
}

/** Everything the tools need from outside. */
export interface WorkflowPorts {
  readonly approverMode: Approver;
  readonly states: {
    list(): Promise<readonly WorkflowState[]>;
    save(state: WorkflowState): Promise<void>;
  };
  useTasks<T>(mode: "read" | "update" | "create", run: (tasks: TaskRecords | undefined) => T): T;
  roadmapText(): string;
  askUser(question: {
    readonly question: string;
    readonly answers: readonly string[];
    readonly isNotesAsked: boolean;
  }): Promise<UserReply>;
  currentBranch(): Promise<string | undefined>;
  changedFiles(): Promise<readonly string[]>;
  runHoldingTask(taskId: number): Promise<string | undefined>;
  readRun(runId: string | undefined): Promise<RunSummary | undefined>;
  startPreview(): Promise<{ readonly isRunning: boolean; readonly detail: string }>;
  readDocument(relativePath: string): Promise<string | undefined>;
  now(): string;
}

type Reply = Awaited<ReturnType<WorkflowTool["run"]>>;

const NO_BRANCH = "no-branch";
const APPROVE_COMMAND = "cclinic approve";
const NO_INPUT = advanceInputSchema.pick({});

function ok(message: string, extra: Record<string, unknown> = {}): Reply {
  return { text: JSON.stringify({ status: "ok", message, ...extra }), isError: false };
}

function refused(message: string): Reply {
  return { text: JSON.stringify({ status: "refused", message }), isError: true };
}

function json(value: Record<string, unknown>): Reply {
  return { text: JSON.stringify({ status: "success", ...value }), isError: false };
}

function describe(state: WorkflowState): string {
  const task = state.taskId === null ? "" : `task #${state.taskId}, `;
  return `${state.key} (${task}spec "${state.spec}", at "${state.step}")`;
}

export function createWorkflowTools(ports: WorkflowPorts): {
  readonly tools: readonly WorkflowTool[];
  readonly resources: readonly WorkflowResource[];
} {
  const findOpen = async (): Promise<WorkflowState | undefined> => (await ports.states.list()).find(isOpenChange);

  const withOpen = async (run: (state: WorkflowState) => Promise<Reply>): Promise<Reply> => {
    const state = await findOpen();
    if (state === undefined) return refused("No change is open. Start one with workflow_begin.");
    return run(state);
  };

  const save = async (outcome: Outcome, extra: Record<string, unknown> = {}): Promise<Reply> => {
    if ("refusal" in outcome) return refused(outcome.refusal);
    await ports.states.save(outcome.state);
    return ok(outcome.message, extra);
  };

  /**
   * Asks the user, or, when the host can't, saves the question for `cclinic approve` (FR-MCP-028, FR-MCP-029).
   * An answer given that way is picked up the next time the agent asks.
   */
  const askUser = async (
    state: WorkflowState,
    question: Omit<PendingQuestion, "question" | "answers" | "answer" | "notes">,
    asked: { readonly question: string; readonly answers: readonly string[] },
  ): Promise<{ readonly answer: string; readonly notes: string | null } | Reply> => {
    const waiting = state.pending;
    if (
      waiting?.answer !== null &&
      waiting?.answer !== undefined &&
      waiting.kind === question.kind &&
      waiting.gate === question.gate &&
      waiting.step === question.step
    )
      return { answer: waiting.answer, notes: waiting.notes };
    const reply = await ports.askUser({ ...asked, isNotesAsked: asked.answers.some(isNotesAnswer) });
    if (reply.kind === "answered") return { answer: reply.answer, notes: reply.notes };
    if (reply.kind === "declined")
      return refused("The user didn't answer, so nothing changed. Ask again when they're ready.");
    await ports.states.save(
      withPending(
        state,
        { ...question, ...asked, answers: [...asked.answers], answer: null, notes: null },
        ports.now(),
      ),
    );
    return {
      text: JSON.stringify({
        status: "waiting-for-approval",
        question: asked.question,
        answers: asked.answers,
        message: `Your tool can't show this question. Ask the user to answer it by running "${APPROVE_COMMAND}" in their own terminal, then call this tool again. Never run it yourself.`,
      }),
      isError: false,
    };
  };

  const isReply = (value: object): value is Reply => "isError" in value;

  const confirm = async (
    state: WorkflowState,
    pending: Omit<PendingQuestion, "question" | "answers" | "answer" | "notes">,
    question: string,
  ): Promise<boolean | Reply> => {
    const answered = await askUser(state, pending, { question, answers: CONFIRM_ANSWERS });
    if (isReply(answered)) return answered;
    const waiting = state.pending;
    if (waiting?.kind === pending.kind && waiting.step === pending.step && waiting.gate === pending.gate)
      await ports.states.save({ ...state, pending: null });
    return answered.answer === "yes";
  };

  const missingSpecFiles = async (spec: string): Promise<readonly string[]> => {
    const files = Object.values(SPEC_FILES);
    const found = await Promise.all(files.map((file) => ports.readDocument(`specs/${spec}/${file}`)));
    return files.filter((_, index) => found[index] === undefined);
  };

  const advance = (to: WorkflowState["step"]) =>
    withOpen(async (state) => {
      const check = checkAdvance(state, to, to === "implement" ? await missingSpecFiles(state.spec) : []);
      if ("refusal" in check) return refused(check.refusal);
      if (!check.isAnswerNeeded || check.gate === undefined) return save(enterStep(state, to, ports.now()));
      const gate = check.gate as AskedGate;
      const answered = await askUser(
        state,
        { kind: "gate", gate, step: null, reason: null },
        gateQuestion(state, gate),
      );
      if (isReply(answered)) return answered;
      const outcome = applyAnswer(state, gate, answered.answer, {
        approver: ports.approverMode,
        notes: answered.notes,
        now: ports.now(),
      });
      const reply = await save(outcome, { answer: answered.answer });
      // A task is done only once its change is approved, and the approval is saved first (FR-MCP-013, FR-MCP-024).
      if (reply.isError || gate !== "G5" || answered.answer !== "approve" || state.taskId === null) return reply;
      const taskId = state.taskId;
      const marked = changeTask(() =>
        ports.useTasks("update", (tasks) => requireTasks(tasks, taskId).setStatus(taskId, "done")),
      );
      return typeof marked === "string"
        ? ok(`The approval is recorded, but task ${taskId} couldn't be marked done: ${marked}`, {
            answer: answered.answer,
          })
        : reply;
    });

  const toolList: WorkflowTool[] = [
    {
      name: "workflow_status",
      description:
        "Call first in every session. Returns the open change: its step, task, spec, QA runs and code reviews used, preview, decisions and skips.",
      inputSchema: NO_INPUT,
      run: async () => {
        const state = await findOpen();
        if (state === undefined) return ok("No change is open. Start one with workflow_begin.", { change: null });
        return ok(`The open change is ${describe(state)}.`, { change: summarizeState(state) });
      },
    },
    {
      name: "workflow_begin",
      description:
        "Starts a change. changeType is feature, bug or no-behaviour (a refactor, formatting, a typo or a dependency update, which skips the spec gate). Give the spec it belongs to, and the task ID when it's a task.",
      inputSchema: beginInputSchema,
      run: async (input) => {
        const parsed = beginInputSchema.parse(input);
        const open = await findOpen();
        if (open !== undefined)
          return refused(`Change ${describe(open)} is still open. Finish it before starting another.`);
        if (parsed.taskId !== undefined) {
          const taskId = parsed.taskId;
          if (ports.useTasks("read", (tasks) => tasks?.getTask(taskId)) === undefined)
            return refused(`Task ${taskId} doesn't exist.`);
        }
        const key = stateKey(parsed.taskId ?? null, (await ports.currentBranch()) ?? NO_BRANCH);
        const state = beginChange(parsed, { key, approverMode: ports.approverMode, now: ports.now() });
        await ports.states.save(state);
        return ok(`Started ${describe(state)}.`, { change: summarizeState(state) });
      },
    },
    {
      name: "workflow_advance",
      description:
        "Moves the change to the next step: implement, qa, review, preview, approval, commit or done. Refused if its gate hasn't passed. At the spec, approval and commit gates, the user is asked; never answer for them.",
      inputSchema: advanceInputSchema,
      run: (input) => advance(advanceInputSchema.parse(input).to),
    },
    {
      name: "workflow_skip",
      description:
        "Asks the user to skip the spec, qa, review or preview step. Use only when the user asked to skip it.",
      inputSchema: skipInputSchema,
      run: (input) =>
        withOpen(async (state) => {
          const { step, reason } = skipInputSchema.parse(input);
          if (ports.approverMode !== "user") return refused("Steps can't be skipped in automated mode.");
          const problem = checkSkip(state, step);
          if (problem !== undefined) return refused(problem);
          const isAgreed = await confirm(
            state,
            { kind: "skip", gate: null, step, reason },
            `Skip the "${step}" step? The agent's reason: ${reason}`,
          );
          if (typeof isAgreed !== "boolean") return isAgreed;
          if (!isAgreed) return ok(`The user said no, so "${step}" isn't skipped.`);
          return save(skipStep((await findOpen()) ?? state, step, reason, ports.now()));
        }),
    },
    {
      name: "workflow_reset",
      description:
        "Sends the change back to the spec step, when the spec turns out wrong. The spec then needs approving again.",
      inputSchema: resetInputSchema,
      run: (input) =>
        withOpen(async (state) => save(resetToSpec(state, resetInputSchema.parse(input).reason, ports.now()))),
    },
    {
      name: "workflow_resume",
      description: "When the change stopped at the QA or review limit, asks the user whether to continue.",
      inputSchema: NO_INPUT,
      run: () =>
        withOpen(async (state) => {
          if (state.status !== "stopped") return refused("Only a stopped change can be resumed.");
          const isAgreed = await confirm(
            state,
            { kind: "resume", gate: null, step: null, reason: null },
            `The change stopped: ${state.reason ?? ""} Continue, with the QA and review counts started again?`,
          );
          if (typeof isAgreed !== "boolean") return isAgreed;
          const latest = (await findOpen()) ?? state;
          return save(isAgreed ? resumeChange(latest, ports.now()) : endStoppedChange(latest, ports.now()));
        }),
    },
    {
      name: "tasks_list",
      description: "Lists open, in-progress and blocked tasks in roadmap order, or every task with includeDone.",
      inputSchema: tasksListInputSchema,
      run: (input) => {
        const { includeDone } = tasksListInputSchema.parse(input);
        return Promise.resolve(
          json({ tasks: ports.useTasks("read", (tasks) => tasks?.listTasks(includeDone === true) ?? []) }),
        );
      },
    },
    {
      name: "task_get",
      description: "Returns every detail of one task.",
      inputSchema: taskIdInputSchema,
      run: (input) => {
        const { id } = taskIdInputSchema.parse(input);
        const task = ports.useTasks("read", (tasks) => tasks?.getTask(id));
        return Promise.resolve(task === undefined ? refused(`Task ${id} doesn't exist.`) : json({ task }));
      },
    },
    {
      name: "task_next",
      description: "Returns the first open or blocked task, in roadmap order, whose dependencies are all done.",
      inputSchema: NO_INPUT,
      run: () => {
        const all = ports.useTasks("read", (tasks) => tasks?.listTasks(true) ?? []);
        const done = new Set(all.filter((task) => task.status === "done").map((task) => task.id));
        const next = all.find(
          (task) => (task.status === "open" || task.status === "blocked") && task.dependsOn.every((id) => done.has(id)),
        );
        return Promise.resolve(json({ task: next ?? null }));
      },
    },
    {
      name: "task_start",
      description: "Marks a task in progress, when work on it starts.",
      inputSchema: taskIdInputSchema,
      run: async (input) => {
        const { id } = taskIdInputSchema.parse(input);
        const runId = await ports.runHoldingTask(id);
        if (runId !== undefined) return refused(`Task ${id} is being worked on by automated run ${runId}.`);
        return tasksCall(() =>
          ports.useTasks("update", (tasks) => requireTasks(tasks, id).setStatus(id, "in-progress")),
        );
      },
    },
    {
      name: "task_block",
      description: "Marks a task blocked, with the reason.",
      inputSchema: taskBlockInputSchema,
      run: async (input) => {
        const { id, reason } = taskBlockInputSchema.parse(input);
        const reply = tasksCall(() =>
          ports.useTasks("update", (tasks) => requireTasks(tasks, id).setStatus(id, "blocked")),
        );
        const open = await findOpen();
        if (!reply.isError && open !== undefined)
          await ports.states.save(recordBlockReason(open, id, reason, ports.now()));
        return reply;
      },
    },
    {
      name: "task_add",
      description: "Adds one task with no milestone. Roadmaps and their tasks are planned with cclinic plan instead.",
      inputSchema: taskInputSchema,
      run: (input) => {
        const parsed = taskInputSchema.parse(input);
        return Promise.resolve(
          tasksCall(() =>
            ports.useTasks("create", (tasks) => {
              if (tasks === undefined) throw new UsageError("The task database couldn't be opened.");
              return tasks.addTask(parsed);
            }),
          ),
        );
      },
    },
    {
      name: "qa_handoff",
      description: "Returns what a separate QA agent needs: the spec's three files and the files the change touched.",
      inputSchema: NO_INPUT,
      run: () =>
        withOpen(async (state) => {
          const files = await Promise.all(
            Object.values(SPEC_FILES).map(async (file) => ({
              file,
              content: (await ports.readDocument(`specs/${state.spec}/${file}`)) ?? null,
            })),
          );
          return json({ spec: state.spec, specFiles: files, changedFiles: await ports.changedFiles() });
        }),
    },
    {
      name: "qa_report",
      description: "Records one QA run: passed, and the failing test cases. At most 3 runs per change.",
      inputSchema: qaReportInputSchema,
      run: (input) =>
        withOpen(async (state) => save(recordQaRun(state, qaReportInputSchema.parse(input), ports.now()))),
    },
    {
      name: "review_report",
      description:
        "Records one code review from the review-code skill: approve or changes, with the findings by severity. At most 3 reviews per change.",
      inputSchema: reviewReportInputSchema,
      run: (input) =>
        withOpen(async (state) => save(recordReview(state, reviewReportInputSchema.parse(input), ports.now()))),
    },
    {
      name: "preview_start",
      description: "Starts the project's local environment, leaves it running, and returns the link or command to try.",
      inputSchema: NO_INPUT,
      run: () =>
        withOpen(async (state) => {
          const check = checkPreview(state);
          if ("refusal" in check) return refused(check.refusal);
          const preview = await ports.startPreview();
          if (!check.isRecorded)
            return ok("The change is stopped, so this preview is only for your report to the user.", { preview });
          // The preview can take a while, so the result goes on the latest state.
          const latest = (await findOpen()) ?? state;
          return save(recordPreview(latest, preview.isRunning, preview.detail, ports.now()), { preview });
        }),
    },
    {
      name: "auto_status",
      description: "Shows the progress of an automated run (the latest when no runId is given). Read-only.",
      inputSchema: autoStatusInputSchema,
      run: async (input) => {
        const run = await ports.readRun(autoStatusInputSchema.parse(input).runId);
        return run === undefined ? ok("There's no automated run.", { run: null }) : json({ run });
      },
    },
  ];

  const resources: WorkflowResource[] = [
    {
      name: "specs",
      uri: RESOURCE_URIS.specs,
      description: "The project's specs, from the documents README.",
      read: async () => (await ports.readDocument("README.md")) ?? "There are no project documents.",
    },
    {
      name: "spec",
      uri: RESOURCE_URIS.spec,
      description: "One spec's spec.md, validation.md and verification.md.",
      read: async ({ name }) => {
        const parsed = specNameSchema.safeParse(name);
        if (!parsed.success) return `"${name ?? ""}" isn't a spec name.`;
        const parts = await Promise.all(
          Object.values(SPEC_FILES).map(async (file) => {
            const content = await ports.readDocument(`specs/${parsed.data}/${file}`);
            return `<!-- ${file} -->\n${content ?? "(missing)"}`;
          }),
        );
        return parts.join("\n\n");
      },
    },
    {
      name: "roadmap",
      uri: RESOURCE_URIS.roadmap,
      description: "Roadmaps, milestones and tasks.",
      read: () => Promise.resolve(ports.roadmapText()),
    },
  ];

  return { tools: toolList, resources };
}

function requireTasks(tasks: TaskRecords | undefined, id: number): TaskRecords {
  if (tasks === undefined) throw new UsageError(`Task ${id} doesn't exist.`);
  return tasks;
}

/** The task, or the reason it couldn't be changed, such as a missing ID. */
function changeTask(run: () => Task): Task | string {
  try {
    return run();
  } catch (error) {
    if (error instanceof UsageError) return error.message;
    throw error;
  }
}

/** Task errors become refusals, as `cclinic tasks` reports them. */
function tasksCall(run: () => Task): Reply {
  const task = changeTask(run);
  return typeof task === "string" ? refused(task) : json({ task });
}
