/** The `cclinic plan` command: a chat with the PM agent in its own Claude session (spec: roadmap-planning). */
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { projectPaths } from "../adapters/storage/document-store.js";
import { relativeDocsPath } from "../adapters/storage/skill-installer.js";
import type { PlanStore } from "../adapters/storage/plan-store.js";
import { claudeTranscriptPath } from "../adapters/llm/agent-process.js";
import { isProcessRunning } from "../adapters/storage/file-lock.js";
import {
  approveProposal,
  cancelSession,
  changeRecord,
  lostConversation,
  newTurnCount,
  releaseSessionHold,
  resumeMessage,
  runTurn,
  takeSessionHold,
  type TurnCount,
  type TurnPorts,
} from "../application/planning-session.js";
import { AGENT_SKILLS } from "../core/agent-skills.js";
import { AgentSessionError, CancelledError, SessionClosedError, UsageError } from "../core/errors.js";
import type { Effort, ModelChoice } from "../core/models.js";
import {
  activitiesOfEvent,
  attachmentCountProblem,
  attachmentProblem,
  buildFirstTurnPrompt,
  buildUserMessage,
  isWaitingMessageWritten,
  messageProblem,
  notesOf,
  missingTarget,
  newPlanSession,
  parseChatInput,
  placeName,
  PROPOSE_NOW_MESSAGE,
  renderWaitingProposal,
  shownUserMessage,
  resumeCommands,
  type Holder,
  type PlanSession,
  type PlanTarget,
  type StoredAttachment,
} from "../core/planning.js";
import type { RoadmapOverview } from "../core/tasks.js";
import { requireClaudeCli, requireDocuments } from "./agent-checks.js";
import type { CommandContext } from "./command-context.js";
import { resolveModelAndEffort } from "./generate-command.js";
import { askText, askToConfirm, chooseFrom, isInteractive } from "./menus.js";
import {
  decisionPorts,
  documentPaths,
  planStoreFor,
  readPlanningContext,
  readPlanTranscript,
  turnPorts,
} from "./planning-ports.js";
import { projectFolder } from "./tasks-command.js";

export interface PlanOptions {
  readonly dir?: string;
  readonly roadmap?: number;
  readonly task?: boolean;
  readonly attach?: readonly string[];
  readonly resume?: string | true;
  readonly model?: string | true;
  readonly effort?: string | true;
  readonly timeoutMinutes: number;
}

const PM_SKILL = "product-engineer";
/** This process, as the one acting on a session it holds (FR-PLAN-032). */
const ME = { pid: process.pid, isRunning: isProcessRunning };
/** FR-PLAN-024: a line ending in a backslash continues on the next one. */
const CONTINUATION = "\\";

function roadmapChoices(overview: RoadmapOverview) {
  return overview.roadmaps.map((roadmap) => ({
    value: roadmap.id,
    name: `Roadmap #${roadmap.id}: ${roadmap.title} [${roadmap.status}]`,
  }));
}

/** FR-PLAN-004, FR-PLAN-017 */
async function chooseTarget(options: PlanOptions, overview: RoadmapOverview): Promise<PlanTarget> {
  const roadmapId = options.roadmap;
  if (roadmapId !== undefined && !overview.roadmaps.some((roadmap) => roadmap.id === roadmapId)) {
    throw new UsageError(`Roadmap ${roadmapId} doesn't exist. See your roadmaps with: cclinic tasks roadmaps`);
  }
  if (options.task === true) {
    if (roadmapId !== undefined) return { kind: "task", roadmapId };
    const where = await chooseFrom<number | null>("Where does the task go?", [
      { value: null, name: "Standalone, in no roadmap" },
      ...roadmapChoices(overview),
    ]);
    return { kind: "task", roadmapId: where };
  }
  if (roadmapId !== undefined) return { kind: "extend-roadmap", roadmapId };
  if (overview.roadmaps.length === 0) {
    const choice = await chooseFrom<string>("What should the PM plan?", [
      { value: "new", name: "A new roadmap" },
      { value: "task", name: "A single task" },
    ]);
    return choice === "task" ? chooseTarget({ ...options, task: true }, overview) : { kind: "new-roadmap" };
  }
  const choice = await chooseFrom<string>("What should the PM plan?", [
    { value: "new", name: "A new roadmap" },
    ...roadmapChoices(overview).map((item) => ({ value: String(item.value), name: `Extend ${item.name}` })),
    { value: "task", name: "A single task" },
  ]);
  if (choice === "new") return { kind: "new-roadmap" };
  if (choice === "task") return chooseTarget({ ...options, task: true }, overview);
  return { kind: "extend-roadmap", roadmapId: Number(choice) };
}

/** The checks `cclinic plan` makes before anything else: Claude Code and the documents (FR-PLAN-003). */
export async function checkPlanning(target: string, context: CommandContext): Promise<void> {
  await requireClaudeCli("cclinic plan", context);
  requireDocuments(projectPaths(target, undefined).out);
}

/** The PM's instructions, with the documents' folder filled in. */
export function pmSkill(target: string): string {
  return (AGENT_SKILLS.find((item) => item.name === PM_SKILL)?.body ?? "").replaceAll(
    "{{DOCS}}",
    relativeDocsPath(target, projectPaths(target, undefined).out),
  );
}

/** A file to attach, from the project folder, or why it can't be (FR-PLAN-022). */
async function checkedFile(target: string, given: string): Promise<{ file: string; name: string } | string> {
  const file = path.resolve(target, given);
  const name = path.basename(file);
  try {
    const info = await stat(file);
    if (!info.isFile()) return `${given} isn't a file.`;
    return attachmentProblem({ name, sizeBytes: info.size }) ?? { file, name };
  } catch {
    return `${given} can't be read.`;
  }
}

/** FR-PLAN-001: `--resume` stands alone, and every `--attach` file must be one that can be attached. */
async function checkOptions(target: string, options: PlanOptions): Promise<void> {
  const attach = options.attach ?? [];
  if (options.resume !== undefined && (options.roadmap !== undefined || options.task === true || attach.length > 0)) {
    throw new UsageError(
      "--resume continues a session as it was, so it can't be used with --roadmap, --task or --attach.",
    );
  }
  for (const given of attach) {
    const checked = await checkedFile(target, given);
    if (typeof checked === "string") throw new UsageError(`--attach: ${checked}`);
  }
  const countProblem = attachmentCountProblem(attach.length, 0);
  if (countProblem !== undefined) throw new UsageError(`--attach: ${countProblem}`);
}

/** FR-PLAN-024: one message, over several lines when each but the last ends in a backslash. */
async function readMessage(label: string): Promise<string> {
  const lines: string[] = [];
  for (let line = await askText(label); ; line = await askText("…")) {
    if (!line.endsWith(CONTINUATION)) {
      lines.push(line);
      return lines.join("\n");
    }
    lines.push(line.slice(0, -CONTINUATION.length).trimEnd());
  }
}

interface ChatState {
  readonly target: string;
  /** Set as soon as the session exists, so a stop at any point keeps it and says how to continue. */
  readonly onStarted: (state: ChatState) => void;
  readonly records: PlanStore;
  readonly turns: TurnPorts;
  readonly count: TurnCount;
  readonly context: CommandContext;
  session: PlanSession;
}

/** Why the files can't be attached to one message, or undefined when they can (FR-PLAN-022). */
async function filesProblem(
  target: string,
  given: readonly string[],
  alreadyInSession: number,
): Promise<string | undefined> {
  for (const item of given) {
    const checked = await checkedFile(target, item);
    if (typeof checked === "string") return checked;
  }
  return attachmentCountProblem(given.length, alreadyInSession);
}

/** Copies the message's files into the session, after checking them all (FR-PLAN-022, FR-PLAN-023). */
async function attachFiles(state: ChatState, given: readonly string[]): Promise<StoredAttachment[] | string> {
  const files: { file: string; name: string }[] = [];
  for (const item of given) {
    const checked = await checkedFile(state.target, item);
    if (typeof checked === "string") return checked;
    files.push(checked);
  }
  const countProblem = attachmentCountProblem(files.length, state.session.attachments.length);
  if (countProblem !== undefined) return countProblem;
  if (files.length === 0) return [];
  const stored = await state.records.copyAttachments(state.session.id, files);
  state.session = await changeRecord(state.records, state.session.id, (current) => ({
    ...current,
    attachments: [...current.attachments, ...stored],
    updatedAt: new Date().toISOString(),
  }));
  return stored;
}

/** FR-PLAN-008, FR-PLAN-011: the PM's reply, its suggestions and sources, and a new proposal. */
function showReply(state: ChatState, reply: string, previousProposal: string | null): void {
  const { session, context } = state;
  const lines = [`\nPM › ${reply}`];
  if (session.suggestions.length > 0) {
    lines.push("", ...session.suggestions.map((suggestion, index) => `  ${index + 1}. ${suggestion}`));
  }
  if (session.sources.length > 0) {
    lines.push("", "Sources:", ...session.sources.map((source) => `  ${source.title} (${source.url})`));
  }
  if (session.proposal !== null && session.proposal.proposedAt !== previousProposal) {
    lines.push("", renderWaitingProposal(session.proposal, session.target));
  }
  if (session.proposal !== null) lines.push("", "/approve to save it, /cancel to drop it, or reply to change it.");
  context.reporter.notice(`${lines.join("\n")}\n`);
}

async function sendTurn(state: ChatState, message: string): Promise<void> {
  const previous = state.session.proposal?.proposedAt ?? null;
  const { reply, session } = await runTurn(state.turns, state.session.id, message, state.count);
  state.session = session;
  showReply(state, reply, previous);
}

/**
 * FR-PLAN-031: the conversation so far, from the Claude session's transcript. cclinic's own notes are left out, except
 * for a message one repeats, and a message still waiting for its reply is shown even when Claude Code hadn't written it yet (FR-PLAN-014).
 */
async function showHistory(state: ChatState): Promise<void> {
  const entries = await readPlanTranscript(state.session);
  const said = entries.flatMap((entry) => {
    // A Retry request repeats the user's message only when Claude hadn't written it, so it's shown as theirs.
    const shown = entry.kind === "user" ? shownUserMessage(entry.text) : null;
    if (shown !== null) return [{ who: "You", text: shown }];
    if (entry.kind === "assistant") return [{ who: "PM", text: entry.text }];
    return [];
  });
  const waiting = state.session.isAwaitingReply ? state.session.unansweredMessage : null;
  if (waiting !== null && !isWaitingMessageWritten(entries, state.session.turnStartedAt, waiting))
    said.push({ who: "You", text: waiting });
  if (said.length > 0)
    state.context.reporter.notice(`${said.map((item) => `${item.who} › ${item.text}`).join("\n\n")}\n`);
}

/** FR-PLAN-013: saves the waiting proposal, or says none is waiting. True when it was saved. */
async function approve(state: ChatState): Promise<boolean> {
  const current = await state.records.read(state.session.id);
  if (current !== undefined && current.status !== "open") {
    throw new SessionClosedError(current.id, current.status, current.outcome);
  }
  const proposal = state.session.proposal;
  if (proposal === null) {
    state.context.reporter.notice("No proposal is waiting yet.");
    return false;
  }
  try {
    state.context.reporter.result(
      (await approveProposal(decisionPorts(state.target, state.records), state.session.id)).message,
    );
    return true;
  } catch (error) {
    // The proposal is shown again so the planning isn't lost; the session stays open (FR-PLAN-013).
    state.context.reporter.notice(
      `Couldn't save the approved plan, so nothing was saved. The plan was:\n\n${renderWaitingProposal(proposal, state.session.target)}\n`,
    );
    throw error;
  }
}

/**
 * The chat until the user approves or cancels, here or elsewhere (FR-PLAN-008, FR-PLAN-011 to FR-PLAN-014,
 * FR-PLAN-024, FR-PLAN-032).
 */
async function chat(state: ChatState): Promise<void> {
  try {
    await chatTurns(state);
  } catch (error) {
    if (!(error instanceof SessionClosedError)) throw error;
    state.context.reporter.result(error.message);
  }
}

async function chatTurns(state: ChatState): Promise<void> {
  for (;;) {
    const typed = parseChatInput(await readMessage("You ›"));
    if (typed.kind === "cancel") {
      const cancelled = await cancelSession(decisionPorts(state.target, state.records), state.session.id, ME);
      state.context.reporter.result(cancelled.message);
      return;
    }
    if (typed.kind === "approve") {
      if (await approve(state)) return;
      continue;
    }
    if (typed.kind === "propose") {
      await sendTurn(state, PROPOSE_NOW_MESSAGE);
      continue;
    }
    // A number with no suggestion behind it is sent as the number the user typed.
    const message =
      typed.kind === "message"
        ? typed
        : { text: state.session.suggestions[typed.index - 1] ?? String(typed.index), files: [] as readonly string[] };
    const problem = messageProblem(message.text, message.files.length);
    if (problem !== undefined) {
      state.context.reporter.notice(problem);
      continue;
    }
    const stored = await attachFiles(state, message.files);
    if (typeof stored === "string") {
      state.context.reporter.notice(`${stored} The message wasn't sent.`);
      continue;
    }
    await sendTurn(state, buildUserMessage(message.text, notesOf(stored)));
  }
}

function showActivity(context: CommandContext) {
  return (event: unknown): void => {
    for (const activity of activitiesOfEvent(event)) context.reporter.info(`  · ${activity}`);
  };
}

/** FR-PLAN-021: the user's first message, then the session and its first turn. */
async function startSession(
  base: Omit<ChatState, "session" | "turns">,
  settings: {
    planTarget: PlanTarget;
    holder: Holder;
    attach: readonly string[];
    makeTurns: (records: PlanStore) => TurnPorts;
  },
): Promise<ChatState> {
  const { target, context } = base;
  context.reporter.notice(
    settings.planTarget.kind === "task"
      ? "What's the change? (attach files with @path)"
      : "What do you want to build? (attach files with @path)",
  );
  let first: { text: string; files: readonly string[] };
  for (;;) {
    const typed = parseChatInput(await readMessage("You ›"));
    if (typed.kind === "cancel") throw new CancelledError("Cancelled. Nothing was saved.");
    if (typed.kind === "approve" || typed.kind === "propose") {
      context.reporter.notice("Write what you want first. Nothing has been planned yet.");
      continue;
    }
    first =
      typed.kind === "message"
        ? { text: typed.text, files: [...settings.attach, ...typed.files] }
        : { text: String(typed.index), files: settings.attach };
    const problem = messageProblem(first.text, first.files.length) ?? (await filesProblem(target, first.files, 0));
    if (problem === undefined) break;
    context.reporter.notice(`${problem} The message wasn't sent.`);
    // --attach files are checked before anything starts, so only the typed message is asked for again.
  }
  const claudeSessionId = randomUUID();
  const session = await base.records.create((id) =>
    newPlanSession({
      id,
      target: settings.planTarget,
      summary: first.text,
      holder: settings.holder,
      claudeSessionId,
      transcriptPath: claudeTranscriptPath(context.environment, target, claudeSessionId),
      now: new Date().toISOString(),
    }),
  );
  context.reporter.notice(
    `Planning session ${session.id}. Continue it later with: ${resumeCommands(session).join("  or  ")}`,
  );
  const state: ChatState = { ...base, session, turns: settings.makeTurns(base.records) };
  base.onStarted(state);
  const stored = await attachFiles(state, first.files);
  if (typeof stored === "string") throw new UsageError(stored);
  const message = buildUserMessage(first.text, notesOf(stored));
  // Kept until the Claude session exists, so a stop before then can still start it (FR-PLAN-014).
  state.session = await changeRecord(base.records, session.id, (current) => ({
    ...current,
    pendingFirstMessage: message,
  }));
  await sendTurn(
    state,
    buildFirstTurnPrompt({ ...firstPromptContext(target), planId: session.id, target: settings.planTarget, message }),
  );
  return state;
}

/** FR-PLAN-031: the open session to continue, by ID or from a list. */
async function chooseSession(records: PlanStore, given: string | true): Promise<PlanSession> {
  const open = (await records.list()).sessions
    .filter((session) => session.status === "open")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (given !== true) {
    const found = open.find((session) => session.id === given);
    if (found === undefined)
      throw new UsageError(`There's no open planning session ${given}. See them with: cclinic plan --resume`);
    return found;
  }
  if (open.length === 0)
    throw new UsageError("There's no open planning session to resume. Start one with: cclinic plan");
  return chooseFrom(
    "Which planning session?",
    open.map((session) => ({
      value: session,
      name: `${session.id}  ${targetText(session.target)}  "${session.summary}"  last: ${session.lastPlace === null ? "-" : placeName(session.lastPlace)}  ${session.updatedAt}`,
    })),
  );
}

function targetText(target: PlanTarget): string {
  if (target.kind === "new-roadmap") return "new roadmap";
  if (target.kind === "extend-roadmap") return `extend #${target.roadmapId}`;
  return target.roadmapId === null ? "standalone task" : `task in #${target.roadmapId}`;
}

/** The session to continue, or undefined when the user cancelled one whose conversation is lost. */
async function resumeSession(
  base: Omit<ChatState, "session" | "turns">,
  given: string | true,
  holder: Holder,
  makeTurns: (records: PlanStore) => TurnPorts,
): Promise<ChatState | undefined> {
  const chosen = await chooseSession(base.records, given);
  const missing = missingTarget(chosen.target, readPlanningContext(base.target).overview);
  if (missing !== undefined) throw new UsageError(`${missing} Cancel planning session ${chosen.id}, or plan again.`);
  const turns = makeTurns(base.records);
  if (!(await turns.isStarted(chosen)) && chosen.pendingFirstMessage === null) {
    // The edge case "Claude transcript deleted or moved": named, and offered for cancelling, never continued.
    const lost = lostConversation(chosen.id);
    if (!(await askToConfirm(`${lost} Cancel it now, saving nothing?`))) throw new UsageError(lost);
    base.context.reporter.result(
      (await cancelSession(decisionPorts(base.target, base.records), chosen.id, ME)).message,
    );
    return undefined;
  }
  const session = await takeSessionHold(decisionPorts(base.target, base.records), chosen.id, holder, isProcessRunning);
  if (typeof session === "string") throw new UsageError(session);
  const state: ChatState = { ...base, session, turns };
  base.onStarted(state);
  // Checked first, so a message answered elsewhere since isn't shown as still waiting (FR-PLAN-014).
  const first = await resumeMessage(
    {
      ...decisionPorts(base.target, base.records),
      isStarted: (current) => turns.isStarted(current),
      isAnswered: (current) => turns.isAnswered(current),
      isWritten: (current) => turns.isWritten(current),
    },
    session.id,
    firstPromptContext(base.target),
  );
  state.session = (await base.records.read(session.id)) ?? session;
  await showHistory(state);
  base.context.reporter.notice(
    `Continuing ${session.id}. Continue it elsewhere with: ${resumeCommands(session).join("  or  ")}`,
  );
  if (first !== undefined) await sendTurn(state, first);
  else if (state.session.proposal !== null) {
    base.context.reporter.notice(
      `${renderWaitingProposal(state.session.proposal, state.session.target)}\n\n/approve to save it, /cancel to drop it, or reply to change it.\n`,
    );
  }
  return state;
}

/** FR-PLAN-006: what every first prompt carries besides the user's message. */
function firstPromptContext(target: string) {
  return { skill: pmSkill(target), overview: readPlanningContext(target).overview, ...documentPaths(target) };
}

export async function runPlanCommand(options: PlanOptions, context: CommandContext): Promise<void> {
  const target = await projectFolder(options.dir);
  await checkOptions(target, options);
  await checkPlanning(target, context);
  if (!isInteractive()) {
    throw new UsageError("cclinic plan is a chat with the PM, so it needs an interactive terminal.");
  }
  const { model, effort }: { model: ModelChoice; effort: Effort } = await resolveModelAndEffort(
    { model: options.model, effort: options.effort },
    context,
  );
  const records = planStoreFor(target);
  const holder: Holder = { place: "terminal", pid: process.pid };
  const makeTurns = (store: PlanStore) =>
    turnPorts(
      { target, model, effort, timeoutMinutes: options.timeoutMinutes, onEvent: showActivity(context) },
      store,
      context,
    );
  let state: ChatState | undefined;
  const base = {
    target,
    records,
    count: newTurnCount(),
    context,
    onStarted: (started: ChatState) => {
      state = started;
    },
  };
  try {
    const chatting =
      options.resume === undefined
        ? await startSession(base, {
            planTarget: await chooseTarget(options, readPlanningContext(target).overview),
            holder,
            attach: options.attach ?? [],
            makeTurns,
          })
        : await resumeSession(base, options.resume, holder, makeTurns);
    if (chatting !== undefined) await chat(chatting);
  } catch (error) {
    const session = state?.session;
    if (session === undefined || !(error instanceof CancelledError || error instanceof AgentSessionError)) throw error;
    // FR-PLAN-014, FR-PLAN-015: a stopped session is kept, and the user is told how to continue it.
    const resume = `Continue later with: ${resumeCommands(session).join("  or  ")}`;
    if (error.message.includes(resume)) throw error;
    if (error instanceof CancelledError) {
      context.reporter.notice(`Stopped. Nothing was saved to the roadmap. ${resume}`);
      throw error;
    }
    throw new AgentSessionError(`${error.message} ${resume}`, { cause: error });
  } finally {
    const id = state?.session.id;
    if (id !== undefined) {
      // FR-PLAN-032: the session is let go, so it can be continued anywhere. Letting go never hides the stop's own
      // error; a hold left by an ended process is taken over later.
      await releaseSessionHold(decisionPorts(target, records), id, holder).catch(() => undefined);
    }
  }
}
