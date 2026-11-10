import { describe, expect, it } from "vitest";
import {
  buildPmPrompt,
  checkRoadmapProposal,
  checkTaskProposal,
  parseRoadmapReply,
  parseTaskReply,
  renderRoadmapProposal,
  renderTaskProposal,
  toRoadmapPlan,
  type RoadmapProposal,
  type TaskProposal,
} from "./planning.js";
import type { RoadmapOverview, Task } from "./tasks.js";

const TIME = "2026-11-09T10:00:00.000Z";
const task = (id: number, dependsOn: number[] = []): Task => ({
  id,
  title: `T${id}`,
  description: null,
  status: "open",
  milestoneId: null,
  spec: null,
  dependsOn,
  createdAt: TIME,
  updatedAt: TIME,
});

const planned = (
  key: string,
  dependsOn: (string | number)[] = [],
  extra: Partial<{ spec: string | null; title: string }> = {},
) => ({
  key,
  title: `Task ${key}`,
  description: "Details",
  spec: null,
  dependsOn,
  ...extra,
});

const proposal = (extra: Partial<RoadmapProposal> = {}): RoadmapProposal => ({
  roadmap: { title: "Launch", goal: "First release" },
  milestones: [{ title: "M1", goal: "Start", tasks: [planned("a"), planned("b", ["a"])] }],
  openQuestions: [],
  ...extra,
});

const taskProposal = (extra: Partial<TaskProposal["task"]> = {}, milestoneId: number | null = 3): TaskProposal => ({
  task: { title: "Lock", description: "After 5", spec: "auth", dependsOn: [], ...extra },
  milestoneId,
  openQuestions: [],
});

describe("PM replies", () => {
  it("TC-PLAN-009: only 1 to 5 questions or a complete proposal are accepted", () => {
    const newRoadmap = { kind: "new-roadmap" } as const;
    expect(parseRoadmapReply({ questions: ["a", "b"], proposal: null }, newRoadmap)).toEqual({
      kind: "questions",
      questions: ["a", "b"],
    });
    expect(parseRoadmapReply({ questions: [], proposal: null }, newRoadmap)).toBeTypeOf("string");
    expect(parseRoadmapReply({ questions: ["1", "2", "3", "4", "5", "6"], proposal: null }, newRoadmap)).toBeTypeOf(
      "string",
    );
    expect(parseRoadmapReply({ questions: [], proposal: proposal() }, newRoadmap)).toMatchObject({ kind: "proposal" });
    const missingDependsOn = proposal({
      milestones: [{ title: "M", goal: "", tasks: [{ key: "a", title: "A", description: "", spec: null }] as never }],
    });
    expect(parseRoadmapReply({ questions: [], proposal: missingDependsOn }, newRoadmap)).toBeTypeOf("string");
    expect(parseRoadmapReply({ questions: [], proposal: proposal({ roadmap: null }) }, newRoadmap)).toBe(
      "A new roadmap needs a roadmap title and goal.",
    );
    expect(
      parseRoadmapReply(
        { questions: [], proposal: proposal({ roadmap: null }) },
        { kind: "extend-roadmap", roadmapId: 1 },
      ),
    ).toMatchObject({ kind: "proposal" });
    expect(parseRoadmapReply("not json", newRoadmap)).toBeTypeOf("string");
    expect(parseRoadmapReply({ questions: ["a"], proposal: proposal() }, newRoadmap)).toBe(
      "Send either questions or a proposal, not both.",
    );
  });

  it("TC-PLAN-030: a task reply has exactly one task, with dependencies as existing IDs", () => {
    expect(parseTaskReply({ questions: [], proposal: taskProposal() })).toMatchObject({ kind: "proposal" });
    expect(parseTaskReply({ questions: [], proposal: taskProposal({}, null) })).toMatchObject({ kind: "proposal" });
    expect(
      parseTaskReply({
        questions: [],
        proposal: { ...taskProposal(), task: [taskProposal().task, taskProposal().task] },
      }),
    ).toBeTypeOf("string");
    expect(
      parseTaskReply({
        questions: [],
        proposal: { ...taskProposal(), task: { description: "", spec: null, dependsOn: [] } },
      }),
    ).toBeTypeOf("string");
    expect(parseTaskReply({ questions: [], proposal: taskProposal({ dependsOn: ["a" as never] }) })).toBeTypeOf(
      "string",
    );
  });
});

describe("proposal checks", () => {
  it("TC-PLAN-011: limits, dependencies, cycles and empty milestones are problems", () => {
    expect(checkRoadmapProposal(proposal(), [])).toEqual([]);
    const cases: [RoadmapProposal, RegExp][] = [
      [proposal({ roadmap: { title: "x".repeat(201), goal: "" } }), /Roadmap title/],
      [
        proposal({ milestones: [{ title: "M", goal: "", tasks: [planned("a", [], { spec: "Auth" })] }] }),
        /spec "Auth"/,
      ],
      [
        proposal({ milestones: [{ title: "M", goal: "", tasks: [planned("a", ["missing"])] }] }),
        /depends on "missing"/,
      ],
      [proposal({ milestones: [{ title: "M", goal: "", tasks: [planned("a", [99])] }] }), /depends on task 99/],
      [
        proposal({ milestones: [{ title: "M", goal: "", tasks: [planned("A", ["B"]), planned("B", ["A"])] }] }),
        /cycle: A -> B -> A/,
      ],
      [proposal({ milestones: [] }), /at least one milestone/],
      [proposal({ milestones: [{ title: "Empty", goal: "", tasks: [] }] }), /"Empty" has no tasks/],
      [proposal({ milestones: [{ title: "M", goal: "", tasks: [planned("a"), planned("a")] }] }), /its own key/],
    ];
    for (const [given, problem] of cases) {
      expect(checkRoadmapProposal(given, []).join("\n"), String(problem)).toMatch(problem);
    }
    const onExisting = proposal({ milestones: [{ title: "M", goal: "", tasks: [planned("a", [3])] }] });
    expect(checkRoadmapProposal(onExisting, [task(3)])).toEqual([]);
  });

  it("TC-PLAN-011: a cycle through existing tasks is found", () => {
    const given = proposal({ milestones: [{ title: "M", goal: "", tasks: [planned("a", [1])] }] });
    expect(checkRoadmapProposal(given, [task(1, [2]), task(2)])).toEqual([]);
  });

  it("TC-PLAN-032: a task proposal must use a milestone of the chosen roadmap and existing dependencies", () => {
    const context = { existing: [task(4), task(5, [6]), task(6)], roadmapMilestoneIds: [1, 2] };
    expect(checkTaskProposal(taskProposal({ dependsOn: [4] }, 2), context)).toEqual([]);
    expect(checkTaskProposal(taskProposal({}, 7), context).join()).toMatch(
      /one of the chosen roadmap's milestones: 1, 2/,
    );
    expect(checkTaskProposal(taskProposal({}, null), context).join()).toMatch(/milestones/);
    expect(checkTaskProposal(taskProposal({ dependsOn: [99] }, 1), context).join()).toMatch(
      /task 99, which doesn't exist/,
    );
    expect(checkTaskProposal(taskProposal({ title: " " }, 1), context).join()).toMatch(/Task title/);
  });

  it("TC-PLAN-033: a standalone task has no milestone", () => {
    const context = { existing: [], roadmapMilestoneIds: undefined };
    expect(checkTaskProposal(taskProposal({}, null), context)).toEqual([]);
    expect(checkTaskProposal(taskProposal({}, 1), context)).toEqual([
      "A standalone task has no milestone, so milestoneId must be null.",
    ]);
  });
});

describe("prompt and display", () => {
  const overview: RoadmapOverview = {
    roadmaps: [
      {
        id: 1,
        title: "Launch",
        goal: null,
        createdAt: TIME,
        status: "planned",
        milestones: [
          {
            id: 1,
            roadmapId: 1,
            title: "M1",
            goal: null,
            position: 1,
            createdAt: TIME,
            tasks: [task(1), task(2, [1])],
          },
        ],
      },
    ],
    unassigned: [],
  };

  it("TC-PLAN-008: the PM prompt has the skill, docs paths, roadmaps, the target and the conversation", () => {
    const prompt = buildPmPrompt({
      skill: "Read `.cclinic/sdd/overview.md` and `.cclinic/sdd/README.md`.",
      target: { kind: "extend-roadmap", roadmapId: 1 },
      overview,
      conversation: [
        { from: "pm", text: '{"questions":["Who?"]}' },
        { from: "user", text: "Q: Who?\nA: Admins" },
      ],
    });
    for (const part of [
      ".cclinic/sdd/overview.md",
      ".cclinic/sdd/README.md",
      '"dependsOn":[1]',
      '"status":"open"',
      "EXTEND roadmap 1",
      '{"questions":["Who?"]}',
      "A: Admins",
      '"questions": [1 to 5 questions]',
    ]) {
      expect(prompt, part).toContain(part);
    }
    expect(
      buildPmPrompt({ skill: "", target: { kind: "task", roadmapId: null }, overview, conversation: [] }),
    ).toContain("SINGLE STANDALONE task");
    expect(buildPmPrompt({ skill: "", target: { kind: "task", roadmapId: 1 }, overview, conversation: [] })).toContain(
      "SINGLE task for roadmap 1",
    );
  });

  it("TC-PLAN-015: a roadmap proposal shows titles, goals, specs, dependencies and open questions", () => {
    const text = renderRoadmapProposal(
      proposal({
        milestones: [
          { title: "First", goal: "Start", tasks: [planned("a", [], { spec: "auth" })] },
          { title: "Second", goal: "Grow", tasks: [planned("b", ["a", 4])] },
        ],
        openQuestions: ["Which email provider?"],
      }),
      { kind: "new-roadmap" },
    );
    for (const part of [
      "Roadmap: Launch",
      "Goal: First release",
      "Milestone 1: First",
      "Goal: Start",
      "spec: auth",
      "spec: new spec (needs a, #4)",
      "Which email provider?",
    ]) {
      expect(text, part).toContain(part);
    }
    expect(text.indexOf("First")).toBeLessThan(text.indexOf("Second"));
  });

  it("TC-PLAN-034: a task proposal shows its spec, place and dependencies", () => {
    const text = renderTaskProposal(taskProposal({ spec: null, dependsOn: [4] }, 2), { kind: "task", roadmapId: 1 });
    for (const part of ["Task: Lock", "Spec: new spec", "Where: milestone #2 of roadmap #1", "Depends on: #4"]) {
      expect(text, part).toContain(part);
    }
    expect(renderTaskProposal(taskProposal({}, null), { kind: "task", roadmapId: null })).toContain(
      "Where: standalone",
    );
  });

  it("TC-PLAN-017: an approved proposal becomes a plan for a new or an existing roadmap", () => {
    expect(toRoadmapPlan(proposal(), { kind: "new-roadmap" }).roadmap).toEqual({
      title: "Launch",
      goal: "First release",
    });
    expect(toRoadmapPlan(proposal({ roadmap: null }), { kind: "extend-roadmap", roadmapId: 4 }).roadmap).toEqual({
      id: 4,
    });
  });
});
