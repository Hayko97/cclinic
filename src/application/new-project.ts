/**
 * A new project from an empty folder (spec: roadmap-planning FR-PLAN-047 to FR-PLAN-057): the PM's brief becomes
 * README.md, luseen writes the specs, the PM proposes the first roadmap, and the designer drafts the design system.
 * The same for the terminal and the GUI; each says how the specs and the design step run.
 */
import { BRIEF_FILE } from "../core/constants/agents.js";
import { DESIGN_FOLDER } from "../core/constants/design.js";
import { UsageError } from "../core/errors.js";
import {
  roadmapRequest,
  type PlanSession,
  type ProjectPhase,
  type ProjectState,
  type StoredAttachment,
} from "../core/planning.js";
import type { PlanRecords } from "./planning-session.js";

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
  /** TC-PLAN-087: a skipped draft is removed, so agents don't build UI with a design nobody approved. */
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

/**
 * FR-PLAN-054: drafts the design system; the session stays at its design until the user approves or skips it. A
 * draft already waiting isn't made again (FR-PLAN-048). When the designer finds no user interface (FR-DSGN-041),
 * there's nothing to approve, so the setup ends. True when a draft is waiting.
 */
export async function writeProjectDesign(ports: ProjectPorts, id: string): Promise<boolean> {
  requirePhase(await readSession(ports, id), "design");
  if (ports.hasDesign()) return true;
  await ports.writeDesign();
  if (ports.hasDesign()) return true;
  await finishDesign(ports, id, false);
  return false;
}

/** FR-PLAN-054, FR-PLAN-055: approves or skips the design system, and finishes the setup. */
export async function finishDesign(ports: ProjectPorts, id: string, isApproved: boolean): Promise<string> {
  requirePhase(await readSession(ports, id), "design");
  let decided = "Skipped the design system.";
  if (isApproved) decided = await ports.approveDesign();
  else await ports.discardDesign();
  await changeProject(ports, id, "design", () => ({ phase: "done" }), true);
  await ports.records.deleteAttachments(id);
  return decided;
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
    ...(ports.hasDesign() ? [`- The design system in ${DESIGN_FOLDER}/`] : []),
    "",
    taskId === null
      ? "Next: open a coding agent in this folder and ask it to plan the first task."
      : `Next: open a coding agent in this folder, such as Claude Code, and say "work on task ${taskId}".`,
  ].join("\n");
}
