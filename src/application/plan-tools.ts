/**
 * The MCP server's planning tools, for a PM in Claude Code or in a turn luseen drives (roadmap-planning
 * FR-PLAN-007, FR-PLAN-009, FR-PLAN-044 to FR-PLAN-046; mcp-server FR-MCP-007, FR-MCP-046).
 */
import { PLAN_DRIVEN_TOOL_NAMES } from "../core/constants/agents.js";
import { UsageError } from "../core/errors.js";
import {
  checkProposal,
  newPlanSession,
  parseProposal,
  planBeginInputSchema,
  planIdInputSchema,
  planProposeInputSchema,
  planSuggestInputSchema,
  PROPOSAL_ANSWERS,
  renderPlanContext,
  renderWaitingProposal,
  type Holder,
  type PlanSession,
} from "../core/planning.js";
import {
  approveProposal,
  cancelSession,
  changeRecord,
  takeSessionHold,
  type DecisionPorts,
} from "./planning-session.js";
import type { UserReply, WorkflowTool } from "./workflow-tools.js";

export interface PlanToolPorts extends DecisionPorts {
  /**
   * `host`: a Claude Code session's own server, which begins and resumes sessions and asks the user about
   * proposals. `driven`: the server of one session a luseen process drives, which shows proposals itself.
   */
  readonly mode: { readonly kind: "host" } | { readonly kind: "driven"; readonly planId: string };
  /** This server's process, as the holder of the sessions it begins or resumes. */
  readonly holder: Holder;
  readonly overviewPath: string;
  readonly specsListPath: string;
  isRunning(pid: number): boolean;
  askUser(question: { readonly question: string; readonly answers: readonly string[] }): Promise<UserReply>;
}

type Reply = Awaited<ReturnType<WorkflowTool["run"]>>;

function reply(status: string, message: string, extra: Record<string, unknown> = {}): Reply {
  return { text: JSON.stringify({ status, message, ...extra }), isError: false };
}

function refused(message: string): Reply {
  return { text: JSON.stringify({ status: "refused", message }), isError: true };
}

export function createPlanTools(ports: PlanToolPorts): readonly WorkflowTool[] {
  /** The session, if this server may act on it: in driven mode only its own, in host mode only one it holds. */
  const ownSession = async (planId: string): Promise<PlanSession | Reply> => {
    if (ports.mode.kind === "driven" && planId !== ports.mode.planId) {
      return refused(`This server only serves planning session ${ports.mode.planId}.`);
    }
    const session = await ports.records.read(planId);
    if (session === undefined) return refused(`There's no planning session ${planId}.`);
    if (session.status !== "open") return refused(`Planning session ${planId} is ${session.status}.`);
    if (ports.mode.kind === "host" && session.holder?.pid !== ports.holder.pid) {
      return refused(`Call plan_resume for ${planId} first.`);
    }
    return session;
  };
  const isReply = (value: PlanSession | Reply): value is Reply => "isError" in value;

  const context = (session: PlanSession) =>
    renderPlanContext({
      planId: session.id,
      target: session.target,
      overview: ports.readContext().overview,
      overviewPath: ports.overviewPath,
      specsListPath: ports.specsListPath,
    });

  /** FR-PLAN-045: asks the user about an accepted proposal, or leaves it waiting for the GUI or `luseen approve`. */
  const decide = async (session: PlanSession): Promise<Reply> => {
    if (session.proposal === null) return refused("No proposal is waiting.");
    const asked = await ports.askUser({
      question: `Approve this proposal?\n\n${renderWaitingProposal(session.proposal, session.target)}`,
      answers: PROPOSAL_ANSWERS,
    });
    if (asked.kind === "unsupported") {
      return reply(
        "waiting-for-approval",
        'The proposal is saved as waiting. Ask the user to approve or cancel it in the GUI\'s Needs you, or by running "luseen approve" in their own terminal. Never run it yourself.',
      );
    }
    if (asked.kind === "declined" || asked.answer === "keep chatting") {
      return reply("waiting", "The user wants to keep talking. The proposal stays waiting; ask what to change.");
    }
    try {
      if (asked.answer === "cancel") {
        const cancelled = await cancelSession(ports, session.id, {
          pid: ports.holder.pid,
          isRunning: (pid) => ports.isRunning(pid),
        });
        return reply("cancelled", cancelled.message);
      }
      const approved = await approveProposal(ports, session.id);
      return reply("approved", approved.message);
    } catch (error) {
      if (error instanceof UsageError) return refused(error.message);
      throw error;
    }
  };

  const tools: WorkflowTool[] = [
    {
      name: "plan_begin",
      description:
        "Starts a planning session with the user: a new roadmap, more milestones for a roadmap, or one task. Call it before anything else when the user asks you to plan. Returns the session's ID and what exists.",
      inputSchema: planBeginInputSchema,
      run: async (input) => {
        const { target, request } = planBeginInputSchema.parse(input);
        const roadmapId = target.kind === "new-roadmap" ? null : target.roadmapId;
        if (roadmapId !== null && !ports.readContext().overview.roadmaps.some((roadmap) => roadmap.id === roadmapId)) {
          return refused(`Roadmap ${roadmapId} doesn't exist.`);
        }
        // The Claude session is linked by the session-link hook once this tool returns (FR-MCP-045).
        const session = await ports.records.create((id) =>
          newPlanSession({
            id,
            target,
            summary: request,
            holder: ports.holder,
            claudeSessionId: null,
            transcriptPath: null,
            now: ports.now(),
          }),
        );
        return reply("ok", `Planning session ${session.id} started.`, {
          planId: session.id,
          context: context(session),
        });
      },
    },
    {
      name: "plan_resume",
      description:
        "Continues a planning session, when this conversation is one (it was resumed with claude --resume). Returns its target and any waiting proposal.",
      inputSchema: planIdInputSchema,
      run: async (input) => {
        const { planId } = planIdInputSchema.parse(input);
        const taken = await takeSessionHold(ports, planId, ports.holder, (pid) => ports.isRunning(pid));
        if (typeof taken === "string") return refused(taken);
        return reply("ok", `You hold planning session ${planId} now.`, {
          planId,
          context: context(taken),
          waitingProposal: taken.proposal === null ? null : renderWaitingProposal(taken.proposal, taken.target),
        });
      },
    },
    {
      name: "plan_status",
      description: "Returns a planning session's status, its waiting proposal, and what was saved if it was approved.",
      inputSchema: planIdInputSchema,
      run: async (input) => {
        const { planId } = planIdInputSchema.parse(input);
        if (ports.mode.kind === "driven" && planId !== ports.mode.planId) {
          return refused(`This server only serves planning session ${ports.mode.planId}.`);
        }
        const session = await ports.records.read(planId);
        if (session === undefined) return refused(`There's no planning session ${planId}.`);
        return reply("ok", `Planning session ${planId} is ${session.status}.`, {
          planId,
          sessionStatus: session.status,
          outcome: session.outcome,
          waitingProposal: session.proposal === null ? null : renderWaitingProposal(session.proposal, session.target),
        });
      },
    },
    {
      name: "plan_suggest",
      description:
        "Gives the user up to 4 short answers to pick from, and the web pages you used as sources. Write the choices in your reply too.",
      inputSchema: planSuggestInputSchema,
      run: async (input) => {
        const { planId, suggestions, sources } = planSuggestInputSchema.parse(input);
        const session = await ownSession(planId);
        if (isReply(session)) return session;
        await changeRecord(ports.records, planId, (current) => ({
          ...current,
          suggestions,
          sources,
          updatedAt: ports.now(),
        }));
        return reply("ok", "The user will see these suggestions with your reply.");
      },
    },
    {
      name: "plan_propose",
      description:
        "Proposes the roadmap or the task. luseen checks it: if it returns problems, fix them and call it again. Only an accepted proposal is shown to the user, who approves, cancels or keeps chatting.",
      inputSchema: planProposeInputSchema,
      run: async (input) => {
        const { planId, proposal } = planProposeInputSchema.parse(input);
        const session = await ownSession(planId);
        if (isReply(session)) return session;
        const parsed = parseProposal(proposal, session.target);
        if (typeof parsed === "string") return refused(`The proposal isn't in the right shape: ${parsed}`);
        const problems = checkProposal(parsed, { ...ports.readContext(), target: session.target });
        if (problems.length > 0) {
          return refused(
            `Fix these problems and call plan_propose again:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
          );
        }
        const waiting = await changeRecord(ports.records, planId, (current) => ({
          ...current,
          proposal: { ...parsed, proposedAt: ports.now() },
          updatedAt: ports.now(),
        }));
        if (ports.mode.kind === "driven") {
          return reply("shown", "The proposal is accepted and shown to the user with your reply. End your turn now.");
        }
        return decide(waiting);
      },
    },
  ];
  return ports.mode.kind === "driven"
    ? tools.filter((tool) => (PLAN_DRIVEN_TOOL_NAMES as readonly string[]).includes(tool.name))
    : tools;
}
