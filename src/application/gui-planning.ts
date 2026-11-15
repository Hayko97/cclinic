/**
 * Plan with the PM from the GUI: a chat in the side panel, on the same planning sessions as `luseen plan` and
 * Claude Code (spec: roadmap-planning FR-PLAN-033 to FR-PLAN-043, gui FR-GUI-023 to FR-GUI-026). One session is
 * open in a GUI at a time; its conversation is read from the session's Claude transcript.
 */
import { PLAN_ATTACHMENTS_FOLDER, PLAN_LIMITS, PLANS_FOLDER } from "../core/constants/agents.js";
import { PLAN_VIEW_POLL_MS, UPLOAD_ORPHAN_MS } from "../core/constants/gui.js";
import { AgentSessionError, CancelledError, SessionClosedError, UsageError } from "../core/errors.js";
import type { TranscriptLines, TranscriptLocation, TranscriptPosition } from "../core/canvas.js";
import { parseTranscriptLine } from "../core/canvas.js";
import {
  IMAGE_CONTENT_TYPES,
  UPLOAD_ID_BYTES,
  UPLOAD_ID_PREFIX,
  toolLinksOf,
  toPlanChatItems,
  type PlanChatItem,
  type PlanMessage,
  type PlanOptionsRequest,
  type PlanRequest,
  type SendEvent,
} from "../core/gui.js";
import {
  attachmentCountProblem,
  attachmentKind,
  attachmentProblem,
  buildFirstTurnPrompt,
  buildUserMessage,
  dependencyLabel,
  messageProblem,
  missingTarget,
  newPlanSession,
  notesOf,
  PROPOSE_NOW_MESSAGE,
  resumeCommands,
  type AttachmentKind,
  type HolderPlace,
  type PlanSession,
  type PlanTarget,
  type StoredAttachment,
  type WaitingProposal,
} from "../core/planning.js";
import { redact } from "../core/redaction.js";
import {
  approveProposal,
  cancelSession,
  changeRecord,
  releaseSessionHold,
  lostConversation,
  newTurnCount,
  resumeMessage,
  runTurn,
  takeSessionHold,
  type DecisionPorts,
  type FirstPromptContext,
  type PlanRecords,
  type TurnCount,
  type TurnPorts,
} from "./planning-session.js";

/** Makes a turn's ports, its PM call stopped by `signal`. */
export type TurnMaker = (signal: AbortSignal) => TurnPorts;

export interface PlannerPorts {
  /** Makes `luseen plan`'s checks and resolves the model and effort (FR-GUI-023). Throws what the CLI refuses. */
  prepare(options: PlanOptionsRequest): Promise<TurnMaker>;
  readonly records: PlanRecords & {
    copyAttachments(id: string, files: readonly { file: string; name: string }[]): Promise<StoredAttachment[]>;
  };
  readonly decisions: DecisionPorts;
  /** What the first turn's prompt has besides the message and what exists: the PM's instructions (FR-PLAN-006). */
  pmContext(): Omit<FirstPromptContext, "overview">;
  newClaudeSession(): { readonly claudeSessionId: string; readonly transcriptPath: string | null };
  isRunning(pid: number): boolean;
  /** This GUI's process, as the holder of the session it drives. */
  readonly pid: number;
  now(): string;
  /** Whether a session's Claude transcript is still where it was recorded. */
  transcriptExists(transcriptPath: string): boolean;
  /** Whether the session's transcript shows a reply after its newest message (FR-PLAN-014, DEF-18). */
  isAnswered(session: PlanSession): Promise<boolean>;
  /** Whether the session's transcript already has its waiting message (FR-PLAN-014). */
  isWritten(session: PlanSession): Promise<boolean>;
  /** FR-PLAN-037: the bytes of a file in a session's attachments folder, by its stored name. */
  readAttachment(planId: string, file: string): Promise<Uint8Array>;
  /** Uploaded files, kept until their message is sent (FR-PLAN-033). */
  readonly uploads: {
    save(bytes: Uint8Array): Promise<string>;
    remove(file: string): Promise<void>;
    /** Removes every waiting file, and where they wait, when the GUI stops. */
    clear(): Promise<void>;
  };
  readonly transcripts: {
    locate(transcriptPath: string, claudeSessionId: string): Promise<TranscriptLocation>;
    read(file: string, from?: TranscriptPosition): Promise<TranscriptLines>;
  };
  every(ms: number, run: () => Promise<void>): () => void;
}

export interface SessionItem {
  readonly id: string;
  readonly target: PlanTarget;
  readonly summary: string;
  /** Where a live process holds it now, if anywhere. */
  readonly heldBy: HolderPlace | null;
  readonly isHeldHere: boolean;
  readonly lastPlace: HolderPlace | null;
  readonly hasProposal: boolean;
  readonly updatedAt: string;
}

export type ProposalView =
  | {
      readonly kind: "roadmap";
      readonly roadmap: { readonly title: string; readonly goal: string } | null;
      readonly extending: number | null;
      readonly milestones: readonly {
        readonly title: string;
        readonly goal: string;
        readonly tasks: readonly {
          readonly key: string;
          readonly title: string;
          readonly spec: string | null;
          readonly dependsOn: readonly string[];
        }[];
      }[];
      readonly openQuestions: readonly string[];
    }
  | {
      readonly kind: "task";
      readonly task: {
        readonly title: string;
        readonly description: string;
        readonly spec: string | null;
        readonly dependsOn: readonly string[];
      };
      readonly milestoneId: number | null;
      readonly roadmapId: number | null;
      readonly openQuestions: readonly string[];
    };

export interface OpenSessionView extends SessionItem {
  readonly status: PlanSession["status"];
  readonly suggestions: readonly string[];
  readonly sources: PlanSession["sources"];
  readonly proposal: ProposalView | null;
  readonly attachments: readonly { readonly name: string; readonly kind: AttachmentKind; readonly file: string }[];
  readonly resumeCommands: readonly string[];
  readonly outcome: string | null;
  readonly isAwaitingReply: boolean;
  /** The user's message a stopped turn left unanswered, as the conversation shows it (FR-PLAN-038). */
  readonly unanswered: PlanChatItem | null;
  /** Why it can't continue here, such as its Claude conversation being gone; it can only be cancelled. */
  readonly unavailable: string | null;
}

/** FR-PLAN-041: a problem shown in the conversation, with the one action that helps. */
export interface PlanNotice {
  readonly message: string;
  readonly action: "retry" | "resume" | null;
}

export interface PlanPanelView {
  readonly open: OpenSessionView | null;
  readonly sessions: readonly SessionItem[];
  /** FR-PLAN-038: the turn the GUI is running, if any. */
  readonly turn: { readonly startedAt: string } | null;
  readonly notice: PlanNotice | null;
  /**
   * Counts up with each view made, so a page keeps the newest it has seen when an action's reply arrives after a
   * later update from the stream (FR-PLAN-038).
   */
  readonly version: number;
}

export interface UploadView {
  readonly id: string;
  readonly name: string;
  readonly kind: AttachmentKind;
  readonly sizeBytes: number;
}

export interface Planner {
  view(): Promise<PlanPanelView>;
  /** Called after each change the GUI makes; changes made elsewhere are found by polling. */
  subscribe(listener: () => void): () => void;
  start(request: PlanRequest): Promise<void>;
  open(planId: string, options: PlanOptionsRequest): Promise<void>;
  /** Lets go of the open session and shows the start state. */
  newSession(): Promise<void>;
  send(message: PlanMessage): Promise<void>;
  proposeNow(): Promise<void>;
  stop(): void;
  retry(): Promise<void>;
  approve(planId: string): Promise<string>;
  cancel(planId: string): Promise<string>;
  /** `pageId` is the page that holds it, so a page counts only its own files (FR-PLAN-022). */
  upload(name: string, contentBase64: string, pageId: string): Promise<UploadView>;
  removeUpload(id: string): Promise<void>;
  /**
   * FR-PLAN-037: an image recorded in a session's attachments, by its stored file name, with its type; undefined
   * for any other name, a document, or another session's file.
   */
  attachment(
    planId: string,
    file: string,
  ): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | undefined>;
  /** The session open in the panel, if any. */
  openId(): string | null;
  /** FR-PLAN-042: the panel and its conversation as they change, until the returned function is called. */
  stream(send: SendEvent): () => void;
  /** Stops a turn going and lets go of the session, saving nothing, when the GUI stops (FR-GUI-025). */
  shutdown(): Promise<void>;
}

/** An upload's ID, as `UPLOAD_ID_SOURCE` allows: 16 hex digits. */
function randomUploadId(): string {
  return `${UPLOAD_ID_PREFIX}${Buffer.from(crypto.getRandomValues(new Uint8Array(UPLOAD_ID_BYTES))).toString("hex")}`;
}

function proposalView(proposal: WaitingProposal, target: PlanTarget): ProposalView {
  if (proposal.kind === "task") {
    const { task, milestoneId, openQuestions } = proposal.proposal;
    return {
      kind: "task",
      task: { ...task, dependsOn: task.dependsOn.map(dependencyLabel) },
      milestoneId,
      roadmapId: target.kind === "task" ? target.roadmapId : null,
      openQuestions,
    };
  }
  const { roadmap, milestones, openQuestions } = proposal.proposal;
  return {
    kind: "roadmap",
    roadmap: target.kind === "extend-roadmap" ? null : roadmap,
    extending: target.kind === "extend-roadmap" ? target.roadmapId : null,
    milestones: milestones.map((milestone) => ({
      title: milestone.title,
      goal: milestone.goal,
      tasks: milestone.tasks.map((task) => ({
        key: task.key,
        title: task.title,
        spec: task.spec,
        dependsOn: task.dependsOn.map(dependencyLabel),
      })),
    })),
    openQuestions,
  };
}

/** FR-GUI-011: everything the panel shows is redacted, as the rest of the GUI is. */
function redacted<T>(value: T): T {
  return JSON.parse(redact(JSON.stringify(value)).text) as T;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The user's message a stopped turn left unanswered, as theirs; never one of luseen's own notes. Its time is when the
 * turn started, so the panel can tell whether the transcript has it yet (FR-PLAN-038).
 */
function unansweredItem(session: PlanSession): PlanChatItem | null {
  if (!session.isAwaitingReply || session.unansweredMessage === null) return null;
  const [item] = toPlanChatItems([
    { kind: "user", text: session.unansweredMessage, tool: null, at: session.turnStartedAt },
  ]);
  return item?.kind === "user" ? item : null;
}

export function createPlanner(ports: PlannerPorts): Planner {
  const planner: Planner = createPlannerCore(ports);
  return { ...planner, stream: (send) => streamPlan(planner, ports, send) };
}

function createPlannerCore(ports: PlannerPorts): Planner {
  const listeners = new Set<() => void>();
  const uploads = new Map<
    string,
    UploadView & { readonly file: string; readonly pageId: string; readonly uploadedAt: number }
  >();
  let version = 0;
  let openId: string | null = null;
  let options: PlanOptionsRequest = {};
  let makeTurns: TurnMaker | null = null;
  let count: TurnCount = newTurnCount();
  let turn: { readonly controller: AbortController; readonly startedAt: string; readonly done: Promise<void> } | null =
    null;
  let notice: PlanNotice | null = null;

  const changed = (): void => {
    for (const listener of listeners) listener();
  };

  const itemOf = (session: PlanSession): SessionItem => {
    const holder = session.holder;
    const isLive = holder !== null && ports.isRunning(holder.pid);
    return {
      id: session.id,
      target: session.target,
      summary: session.summary,
      heldBy: isLive ? holder.place : null,
      isHeldHere: isLive && holder.pid === ports.pid && holder.place === "gui",
      lastPlace: session.lastPlace,
      hasProposal: session.proposal !== null,
      updatedAt: session.updatedAt,
    };
  };

  const releaseOf = async (id: string): Promise<void> => {
    // Letting go is best effort: a session already closed or removed has no hold to give back.
    await releaseSessionHold(ports.decisions, id, { place: "gui", pid: ports.pid }).catch(() => undefined);
  };
  const release = async (): Promise<void> => {
    if (openId !== null) await releaseOf(openId);
  };

  /** Whether the session's Claude conversation exists, so a turn continues it (FR-PLAN-005). */
  const isStarted = (session: PlanSession): boolean =>
    session.transcriptPath !== null && ports.transcriptExists(session.transcriptPath);

  /**
   * Edge case: a session whose Claude conversation is gone, or not linked yet, can't be continued here, since a
   * new Claude session wouldn't know it. It can only be cancelled. One whose first message never reached Claude is
   * sent it again instead (FR-PLAN-014).
   */
  const unavailable = (session: PlanSession): string | null => {
    if (session.status !== "open") return null;
    if (session.claudeSessionId === null)
      return `Planning session ${session.id} isn't linked to a Claude conversation yet, so it can't continue here.`;
    return isStarted(session) || session.pendingFirstMessage !== null ? null : lostConversation(session.id);
  };

  const firstContext = (): FirstPromptContext => ({
    ...ports.pmContext(),
    overview: ports.decisions.readContext().overview,
  });

  /** FR-PLAN-014, FR-PLAN-031: what a session continued here sends first, if anything. */
  const resumeWith = (id: string): Promise<string | undefined> =>
    resumeMessage(
      {
        ...ports.decisions,
        isStarted: (session) => Promise.resolve(isStarted(session)),
        isAnswered: (session) => ports.isAnswered(session),
        isWritten: (session) => ports.isWritten(session),
      },
      id,
      firstContext(),
    );

  /** The actor of a cancel from this GUI (FR-PLAN-032). */
  const actor = { pid: ports.pid, isRunning: (pid: number) => ports.isRunning(pid) };

  /** FR-PLAN-032: takes a session for this GUI, or says where it's held. */
  const holdOf = async (id: string): Promise<PlanSession> => {
    const current = await ports.records.read(id);
    const reason = current === undefined ? null : unavailable(current);
    if (reason !== null) throw new UsageError(reason);
    const taken = await takeSessionHold(ports.decisions, id, { place: "gui", pid: ports.pid }, (pid) =>
      ports.isRunning(pid),
    );
    if (typeof taken === "string") throw new UsageError(taken);
    return taken;
  };
  const hold = (): Promise<PlanSession> => {
    if (openId === null) throw new UsageError("No planning session is open.");
    return holdOf(openId);
  };

  // Set from a request's first check until its turn starts, so two requests at once can't both start one (DEF-33).
  let isStarting = false;
  // Sessions being opened: a message sent meanwhile can't tell which session it's for (DEF-35).
  let opening = 0;
  // Counts the user's choices of session; an open overtaken by a newer choice stops, and lets go of what it took, so
  // only the chosen session is held and driven (DEF-36, DEF-37).
  let choice = 0;
  /** No turn is running or starting, so the open session can change. */
  const requireNoStart = (): void => {
    if (turn !== null || isStarting)
      throw new UsageError("The PM is still working. Wait for its reply, or press Stop.");
  };
  const requireIdle = (): void => {
    requireNoStart();
    if (opening > 0) throw new UsageError("The session is still opening. Send again in a moment.");
  };
  const whileIdle = async (work: () => Promise<void>): Promise<void> => {
    requireIdle();
    isStarting = true;
    try {
      await work();
    } finally {
      isStarting = false;
    }
  };

  /** Runs one turn in the background; its end, or what stopped it, shows in the panel (FR-PLAN-038, FR-PLAN-041). */
  const runInBackground = (id: string, message: string): void => {
    const turns = makeTurns;
    if (turns === null) throw new UsageError("Open the session again before sending.");
    const controller = new AbortController();
    notice = null;
    const run = async (): Promise<void> => {
      try {
        await runTurn(turns(controller.signal), id, message, count);
      } catch (error) {
        if (error instanceof SessionClosedError) {
          // Approved or cancelled from another place while the PM worked: nothing to retry.
          notice = { message: messageOf(error), action: null };
        } else if (controller.signal.aborted || error instanceof CancelledError) {
          notice = { message: "Stopped. Nothing was saved, and the session is kept.", action: "retry" };
        } else if (error instanceof AgentSessionError) {
          notice = { message: messageOf(error), action: "resume" };
        } else {
          notice = { message: messageOf(error), action: "retry" };
        }
      } finally {
        turn = null;
        changed();
      }
    };
    // The turn is recorded before its body starts, so a body that ends at once still clears it.
    let finished = (): void => undefined;
    turn = {
      controller,
      startedAt: ports.now(),
      done: new Promise<void>((resolve) => {
        finished = resolve;
      }),
    };
    changed();
    void run().finally(finished);
  };

  /** FR-PLAN-022: the uploads a message names, or a refusal when one isn't there or there are too many. */
  const findUploads = (ids: readonly string[], alreadyInSession: number) => {
    const files = ids.map((uploadId) => {
      const found = uploads.get(uploadId);
      if (found === undefined) throw new UsageError("A file you attached is no longer there. Attach it again.");
      return found;
    });
    const problem = attachmentCountProblem(files.length, alreadyInSession);
    if (problem !== undefined) throw new UsageError(problem);
    return files;
  };

  /** FR-PLAN-022, FR-PLAN-023: the uploads a message names, checked, then copied into the session. */
  const takeUploads = async (id: string, ids: readonly string[]): Promise<StoredAttachment[]> => {
    const session = await ports.records.read(id);
    const files = findUploads(ids, session?.attachments.length ?? 0);
    if (files.length === 0) return [];
    const stored = await ports.records.copyAttachments(
      id,
      files.map((upload) => ({ file: upload.file, name: upload.name })),
    );
    await ports.records.update(id, (current) => ({
      save: { ...current, attachments: [...current.attachments, ...stored], updatedAt: ports.now() },
      value: undefined,
    }));
    for (const upload of files) {
      uploads.delete(upload.id);
      // The copy in the session is what counts; a waiting file left behind goes with the folder at shutdown.
      await ports.uploads.remove(upload.file).catch(() => undefined);
    }
    return stored;
  };

  const checkMessage = (message: PlanMessage): void => {
    const problem = messageProblem(message.text, message.uploads.length);
    if (problem !== undefined) throw new UsageError(problem);
  };

  return {
    view: async () => {
      const { sessions } = await ports.records.list();
      const open = sessions
        .filter((session) => session.status === "open")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(itemOf);
      const session = openId === null ? undefined : sessions.find((item) => item.id === openId);
      // FR-PLAN-014 (DEF-21): a stopped turn answered elsewhere since, such as in Claude Code, waits no more; viewing
      // a session only reads its transcript, and the record is set right by whoever next continues it.
      const isAnsweredElsewhere =
        session !== undefined && session.isAwaitingReply && turn === null && (await ports.isAnswered(session));
      const openView: OpenSessionView | null =
        session === undefined
          ? null
          : {
              ...itemOf(session),
              status: session.status,
              suggestions: session.suggestions,
              sources: session.sources,
              proposal: session.proposal === null ? null : proposalView(session.proposal, session.target),
              attachments: session.attachments.map((item) => ({
                name: item.name,
                kind: item.kind,
                file: item.path.split(/[\\/]/).at(-1) ?? "",
              })),
              resumeCommands: resumeCommands(session),
              outcome: session.outcome,
              isAwaitingReply: session.isAwaitingReply && !isAnsweredElsewhere,
              // FR-PLAN-038: the message the PM hasn't answered, shown until the transcript has it.
              unanswered: isAnsweredElsewhere ? null : unansweredItem(session),
              unavailable: unavailable(session),
            };
      // Counted when the view is made, after its reads, so a later view always has a higher number.
      version += 1;
      return {
        ...redacted({
          open: openView,
          sessions: open,
          turn: turn === null ? null : { startedAt: turn.startedAt },
          // A Retry is offered only while the turn still waits for its answer.
          notice: isAnsweredElsewhere && notice?.action === "retry" ? null : notice,
        }),
        version,
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: (request) =>
      whileIdle(async () => {
        checkMessage(request);
        const turns = await ports.prepare(request);
        const { overview } = ports.decisions.readContext();
        const missing = missingTarget(request.target, overview);
        if (missing !== undefined) throw new UsageError(missing);
        // FR-PLAN-022: a file that isn't there refuses the message before any session exists.
        findUploads(request.uploads, 0);
        await release();
        const claude = ports.newClaudeSession();
        const session = await ports.records.create((id) =>
          newPlanSession({
            id,
            target: request.target,
            summary: request.text,
            holder: { place: "gui", pid: ports.pid },
            ...claude,
            now: ports.now(),
          }),
        );
        openId = session.id;
        options = request;
        makeTurns = turns;
        count = newTurnCount();
        notice = null;
        // FR-PLAN-014: kept until the PM replies, so a first turn that never reached Claude can be sent again. It's
        // saved before the files are copied, so a failed copy doesn't lose it.
        const keep = (message: string) =>
          changeRecord(ports.records, session.id, (current) => ({
            ...current,
            pendingFirstMessage: message,
            updatedAt: ports.now(),
          }));
        await keep(request.text);
        const stored = await takeUploads(session.id, request.uploads);
        const message = buildUserMessage(request.text, notesOf(stored));
        if (stored.length > 0) await keep(message);
        runInBackground(
          session.id,
          buildFirstTurnPrompt({ ...firstContext(), overview, planId: session.id, target: request.target, message }),
        );
      }),
    open: async (planId, given) => {
      requireNoStart();
      choice += 1;
      const mine = choice;
      const isOvertaken = (): boolean => mine !== choice;
      // Overtaken, a newer choice has the panel, so this one keeps nothing of a session it's no longer showing.
      const isStillChosen = async (): Promise<boolean> => {
        if (!isOvertaken()) return true;
        if (openId !== planId) await releaseOf(planId);
        return false;
      };
      opening += 1;
      try {
        const session = await ports.records.read(planId);
        if (session?.status !== "open") throw new UsageError(`There's no open planning session ${planId}.`);
        if (isOvertaken()) return;
        if (openId !== planId) await release();
        if (isOvertaken()) return;
        openId = planId;
        options = given;
        makeTurns = null;
        count = newTurnCount();
        notice = null;
        // Held elsewhere, or with its Claude conversation gone, it's shown without being driven (FR-PLAN-042);
        // otherwise this GUI takes it.
        const { heldBy, isHeldHere } = itemOf(session);
        if ((heldBy !== null && !isHeldHere) || unavailable(session) !== null) {
          changed();
          return;
        }
        await holdOf(planId);
        if (!(await isStillChosen())) return;
        const turns = await ports.prepare(given);
        if (!(await isStillChosen())) return;
        makeTurns = turns;
        const first = await resumeWith(planId);
        if (!(await isStillChosen())) return;
        if (first !== undefined && turn === null) runInBackground(planId, first);
        else changed();
      } finally {
        opening -= 1;
      }
    },
    newSession: async () => {
      requireNoStart();
      choice += 1;
      await release();
      openId = null;
      makeTurns = null;
      notice = null;
      changed();
    },
    send: (message) =>
      whileIdle(async () => {
        checkMessage(message);
        const session = await hold();
        makeTurns ??= await ports.prepare(options);
        // FR-PLAN-014: the first message goes to Claude before anything else.
        if (!isStarted(session) && session.pendingFirstMessage !== null)
          throw new UsageError("Your first message hasn't reached the PM yet. Press Retry to send it.");
        const stored = await takeUploads(session.id, message.uploads);
        runInBackground(session.id, buildUserMessage(message.text, notesOf(stored)));
      }),
    proposeNow: () =>
      whileIdle(async () => {
        const session = await hold();
        makeTurns ??= await ports.prepare(options);
        runInBackground(session.id, PROPOSE_NOW_MESSAGE);
      }),
    stop: () => {
      if (turn === null) throw new UsageError("The PM isn't working on anything.");
      turn.controller.abort();
    },
    retry: () =>
      whileIdle(async () => {
        const session = await hold();
        makeTurns ??= await ports.prepare(options);
        // FR-PLAN-015: replying after a limit starts the count again.
        count = newTurnCount();
        // FR-PLAN-014: asks the PM to answer the stopped turn; a message answered elsewhere meanwhile, such as in
        // Claude Code, isn't asked about again.
        const first = await resumeWith(session.id);
        if (first !== undefined) runInBackground(session.id, first);
        else {
          notice = null;
          changed();
        }
      }),
    approve: async (planId) => {
      if (turn !== null && planId === openId) requireIdle();
      const decided = await approveProposal(ports.decisions, planId);
      changed();
      return decided.message;
    },
    cancel: async (planId) => {
      if (turn !== null && planId === openId) {
        turn.controller.abort();
        await turn.done;
      }
      const decided = await cancelSession(ports.decisions, planId, actor);
      if (planId === openId) notice = null;
      changed();
      return decided.message;
    },
    upload: async (name, contentBase64, pageId) => {
      const bytes = Buffer.from(contentBase64, "base64");
      const problem = attachmentProblem({ name, sizeBytes: bytes.length });
      if (problem !== undefined) throw new UsageError(problem);
      // attachmentProblem has refused any file without a kind.
      const kind = attachmentKind(name) ?? "document";
      // Files a closed or reloaded page left behind are dropped once they're old enough not to be in use.
      const now = Date.now();
      for (const [id, upload] of uploads) {
        if (upload.pageId === pageId || now - upload.uploadedAt < UPLOAD_ORPHAN_MS) continue;
        uploads.delete(id);
        // Forgotten already, so it's never sent; a file left behind goes with the folder at shutdown.
        await ports.uploads.remove(upload.file).catch(() => undefined);
      }
      const held = [...uploads.values()].filter((upload) => upload.pageId === pageId).length;
      const session = openId === null ? undefined : await ports.records.read(openId);
      const countProblem = attachmentCountProblem(held + 1, session?.attachments.length ?? 0);
      if (countProblem !== undefined) throw new UsageError(`${name} can't be attached: ${countProblem}`);
      const id = randomUploadId();
      const view: UploadView = { id, name, kind, sizeBytes: bytes.length };
      uploads.set(id, { ...view, file: await ports.uploads.save(bytes), pageId, uploadedAt: now });
      return view;
    },
    removeUpload: async (id) => {
      const found = uploads.get(id);
      if (found === undefined) return;
      uploads.delete(id);
      // Forgotten already, so it's never sent; a file left behind goes with the folder at shutdown.
      await ports.uploads.remove(found.file).catch(() => undefined);
    },
    attachment: async (planId, file) => {
      const session = await ports.records.read(planId);
      const expected = [PLANS_FOLDER, planId, PLAN_ATTACHMENTS_FOLDER, file].join("/");
      const found = session?.attachments.find(
        (item) => item.kind === "image" && item.path.split(/[\\/]/).join("/") === expected,
      );
      const contentType = IMAGE_CONTENT_TYPES[file.slice(file.lastIndexOf(".")).toLowerCase()];
      if (found === undefined || contentType === undefined || !file.includes(".")) return undefined;
      return { bytes: await ports.readAttachment(planId, file), contentType };
    },
    openId: () => openId,
    // Replaced by createPlanner, which streams this planner.
    stream: () => () => undefined,
    shutdown: async () => {
      if (turn !== null) {
        turn.controller.abort();
        await turn.done;
      }
      await release();
      uploads.clear();
      await ports.uploads.clear();
    },
  };
}

/**
 * FR-PLAN-042: the panel's state, and the open session's conversation from its Claude transcript, as it changes,
 * whichever place drives it. A `plan-transcript` event replaces the conversation shown; `plan-entries` adds to it.
 */
function streamPlan(
  planner: Planner,
  ports: Pick<PlannerPorts, "records" | "transcripts" | "every">,
  send: SendEvent,
): () => void {
  let lastView = "";
  let reading: { planId: string; file: string; position: TranscriptPosition | undefined } | undefined;
  let lastProblem = "";
  /** The session an empty conversation was last sent for, so it's sent once while no transcript exists. */
  let emptyFor: string | null | undefined;
  const sendEmpty = (planId: string | null): void => {
    if (emptyFor === planId) return;
    emptyFor = planId;
    send("plan-transcript", { planId, items: [], isTruncated: false });
  };
  let isBusy = false;

  const sendView = async (): Promise<void> => {
    const view = await planner.view();
    // The version changes with every view, so only what's shown is compared.
    const text = JSON.stringify({ ...view, version: 0 });
    if (text === lastView) return;
    lastView = text;
    send("plan", { plan: view });
  };

  const items = (lines: readonly string[]): PlanChatItem[] =>
    lines.flatMap((line) =>
      toPlanChatItems(parseTranscriptLine(line, PLAN_LIMITS.transcriptEntryChars).entries, toolLinksOf(line)),
    );

  const readTranscript = async (): Promise<void> => {
    const planId = planner.openId();
    if (planId === null) {
      if (reading !== undefined || emptyFor !== undefined) sendEmpty(null);
      reading = undefined;
      return;
    }
    if (reading?.planId !== planId) {
      const session = await ports.records.read(planId);
      if (session?.transcriptPath == null || session.claudeSessionId === null) {
        sendEmpty(planId);
        reading = undefined;
        return;
      }
      const location = await ports.transcripts.locate(session.transcriptPath, session.claudeSessionId);
      if (location.kind !== "found") {
        // A transcript appears with the session's first turn, so it's looked for again on the next check.
        sendEmpty(planId);
        return;
      }
      reading = { planId, file: location.file, position: undefined };
    }
    const read = await ports.transcripts.read(reading.file, reading.position);
    const isFirst = reading.position === undefined;
    emptyFor = undefined;
    reading.position = read.next;
    // FR-GUI-042: a replaced, shrunk or far-grown file replaces what's shown, so old and new lines never mix.
    if (isFirst || read.isRestart || read.isTruncated)
      send("plan-transcript", { planId, items: items(read.lines), isTruncated: read.isTruncated });
    else if (read.lines.length > 0) send("plan-entries", { planId, items: items(read.lines) });
  };

  let isAgain = false;
  const check = async (): Promise<void> => {
    // A change while a check runs is checked again after it, so none is missed.
    if (isBusy) {
      isAgain = true;
      return;
    }
    isBusy = true;
    try {
      await sendView();
      await readTranscript();
      lastProblem = "";
    } catch (error) {
      reading = undefined;
      const message = redact(messageOf(error)).text;
      if (message !== lastProblem) send("problem", { message });
      lastProblem = message;
    } finally {
      isBusy = false;
    }
    if (isAgain) {
      isAgain = false;
      await check();
    }
  };
  void check();
  const unsubscribe = planner.subscribe(() => void check());
  const stopEvery = ports.every(PLAN_VIEW_POLL_MS, check);
  return () => {
    unsubscribe();
    stopEvery();
  };
}
