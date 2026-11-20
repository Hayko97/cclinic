/** `luseen mcp` and `luseen approve`: the MCP server, and answering its questions in a terminal (spec: mcp-server). */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { listChangedFiles, readCurrentBranch } from "../adapters/git/git-repository.js";
import { createMcpServer, type McpConnection } from "../adapters/mcp/mcp-server.js";
import { startPreview } from "../adapters/preview/preview-runner.js";
import { projectPaths } from "../adapters/storage/document-store.js";
import { findRunHoldingTask, readRunState } from "../adapters/storage/run-store.js";
import { readEnvironmentFile } from "../adapters/storage/environment-store.js";
import { openTaskStore, type OpenMode, type TaskStore } from "../adapters/storage/task-store.js";
import { openWorkflowStore } from "../adapters/storage/workflow-store.js";
import { createPlanTools } from "../application/plan-tools.js";
import { approveProposal, cancelSession, releaseSessionHold } from "../application/planning-session.js";
import { createNotSetUpTools, createWorkflowTools, type RunSummary } from "../application/workflow-tools.js";
import { TOOL_FOLDER_NAME } from "../core/constants/paths.js";
import { MCP_SERVER_NAME, SESSION_LINK_LOCK_WAIT_MS, SESSION_LINK_TIMEOUT_MS } from "../core/constants/workflow.js";
import { ENVIRONMENT_FILE_PATH } from "../core/environment.js";
import { UsageError } from "../core/errors.js";
import { renderOverview } from "../core/tasks.js";
import {
  answerPending,
  isStillWaiting,
  APPROVERS,
  hookInputSchema,
  isNotesAnswer,
  linkSession,
  type Approver,
  type WorkflowState,
} from "../core/workflow.js";
import {
  isPlanToolCall,
  linkClaudeSession,
  planIdOfToolCall,
  PROPOSAL_ANSWERS,
  renderWaitingProposal,
  type PlanSession,
} from "../core/planning.js";
import type { CommandContext } from "./command-context.js";
import { askText, chooseFrom, isInteractive } from "./menus.js";
import { decisionPorts, documentPaths, planStoreFor } from "./planning-ports.js";
import { isProcessRunning } from "../adapters/storage/file-lock.js";
import { projectFolder, readOverview } from "./tasks-command.js";

export interface McpOptions {
  readonly dir?: string;
  readonly approver: string;
  readonly run?: string;
  readonly task?: number;
  /** FR-MCP-046: serve only this planning session's tools, for a PM turn luseen drives. */
  readonly plan?: string;
}

/** FR-MCP-002: pm-agent needs to know its run and its task; it has no dollar budget (FR-MCP-036). */
function parseApprover(options: McpOptions): Approver {
  const approver = APPROVERS.find((name) => name === options.approver);
  if (approver === undefined) throw new UsageError(`--approver must be ${APPROVERS.join(" or ")}.`);
  if (approver === "pm-agent") {
    for (const [option, value] of [
      ["--run", options.run],
      ["--task", options.task],
    ] as const) {
      if (value === undefined) throw new UsageError(`--approver pm-agent needs ${option}.`);
    }
    throw new UsageError("The pm-agent approver isn't available yet. Use --approver user.");
  }
  return approver;
}

function useTasksIn(toolFolder: string) {
  return <T>(mode: OpenMode, run: (store: TaskStore | undefined) => T): T => {
    const store = openTaskStore(toolFolder, mode);
    try {
      return run(store);
    } finally {
      store?.close();
    }
  };
}

function summarizeRun(target: string) {
  return async (runId: string | undefined): Promise<RunSummary | undefined> => {
    const state = await readRunState(target, runId);
    if (state === undefined) return undefined;
    return {
      runId: state.runId,
      outcome: state.outcome,
      spentUsd: state.spentUsd,
      tasks: state.tasks.map(({ taskId, title, status, rounds, costUsd, reason }) => ({
        taskId,
        title,
        status,
        rounds,
        costUsd,
        reason,
      })),
    };
  };
}

/** This server, as the holder of the planning sessions Claude Code begins or resumes (FR-PLAN-032). */
const HOST_HOLDER = { place: "claude-code", pid: process.pid } as const;

/** FR-PLAN-044, FR-MCP-046: the planning tools, for Claude Code itself or for one session luseen drives. */
function planTools(target: string, connection: McpConnection, driven: PlanSession | undefined) {
  const ports = decisionPorts(target);
  return createPlanTools({
    ...ports,
    mode:
      driven === undefined
        ? { kind: "host" }
        : { kind: "driven", planId: driven.id, isNewProject: driven.target.kind === "new-project" },
    holder: HOST_HOLDER,
    ...documentPaths(target),
    isRunning: isProcessRunning,
    askUser: (question) => connection.askUser({ ...question, isNotesAsked: false }),
  });
}

/** FR-MCP-046: a driven server serves one open session only. */
async function requireOpenPlan(target: string, planId: string): Promise<PlanSession> {
  const session = await planStoreFor(target).read(planId);
  if (session?.status !== "open") throw new UsageError(`There's no open planning session ${planId}.`);
  return session;
}

/** FR-PLAN-032: the sessions this server held are let go when Claude Code ends it. */
async function releaseHeldPlans(target: string): Promise<void> {
  const ports = decisionPorts(target);
  for (const session of (await ports.records.list()).sessions) {
    if (session.holder?.pid === process.pid) await releaseSessionHold(ports, session.id, HOST_HOLDER);
  }
}

/** The server for a project, with every tool and resource, not yet connected. */
export async function createProjectServer(options: McpOptions, context: CommandContext): Promise<McpConnection> {
  const target = await projectFolder(options.dir);
  const approverMode = parseApprover(options);
  const paths = projectPaths(target, undefined);
  const connection = createMcpServer({ name: MCP_SERVER_NAME, version: context.version });
  if (options.plan !== undefined) {
    // FR-MCP-046, FR-MCP-048: a driven server serves a session of a project that is set up, or a new project's.
    const session = existsSync(paths.out) ? undefined : await planStoreFor(target).read(options.plan);
    if (!existsSync(paths.out) && (session?.status !== "open" || session.target.kind !== "new-project"))
      throw new UsageError(`There are no project documents in ${paths.out}. Run "luseen" in the project first.`);
    const driven = session ?? (await requireOpenPlan(target, options.plan));
    for (const tool of planTools(target, connection, driven)) connection.addTool(tool);
    return connection;
  }
  if (!existsSync(paths.out)) {
    for (const tool of createNotSetUpTools()) connection.addTool(tool);
    return connection;
  }
  const git = { environment: context.environment };
  const useTasks = useTasksIn(paths.tool);
  const { tools, resources } = createWorkflowTools({
    approverMode,
    states: openWorkflowStore(target),
    useTasks,
    roadmapText: () => useTasks("read", (store) => renderOverview(readOverview(store))),
    askUser: (question) => connection.askUser(question),
    currentBranch: () => readCurrentBranch(target, git),
    changedFiles: () => listChangedFiles(target, git),
    runHoldingTask: (taskId) => findRunHoldingTask(target, taskId),
    readRun: summarizeRun(target),
    startPreview: async () => {
      const environment = await readEnvironmentFile(target);
      if (environment.kind === "valid") return startPreview(target, environment.file);
      return {
        isRunning: false,
        detail:
          environment.kind === "missing"
            ? `There's no ${ENVIRONMENT_FILE_PATH}. Set up the local environment with the local-env skill, then call preview_start again.`
            : `${ENVIRONMENT_FILE_PATH} isn't valid: ${environment.problems.join("; ")}`,
      };
    },
    readDocument: (relative) => readFile(path.join(paths.out, relative), "utf8").catch(() => undefined),
    now: () => new Date().toISOString(),
  });
  for (const tool of [...tools, ...planTools(target, connection, undefined)]) connection.addTool(tool);
  for (const resource of resources) connection.addResource(resource);
  return connection;
}

export async function runMcpCommand(options: McpOptions, context: CommandContext): Promise<void> {
  const connection = await createProjectServer(options, context);
  await connection.connect();
  context.reporter.debug("The luseen MCP server is running.");
  await connection.waitUntilClosed();
  const target = await projectFolder(options.dir);
  if (options.plan === undefined && existsSync(projectPaths(target, undefined).out)) await releaseHeldPlans(target);
}

/** FR-PLAN-045: a proposal a Claude Code session couldn't ask about, approved or cancelled here. */
async function answerProposal(target: string, session: PlanSession, context: CommandContext): Promise<void> {
  if (session.proposal === null) return;
  const answer = await chooseFrom(
    `${renderWaitingProposal(session.proposal, session.target)}\n\nApprove this proposal?`,
    PROPOSAL_ANSWERS.map((value) => ({ value, name: value })),
  );
  if (answer === "keep chatting") {
    context.reporter.result("The proposal stays waiting. Tell the PM what to change.");
    return;
  }
  const ports = decisionPorts(target);
  const decided =
    answer === "approve"
      ? await approveProposal(ports, session.id)
      : await cancelSession(ports, session.id, { pid: process.pid, isRunning: isProcessRunning });
  context.reporter.result(decided.message);
}

/** FR-MCP-029, FR-CLI-029: only a person at a terminal can answer, so an agent's shell can't. */
export async function runApproveCommand(given: string | undefined, context: CommandContext): Promise<void> {
  if (!isInteractive())
    throw new UsageError("luseen approve must be run in your own terminal, so only you can answer.");
  const target = await projectFolder(given);
  const store = openWorkflowStore(target);
  const waiting = (await store.list()).filter((state) => state.pending !== null && state.pending.answer === null);
  const proposals = (await planStoreFor(target).list()).sessions.filter(
    (session) => session.status === "open" && session.proposal !== null,
  );
  if (waiting.length === 0 && proposals.length === 0) {
    context.reporter.result("No question is waiting for your answer.");
    return;
  }
  const choices: { value: WorkflowState | PlanSession; name: string }[] = [
    ...waiting.map((item) => ({ value: item, name: item.pending?.question ?? item.key })),
    ...proposals.map((session) => ({
      value: session,
      name: `Approve the proposal of planning session ${session.id}?`,
    })),
  ];
  const chosen =
    choices.length === 1 && choices[0] !== undefined
      ? choices[0].value
      : await chooseFrom("Which question do you want to answer?", choices);
  if ("target" in chosen) {
    await answerProposal(target, chosen, context);
    return;
  }
  const state: WorkflowState = chosen;
  const pending = state.pending;
  if (pending === null) return;
  const answer = await chooseFrom(
    pending.question,
    pending.answers.map((value) => ({ value, name: value })),
  );
  const notes = isNotesAnswer(answer) ? (await askText("Notes for the agent")).trim() : "";
  // The server may have saved this change while the user was choosing, so the answer goes on its latest state.
  const latest = (await store.list()).find((item) => item.key === state.key);
  if (latest === undefined || !isStillWaiting(latest, pending.question))
    throw new UsageError("That question changed while you were answering. Run luseen approve again.");
  const outcome = answerPending(latest, answer, notes === "" ? null : notes, new Date().toISOString());
  if ("refusal" in outcome) throw new UsageError(outcome.refusal);
  await store.save(outcome.state);
  context.reporter.result(outcome.message);
}

/**
 * The project the hook's session works on: Claude Code's project folder, else the nearest folder with
 * `.luseen`. Undefined when there's none, so nothing is written outside a luseen project.
 */
function hookProject(cwd: string, environment: NodeJS.ProcessEnv): string | undefined {
  const given = environment["CLAUDE_PROJECT_DIR"];
  if (given !== undefined && given !== "") return given;
  for (let folder = cwd; ; folder = path.dirname(folder)) {
    if (existsSync(path.join(folder, TOOL_FOLDER_NAME))) return folder;
    if (path.dirname(folder) === folder) return undefined;
  }
}

async function linkFromHook(stdin: Readable, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  let text = "";
  for await (const chunk of stdin) text += String(chunk);
  const input = hookInputSchema.safeParse(JSON.parse(text));
  if (!input.success) return;
  const project = hookProject(input.data.cwd, environment);
  if (project === undefined) return;
  if (isPlanToolCall(input.data.tool_name)) {
    const planId = planIdOfToolCall(input.data.tool_name, input.data.tool_response);
    if (planId === undefined) return;
    const claude = { sessionId: input.data.session_id, transcriptPath: input.data.transcript_path };
    await planStoreFor(project).update(planId, (session) => {
      const linked = linkClaudeSession(session, claude, new Date().toISOString());
      return linked === session ? { value: undefined } : { save: linked, value: undefined };
    });
    return;
  }
  const store = openWorkflowStore(project);
  const session = { sessionId: input.data.session_id, transcriptPath: input.data.transcript_path };
  await store.updateOpen((open) => linkSession(open, session, new Date().toISOString()), signal);
}

/**
 * FR-MCP-045, FR-CLI-031: links the Claude Code session that just used a luseen tool to the open change.
 * It runs inside the user's session, so it never fails, never prints and never waits long.
 */
export async function runSessionLink(stdin: Readable, environment: NodeJS.ProcessEnv): Promise<void> {
  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, SESSION_LINK_TIMEOUT_MS).unref();
  });
  // Counted from the start, so the lock is given up before the hook's own time runs out, however slow stdin was.
  const lockDeadline = AbortSignal.timeout(SESSION_LINK_LOCK_WAIT_MS);
  await Promise.race([linkFromHook(stdin, environment, lockDeadline).catch(() => undefined), timeout]);
  stdin.destroy();
}
