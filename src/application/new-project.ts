/**
 * A new project from an empty folder (spec: roadmap-planning FR-PLAN-047 to FR-PLAN-061): the PM's brief becomes
 * README.md, luseen writes the specs, the PM proposes the first roadmap, and the designer makes the design system.
 * Once the brief is approved, the rest needs no other approval (FR-PLAN-061).
 * The same for the terminal and the GUI; each says how the specs and the design step run.
 */
import { BRIEF_FILE } from "../core/constants/agents.js";
import { DESIGN_SYSTEM_PATH, STYLE_GUIDE_PATH } from "../core/design.js";
import { AgentSessionError, UsageError } from "../core/errors.js";
import {
  roadmapRequest,
  type PlanSession,
  type ProjectPhase,
  type ProjectState,
  type StoredAttachment,
} from "../core/planning.js";
import { approveProposal, type DecisionPorts, type PlanRecords } from "./planning-session.js";

export interface ProjectPorts {
  readonly records: PlanRecords;
  now(): string;
  /**
   * FR-PLAN-051: writes the brief as README.md and copies the attachments to docs/, and returns the files written.
   * Refuses, writing nothing, when README.md exists.
   */
  writeBrief(markdown: string, attachments: readonly StoredAttachment[]): Promise<readonly string[]>;
  /** Whether `.luseen/sdd` exists. */
  hasDocuments(): boolean;
  /** FR-PLAN-052: spec generation; throws with the generation's own message when it fails. */
  writeSpecs(): Promise<void>;
  /** The specs folder, relative to the project, and the generated specs' names. */
  specs(): { readonly folder: string; readonly names: readonly string[] };
  /** FR-PLAN-054: the design step; throws with its message when it fails. */
  writeDesign(): Promise<void>;
  /** Whether the project has a design system, which a failed design step never leaves (FR-DSGN-040). */
  hasDesign(): boolean;
  /** FR-DSGN-044 */
  approveDesign(): Promise<string>;
  /** TC-PLAN-087: a draft left behind is removed, so agents don't build UI with a design that wasn't approved. */
  discardDesign(): Promise<void>;
  /** The first open task of the roadmap the session saved, for the next step (FR-PLAN-055). */
  firstOpenTaskId(): number | null;
}

function projectOf(session: PlanSession) {
  if (session.project === null) throw new UsageError(`Planning session ${session.id} isn't a new project.`);
  return session.project;
}

function requirePhase(session: PlanSession, phase: ProjectPhase): void {
  if (session.status !== "open") throw new UsageError(`Planning session ${session.id} is ${session.status}.`);
  const current = projectOf(session).phase;
  if (current !== phase) throw new UsageError(`Planning session ${session.id} is at "${current}", not "${phase}".`);
}

async function readSession(ports: Pick<ProjectPorts, "records">, id: string): Promise<PlanSession> {
  const session = await ports.records.read(id);
  if (session === undefined) throw new UsageError(`There's no planning session ${id}.`);
  return session;
}

/**
 * Changes the session's project, checked again under the record's lock, so a session cancelled or moved on meanwhile,
 * such as by a step that ended after a cancel, is never changed.
 */
function changeProject(
  ports: Pick<ProjectPorts, "records" | "now">,
  id: string,
  phase: ProjectPhase,
  change: (project: ProjectState) => Partial<ProjectState>,
  close = false,
): Promise<PlanSession> {
  return ports.records.update(id, (current) => {
    requirePhase(current, phase);
    const project = projectOf(current);
    const changed: PlanSession = {
      ...current,
      ...(close ? { status: "approved" as const, holder: null } : {}),
      project: { ...project, ...change(project) },
      updatedAt: ports.now(),
    };
    return { save: changed, value: changed };
  });
}

/** FR-PLAN-051: writes the waiting brief and its files, then the session goes on to its specs. */
export async function approveBrief(ports: ProjectPorts, id: string): Promise<string> {
  const session = await readSession(ports, id);
  requirePhase(session, "brief");
  const brief = projectOf(session).brief;
  if (brief === null) throw new UsageError("No brief is waiting to be approved.");
  let written: readonly string[];
  try {
    written = await ports.writeBrief(brief.markdown, session.attachments);
  } catch (error) {
    // Approved twice at once, the second finds the first's README.md: it was approved, so nothing more is done.
    if (error instanceof UsageError && (await readSession(ports, id)).project?.phase !== "brief")
      return "The brief is already approved.";
    throw error;
  }
  await changeProject(ports, id, "brief", () => ({
    phase: "specs",
    brief: null,
    hasScreens: brief.hasScreens,
    files: [...written],
  }));
  return `Saved ${written.join(", ")}. Next, luseen writes the specs.`;
}

/**
 * FR-PLAN-052: writes the specs, unless they were written meanwhile, then the session goes on to its roadmap. A
 * failure keeps the session at its specs, to try again.
 */
export async function writeProjectSpecs(ports: ProjectPorts, id: string): Promise<void> {
  requirePhase(await readSession(ports, id), "specs");
  if (!ports.hasDocuments()) await ports.writeSpecs();
  await changeProject(ports, id, "specs", () => ({ phase: "roadmap" }));
}

/**
 * FR-PLAN-053: the message that asks the PM for the first roadmap, once; undefined when it was asked for already. The
 * session records it as asked, so a stopped turn is continued with Retry, not asked again.
 */
export async function takeRoadmapRequest(ports: ProjectPorts, id: string): Promise<string | undefined> {
  const session = await readSession(ports, id);
  requirePhase(session, "roadmap");
  if (projectOf(session).isRoadmapAsked || session.proposal !== null) return undefined;
  await changeProject(ports, id, "roadmap", () => ({ isRoadmapAsked: true }));
  const { folder, names } = ports.specs();
  return roadmapRequest(folder, names);
}

/** FR-PLAN-053: the roadmap request is asked again on Retry, such as after its turn stopped (FR-PLAN-058). */
export async function releaseRoadmapRequest(ports: ProjectPorts, id: string): Promise<void> {
  await changeProject(ports, id, "roadmap", () => ({ isRoadmapAsked: false }));
}

/**
 * FR-PLAN-053, FR-PLAN-061: once the PM's roadmap turn has ended, saves the roadmap it proposed, with no approval
 * asked, since approving the brief approved it (FR-PLAN-016). With none proposed, the session stays at its roadmap,
 * and the request is asked again on Retry.
 */
export async function saveProjectRoadmap(ports: ProjectPorts, decisions: DecisionPorts, id: string): Promise<string> {
  const session = await readSession(ports, id);
  requirePhase(session, "roadmap");
  if (session.proposal !== null) {
    try {
      return (await approveProposal(decisions, id)).message;
    } catch (error) {
      // No longer fits what exists, such as a task it depends on that was removed: the PM is asked again on Retry.
      // A roadmap saved but not recorded (an error with a cause) must never be saved twice, so it's left as it is.
      if (!(error instanceof UsageError) || error.cause !== undefined) throw error;
      await ports.records.update(id, (current) => {
        requirePhase(current, "roadmap");
        const next: PlanSession = {
          ...current,
          proposal: null,
          project: { ...projectOf(current), isRoadmapAsked: false },
          updatedAt: ports.now(),
        };
        return { save: next, value: undefined };
      });
      throw new AgentSessionError(`${error.message.replace(" Ask the PM to fix it.", "")} Retry asks the PM again.`, {
        cause: error,
      });
    }
  }
  await releaseRoadmapRequest(ports, id);
  throw new AgentSessionError("The PM ended without proposing the roadmap, so nothing was saved. Retry asks it again.");
}

/**
 * FR-PLAN-054, FR-PLAN-061: makes the design system and approves it, with no approval asked, then finishes the setup.
 * A draft already made isn't made again (FR-PLAN-048). When the designer finds no user interface (FR-DSGN-041),
 * the setup ends with none. A draft that fails the checks is removed, so Retry makes a new one.
 */
export async function writeProjectDesign(ports: ProjectPorts, id: string): Promise<string> {
  requirePhase(await readSession(ports, id), "design");
  if (!ports.hasDesign()) await ports.writeDesign();
  if (!ports.hasDesign()) return continueWithoutDesign(ports, id);
  let approved: string;
  try {
    approved = await ports.approveDesign();
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    await ports.discardDesign();
    throw new AgentSessionError(`The design system didn't pass its checks, so it was removed: ${error.message}`, {
      cause: error,
    });
  }
  await closeSetup(ports, id);
  return approved;
}

/** FR-PLAN-054: after a failed design step, continues without a design system, removing any draft. */
export async function continueWithoutDesign(ports: ProjectPorts, id: string): Promise<string> {
  requirePhase(await readSession(ports, id), "design");
  await ports.discardDesign();
  await closeSetup(ports, id);
  return "Continued without a design system.";
}

/** FR-PLAN-055: the setup is done, and the session approved. */
async function closeSetup(ports: ProjectPorts, id: string): Promise<void> {
  await changeProject(ports, id, "design", () => ({ phase: "done" }), true);
  await ports.records.deleteAttachments(id);
}

/** FR-PLAN-055: what the setup made, and what to do next. */
export function projectSummary(ports: ProjectPorts, session: PlanSession): string {
  const { folder, names } = ports.specs();
  const taskId = ports.firstOpenTaskId();
  const files = session.project?.files ?? [];
  return [
    "The project is set up:",
    `- ${files.length === 0 ? BRIEF_FILE : files.join(", ")}`,
    `- Specs in ${folder}: ${names.join(", ") || "none"}`,
    `- ${session.outcome ?? "No roadmap was saved."}`,
    // FR-PLAN-054, FR-GUI-089: the design system's paths.
    ...(ports.hasDesign() ? [`- The design system: ${DESIGN_SYSTEM_PATH} and ${STYLE_GUIDE_PATH}`] : []),
    "",
    taskId === null
      ? "Next: open a coding agent in this folder and ask it to plan the first task."
      : `Next: open a coding agent in this folder, such as Claude Code, and say "work on task ${taskId}".`,
  ].join("\n");
}
