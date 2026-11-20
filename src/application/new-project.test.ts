import { describe, expect, it } from "vitest";
import { UsageError } from "../core/errors.js";
import { newPlanSession, type PlanSession, type ProjectState, type RoadmapProposal } from "../core/planning.js";
import {
  approveBrief,
  finishDesign,
  projectSummary,
  takeRoadmapRequest,
  writeProjectDesign,
  writeProjectSpecs,
  type ProjectPorts,
} from "./new-project.js";
import { approveProposal, cancelSession, type DecisionPorts, type PlanRecords } from "./planning-session.js";

const NOW = "2026-11-20T10:00:00.000Z";

function memoryRecords(first: PlanSession): PlanRecords & { readonly deleted: string[] } {
  const sessions = new Map([[first.id, first]]);
  const deleted: string[] = [];
  return {
    deleted,
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
    deleteAttachments: (id) => {
      deleted.push(id);
      return Promise.resolve();
    },
  };
}

function projectSession(project: Partial<ProjectState> = {}, extra: Partial<PlanSession> = {}): PlanSession {
  const made = newPlanSession({
    id: "plan-1",
    target: { kind: "new-project" },
    summary: "A booking app",
    holder: { place: "gui", pid: 1 },
    claudeSessionId: "claude-1",
    transcriptPath: "/t.jsonl",
    now: NOW,
  });
  return { ...made, project: { ...(made.project as ProjectState), ...project }, ...extra };
}

interface FakeProject extends ProjectPorts {
  readonly calls: string[];
  hasSpecs: boolean;
  failSpecs: boolean;
  readmeExists: boolean;
  /** What the design step leaves: a draft, or nothing when it finds no user interface. */
  draftsDesign: boolean;
  designExists: boolean;
}

function fakeProject(records: PlanRecords): FakeProject {
  const calls: string[] = [];
  const fake: FakeProject = {
    calls,
    hasSpecs: false,
    failSpecs: false,
    readmeExists: false,
    draftsDesign: true,
    designExists: false,
    records,
    now: () => NOW,
    writeBrief: (markdown, attachments) => {
      if (fake.readmeExists) return Promise.reject(new UsageError("README.md already exists"));
      calls.push(`brief:${markdown}:${attachments.map((item) => item.name).join(",")}`);
      return Promise.resolve(["README.md", ...attachments.map((item) => `docs/${item.name}`)]);
    },
    hasDocuments: () => fake.hasSpecs,
    writeSpecs: () => {
      calls.push("specs");
      if (fake.failSpecs) return Promise.reject(new Error("Claude's usage limit is reached."));
      fake.hasSpecs = true;
      return Promise.resolve();
    },
    specs: () => ({ folder: ".luseen/sdd", names: fake.hasSpecs ? ["accounts", "booking"] : [] }),
    writeDesign: () => {
      calls.push("design");
      fake.designExists = fake.draftsDesign;
      return Promise.resolve();
    },
    hasDesign: () => fake.designExists,
    approveDesign: () => {
      calls.push("approve-design");
      return Promise.resolve("Approved the design system.");
    },
    discardDesign: () => {
      calls.push("discard-design");
      fake.designExists = false;
      return Promise.resolve();
    },
    firstOpenTaskId: () => 4,
  };
  return fake;
}

const roadmap: RoadmapProposal = {
  roadmap: { title: "First release", goal: "Book visits" },
  milestones: [
    {
      title: "Foundation",
      goal: "App shell",
      tasks: [{ key: "shell", title: "Scaffold", description: "Vite app", spec: "booking", dependsOn: [] }],
    },
  ],
  openQuestions: [],
};

function decisions(records: PlanRecords): DecisionPorts {
  return {
    records,
    readContext: () => ({ overview: { roadmaps: [], unassigned: [] }, tasks: [] }),
    save: () => "Saved roadmap #1. Run it with: luseen auto --roadmap 1",
    now: () => NOW,
  };
}

const ATTACHMENT = {
  name: "spec.pdf",
  kind: "document" as const,
  path: ".luseen/plans/plan-1/attachments/spec.pdf",
  textPath: null,
  sizeBytes: 10,
};

describe("a new project's brief", () => {
  it("TC-PLAN-083: approving the brief writes it with its files, and goes on to the specs", async () => {
    const records = memoryRecords(
      projectSession(
        { brief: { markdown: "# App", hasScreens: true, proposedAt: NOW } },
        { attachments: [ATTACHMENT] },
      ),
    );
    const project = fakeProject(records);
    expect(await approveBrief(project, "plan-1")).toContain("README.md, docs/spec.pdf");
    expect(project.calls).toEqual(["brief:# App:spec.pdf"]);
    expect((await records.read("plan-1"))?.project).toMatchObject({ phase: "specs", brief: null, hasScreens: true });
  });

  it("TC-PLAN-084: an existing README.md refuses the brief, which stays waiting", async () => {
    const records = memoryRecords(projectSession({ brief: { markdown: "# App", hasScreens: false, proposedAt: NOW } }));
    const project = fakeProject(records);
    project.readmeExists = true;
    await expect(approveBrief(project, "plan-1")).rejects.toThrow("README.md already exists");
    expect((await records.read("plan-1"))?.project).toMatchObject({ phase: "brief", brief: { markdown: "# App" } });
  });

  it("refuses when no brief is waiting", async () => {
    const records = memoryRecords(projectSession());
    await expect(approveBrief(fakeProject(records), "plan-1")).rejects.toThrow("No brief is waiting");
  });
});

describe("a new project's specs and roadmap", () => {
  it("TC-PLAN-085: a failed generation keeps the specs step; a later success goes on to the roadmap", async () => {
    const records = memoryRecords(projectSession({ phase: "specs", hasScreens: true }));
    const project = fakeProject(records);
    project.failSpecs = true;
    await expect(writeProjectSpecs(project, "plan-1")).rejects.toThrow("usage limit");
    expect((await records.read("plan-1"))?.project?.phase).toBe("specs");
    project.failSpecs = false;
    await writeProjectSpecs(project, "plan-1");
    expect((await records.read("plan-1"))?.project?.phase).toBe("roadmap");
    expect(project.calls).toEqual(["specs", "specs"]);
  });

  it("specs written meanwhile aren't written again", async () => {
    const records = memoryRecords(projectSession({ phase: "specs" }));
    const project = fakeProject(records);
    project.hasSpecs = true;
    await writeProjectSpecs(project, "plan-1");
    expect(project.calls).toEqual([]);
    expect((await records.read("plan-1"))?.project?.phase).toBe("roadmap");
  });

  it("TC-PLAN-086: the first roadmap is asked for once, naming the specs", async () => {
    const records = memoryRecords(projectSession({ phase: "roadmap" }));
    const project = fakeProject(records);
    project.hasSpecs = true;
    expect(await takeRoadmapRequest(project, "plan-1")).toContain("accounts, booking");
    expect(await takeRoadmapRequest(project, "plan-1")).toBeUndefined();
  });

  it("TC-PLAN-086: an approved roadmap goes on to the design with screens, or finishes without", async () => {
    for (const [hasScreens, phase, status] of [
      [true, "design", "open"],
      [false, "done", "approved"],
    ] as const) {
      const records = memoryRecords(
        projectSession(
          { phase: "roadmap", hasScreens, isRoadmapAsked: true },
          { proposal: { kind: "roadmap", proposal: roadmap, proposedAt: NOW } },
        ),
      );
      const decided = await approveProposal(decisions(records), "plan-1");
      expect(decided.session.project?.phase).toBe(phase);
      expect(decided.session.status).toBe(status);
      expect(decided.session.proposal).toBeNull();
      expect(records.deleted).toEqual(status === "approved" ? ["plan-1"] : []);
    }
  });
});

describe("a new project's design and end", () => {
  it("TC-PLAN-087: approving or skipping the design finishes the setup", async () => {
    for (const isApproved of [true, false]) {
      const records = memoryRecords(projectSession({ phase: "design", hasScreens: true }));
      const project = fakeProject(records);
      const said = await finishDesign(project, "plan-1", isApproved);
      expect(said).toBe(isApproved ? "Approved the design system." : "Skipped the design system.");
      expect(project.calls).toEqual(isApproved ? ["approve-design"] : ["discard-design"]);
      const session = await records.read("plan-1");
      expect(session).toMatchObject({ status: "approved", project: { phase: "done" } });
    }
  });

  it("TC-PLAN-087: a draft waits for the user; no design system at all finishes the setup", async () => {
    const drafted = memoryRecords(projectSession({ phase: "design", hasScreens: true }));
    expect(await writeProjectDesign(fakeProject(drafted), "plan-1")).toBe(true);
    expect((await drafted.read("plan-1"))?.project?.phase).toBe("design");
    const none = memoryRecords(projectSession({ phase: "design", hasScreens: true }));
    const project = fakeProject(none);
    project.draftsDesign = false;
    expect(await writeProjectDesign(project, "plan-1")).toBe(false);
    expect(await none.read("plan-1")).toMatchObject({ status: "approved", project: { phase: "done" } });
    // The summary names a design system only when one was kept.
    expect(projectSummary(project, projectSession({ phase: "done", hasScreens: true }))).not.toContain(
      ".luseen/design",
    );
  });

  it("TC-PLAN-089: a draft already waiting isn't made again when the session is continued", async () => {
    const records = memoryRecords(projectSession({ phase: "design", hasScreens: true }));
    const project = fakeProject(records);
    project.designExists = true;
    expect(await writeProjectDesign(project, "plan-1")).toBe(true);
    expect(project.calls).toEqual([]);
  });

  it("TC-PLAN-088: a step that ends after a cancel never moves the cancelled session on", async () => {
    const records = memoryRecords(projectSession({ phase: "specs" }));
    const project = fakeProject(records);
    project.writeSpecs = async () => {
      await cancelSession(decisions(records), "plan-1", { pid: 1, isRunning: () => true });
      project.hasSpecs = true;
    };
    await expect(writeProjectSpecs(project, "plan-1")).rejects.toThrow("is cancelled");
    expect(await records.read("plan-1")).toMatchObject({ status: "cancelled", project: { phase: "specs" } });
  });

  it("FR-PLAN-051: a second approval that finds the first's README.md says the brief is approved", async () => {
    const records = memoryRecords(projectSession({ brief: { markdown: "# App", hasScreens: false, proposedAt: NOW } }));
    const project = fakeProject(records);
    // The first approval saves its step while the second is writing, which finds the first's README.md.
    project.writeBrief = async () => {
      await records.update("plan-1", (current) => ({
        save: { ...current, project: { ...(current.project as ProjectState), phase: "specs", brief: null } },
        value: undefined,
      }));
      throw new UsageError("README.md already exists");
    };
    expect(await approveBrief(project, "plan-1")).toBe("The brief is already approved.");
  });

  it("TC-PLAN-087: the summary lists what was made and the first task", () => {
    const records = memoryRecords(projectSession());
    const project = fakeProject(records);
    project.hasSpecs = true;
    project.designExists = true;
    const summary = projectSummary(
      project,
      projectSession(
        { phase: "done", hasScreens: true, files: ["README.md", "docs/spec-2.pdf"] },
        { attachments: [ATTACHMENT], outcome: "Saved roadmap #1. Run it with: luseen auto --roadmap 1" },
      ),
    );
    expect(summary).toContain("README.md, docs/spec-2.pdf");
    expect(summary).toContain("accounts, booking");
    expect(summary).toContain("Saved roadmap #1");
    expect(summary).toContain(".luseen/design/");
    expect(summary).toContain('"work on task 4"');
  });

  it("TC-PLAN-088: cancelling at the brief saves nothing; later, it keeps what was written", async () => {
    const by = { pid: 1, isRunning: () => true };
    const atBrief = memoryRecords(projectSession());
    expect((await cancelSession(decisions(atBrief), "plan-1", by)).message).toBe("Cancelled. Nothing was saved.");
    const atRoadmap = memoryRecords(
      projectSession({ phase: "roadmap", files: ["README.md", "docs/spec.pdf"] }, { attachments: [ATTACHMENT] }),
    );
    expect((await cancelSession(decisions(atRoadmap), "plan-1", by)).message).toBe(
      "Cancelled. Kept what was already written: README.md, docs/, .luseen/sdd and the agent setup.",
    );
  });
});
