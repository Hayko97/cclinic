/**
 * Shapes of Claude's output and the manifest. They stay plain (no patterns or length limits),
 * because providers accept only a subset of JSON Schema. validation.ts checks the rest.
 */
import { z } from "zod";
import { LEGACY_NAME } from "./constants/paths.js";

const evidence = z.array(z.string());

const item = z.object({ statement: z.string(), evidence });

export const moduleSummarySchema = z.object({
  purpose: z.string(),
  capabilities: z.array(z.object({ name: z.string(), description: z.string(), evidence })),
  dataAndInterfaces: z.array(item),
  businessRules: z.array(item),
  technologies: z.array(z.object({ category: z.string(), name: z.string(), version: z.string(), evidence })),
  conventions: z.array(item),
  commands: z.array(z.object({ command: z.string(), purpose: z.string(), evidence })),
});
export type ModuleSummary = z.infer<typeof moduleSummarySchema>;

export const guidelineLabels = ["observed", "recommended"] as const;

const specEntry = z.object({
  name: z.string(),
  area: z.string(),
  goal: z.string(),
  modules: z.array(z.string()),
});
export type SpecEntry = z.infer<typeof specEntry>;

const openQuestion = z.object({ question: z.string(), evidence });
export type OpenQuestion = z.infer<typeof openQuestion>;

export const projectDataSchema = z.object({
  overview: z.object({
    purpose: z.string(),
    users: z.array(z.string()),
    scope: z.array(z.string()),
    nonGoals: z.array(z.string()),
    glossary: z.array(z.object({ term: z.string(), meaning: z.string() })),
  }),
  stack: z.array(z.object({ category: z.string(), name: z.string(), version: z.string(), evidence })),
  architecture: z.object({
    parts: z.array(
      z.object({ name: z.string(), responsibility: z.string(), dependsOn: z.array(z.string()), evidence }),
    ),
    dataFlow: z.array(z.string()),
    externalSystems: z.array(z.string()),
    problems: z.array(z.object({ problem: z.string(), evidence })),
  }),
  guidelines: z.array(
    z.object({ section: z.string(), guidance: z.string(), label: z.enum(guidelineLabels), evidence }),
  ),
  specs: z.array(specEntry),
  openQuestions: z.array(openQuestion),
});
export type ProjectData = z.infer<typeof projectDataSchema>;

export const requirementStatuses = ["confirmed", "code-only", "docs-only"] as const;
export const testLevels = ["unit", "integration", "e2e", "manual"] as const;

const specContentFields = {
  goal: z.string(),
  requirements: z.array(
    z.object({ id: z.string(), statement: z.string(), status: z.enum(requirementStatuses), evidence }),
  ),
  edgeCases: z.array(z.string()),
  nonGoals: z.array(z.string()),
  testSetup: z.array(z.string()),
  acceptanceCriteria: z.array(
    z.object({ id: z.string(), covers: z.array(z.string()), userNeed: z.string(), acceptedWhen: z.string() }),
  ),
  testCases: z.array(
    z.object({
      id: z.string(),
      covers: z.array(z.string()),
      level: z.enum(testLevels),
      given: z.string(),
      when: z.string(),
      then: z.string(),
    }),
  ),
  openQuestions: z.array(openQuestion),
};

export const specContentSchema = z.object(specContentFields);
export type SpecContent = z.infer<typeof specContentSchema>;

/** Used when a spec was too long for one response and must be split (FR-ANA-026). */
export const splitSpecSchema = z.object({
  specs: z.array(z.object({ name: z.string(), area: z.string(), ...specContentFields })),
});

export const generatedSpecsSchema = splitSpecSchema.shape.specs;

export interface GeneratedSpec extends SpecContent {
  readonly name: string;
  readonly area: string;
}

const LEGACY_VERSION_FIELD = `${LEGACY_NAME}Version`;

/** FR-CLI-035: a manifest cclinic wrote names its version `cclinicVersion`. */
function renameLegacyVersion(value: unknown): unknown {
  if (typeof value !== "object" || value === null || "luseenVersion" in value || !(LEGACY_VERSION_FIELD in value))
    return value;
  const { [LEGACY_VERSION_FIELD]: version, ...rest } = value as Record<string, unknown>;
  return { ...rest, luseenVersion: version };
}

export const manifestSchema = z.preprocess(
  renameLegacyVersion,
  z.object({
    luseenVersion: z.string(),
    promptVersion: z.string(),
    generatedAt: z.string(),
    provider: z.string(),
    requestedModel: z.string(),
    actualModels: z.array(z.string()),
    effort: z.string(),
    analysedFiles: z.record(z.string(), z.string()),
    generatedFiles: z.record(z.string(), z.string()),
    specs: z.array(
      z.object({
        name: z.string(),
        area: z.string(),
        ids: z.array(z.object({ id: z.string(), title: z.string() })),
      }),
    ),
    retiredIds: z.array(z.string()),
    newestCommit: z.string().optional(),
  }),
);
export type Manifest = z.infer<typeof manifestSchema>;
