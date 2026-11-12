/** The conversation between the user and the PM agent in `cclinic plan` (spec: roadmap-planning). */
import { canStartCall, NO_SPENDING, recordCall, remainingUsd, type Spending } from "../core/agent-budget.js";
import { PLAN_LIMITS } from "../core/constants/agents.js";
import { AgentSessionError } from "../core/errors.js";
import {
  buildPmPrompt,
  checkRoadmapProposal,
  checkTaskProposal,
  parseRoadmapReply,
  parseTaskReply,
  renderRoadmapProposal,
  renderTaskProposal,
  type ConversationTurn,
  type PlanTarget,
  type PmReply,
  type RoadmapProposal,
  type TaskProposal,
} from "../core/planning.js";
import type { RoadmapOverview, Task } from "../core/tasks.js";

export type ReviewChoice = "approve" | "refine" | "cancel";

/** Everything the session needs from outside: Claude and the terminal. */
export interface PlanningPorts {
  callPm(prompt: string, maxBudgetUsd: number): Promise<{ readonly reply: unknown; readonly costUsd: number | null }>;
  answer(question: string): Promise<string>;
  review(proposalText: string): Promise<ReviewChoice>;
  feedback(): Promise<string>;
}

export interface PlanningInput {
  readonly target: PlanTarget;
  readonly skill: string;
  readonly overview: RoadmapOverview;
  readonly existingTasks: readonly Task[];
  /** The chosen roadmap's milestones, for a single task in a roadmap. */
  readonly roadmapMilestoneIds?: readonly number[];
  readonly maxBudgetUsd: number;
  readonly maxTurns?: number;
}

/** A session ready to run: its input, its PM and its save, the same for `cclinic plan` and the GUI (FR-GUI-023). */
export interface PreparedSession {
  readonly input: PlanningInput;
  readonly callPm: PlanningPorts["callPm"];
  /** Saves an approved plan, or nothing for a cancelled one, and says what happened. */
  readonly save: (outcome: PlanningOutcome) => string;
}

export type PlanningOutcome =
  | { readonly kind: "roadmap"; readonly proposal: RoadmapProposal; readonly text: string; readonly costUsd: number }
  | { readonly kind: "task"; readonly proposal: TaskProposal; readonly text: string; readonly costUsd: number }
  | { readonly kind: "cancelled"; readonly costUsd: number };

type CheckedProposal =
  | { readonly kind: "roadmap"; readonly proposal: RoadmapProposal }
  | { readonly kind: "task"; readonly proposal: TaskProposal };

const UNKNOWN_ANSWER = "unknown";

export async function runPlanningSession(input: PlanningInput, ports: PlanningPorts): Promise<PlanningOutcome> {
  const maxTurns = input.maxTurns ?? PLAN_LIMITS.maxTurns;
  const conversation: ConversationTurn[] = [];
  let spending: Spending = NO_SPENDING;
  let turns = 0;
  let invalidInARow = 0;

  const parse = (value: unknown): PmReply<CheckedProposal> | string => {
    if (input.target.kind === "task") {
      const reply = parseTaskReply(value);
      if (typeof reply === "string" || reply.kind === "questions") return reply;
      return { kind: "proposal", proposal: { kind: "task", proposal: reply.proposal } };
    }
    const reply = parseRoadmapReply(value, input.target);
    if (typeof reply === "string" || reply.kind === "questions") return reply;
    return { kind: "proposal", proposal: { kind: "roadmap", proposal: reply.proposal } };
  };

  const check = (checked: CheckedProposal): string[] =>
    checked.kind === "task"
      ? checkTaskProposal(checked.proposal, {
          existing: input.existingTasks,
          roadmapMilestoneIds:
            input.target.kind === "task" && input.target.roadmapId !== null
              ? (input.roadmapMilestoneIds ?? [])
              : undefined,
        })
      : checkRoadmapProposal(checked.proposal, input.existingTasks);

  const render = (checked: CheckedProposal): string =>
    checked.kind === "task"
      ? renderTaskProposal(checked.proposal, input.target)
      : renderRoadmapProposal(checked.proposal, input.target);

  for (;;) {
    if (turns >= maxTurns) {
      throw new AgentSessionError(`Planning stopped at the limit of ${maxTurns} PM turns. Nothing was saved.`);
    }
    if (!canStartCall(spending, input.maxBudgetUsd)) {
      throw new AgentSessionError(
        `Planning stopped at its budget of $${input.maxBudgetUsd} (--max-budget-usd). Nothing was saved.`,
      );
    }
    turns += 1;
    const prompt = buildPmPrompt({
      skill: input.skill,
      target: input.target,
      overview: input.overview,
      conversation,
    });
    const { reply, costUsd } = await ports.callPm(prompt, remainingUsd(spending, input.maxBudgetUsd));
    spending = recordCall(spending, costUsd);
    conversation.push({ from: "pm", text: JSON.stringify(reply) });

    const parsed = parse(reply);
    if (typeof parsed === "string") {
      invalidInARow += 1;
      if (invalidInARow >= PLAN_LIMITS.invalidRepliesInARow) {
        throw new AgentSessionError(`The PM's replies weren't usable: ${parsed} Nothing was saved.`);
      }
      conversation.push({ from: "cclinic", text: `Your last reply wasn't valid: ${parsed} Reply again.` });
      continue;
    }
    invalidInARow = 0;

    if (parsed.kind === "questions") {
      for (const question of parsed.questions) {
        const answer = (await ports.answer(question)).trim();
        conversation.push({ from: "user", text: `Q: ${question}\nA: ${answer === "" ? UNKNOWN_ANSWER : answer}` });
      }
      continue;
    }

    const problems = check(parsed.proposal);
    if (problems.length > 0) {
      conversation.push({
        from: "cclinic",
        text: `The proposal can't be shown yet. Fix these problems:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
      });
      continue;
    }

    const text = render(parsed.proposal);
    const choice = await ports.review(text);
    if (choice === "cancel") return { kind: "cancelled", costUsd: spending.spentUsd };
    if (choice === "approve") return { ...parsed.proposal, text, costUsd: spending.spentUsd };
    conversation.push({ from: "user", text: `Feedback on the proposal: ${(await ports.feedback()).trim()}` });
  }
}
