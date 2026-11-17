/** Values for the design system and its setup step (spec: ui-design). */
import { SECRET_FILES } from "./environment.js";
import { TOOL_FOLDER_NAME } from "./paths.js";

export const UI_DESIGN_SKILL_NAME = "ui-design";
export const DESIGN_FOLDER = `${TOOL_FOLDER_NAME}/design`;
export const DESIGN_SYSTEM_FILE = "design-system.md";
export const DESIGN_TOKENS_FILE = "design.tokens.json";
export const STYLE_GUIDE_FILE = "style-guide.html";
/** The old design system is kept here while `luseen design --force` makes a new one (FR-DSGN-032). */
export const DESIGN_PREVIOUS_FOLDER = "previous";

/** The sections of design-system.md, in order (FR-DSGN-008). */
export const DESIGN_SECTIONS = [
  "Status",
  "Principles",
  "Color",
  "Typography",
  "Spacing and layout",
  "Shape and elevation",
  "Motion",
  "Accessibility",
  "Components",
  "Templates",
  "Decisions",
  "Sources",
  "Open questions",
] as const;
export const DESIGN_STATUSES = ["draft", "approved"] as const;

/** Environment part types with screens; `cli` and `library` have none (FR-DSGN-024). */
export const UI_PART_TYPES: readonly string[] = ["web", "ios", "android", "desktop"];

export const DESIGN_TIMEOUT_MS = 900_000;
export const DESIGN_MAX_BUDGET_USD = 2;

export const DESIGN_AGENT_TOOLS: readonly string[] = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Write", "Edit"];

/** No shell, and writes only in the design folder (FR-DSGN-028). */
export const DESIGN_AGENT_ALLOWED_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  `Write(./${DESIGN_FOLDER}/**)`,
  `Edit(./${DESIGN_FOLDER}/**)`,
];

export const DESIGN_AGENT_DENIED_TOOLS: readonly string[] = ["Bash", ...SECRET_FILES.map((file) => `Read(**/${file})`)];

/** The designer agent, in the plugin and in `.claude/agents/` (FR-DSGN-038, FR-DSGN-039). */
export const DESIGNER_AGENT_NAME = "designer";
export const DESIGNER_AGENT_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Bash",
  "WebSearch",
  "WebFetch",
];
export const CLAUDE_AGENTS_FOLDER = ".claude/agents";
