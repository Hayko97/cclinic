import { describe, expect, it } from "vitest";
import { newPlanSession, PROPOSAL_NO_LONGER_FITS, type PlanSession } from "../core/planning.js";
import {
  newTurnCount,
  resumeMessage,
  runTurn,
  type DecisionPorts,
  type PlanRecords,
  type TurnPorts,
} from "./planning-session.js";

const NOW = "2026-11-15T10:00:00.000Z";

function memoryRecords(first: PlanSession): PlanRecords {
  const sessions = new Map([[first.id, first]]);
  return {
    list: () => Promise.resolve({ sessions: [...sessions.values()], problems: [] }),
    read: (id) => Promise.resolve(sessions.get(id)),
    create: (make) => {
      const made = make(`plan-${sessions.size + 1}`);
      sessions.set(made.id, made);
      return Promise.resolve(made);
    },
    update: (id, decide) => {
      const current = sessions.get(id);
      if (current === undefined) throw new Error(`no ${id}`);
      const { save, value } = decide(current);
      if (save !== undefined) sessions.set(id, save);
      return Promise.resolve(value);
    },
    deleteAttachments: () => Promise.resolve(),
  };
}

/** A task proposal for milestone 999 of roadmap 1, which doesn't exist, so it no longer fits. */
function staleSession(): PlanSession {
  return {
    ...newPlanSession({
      id: "plan-1",
      target: { kind: "task", roadmapId: 1 },
      summary: "Login task",
      holder: { place: "gui", pid: 1 },
      claudeSessionId: "claude-1",
      transcriptPath: "/transcript.jsonl",
      now: NOW,
    }),
    proposal: {
      kind: "task",
      proposal: {
        task: { title: "Login", description: "Log in", spec: null, dependsOn: [] },
        milestoneId: 999,
        openQuestions: [],
      },
      proposedAt: NOW,
    },
  };
}

function ports(records: PlanRecords): DecisionPorts & TurnPorts {
  return {
    records,
    readContext: () => ({ overview: { roadmaps: [], unassigned: [] }, tasks: [] }),
    save: () => "saved",
    now: () => NOW,
    callPm: () => Promise.resolve("Fixed."),
    isStarted: () => Promise.resolve(true),
    isAnswered: () => Promise.resolve(false),
    isWritten: () => Promise.resolve(true),
  };
}

const FIRST = { skill: "pm", overview: { roadmaps: [], unassigned: [] }, overviewPath: "o.md", specsListPath: "s.md" };

describe("a proposal that no longer fits", () => {
  it("TC-PLAN-079: is taken away only by the turn that tells the PM, so a resume dropped before sending loses nothing", async () => {
    const records = memoryRecords(staleSession());
    const both = ports(records);
    // An open overtaken by a newer choice works out the note but never sends it.
    const dropped = await resumeMessage(both, "plan-1", FIRST);
    expect(dropped?.startsWith(PROPOSAL_NO_LONGER_FITS)).toBe(true);
    expect((await records.read("plan-1"))?.proposal).not.toBeNull();
    // Opened again, the PM is still told.
    const sent = await resumeMessage(both, "plan-1", FIRST);
    expect(sent).toBe(dropped);
    await runTurn(both, "plan-1", sent ?? "", newTurnCount());
    expect((await records.read("plan-1"))?.proposal).toBeNull();
  });
});
