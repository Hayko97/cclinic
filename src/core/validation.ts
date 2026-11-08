/** Checks generated content before anything is saved (FR-OUT-013). Returns problems, and never throws. */
import { DOCUMENT_FILES, SPECS_FOLDER_NAME, SPEC_FILES } from "./constants/paths.js";
import { GUIDELINE_SECTIONS } from "./guidelines-baseline.js";
import type { ExtractedFile, Positioning } from "./ports.js";
import type { GeneratedSpec, ProjectData } from "./schemas.js";

interface FileEntry {
  readonly positioning: Positioning;
  readonly refs: ReadonlySet<string>;
  readonly unitCount: number;
}

export type FileIndex = ReadonlyMap<string, FileEntry>;

export function buildFileIndex(files: readonly ExtractedFile[]): FileIndex {
  return new Map(
    files.map((file) => [
      file.path,
      {
        positioning: file.positioning,
        refs: new Set(file.units.map((unit) => unit.ref)),
        unitCount: file.units.length,
      },
    ]),
  );
}

const POSITION = /^(.+):(\d+)(?:-(\d+))?$/;

/** Returns a problem, or undefined if the citation points at something real. */
export function checkEvidence(evidence: string, index: FileIndex): string | undefined {
  const hash = evidence.indexOf(".docx#");
  if (hash !== -1) {
    const path = evidence.slice(0, hash + ".docx".length);
    const heading = evidence.slice(hash + ".docx#".length);
    const entry = index.get(path);
    if (entry === undefined) return `evidence "${evidence}" cites a file that wasn't analysed`;
    return entry.refs.has(heading) ? undefined : `evidence "${evidence}" cites a heading that doesn't exist`;
  }
  const match = POSITION.exec(evidence);
  if (match === null) return `evidence "${evidence}" isn't in a valid format`;
  const [, path = "", startText = "", endText] = match;
  const entry = index.get(path);
  if (entry === undefined) return `evidence "${evidence}" cites a file that wasn't analysed`;
  const start = Number(startText);
  const end = endText === undefined ? start : Number(endText);
  if (start < 1 || end < start || end > entry.unitCount) {
    return `evidence "${evidence}" is out of range: the file has ${entry.unitCount} ${entry.positioning}s`;
  }
  return undefined;
}

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AREA = /^[A-Z]{2,8}$/;

function checkEvidenceList(
  evidence: readonly string[],
  index: FileIndex,
  owner: string,
  allowsWholeFile = false,
): string[] {
  return evidence.flatMap((item) => {
    // An open question can be about a whole document. A requirement must cite a position (FR-ANA-009).
    if (allowsWholeFile && index.has(item)) return [];
    const problem = checkEvidence(item, index);
    return problem === undefined ? [] : [`${owner}: ${problem}`];
  });
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function idPattern(prefix: string, area: string): RegExp {
  return new RegExp(`^${prefix}-${area}-\\d{3,}$`);
}

/** Checks IDs, coverage and evidence for one spec. */
export function validateSpec(spec: GeneratedSpec, index: FileIndex, retiredIds: readonly string[]): string[] {
  const problems: string[] = [];
  const add = (message: string): void => {
    problems.push(`${spec.name}: ${message}`);
  };
  const requirementIds = spec.requirements.map((requirement) => requirement.id);
  const requirementSet = new Set(requirementIds);
  const allIds = [
    ...requirementIds,
    ...spec.acceptanceCriteria.map((item) => item.id),
    ...spec.testCases.map((item) => item.id),
  ];

  if (spec.requirements.length === 0) add("has no requirements");
  for (const id of findDuplicates(allIds)) add(`duplicate ID ${id}`);
  for (const id of allIds) {
    if (retiredIds.includes(id)) add(`${id} reuses a retired ID`);
  }

  for (const requirement of spec.requirements) {
    if (!idPattern("FR", spec.area).test(requirement.id)) add(`malformed ID ${requirement.id}`);
    if (requirement.evidence.length === 0) add(`${requirement.id} has no evidence`);
    problems.push(...checkEvidenceList(requirement.evidence, index, `${spec.name}: ${requirement.id}`));
  }

  const checkLinks = (id: string, covers: readonly string[], prefix: string): void => {
    if (!idPattern(prefix, spec.area).test(id)) add(`malformed ID ${id}`);
    if (covers.length === 0) add(`${id} covers no requirement`);
    for (const covered of covers) {
      if (!requirementSet.has(covered)) add(`${id} points to unknown ${covered}`);
    }
  };

  for (const item of spec.acceptanceCriteria) {
    checkLinks(item.id, item.covers, "VAL");
    if (item.acceptedWhen.trim() === "") add(`${item.id} has no outcome`);
  }
  for (const item of spec.testCases) {
    checkLinks(item.id, item.covers, "TC");
    if (item.given.trim() === "" || item.when.trim() === "" || item.then.trim() === "") {
      add(`${item.id} needs a Given, When and Then`);
    }
  }

  const coveredByVal = new Set(spec.acceptanceCriteria.flatMap((item) => item.covers));
  const coveredByTc = new Set(spec.testCases.flatMap((item) => item.covers));
  for (const id of requirementIds) {
    if (!coveredByVal.has(id)) add(`${id} has no VAL`);
    if (!coveredByTc.has(id)) add(`${id} has no TC`);
  }
  for (const question of spec.openQuestions) {
    problems.push(...checkEvidenceList(question.evidence, index, `${spec.name}: open question`, true));
  }
  return problems;
}

export function validateProject(project: ProjectData, index: FileIndex): string[] {
  const problems: string[] = [];
  for (const item of project.stack) {
    if (item.evidence.length === 0) problems.push(`stack: ${item.name} has no evidence`);
    problems.push(...checkEvidenceList(item.evidence, index, `stack: ${item.name}`));
  }
  for (const guideline of project.guidelines) {
    if (guideline.label === "observed" && guideline.evidence.length === 0) {
      problems.push(`guidelines: an observed item in "${guideline.section}" has no evidence`);
    }
    problems.push(...checkEvidenceList(guideline.evidence, index, `guidelines: "${guideline.section}"`));
  }
  for (const part of project.architecture.parts) {
    problems.push(...checkEvidenceList(part.evidence, index, `architecture: ${part.name}`));
  }
  for (const question of project.openQuestions) {
    problems.push(...checkEvidenceList(question.evidence, index, "open question", true));
  }
  if (project.specs.length === 0) problems.push("specs: the project has no specs");
  problems.push(...validateSpecEntries(project.specs));
  return problems;
}

export function validateSpecEntries(specs: readonly { name: string; area: string }[]): string[] {
  const problems: string[] = [];
  for (const spec of specs) {
    if (!KEBAB_CASE.test(spec.name)) problems.push(`spec name "${spec.name}" isn't kebab-case`);
    if (!AREA.test(spec.area)) problems.push(`${spec.name}: area "${spec.area}" must be 2 to 8 uppercase letters`);
  }
  for (const name of findDuplicates(specs.map((spec) => spec.name))) problems.push(`duplicate spec name ${name}`);
  for (const area of findDuplicates(specs.map((spec) => spec.area))) problems.push(`duplicate area ${area}`);
  return problems;
}

const MARKDOWN_LINK = /\]\(([^)\s]+\.md)(?:#[^)\s]*)?\)/g;

function resolveLink(from: string, target: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

export function validateRendered(files: ReadonlyMap<string, string>, specNames: readonly string[]): string[] {
  const problems: string[] = [];
  for (const name of specNames) {
    for (const file of Object.values(SPEC_FILES)) {
      const path = `${SPECS_FOLDER_NAME}/${name}/${file}`;
      if (!files.has(path)) problems.push(`${path} is missing`);
    }
  }
  const guidelines = files.get(DOCUMENT_FILES.GUIDELINES) ?? "";
  for (const section of GUIDELINE_SECTIONS) {
    if (!guidelines.includes(`\n## ${section}\n`)) problems.push(`developer-guidelines.md: "${section}" is missing`);
  }
  for (const [path, content] of files) {
    for (const match of content.matchAll(MARKDOWN_LINK)) {
      const target = match[1] ?? "";
      if (/^[a-z]+:/i.test(target)) continue;
      if (!files.has(resolveLink(path, target))) problems.push(`${path}: broken link ${target}`);
    }
  }
  return problems;
}
