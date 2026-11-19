/** Repairs what's left wrong in generated content after the retry, without the LLM (FR-ANA-030 to FR-ANA-033). */
import type { OpenQuestion, ProjectData, GeneratedSpec, SpecEntry } from "./schemas.js";
import { checkEvidence, type FileIndex } from "./validation.js";

export interface Repaired<T> {
  readonly value: T;
  readonly repairs: readonly string[];
}

const ID_DIGITS = 3;
const MIN_AREA_LETTERS = 2;
const MAX_AREA_LETTERS = 8;
const FALLBACK_NAME = "spec";
const FALLBACK_AREA = "SPEC";

function idNumber(id: string, prefix: string, area: string): number | undefined {
  const escapedArea = area.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${prefix}-${escapedArea}-(\\d{3,})$`).exec(id);
  return match === null ? undefined : Number(match[1]);
}

/** Gives each malformed, duplicate or retired ID the next unused number. Returns the renames, in order. */
function renumber(
  ids: readonly string[],
  prefix: string,
  area: string,
  retiredIds: readonly string[],
  previousIds: readonly string[],
): { ids: string[]; renames: [string, string][] } {
  // A new number also skips IDs the previous run used, so an ID never changes meaning.
  const taken = [...ids, ...retiredIds, ...previousIds]
    .map((id) => idNumber(id, prefix, area))
    .filter((value) => value !== undefined);
  let next = Math.max(0, ...taken) + 1;
  const seen = new Set<string>();
  const renames: [string, string][] = [];
  const result = ids.map((id) => {
    const isValid = idNumber(id, prefix, area) !== undefined && !retiredIds.includes(id) && !seen.has(id);
    seen.add(id);
    if (isValid) return id;
    const replacement = `${prefix}-${area}-${String(next).padStart(ID_DIGITS, "0")}`;
    next += 1;
    renames.push([id, replacement]);
    return replacement;
  });
  return { ids: result, renames };
}

function keepValidEvidence(
  evidence: readonly string[],
  index: FileIndex,
  owner: string,
  repairs: string[],
  allowsWholeFile = false,
): string[] {
  return evidence.filter((item) => {
    if (allowsWholeFile && index.has(item)) return true;
    const problem = checkEvidence(item, index);
    if (problem !== undefined) repairs.push(`${owner}: removed ${problem}`);
    return problem === undefined;
  });
}

function hasText(...values: readonly string[]): boolean {
  return values.every((value) => value.trim() !== "");
}

export function repairSpec(
  spec: GeneratedSpec,
  index: FileIndex,
  retiredIds: readonly string[],
  previousIds: readonly string[] = [],
): Repaired<GeneratedSpec | undefined> {
  const repairs: string[] = [];
  const note = (message: string): void => {
    repairs.push(`${spec.name}: ${message}`);
  };

  const requirementIds = renumber(
    spec.requirements.map((item) => item.id),
    "FR",
    spec.area,
    retiredIds,
    previousIds,
  );
  const valIds = renumber(
    spec.acceptanceCriteria.map((item) => item.id),
    "VAL",
    spec.area,
    retiredIds,
    previousIds,
  );
  const tcIds = renumber(
    spec.testCases.map((item) => item.id),
    "TC",
    spec.area,
    retiredIds,
    previousIds,
  );
  for (const [from, to] of [...requirementIds.renames, ...valIds.renames, ...tcIds.renames]) {
    note(`renumbered ${from} to ${to}`);
  }
  // Links stay with the first requirement that had an ID, so a duplicate gets none.
  const renamedRequirements = new Map<string, string>();
  for (const [from, to] of requirementIds.renames) {
    if (!requirementIds.ids.includes(from) && !renamedRequirements.has(from)) renamedRequirements.set(from, to);
  }
  const renameCovers = (covers: readonly string[]): string[] =>
    covers.map((covered) => renamedRequirements.get(covered) ?? covered);

  let requirements = spec.requirements.map((item, position) => {
    const id = requirementIds.ids[position] ?? item.id;
    return { ...item, id, evidence: keepValidEvidence(item.evidence, index, `${spec.name}: ${id}`, repairs) };
  });
  const known = new Set(requirements.map((item) => item.id));
  const keepKnown = (id: string, covers: readonly string[]): string[] =>
    renameCovers(covers).filter((covered) => {
      if (!known.has(covered)) note(`removed ${id}'s link to unknown ${covered}`);
      return known.has(covered);
    });

  let acceptanceCriteria = spec.acceptanceCriteria
    .map((item, position) => {
      const id = valIds.ids[position] ?? item.id;
      return { ...item, id, covers: keepKnown(id, item.covers) };
    })
    .filter((item) => {
      const isComplete = item.covers.length > 0 && hasText(item.acceptedWhen);
      if (!isComplete) note(`removed ${item.id}, which had no outcome or covered nothing`);
      return isComplete;
    });
  let testCases = spec.testCases
    .map((item, position) => {
      const id = tcIds.ids[position] ?? item.id;
      return { ...item, id, covers: keepKnown(id, item.covers) };
    })
    .filter((item) => {
      const isComplete = item.covers.length > 0 && hasText(item.given, item.when, item.then);
      if (!isComplete) note(`removed ${item.id}, which had no Given, When and Then or covered nothing`);
      return isComplete;
    });

  const coveredByVal = new Set(acceptanceCriteria.flatMap((item) => item.covers));
  const coveredByTc = new Set(testCases.flatMap((item) => item.covers));
  const unverified = requirements.filter(
    (item) => item.evidence.length === 0 || !coveredByVal.has(item.id) || !coveredByTc.has(item.id),
  );
  const unverifiedIds = new Set(unverified.map((item) => item.id));
  const questions: OpenQuestion[] = unverified.map((item) => {
    note(`moved ${item.id} to the open questions, because it had no valid evidence, VAL or TC`);
    return {
      question: `luseen couldn't verify this ${spec.name} requirement, so it was left out of the spec: "${item.statement}" Is it a real requirement?`,
      evidence: item.evidence,
    };
  });
  requirements = requirements.filter((item) => !unverifiedIds.has(item.id));
  const dropUnverified = <T extends { covers: string[] }>(items: T[]): T[] =>
    items
      .map((item) => ({ ...item, covers: item.covers.filter((covered) => !unverifiedIds.has(covered)) }))
      .filter((item) => item.covers.length > 0);
  acceptanceCriteria = dropUnverified(acceptanceCriteria);
  testCases = dropUnverified(testCases);

  const openQuestions = [
    ...spec.openQuestions.map((item) => ({
      ...item,
      evidence: keepValidEvidence(item.evidence, index, `${spec.name}: open question`, repairs, true),
    })),
    ...questions,
  ];

  if (requirements.length === 0) {
    note("removed the spec, because none of its requirements could be verified");
    return { value: undefined, repairs };
  }
  return { value: { ...spec, requirements, acceptanceCriteria, testCases, openQuestions }, repairs };
}

/** The open question recorded for a spec that had nothing left after repair (FR-ANA-032). */
export function removedSpecQuestion(entry: Pick<SpecEntry, "name" | "goal">): OpenQuestion {
  return {
    question: `luseen couldn't produce a verified spec for "${entry.name}" (${entry.goal}), so it was left out. Which requirements does it have?`,
    evidence: [],
  };
}

function toKebabCase(name: string): string {
  const kebab = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab === "" ? FALLBACK_NAME : kebab;
}

function toArea(area: string, name: string): string {
  const letters = area.toUpperCase().replace(/[^A-Z]/g, "");
  const fromName = name.toUpperCase().replace(/[^A-Z]/g, "");
  const candidate = letters.length >= MIN_AREA_LETTERS ? letters : fromName;
  return candidate.length >= MIN_AREA_LETTERS ? candidate.slice(0, MAX_AREA_LETTERS) : FALLBACK_AREA;
}

function unique(value: string, used: Set<string>, variant: (value: string, attempt: number) => string): string {
  let candidate = value;
  let attempt = 1;
  while (used.has(candidate)) {
    attempt += 1;
    candidate = variant(value, attempt);
  }
  used.add(candidate);
  return candidate;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Areas allow letters only, so the variant ends in letters counted like A, B, ... Z, BA, BB. */
function areaVariant(area: string, attempt: number): string {
  let suffix = "";
  for (let rest = attempt; rest > 0; rest = Math.floor(rest / ALPHABET.length)) {
    suffix = ALPHABET.charAt(rest % ALPHABET.length) + suffix;
  }
  return `${area.slice(0, Math.max(MIN_AREA_LETTERS, MAX_AREA_LETTERS - suffix.length))}${suffix}`.slice(
    0,
    MAX_AREA_LETTERS,
  );
}

/** Makes spec names kebab-case and unique, and areas 2 to 8 uppercase letters and unique. */
export function repairSpecEntries<T extends { name: string; area: string }>(entries: readonly T[]): Repaired<T[]> {
  const repairs: string[] = [];
  const names = new Set<string>();
  const areas = new Set<string>();
  const value = entries.map((entry) => {
    const name = unique(toKebabCase(entry.name), names, (base, attempt) => `${base}-${attempt}`);
    const area = unique(toArea(entry.area, name), areas, areaVariant);
    if (name !== entry.name) repairs.push(`renamed spec "${entry.name}" to "${name}"`);
    if (area !== entry.area) repairs.push(`${name}: changed area "${entry.area}" to "${area}"`);
    return { ...entry, name, area };
  });
  return { value, repairs };
}

export function repairProject(project: ProjectData, index: FileIndex): Repaired<ProjectData> {
  const repairs: string[] = [];
  const stack = project.stack
    .map((item) => ({ ...item, evidence: keepValidEvidence(item.evidence, index, `stack: ${item.name}`, repairs) }))
    .filter((item) => {
      if (item.evidence.length === 0) repairs.push(`stack: removed ${item.name}, which had no valid evidence`);
      return item.evidence.length > 0;
    });
  const guidelines = project.guidelines.map((item) => {
    const evidence = keepValidEvidence(item.evidence, index, `guidelines: "${item.section}"`, repairs);
    if (item.label !== "observed" || evidence.length > 0) return { ...item, evidence };
    repairs.push(`guidelines: labelled an item in "${item.section}" recommended, because it had no valid evidence`);
    return { ...item, label: "recommended" as const, evidence };
  });
  const parts = project.architecture.parts.map((part) => ({
    ...part,
    evidence: keepValidEvidence(part.evidence, index, `architecture: ${part.name}`, repairs),
  }));
  const openQuestions = project.openQuestions.map((item) => ({
    ...item,
    evidence: keepValidEvidence(item.evidence, index, "open question", repairs, true),
  }));
  const specs = repairSpecEntries(project.specs);
  return {
    value: {
      ...project,
      stack,
      guidelines,
      architecture: { ...project.architecture, parts },
      openQuestions,
      specs: specs.value,
    },
    repairs: [...repairs, ...specs.repairs],
  };
}
