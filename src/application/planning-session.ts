/**
 * A planning session with the PM, the same from `cclinic plan`, the GUI and the MCP tools (spec: roadmap-planning):
 * driving one PM turn, and approving or cancelling a proposal.
 */
import { PLAN_LIMITS } from "../core/constants/agents.js";
import { AgentSessionError, SessionClosedError, UsageError } from "../core/errors.js";
import {
  answerLastMessage,
  buildFirstTurnPrompt,
  checkProposal,
  FIRST_MESSAGE_MARKER,
  isPlanningNote,
  NUDGE_MESSAGE,
  placeName,
  PROPOSAL_NO_LONGER_FITS,
  releaseHold,
  takeHold,
  type Holder,
  type PlanSession,
  type PlanTarget,
  type WaitingProposal,
} from "../core/planning.js";
import type { RoadmapOverview, Task } from "../core/tasks.js";

/** The plan store's methods the session uses. */
export interface PlanRecords {
  list(): Promise<{ readonly sessions: readonly PlanSession[]; readonly problems: readonly string[] }>;
  read(id: string): Promise<PlanSession | undefined>;
  create(make: (id: string) => PlanSession): Promise<PlanSession>;
  update<T>(
    id: string,
    decide: (session: PlanSession) => { readonly save?: PlanSession; readonly value: T },
  ): Promise<T>;
  deleteAttachments(id: string): Promise<void>;
}

/** What exists now, for checking and saving a proposal. */
export interface PlanningContext {
  readonly overview: RoadmapOverview;
  readonly tasks: readonly Task[];
}

export interface DecisionPorts {
  readonly records: PlanRecords;
  readContext(): PlanningContext;
  /** Saves an approved proposal in one transaction, and says what was saved and how to run it. */
  save(target: PlanTarget, proposal: WaitingProposal): string;
  now(): string;
}

/** Changes a record, and returns it as saved. */
export function changeRecord(
  records: PlanRecords,
  id: string,
  change: (session: PlanSession) => PlanSession,
): Promise<PlanSession> {
  return records.update(id, (session) => {
    const changed = change(session);
    return { save: changed, value: changed };
  });
}

export type Decision = { readonly session: PlanSession; readonly message: string };

/**
 * FR-PLAN-013, FR-PLAN-020: saves the waiting proposal, checked again against what exists now, then closes the
 * session. When the check or the save fails, nothing is saved and the session stays open.
 */
export async function approveProposal(ports: DecisionPorts, id: string): Promise<Decision> {
  let saved: string | undefined;
  try {
    // Checked and saved under the record's lock, so two approvals at once save it only once (FR-PLAN-013).
    const decided = await ports.records.update<Decision>(id, (session) => {
      if (session.status !== "open") throw new UsageError(`Planning session ${id} is already ${session.status}.`);
      if (session.proposal === null) throw new UsageError("No proposal is waiting to be approved.");
      const context = ports.readContext();
      const problems = checkProposal(session.proposal, { ...context, target: session.target });
      if (problems.length > 0) {
        throw new UsageError(`The proposal can't be saved as it is now: ${problems.join(" ")} Ask the PM to fix it.`);
      }
      saved = ports.save(session.target, session.proposal);
      const closed: PlanSession = {
        ...session,
        status: "approved",
        holder: null,
        outcome: saved,
        updatedAt: ports.now(),
      };
      return { save: closed, value: { session: closed, message: saved } };
    });
    await ports.records.deleteAttachments(id);
    return decided;
  } catch (error) {
    if (saved === undefined) throw error;
    // The plan is in the task database but the record still says it's waiting, so nothing may save it twice.
    throw new UsageError(
      `${saved}, but planning session ${id} couldn't be marked approved, so don't approve it again. Cancel the session.`,
      { cause: error },
    );
  }
}

/** FR-PLAN-032: takes the session for `holder`, or says where it's held. */
export function takeSessionHold(
  ports: Pick<DecisionPorts, "records" | "now">,
  id: string,
  holder: Holder,
  isRunning: (pid: number) => boolean,
): Promise<PlanSession | string> {
  return ports.records.update<PlanSession | string>(id, (current) => {
    const held = takeHold(current, holder, isRunning, ports.now());
    return typeof held === "string" ? { value: held } : { save: held, value: held };
  });
}

/** FR-PLAN-032: lets go of the session, unless another process holds it now. */
export function releaseSessionHold(
  ports: Pick<DecisionPorts, "records" | "now">,
  id: string,
  holder: Holder,
): Promise<void> {
  return ports.records.update(id, (current) => ({ save: releaseHold(current, holder, ports.now()), value: undefined }));
}

/** Who is acting, to check a session's hold (FR-PLAN-032). */
export interface Actor {
  readonly pid: number;
  isRunning(pid: number): boolean;
}

/**
 * FR-PLAN-014: closes the session with nothing saved. Claude's own transcript is left alone. Ending a session
 * another live place drives is driving it, so it's refused, unless a proposal is waiting for an answer (FR-PLAN-032).
 */
export async function cancelSession(
  ports: Pick<DecisionPorts, "records" | "now">,
  id: string,
  by: Actor,
): Promise<Decision> {
  const message = "Cancelled. Nothing was saved.";
  const closed = await changeRecord(ports.records, id, (current) => {
    if (current.status !== "open") throw new UsageError(`Planning session ${id} is already ${current.status}.`);
    const holder = current.holder;
    if (holder !== null && holder.pid !== by.pid && current.proposal === null && by.isRunning(holder.pid)) {
      throw new UsageError(`Planning session ${id} is open in ${placeName(holder.place)}. Cancel it there.`);
    }
    return {
      ...current,
      status: "cancelled",
      holder: null,
      proposal: null,
      pendingFirstMessage: null,
      unansweredMessage: null,
      outcome: message,
      updatedAt: ports.now(),
    };
  });
  await ports.records.deleteAttachments(id);
  return { session: closed, message };
}

/** One PM turn's request: the message to send, and whether the Claude session has to be started first. */
export interface PmCall {
  readonly session: PlanSession;
  readonly message: string;
  readonly isFirst: boolean;
}

export interface TurnPorts {
  readonly records: PlanRecords;
  /** Runs the turn, and returns the PM's text for it. Throws AgentSessionError at a usage limit. */
  callPm(call: PmCall): Promise<string>;
  /** Whether the Claude session already exists, so a turn continues it (FR-PLAN-005). */
  isStarted(session: PlanSession): Promise<boolean>;
  /** Whether the session's newest message has a reply in its transcript, from wherever it was driven. */
  isAnswered(session: PlanSession): Promise<boolean>;
  /** Whether the transcript already has the session's waiting message, so a Retry needn't repeat it (FR-PLAN-014). */
  isWritten(session: PlanSession): Promise<boolean>;
  now(): string;
}

/** The turns used in this run, against the limit (FR-PLAN-015). */
export interface TurnCount {
  used: number;
  readonly limit: number;
}

export function newTurnCount(limit: number = PLAN_LIMITS.maxTurns): TurnCount {
  return { used: 0, limit };
}

export interface TurnResult {
  readonly reply: string;
  readonly session: PlanSession;
}

function isUsableReply(text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== "" && trimmed.length <= PLAN_LIMITS.maxReplyChars;
}

/**
 * FR-PLAN-005, FR-PLAN-008, FR-PLAN-010, FR-PLAN-015: sends a message, and returns the PM's reply with the record as
 * the turn left it, with its suggestions, sources and any new proposal. A turn with no reply and no new proposal
 * gets one nudge; a second one in a row ends the run, keeping the session.
 */
export async function runTurn(ports: TurnPorts, id: string, message: string, count: TurnCount): Promise<TurnResult> {
  let session = await changeRecord(ports.records, id, (current) => {
    // Approved or cancelled elsewhere meanwhile, such as from the GUI's Needs you (FR-PLAN-032).
    if (current.status !== "open") throw new SessionClosedError(id, current.status, current.outcome);
    // The first prompt is kept as `pendingFirstMessage`; a later message of the user's is kept until it's answered.
    // cclinic's own notes, such as Retry's request, keep the user's message that's still waiting (FR-PLAN-014).
    const unansweredMessage = message.startsWith(FIRST_MESSAGE_MARKER)
      ? null
      : isPlanningNote(message)
        ? current.unansweredMessage
        : message;
    return {
      ...current,
      // FR-PLAN-031: a proposal that no longer fits can't be approved once the PM is told to fix it.
      proposal: message.startsWith(PROPOSAL_NO_LONGER_FITS) ? null : current.proposal,
      suggestions: [],
      sources: [],
      isAwaitingReply: true,
      unansweredMessage,
      // A note re-asks a waiting message's turn, so it keeps that turn's start, even an unknown one from an older
      // record; anything else starts a new turn (FR-PLAN-014, DEF-28).
      turnStartedAt:
        isPlanningNote(message) && current.unansweredMessage !== null ? current.turnStartedAt : ports.now(),
      updatedAt: ports.now(),
    };
  });
  const startedAt = session.updatedAt;
  let next = message;
  for (let empty = 0; ;) {
    if (count.used >= count.limit) {
      throw new AgentSessionError(
        `Planning stopped at the limit of ${count.limit} PM turns. Nothing was saved to the roadmap.`,
      );
    }
    const isFirst = !(await ports.isStarted(session));
    // Only the first prompt may start the Claude session: any other message would reach a PM with no instructions.
    if (isFirst && !next.startsWith(FIRST_MESSAGE_MARKER)) {
      throw new UsageError(lostConversation(id));
    }
    count.used += 1;
    const reply = await ports.callPm({ session, message: next, isFirst });
    session = (await ports.records.read(id)) ?? session;
    const hasNewProposal = session.proposal !== null && session.proposal.proposedAt >= startedAt;
    if (isUsableReply(reply) || hasNewProposal) {
      const done = await changeRecord(ports.records, id, (current) => ({
        ...current,
        isAwaitingReply: false,
        // The Claude session has them now (FR-PLAN-030).
        pendingFirstMessage: null,
        unansweredMessage: null,
        turnStartedAt: null,
        updatedAt: ports.now(),
      }));
      return { reply: reply.trim().slice(0, PLAN_LIMITS.maxReplyChars), session: done };
    }
    empty += 1;
    if (empty >= PLAN_LIMITS.emptyRepliesInARow) {
      throw new AgentSessionError("The PM stopped replying. Nothing was saved to the roadmap.");
    }
    next =
      reply.trim() === "" ? NUDGE_MESSAGE : `${NUDGE_MESSAGE} Keep it under ${PLAN_LIMITS.maxReplyChars} characters.`;
  }
}

/** What the first prompt needs besides the user's message (FR-PLAN-006). */
export interface FirstPromptContext {
  readonly skill: string;
  readonly overview: RoadmapOverview;
  readonly overviewPath: string;
  readonly specsListPath: string;
}

/**
 * FR-PLAN-014, FR-PLAN-031: what a resumed session sends first, if anything: its first prompt again when its first
 * turn never reached Claude; the problems with a waiting proposal that no longer fits, which is taken away so it
 * can't be approved; or a request to answer a message left without a reply. A session whose Claude conversation is
 * lost can't continue.
 */
export async function resumeMessage(
  ports: Pick<DecisionPorts, "records" | "readContext" | "now"> &
    Pick<TurnPorts, "isStarted" | "isAnswered" | "isWritten">,
  id: string,
  first: FirstPromptContext,
): Promise<string | undefined> {
  const session = await ports.records.read(id);
  if (session === undefined) throw new UsageError(`There's no planning session ${id}.`);
  if (!(await ports.isStarted(session))) {
    if (session.pendingFirstMessage === null) throw new UsageError(lostConversation(id));
    return buildFirstTurnPrompt({ ...first, planId: id, target: session.target, message: session.pendingFirstMessage });
  }
  if (session.proposal !== null) {
    const problems = checkProposal(session.proposal, { ...ports.readContext(), target: session.target });
    // Taken away by the turn that sends this, so a resume dropped before it's sent loses nothing.
    if (problems.length > 0)
      return `${PROPOSAL_NO_LONGER_FITS}\n${problems.map((problem) => `- ${problem}`).join("\n")}`;
  }
  if (!session.isAwaitingReply) return undefined;
  // Answered elsewhere since, such as in Claude Code after this turn was stopped: nothing is waiting any more.
  if (await ports.isAnswered(session)) {
    await changeRecord(ports.records, id, (current) => ({
      ...current,
      isAwaitingReply: false,
      unansweredMessage: null,
      turnStartedAt: null,
      updatedAt: ports.now(),
    }));
    return undefined;
  }
  return answerLastMessage((await ports.isWritten(session)) ? null : session.unansweredMessage);
}

/** The edge case "Claude transcript deleted or moved": named, and never continued. */
export function lostConversation(id: string): string {
  return `Planning session ${id}'s Claude conversation can't be found, so it can't continue. Cancel it, and plan again.`;
}
