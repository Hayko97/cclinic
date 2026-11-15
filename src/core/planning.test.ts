import { describe, expect, it } from "vitest";
import {
  activitiesOfEvent,
  isTurnAnswered,
  isWaitingMessageWritten,
  activityOf,
  attachmentCountProblem,
  attachmentProblem,
  buildFirstTurnPrompt,
  buildUserMessage,
  checkRoadmapProposal,
  checkTaskProposal,
  linkClaudeSession,
  messageProblem,
  newPlanSession,
  nextPlanId,
  parseChatInput,
  parseProposal,
  isPlanToolCall,
  planIdOfToolCall,
  planSuggestInputSchema,
  releaseHold,
  renderRoadmapProposal,
  takeHold,
  userPartOf,
  renderTaskProposal,
  toRoadmapPlan,
  type RoadmapProposal,
  type TaskProposal,
  answerLastMessage,
  repeatedMessageOf,
  shownUserMessage,
  PROPOSE_NOW_MESSAGE,
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

describe("planning tool input", () => {
  const newRoadmap = { kind: "new-roadmap" } as const;

  it("TC-PLAN-009: suggestions and sources are limited, and a proposal must match the target's shape", () => {
    const suggest = (suggestions: string[], sources: { title: string; url: string }[] = []) =>
      planSuggestInputSchema.safeParse({ planId: "plan-1", suggestions, sources }).success;
    expect(suggest(["Web", "Mobile"], [{ title: "HHS", url: "https://www.hhs.gov/hipaa" }])).toBe(true);
    expect(suggest(["1", "2", "3", "4", "5"])).toBe(false);
    expect(suggest(["x".repeat(201)])).toBe(false);
    expect(suggest(["a"], [{ title: "FTP", url: "ftp://files.example.com" }])).toBe(false);
    expect(
      suggest(
        ["a"],
        Array.from({ length: 11 }, (_, index) => ({ title: `S${index}`, url: "https://a.example" })),
      ),
    ).toBe(false);

    expect(parseProposal(proposal(), newRoadmap)).toMatchObject({ kind: "roadmap" });
    const missingDependsOn = proposal({
      milestones: [{ title: "M", goal: "", tasks: [{ key: "a", title: "A", description: "", spec: null }] as never }],
    });
    expect(parseProposal(missingDependsOn, newRoadmap)).toContain("dependsOn");
    expect(parseProposal(proposal({ roadmap: null }), newRoadmap)).toContain("roadmap");
    expect(parseProposal(proposal({ roadmap: null }), { kind: "extend-roadmap", roadmapId: 1 })).toMatchObject({
      kind: "roadmap",
    });
  });

  it("TC-PLAN-030: a task proposal has exactly one task, with dependencies as existing IDs", () => {
    const taskMode = { kind: "task", roadmapId: 1 } as const;
    expect(parseProposal(taskProposal(), taskMode)).toMatchObject({ kind: "task" });
    expect(parseProposal(taskProposal({}, null), { kind: "task", roadmapId: null })).toMatchObject({ kind: "task" });
    expect(parseProposal({ ...taskProposal(), task: [taskProposal().task, taskProposal().task] }, taskMode)).toBeTypeOf(
      "string",
    );
    expect(
      parseProposal({ ...taskProposal(), task: { description: "", spec: null, dependsOn: [] } }, taskMode),
    ).toContain("task.title");
    expect(parseProposal(taskProposal({ dependsOn: ["a" as never] }), taskMode)).toBeTypeOf("string");
  });
});

describe("attachments and messages", () => {
  it("TC-PLAN-039: only images and documents of an allowed size can be attached", () => {
    expect(attachmentProblem({ name: "song.mp3", sizeBytes: 10 })).toContain("only images");
    expect(attachmentProblem({ name: "big.png", sizeBytes: 6 * 1024 * 1024 })).toContain("at most 5 MB");
    expect(attachmentProblem({ name: "doc.pdf", sizeBytes: 21 * 1024 * 1024 })).toContain("at most 20 MB");
    expect(attachmentProblem({ name: "README", sizeBytes: 1 })).toContain("only images");
    for (const name of [
      "mock.png",
      "a.JPG",
      "a.jpeg",
      "a.gif",
      "a.webp",
      "brief.pdf",
      "b.docx",
      "n.md",
      "t.txt",
      "d.csv",
    ]) {
      expect(attachmentProblem({ name, sizeBytes: 1024 }), name).toBeUndefined();
    }
    expect(attachmentCountProblem(11, 0)).toContain("at most 10 files");
    expect(attachmentCountProblem(10, 0)).toBeUndefined();
  });

  it("TC-PLAN-040: a session holds at most 30 files", () => {
    expect(attachmentCountProblem(3, 28)).toContain("at most 30 files");
    expect(attachmentCountProblem(2, 28)).toBeUndefined();
  });

  it("TC-PLAN-041: a message needs text or a file, and no attachment is ever required", () => {
    expect(messageProblem("hello", 0)).toBeUndefined();
    expect(messageProblem("", 1)).toBeUndefined();
    expect(messageProblem("  ", 0)).toBe("Write a message or attach a file.");
    expect(messageProblem("x".repeat(20_001), 0)).toContain("20000");
  });

  it("TC-PLAN-044: the terminal understands @files, /attach, a suggestion's number and the commands", () => {
    expect(parseChatInput('look @"docs/my brief.pdf"')).toEqual({
      kind: "message",
      text: "look",
      files: ["docs/my brief.pdf"],
    });
    expect(parseChatInput("split @notes.md it")).toEqual({ kind: "message", text: "split it", files: ["notes.md"] });
    expect(parseChatInput("@a.png @b.png hello")).toEqual({
      kind: "message",
      text: "hello",
      files: ["a.png", "b.png"],
    });
    expect(parseChatInput("Keep  this\n    indented @x.md line")).toEqual({
      kind: "message",
      text: "Keep  this\n    indented line",
      files: ["x.md"],
    });
    expect(parseChatInput("mail bob@example.com")).toEqual({
      kind: "message",
      text: "mail bob@example.com",
      files: [],
    });
    expect(parseChatInput("/attach notes.md")).toEqual({ kind: "message", text: "", files: ["notes.md"] });
    expect(parseChatInput("1")).toEqual({ kind: "suggestion", index: 1 });
    expect(parseChatInput("/propose")).toEqual({ kind: "propose" });
    expect(parseChatInput("/approve")).toEqual({ kind: "approve" });
    expect(parseChatInput("/cancel")).toEqual({ kind: "cancel" });
    expect(parseChatInput("first\nsecond")).toEqual({ kind: "message", text: "first\nsecond", files: [] });
  });
});

describe("sessions", () => {
  const holder = { place: "terminal", pid: 10 } as const;
  const session = () =>
    newPlanSession({
      id: "plan-1",
      target: { kind: "new-roadmap" },
      summary: "A patient portal for clinics, with booking, results, messages, payments and a lot more besides that",
      holder,
      claudeSessionId: "u-1",
      transcriptPath: "/t/u-1.jsonl",
      now: TIME,
    });

  it("TC-PLAN-046: a new record keeps metadata and only the start of the first message", () => {
    const created = session();
    expect(created).toMatchObject({
      status: "open",
      claudeSessionId: "u-1",
      holder,
      lastPlace: "terminal",
      proposal: null,
    });
    expect(created.summary.length).toBeLessThanOrEqual(80);
    expect(created.summary.endsWith("…")).toBe(true);
    expect(nextPlanId([])).toBe("plan-1");
    expect(nextPlanId(["plan-2", "plan-9", "other"])).toBe("plan-10");
  });

  it("TC-PLAN-049: a session is driven from one place at a time, and a dead holder is taken over", () => {
    const held = session();
    const gui = { place: "gui", pid: 20 } as const;
    expect(takeHold(held, gui, () => true, TIME)).toBe(
      "Planning session plan-1 is open in a terminal (luseen plan). Close it there to continue here.",
    );
    expect(takeHold(held, gui, () => false, TIME)).toMatchObject({ holder: gui, lastPlace: "gui" });
    expect(takeHold(held, holder, () => true, TIME)).toMatchObject({ holder });
    expect(takeHold({ ...held, status: "approved" }, gui, () => false, TIME)).toContain("approved");
    expect(releaseHold(held, { place: "terminal", pid: 20 }, TIME)).toBe(held);
    // The same process ID in another place, as in tests that run both in one process, isn't the holder.
    expect(releaseHold(held, { place: "gui", pid: 10 }, TIME)).toBe(held);
    expect(releaseHold(held, holder, TIME).holder).toBeNull();
  });

  it("TC-PLUG-007: the plugin's tool names give the same planning ID as mcp__luseen__", () => {
    const reply = [{ type: "text", text: JSON.stringify({ status: "ok", planId: "plan-4" }) }];
    expect(planIdOfToolCall("mcp__plugin_luseen_luseen__plan_resume", reply)).toBe("plan-4");
    expect(planIdOfToolCall("mcp__luseen__plan_resume", reply)).toBe("plan-4");
    expect(planIdOfToolCall("mcp__plugin_luseen_luseen__workflow_status", reply)).toBeUndefined();
    expect(isPlanToolCall("mcp__plugin_luseen_luseen__plan_suggest")).toBe(true);
    expect(isPlanToolCall("mcp__plugin_luseen_luseen__workflow_status")).toBe(false);
  });

  it("TC-PLAN-064: a planning tool call names its session, and links the Claude session to it", () => {
    const reply = (body: Record<string, unknown>) => [{ type: "text", text: JSON.stringify(body) }];
    expect(planIdOfToolCall("mcp__luseen__plan_resume", reply({ status: "ok", planId: "plan-4" }))).toBe("plan-4");
    expect(planIdOfToolCall("mcp__luseen__plan_begin", reply({ status: "ok", planId: "plan-7" }))).toBe("plan-7");
    // A refused take, a look or a suggestion from another Claude session never moves the link.
    expect(
      planIdOfToolCall("mcp__luseen__plan_resume", reply({ status: "refused", message: "plan-4 is open in the GUI" })),
    ).toBeUndefined();
    expect(planIdOfToolCall("mcp__luseen__plan_status", reply({ status: "ok", planId: "plan-4" }))).toBeUndefined();
    expect(planIdOfToolCall("mcp__luseen__workflow_status", reply({ planId: "plan-4" }))).toBeUndefined();
    expect(planIdOfToolCall(undefined, undefined)).toBeUndefined();
    const linked = linkClaudeSession(
      { ...session(), claudeSessionId: null, transcriptPath: null },
      { sessionId: "s", transcriptPath: "/p/s.jsonl" },
      TIME,
    );
    expect(linked).toMatchObject({ claudeSessionId: "s", transcriptPath: "/p/s.jsonl", lastPlace: "claude-code" });
    expect(linkClaudeSession(linked, { sessionId: "s", transcriptPath: "/p/s.jsonl" }, TIME)).toBe(linked);
  });

  it("TC-PLAN-061: tool calls read as short activity lines", () => {
    expect(activityOf("Read", { file_path: "/p/.luseen/plans/plan-1/attachments/brief.pdf" })).toBe("Read brief.pdf");
    expect(activityOf("WebSearch", { query: "patient portal GDPR" })).toBe("Searched the web: patient portal GDPR");
    expect(activityOf("Grep", { pattern: "auth" })).toBe("Searched the project: auth");
    expect(activityOf("mcp__luseen__plan_propose", {})).toBe("plan_propose");
    expect(
      activitiesOfEvent({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hi" },
            { type: "tool_use", name: "Read", input: { file_path: "a/b.md" } },
          ],
        },
      }),
    ).toEqual(["Read b.md"]);
    expect(activitiesOfEvent({ type: "result" })).toEqual([]);
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

  it("TC-PLAN-008: the first turn has the skill, docs paths, roadmaps, the target and the message; later ones only the message", () => {
    const prompt = buildFirstTurnPrompt({
      skill: "Follow the PM steps.",
      planId: "plan-3",
      target: { kind: "extend-roadmap", roadmapId: 1 },
      overview,
      overviewPath: ".luseen/sdd/overview.md",
      specsListPath: ".luseen/sdd/README.md",
      message: buildUserMessage("Add exports", [
        { name: "mock.png", kind: "image", readPath: ".luseen/plans/plan-3/attachments/mock.png" },
      ]),
    });
    for (const part of [
      "Follow the PM steps.",
      ".luseen/sdd/overview.md",
      ".luseen/sdd/README.md",
      '"dependsOn":[1]',
      '"status":"open"',
      "EXTEND roadmap 1",
      "plan-3",
      "Add exports",
      "- mock.png (image): .luseen/plans/plan-3/attachments/mock.png",
    ]) {
      expect(prompt, part).toContain(part);
    }
    expect(prompt.startsWith("## The user's first message\n\nAdd exports")).toBe(true);
    expect(userPartOf(prompt)).toBe(
      "Add exports\n\nAttached (new in this message):\n- mock.png (image): .luseen/plans/plan-3/attachments/mock.png",
    );
    const later = buildUserMessage("Also", [{ name: "brief.docx", kind: "document", readPath: "p/brief.docx.md" }]);
    expect(later).toBe("Also\n\nAttached (new in this message):\n- brief.docx (document): p/brief.docx.md");
    expect(later).not.toContain("Follow the PM steps.");
    expect(buildUserMessage("Just text", [])).toBe("Just text");
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

describe("answered turns", () => {
  const at = (minute: number) => `2026-11-14T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const entry = (kind: string, minute: number | null, text = "") => ({
    kind,
    text,
    at: minute === null ? null : at(minute),
  });

  it("TC-PLAN-073: a waiting turn is answered only by a complete reply, or by the conversation moving on", () => {
    const before = [entry("user", 0, "A portal"), entry("assistant", 1, "Who for?")];
    // Stopped before Claude wrote anything: the earlier reply doesn't count.
    expect(isTurnAnswered(before, at(2))).toBe(false);
    // The PM wrote a lead-in, then a tool call, then it was stopped: no complete reply.
    expect(
      isTurnAnswered(
        [...before, entry("user", 2, "Patients"), entry("assistant", 3, "Let me look."), entry("tool-call", 3)],
        at(2),
      ),
    ).toBe(false);
    // Answered later in Claude Code.
    expect(isTurnAnswered([...before, entry("user", 2, "Patients"), entry("assistant", 4, "Noted.")], at(2))).toBe(
      true,
    );
    // The user moved on in Claude Code, even if that turn was stopped too.
    expect(
      isTurnAnswered(
        [...before, entry("user", 2, "Patients"), entry("assistant", 3, "Noted."), entry("user", 4, "Staff too")],
        at(2),
      ),
    ).toBe(true);
    // luseen's own Retry request isn't the user moving on.
    expect(
      isTurnAnswered(
        [
          ...before,
          entry("user", 2, "Patients"),
          entry("user", 3, "Your last turn was stopped. Answer my last message."),
        ],
        at(2),
      ),
    ).toBe(false);
    // Entries with no time can't be placed; another time format still compares as a date.
    expect(isTurnAnswered([entry("user", null, "Patients"), entry("assistant", null, "Noted.")], at(2))).toBe(false);
    expect(isTurnAnswered([{ kind: "assistant", text: "Noted.", at: "2026-11-14T11:00:00+01:00" }], at(1))).toBe(false);
    expect(isTurnAnswered([{ kind: "assistant", text: "Noted.", at: "2026-11-14T11:05:00+01:00" }], at(1))).toBe(true);
    expect(isTurnAnswered(before, null)).toBe(false);
  });

  it("TC-PLAN-074: the waiting message is shown from the session only while the transcript has none of the user's messages since the turn started", () => {
    const before = [entry("user", 0, "Yes"), entry("assistant", 1, "Who for?")];
    // Stopped before Claude wrote the message: it isn't shown yet, even though an earlier answered one had its text.
    expect(isWaitingMessageWritten(before, at(2), "Yes")).toBe(false);
    // A lead-in and a tool call after the message don't hide it.
    expect(
      isWaitingMessageWritten(
        [...before, entry("user", 2, "Yes"), entry("assistant", 3, "Let me look."), entry("tool-call", 3)],
        at(2),
        "Yes",
      ),
    ).toBe(true);
    // luseen's own Retry request isn't the user's message.
    expect(
      isWaitingMessageWritten(
        [...before, entry("user", 3, "Your last turn was stopped. Answer my last message.")],
        at(2),
        "Yes",
      ),
    ).toBe(false);
    // With no turn time, only the newest of the user's messages counts.
    expect(
      isWaitingMessageWritten([...before, entry("user", 2, "Patients"), entry("tool-call", 3)], null, "Patients"),
    ).toBe(true);
    // A Retry request that repeated the message shows it, so a later Retry needn't repeat it again.
    expect(isWaitingMessageWritten([...before, entry("user", 3, answerLastMessage("Yes"))], at(2), "Yes")).toBe(true);
    expect(repeatedMessageOf(answerLastMessage("Yes"))).toBe("Yes");
    expect(repeatedMessageOf(answerLastMessage(null))).toBeNull();
    // The user's words, a Retry request's repeat, and nothing for luseen's other notes.
    expect(shownUserMessage("Patients")).toBe("Patients");
    expect(shownUserMessage(answerLastMessage("Patients"))).toBe("Patients");
    expect(shownUserMessage(answerLastMessage(null))).toBeNull();
    expect(shownUserMessage(PROPOSE_NOW_MESSAGE)).toBeNull();
    // A finished reply after it means the waiting message is a new one with the same text.
    expect(isWaitingMessageWritten(before, null, "Yes")).toBe(false);
    expect(isWaitingMessageWritten(before, null, "Patients")).toBe(false);
  });
});
