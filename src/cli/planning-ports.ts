/**
 * The planning session's ports for a project: its records, what exists, saving, and the PM's Claude session
 * (spec: roadmap-planning). Shared by `luseen plan`, the GUI and `luseen mcp`.
 */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { savePlanLimits } from "../adapters/config/limits-store.js";
import { createExtractor } from "../adapters/extraction/extract.js";
import { runAgent } from "../adapters/llm/agent-process.js";
import { projectPaths } from "../adapters/storage/document-store.js";
import { openPlanStore, type PlanStore } from "../adapters/storage/plan-store.js";
import { openTaskStore } from "../adapters/storage/task-store.js";
import { readTranscriptLines } from "../adapters/transcripts/transcript-reader.js";
import type { DecisionPorts, PlanningContext, PmCall, TurnPorts } from "../application/planning-session.js";
import {
  AGENT_DENIED_TOOLS,
  BRIEF_TOOL_NAME,
  PLAN_DRIVEN_TOOL_NAMES,
  PLAN_LIMITS,
  PLAN_TURN_TOOL_NAMES,
  PM_TOOLS,
} from "../core/constants/agents.js";
import { parseTranscriptLine, type TranscriptEntry } from "../core/canvas.js";
import { MS_PER_MINUTE } from "../core/constants/limits.js";
import { DOCUMENT_FILES } from "../core/constants/paths.js";
import { MCP_SERVER_NAME } from "../core/constants/workflow.js";
import { AgentCallError, AgentSessionError, LlmError, PlanningToolsError, UsageError } from "../core/errors.js";
import type { Effort, ModelChoice } from "../core/models.js";
import {
  isTurnAnswered,
  isWaitingMessageWritten,
  planningToolsProblem,
  resumeCommands,
  toRoadmapPlan,
  type PlanSession,
  type PlanTarget,
  type WaitingProposal,
} from "../core/planning.js";
import { luseenBin } from "./luseen-bin.js";
import type { CommandContext } from "./command-context.js";
import { readOverview } from "./tasks-command.js";

/** A planning session's conversation, from its Claude transcript, with whole entries (FR-PLAN-031, FR-PLAN-042). */
export async function readPlanTranscript(session: PlanSession): Promise<TranscriptEntry[]> {
  const file = session.transcriptPath;
  if (file === null || !existsSync(file)) return [];
  const { lines } = await readTranscriptLines(file);
  return lines.flatMap((line) => parseTranscriptLine(line, PLAN_LIMITS.transcriptEntryChars).entries);
}

export function readPlanningContext(target: string): PlanningContext {
  const store = openTaskStore(projectPaths(target, undefined).tool, "read");
  try {
    return { overview: readOverview(store), tasks: store?.listTasks(true) ?? [] };
  } finally {
    store?.close();
  }
}

/** Saves an approved proposal in one transaction (FR-PLAN-013, FR-PLAN-020). */
export function savePlan(target: string, planTarget: PlanTarget, proposal: WaitingProposal): string {
  const store = openTaskStore(projectPaths(target, undefined).tool, "create");
  if (store === undefined) throw new UsageError("Couldn't open the task database.");
  try {
    if (proposal.kind === "roadmap") {
      const { roadmapId } = store.savePlan(toRoadmapPlan(proposal.proposal, planTarget));
      return `Saved roadmap #${roadmapId}. Run it with: luseen auto --roadmap ${roadmapId}`;
    }
    const { task, milestoneId } = proposal.proposal;
    const saved = store.addTask({
      title: task.title.trim(),
      description: task.description,
      ...(task.spec === null ? {} : { spec: task.spec }),
      dependsOn: task.dependsOn,
      ...(milestoneId === null ? {} : { milestoneId }),
    });
    return planTarget.kind === "task" && planTarget.roadmapId !== null
      ? `Saved task #${saved.id}. It runs with its roadmap: luseen auto --roadmap ${planTarget.roadmapId}`
      : `Saved task #${saved.id}. It's standalone, so luseen auto doesn't run it. Ask your coding agent to work on task ${saved.id}, which takes it through the project's lifecycle.`;
  } finally {
    store.close();
  }
}

/** The project overview and specs list, relative to the project, as the PM is told to read them. */
export function documentPaths(target: string): { readonly overviewPath: string; readonly specsListPath: string } {
  const out = projectPaths(target, undefined).out;
  return {
    overviewPath: path.relative(target, path.join(out, DOCUMENT_FILES.OVERVIEW)),
    specsListPath: path.relative(target, path.join(out, DOCUMENT_FILES.README)),
  };
}

/** A DOCX's text, extracted locally as in analysis (FR-PLAN-023). */
async function readDocumentText(file: string, name: string): Promise<string> {
  const extracted = await createExtractor().extract({
    path: name,
    absolutePath: file,
    kind: "document",
    sizeBytes: (await stat(file)).size,
  });
  return extracted.units.map((unit) => unit.text).join("\n\n");
}

export function planStoreFor(target: string): PlanStore {
  return openPlanStore(target, readDocumentText);
}

export function decisionPorts(target: string, records: PlanStore = planStoreFor(target)): DecisionPorts {
  return {
    records,
    readContext: () => readPlanningContext(target),
    save: (planTarget, proposal) => savePlan(target, planTarget, proposal),
    now: () => new Date().toISOString(),
  };
}

export interface PmSettings {
  readonly target: string;
  readonly model: ModelChoice;
  readonly effort: Effort;
  readonly timeoutMinutes: number;
  /** Each stream event of a turn, to show what the PM is doing. */
  readonly onEvent?: (event: unknown) => void;
}

/** FR-PLAN-005: the PM's tools, with only the planning tools of its own `luseen mcp --plan` server. */
function pmCallOptions(settings: PmSettings, call: PmCall) {
  // FR-MCP-048: a new project's PM may also propose its brief.
  const planTools = [...PLAN_DRIVEN_TOOL_NAMES, ...(call.session.project === null ? [] : [BRIEF_TOOL_NAME])].map(
    (name) => `mcp__${MCP_SERVER_NAME}__${name}`,
  );
  const sessionId = call.session.claudeSessionId;
  if (sessionId === null)
    throw new UsageError(`Planning session ${call.session.id} isn't linked to a Claude session yet.`);
  return {
    cwd: settings.target,
    prompt: call.message,
    model: settings.model,
    effort: settings.effort,
    tools: PM_TOOLS,
    allowedTools: [...PM_TOOLS, ...planTools],
    deniedTools: AGENT_DENIED_TOOLS,
    ...(call.isFirst ? { sessionId } : { resumeSessionId: sessionId }),
    mcpConfig: {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: process.execPath,
          args: [luseenBin(), "mcp", "--plan", call.session.id, "-C", settings.target],
        },
      },
    },
    timeoutMs: settings.timeoutMinutes * MS_PER_MINUTE,
  };
}

/**
 * FR-PLAN-005, FR-PLAN-014: what a session's transcript says about it, the same for the terminal and the GUI: whether
 * the Claude session exists, whether the waiting message has a reply, and whether the transcript has that message.
 */
export function transcriptChecks(): Pick<TurnPorts, "isStarted" | "isAnswered" | "isWritten"> {
  return {
    isStarted: (session) => Promise.resolve(session.transcriptPath !== null && existsSync(session.transcriptPath)),
    // A stop before Claude wrote the message leaves it waiting, so only a reply to that message counts.
    isAnswered: async (session) => isTurnAnswered(await readPlanTranscript(session), session.turnStartedAt),
    isWritten: async (session) =>
      session.unansweredMessage === null ||
      isWaitingMessageWritten(await readPlanTranscript(session), session.turnStartedAt, session.unansweredMessage),
  };
}

/** FR-PLAN-058: the planning tools a turn can't go without. */
function neededPlanningTools(session: PlanSession): string[] {
  return [...PLAN_TURN_TOOL_NAMES, ...(session.project?.phase === "brief" ? [BRIEF_TOOL_NAME] : [])];
}

/** FR-PLAN-005, FR-PLAN-015: one PM turn in the session's own Claude session. */
export function turnPorts(settings: PmSettings, records: PlanStore, context: CommandContext): TurnPorts {
  return {
    records,
    ...transcriptChecks(),
    callPm: async (call) => {
      // FR-PLAN-058: a turn without its planning tools is stopped before the PM replies.
      const toolsCheck = new AbortController();
      let toolsProblem: string | undefined;
      const needed = neededPlanningTools(call.session);
      try {
        const result = await runAgent({
          ...pmCallOptions(settings, call),
          // FR-AUTO-041: each plan-limits report is saved for the GUI; failing to save it never stops the PM.
          onLimits: (limits) => {
            savePlanLimits(context.environment, limits).catch(() => undefined);
          },
          onEvent: (event) => {
            toolsProblem ??= planningToolsProblem(event, needed);
            if (toolsProblem !== undefined) {
              toolsCheck.abort();
              return;
            }
            settings.onEvent?.(event);
          },
          environment: context.environment,
          signal: AbortSignal.any([context.signal, toolsCheck.signal]),
        });
        // A turn that ended before it could be stopped still didn't have its tools.
        if (toolsProblem !== undefined) throw new PlanningToolsError(toolsProblem);
        return result.finalMessage;
      } catch (error) {
        if (error instanceof PlanningToolsError) throw error;
        if (toolsProblem !== undefined) throw new PlanningToolsError(toolsProblem, { cause: error });
        const resume = `Continue later with: ${resumeCommands(call.session).join("  or  ")}`;
        if (error instanceof AgentCallError && error.isUsageLimit) {
          const resets = error.resetsAt === null ? "" : ` It resets ${error.resetsAt}.`;
          throw new AgentSessionError(
            `The PM stopped: Claude's usage limit is reached.${resets} Nothing was saved to the roadmap. ${resume}`,
            { cause: error },
          );
        }
        if (error instanceof LlmError) {
          throw new AgentSessionError(`The PM stopped: ${error.message} Nothing was saved to the roadmap. ${resume}`, {
            cause: error,
          });
        }
        throw error;
      }
    },
    now: () => new Date().toISOString(),
  };
}
