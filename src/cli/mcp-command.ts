/** `cclinic mcp` and `cclinic approve`: the MCP server, and answering its questions in a terminal (spec: mcp-server). */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { listChangedFiles, readCurrentBranch } from "../adapters/git/git-repository.js";
import { createMcpServer, type McpConnection } from "../adapters/mcp/mcp-server.js";
import { startPreview } from "../adapters/preview/preview-runner.js";
import { projectPaths } from "../adapters/storage/document-store.js";
import { findRunHoldingTask, readRunState } from "../adapters/storage/run-store.js";
import { readEnvironmentFile } from "../adapters/storage/environment-store.js";
import { openTaskStore, type OpenMode, type TaskStore } from "../adapters/storage/task-store.js";
import { openWorkflowStore } from "../adapters/storage/workflow-store.js";
import { createWorkflowTools, type RunSummary } from "../application/workflow-tools.js";
import { MCP_SERVER_NAME } from "../core/constants/workflow.js";
import { ENVIRONMENT_FILE_PATH } from "../core/environment.js";
import { UsageError } from "../core/errors.js";
import { renderOverview } from "../core/tasks.js";
import { answerPending, APPROVERS, isNotesAnswer, type Approver, type WorkflowState } from "../core/workflow.js";
import type { CommandContext } from "./command-context.js";
import { askText, chooseFrom, isInteractive } from "./menus.js";
import { projectFolder, readOverview } from "./tasks-command.js";

export interface McpOptions {
  readonly dir?: string;
  readonly approver: string;
  readonly run?: string;
  readonly task?: number;
  readonly maxBudgetUsd?: number;
}

/** FR-MCP-002: pm-agent needs to know its run, its task and its budget. */
function parseApprover(options: McpOptions): Approver {
  const approver = APPROVERS.find((name) => name === options.approver);
  if (approver === undefined) throw new UsageError(`--approver must be ${APPROVERS.join(" or ")}.`);
  if (approver === "pm-agent") {
    for (const [option, value] of [
      ["--run", options.run],
      ["--task", options.task],
      ["--max-budget-usd", options.maxBudgetUsd],
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
      budgetUsd: state.budgetUsd,
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

/** The server for a project, with every tool and resource, not yet connected. */
export async function createProjectServer(options: McpOptions, context: CommandContext): Promise<McpConnection> {
  const target = await projectFolder(options.dir);
  const approverMode = parseApprover(options);
  const paths = projectPaths(target, undefined);
  if (!existsSync(paths.out))
    throw new UsageError(`There are no project documents in ${paths.out}. Run "cclinic" in the project first.`);
  const git = { environment: context.environment };
  const useTasks = useTasksIn(paths.tool);
  const connection = createMcpServer({ name: MCP_SERVER_NAME, version: context.version });
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
  for (const tool of tools) connection.addTool(tool);
  for (const resource of resources) connection.addResource(resource);
  return connection;
}

export async function runMcpCommand(options: McpOptions, context: CommandContext): Promise<void> {
  const connection = await createProjectServer(options, context);
  await connection.connect();
  context.reporter.debug("The cclinic MCP server is running.");
  await connection.waitUntilClosed();
}

/** FR-MCP-029, FR-CLI-029: only a person at a terminal can answer, so an agent's shell can't. */
export async function runApproveCommand(given: string | undefined, context: CommandContext): Promise<void> {
  if (!isInteractive())
    throw new UsageError("cclinic approve must be run in your own terminal, so only you can answer.");
  const target = await projectFolder(given);
  const store = openWorkflowStore(target);
  const waiting = (await store.list()).filter((state) => state.pending !== null && state.pending.answer === null);
  if (waiting.length === 0) {
    context.reporter.result("No question is waiting for your answer.");
    return;
  }
  const state: WorkflowState =
    waiting.length === 1 && waiting[0] !== undefined
      ? waiting[0]
      : await chooseFrom(
          "Which question do you want to answer?",
          waiting.map((item) => ({ value: item, name: item.pending?.question ?? item.key })),
        );
  const pending = state.pending;
  if (pending === null) return;
  const answer = await chooseFrom(
    pending.question,
    pending.answers.map((value) => ({ value, name: value })),
  );
  const notes = isNotesAnswer(answer) ? (await askText("Notes for the agent")).trim() : "";
  // The server may have saved this change while the user was choosing, so the answer goes on its latest state.
  const latest = (await store.list()).find((item) => item.key === state.key);
  if (latest?.pending?.question !== pending.question || latest.pending.answer !== null)
    throw new UsageError("That question changed while you were answering. Run cclinic approve again.");
  const outcome = answerPending(latest, answer, notes === "" ? null : notes, new Date().toISOString());
  if ("refusal" in outcome) throw new UsageError(outcome.refusal);
  await store.save(outcome.state);
  context.reporter.result(outcome.message);
}
