/**
 * Plan with the PM from the GUI: the same session as `cclinic plan`, with the browser answering its questions
 * (spec: gui FR-GUI-023 to FR-GUI-026). One session at a time, kept in the GUI's process.
 */
import { CancelledError, UsageError } from "../core/errors.js";
import type { PlanRequest } from "../core/gui.js";
import type { PlanTarget } from "../core/planning.js";
import { redact } from "../core/redaction.js";
import { runPlanningSession, type PreparedSession, type ReviewChoice } from "./planning-session.js";

export type PlanStep = "thinking" | "question" | "review" | "saved" | "cancelled" | "failed";

export interface PlanView {
  readonly id: string;
  readonly target: PlanTarget;
  readonly step: PlanStep;
  /** The PM's question, while it waits for an answer. */
  readonly question: string | null;
  /** The proposal in full, while it waits for a review, and after a failed save so it isn't lost. */
  readonly proposal: string | null;
  /** What happened at the end: saved, cancelled or why it failed. */
  readonly message: string | null;
}

export interface PlannerPorts {
  /** Makes `cclinic plan`'s checks and readies a session; `signal` stops its PM calls. Throws what the CLI refuses. */
  readonly prepare: (
    request: PlanRequest,
    signal: AbortSignal,
  ) => Promise<{ readonly target: PlanTarget } & PreparedSession>;
}

export type PlanEvent = (view: PlanView) => void;

export interface Planner {
  /** FR-GUI-026: refused while another session is going. */
  start(request: PlanRequest): Promise<PlanView>;
  /** The session going, or the last one, so a page opened later sees it (FR-GUI-026). */
  current(): PlanView | null;
  subscribe(listener: PlanEvent): () => void;
  answer(text: string): PlanView;
  review(choice: ReviewChoice, feedback: string): PlanView;
  cancel(): PlanView;
  /** Ends the session going, saving nothing (FR-GUI-025), when the GUI stops. */
  stop(): Promise<void>;
}

const FINAL_STEPS: ReadonlySet<PlanStep> = new Set(["saved", "cancelled", "failed"]);
const CANCELLED = "Cancelled. Nothing was saved.";

/** FR-GUI-011: everything the PM or an error says is redacted before it reaches the browser. */
const shown = (text: string): string => redact(text).text;

function messageOf(error: unknown): string {
  return shown(error instanceof Error ? error.message : String(error));
}

export function createPlanner(ports: PlannerPorts): Planner {
  let view: PlanView | null = null;
  let count = 0;
  let controller: AbortController | undefined;
  let running: Promise<void> = Promise.resolve();
  /** The answer or review the session is waiting for. */
  let waiting: { readonly resolve: (value: string) => void; readonly reject: (error: Error) => void } | undefined;
  let feedback = "";
  const listeners = new Set<PlanEvent>();

  const show = (change: Partial<PlanView>): PlanView => {
    if (view === null) throw new Error("No planning session.");
    view = { ...view, ...change };
    for (const listener of listeners) listener(view);
    return view;
  };
  const isGoing = (): boolean => view !== null && !FINAL_STEPS.has(view.step);
  const wait = (change: Partial<PlanView>): Promise<string> =>
    new Promise((resolve, reject) => {
      waiting = { resolve, reject };
      show(change);
    });
  const reply = (step: PlanStep, value: string): PlanView => {
    if (view?.step !== step || waiting === undefined)
      throw new UsageError(step === "question" ? "No question is waiting." : "No proposal is waiting.");
    const { resolve } = waiting;
    waiting = undefined;
    const shown = show({ step: "thinking", question: null, proposal: null });
    resolve(value);
    return shown;
  };

  const run = async (prepared: PreparedSession): Promise<void> => {
    try {
      const outcome = await runPlanningSession(prepared.input, {
        callPm: prepared.callPm,
        answer: (question) => wait({ step: "question", question: shown(question) }),
        review: async (text) => (await wait({ step: "review", proposal: shown(text) })) as ReviewChoice,
        feedback: () => Promise.resolve(feedback),
      });
      if (outcome.kind === "cancelled") {
        show({ step: "cancelled", message: CANCELLED });
        return;
      }
      try {
        show({ step: "saved", proposal: null, message: prepared.save(outcome) });
      } catch (error) {
        // The approved proposal stays shown, so the planning isn't lost (FR-GUI-025).
        show({ step: "failed", proposal: shown(outcome.text), message: `Nothing was saved: ${messageOf(error)}` });
      }
    } catch (error) {
      const isCancelled = error instanceof CancelledError || controller?.signal.aborted === true;
      show(
        isCancelled
          ? { step: "cancelled", question: null, proposal: null, message: CANCELLED }
          : { step: "failed", question: null, proposal: null, message: messageOf(error) },
      );
    } finally {
      waiting = undefined;
    }
  };

  const cancel = (): PlanView => {
    if (!isGoing()) throw new UsageError("No planning session is going.");
    // At a proposal, cancel is the session's own answer; anywhere else, the PM is stopped.
    if (view?.step === "review") return reply("review", "cancel");
    controller?.abort();
    waiting?.reject(new CancelledError("The planning session was cancelled."));
    waiting = undefined;
    return view as PlanView;
  };

  return {
    start: async (request) => {
      if (isGoing()) throw new UsageError("A planning session is already going. Finish or cancel it first.");
      const next = new AbortController();
      const prepared = await ports.prepare(request, next.signal);
      // Checked again: another start may have begun while this one was checked.
      if (isGoing()) throw new UsageError("A planning session is already going. Finish or cancel it first.");
      controller = next;
      feedback = "";
      count += 1;
      view = {
        id: `plan-${count}`,
        target: prepared.target,
        step: "thinking",
        question: null,
        proposal: null,
        message: null,
      };
      for (const listener of listeners) listener(view);
      running = run(prepared);
      return view;
    },
    current: () => view,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    answer: (text) => reply("question", text),
    review: (choice, text) => {
      feedback = text;
      return reply("review", choice);
    },
    cancel,
    stop: async () => {
      if (isGoing()) cancel();
      await running;
    },
  };
}
