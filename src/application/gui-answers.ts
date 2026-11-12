/** Answering a change's waiting question from the GUI, as `cclinic approve` does (spec: gui FR-GUI-038). */
import { waitingQuestion } from "../core/canvas.js";
import { answerRequestSchema } from "../core/gui.js";
import { answerPending, isNotesAnswer, type WorkflowState } from "../core/workflow.js";

export interface AnswerPorts {
  /** Decides on the change's newest state, and saves what `decide` returns, with nothing written in between. */
  readonly update: <T>(
    key: string,
    decide: (state: WorkflowState | undefined) => { readonly save?: WorkflowState; readonly value: T },
  ) => Promise<T>;
  readonly now: () => Date;
}

export type AnswerResult =
  | { readonly status: "answered"; readonly message: string }
  | { readonly status: "unknown" }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "changed"; readonly message: string };

const CHANGED = "That question was answered or changed meanwhile, so nothing was recorded. Look at it again.";

/** FR-GUI-038: records the answer on the change's newest state, only while the question the user saw still waits. */
export async function answerChange(ports: AnswerPorts, key: string, body: unknown): Promise<AnswerResult> {
  const parsed = answerRequestSchema.safeParse(body);
  if (!parsed.success) {
    // Notes are typed by the user, so a refusal of them says what to change.
    const notes = parsed.error.issues.find((issue) => issue.path[0] === "notes" && issue.code === "too_big");
    return { status: "invalid", message: notes?.message ?? "That isn't an answer to a question." };
  }
  const { question, answer, notes } = parsed.data;
  // As `cclinic approve`: only an answer that carries notes keeps them, and empty notes are none.
  const kept = isNotesAnswer(answer) ? (notes ?? "").trim() : "";
  return ports.update<AnswerResult>(key, (latest) => {
    if (latest === undefined) return { value: { status: "unknown" } };
    // The page shows the question redacted, so that's the text an answer names.
    if (waitingQuestion(latest) !== question) return { value: { status: "changed", message: CHANGED } };
    const outcome = answerPending(latest, answer, kept === "" ? null : kept, ports.now().toISOString());
    if ("refusal" in outcome) return { value: { status: "invalid", message: outcome.refusal } };
    return { save: outcome.state, value: { status: "answered", message: outcome.message } };
  });
}
