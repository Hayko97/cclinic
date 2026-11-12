/** Setup in the GUI: the questions generate asks, and how a host agent connects to `cclinic mcp` (spec: gui). Pure. */
import { z } from "zod";
import { MCP_CONFIG_FILE } from "./constants/workflow.js";
import { ENVIRONMENT_CONSENT_MESSAGE } from "./environment.js";
import type { GenerateOptions } from "./gui.js";
import { mergeMcpConfig } from "./mcp-config.js";
import { labelForEffort, labelForModel, parseEffort, parseModel } from "./models.js";

/** What `cclinic --dry-run --json` prints (FR-GUI-016). Only the fields the questions need are read. */
export const dryRunSchema = z.object({
  status: z.literal("dry-run"),
  provider: z.string().nullable(),
  model: z.string(),
  effort: z.string(),
  estimatedTokens: z.number(),
  estimatedCostUsd: z.number().nullable(),
  included: z.array(z.unknown()),
  git: z.object({ status: z.string() }),
});
export type DryRun = z.output<typeof dryRunSchema>;

export interface QuestionAnswer {
  readonly value: string;
  readonly label: string;
}

export interface SetupQuestion {
  readonly id: "cost" | "git" | "environment" | "force";
  readonly text: string;
  readonly answers: readonly QuestionAnswer[];
}

const COST_DECIMALS = 2;
/** A cost below this would show as $0.00, which reads as free. */
const MIN_SHOWN_COST_USD = 0.005;

function summaryOf(dryRun: DryRun): string {
  const model = parseModel(dryRun.model);
  const effort = parseEffort(dryRun.effort);
  const files = dryRun.included.length;
  const using = `${model === undefined ? dryRun.model : labelForModel(model)} at ${
    effort === undefined ? dryRun.effort : labelForEffort(effort)
  } reasoning`;
  const cost =
    dryRun.estimatedCostUsd === null
      ? "It uses your Claude Code subscription."
      : dryRun.estimatedCostUsd < MIN_SHOWN_COST_USD
        ? "Estimated cost: under $0.01."
        : `Estimated cost: $${dryRun.estimatedCostUsd.toFixed(COST_DECIMALS)}.`;
  return `cclinic will analyse ${files} file${files === 1 ? "" : "s"}, about ${dryRun.estimatedTokens.toLocaleString(
    "en-US",
  )} input tokens, with ${using}. ${cost} Continue?`;
}

/**
 * FR-GUI-016: what the CLI would ask before generating, from its dry run. The cost always; Git when a repository
 * would be created; the environment when the form left it open (it needs the skills); and a warning for --force.
 */
export function generateQuestions(options: GenerateOptions, dryRun: DryRun): SetupQuestion[] {
  const questions: SetupQuestion[] = [
    {
      id: "cost",
      text: summaryOf(dryRun),
      answers: [
        { value: "continue", label: "Generate" },
        { value: "cancel", label: "Cancel" },
      ],
    },
  ];
  if (dryRun.git.status === "no-repository" && !options.noGit)
    questions.push({
      id: "git",
      text: "This folder has no Git repository, so cclinic will create a local one. It never commits or pushes.",
      answers: [
        { value: "create", label: "Create it" },
        { value: "no-git", label: "Continue without Git" },
      ],
    });
  if (options.environment === undefined && !options.noSkills)
    questions.push({
      id: "environment",
      text: ENVIRONMENT_CONSENT_MESSAGE,
      answers: [
        { value: "yes", label: "Set it up" },
        { value: "no", label: "Not now" },
      ],
    });
  if (options.force)
    questions.push({
      id: "force",
      text: "--force replaces .cclinic/sdd completely, including any changes made to it by hand.",
      answers: [
        { value: "replace", label: "Replace them" },
        { value: "cancel", label: "Cancel" },
      ],
    });
  return questions;
}

export interface McpInfo {
  readonly file: string;
  /** installed: cclinic's entry is there; changed: someone edited it; missing; or unreadable JSON. */
  readonly status: "installed" | "changed" | "missing" | "unreadable";
  /** What `.mcp.json` holds with cclinic's entry, for a project that has none yet. */
  readonly entry: string;
}

/** The project's `.mcp.json`, as far as it could be read. */
export type McpFile =
  { readonly kind: "missing" } | { readonly kind: "read"; readonly content: string } | { readonly kind: "unreadable" };

/** FR-GUI-018: whether a host agent finds `cclinic mcp`, read from the project's `.mcp.json`. */
export function mcpInfo(file: McpFile): McpInfo {
  const fresh = mergeMcpConfig(undefined);
  const entry = "content" in fresh ? fresh.content : "";
  if (file.kind === "unreadable") return { file: MCP_CONFIG_FILE, status: "unreadable", entry };
  const merged = mergeMcpConfig(file.kind === "read" ? file.content : undefined);
  const status =
    merged.status === "unchanged"
      ? "installed"
      : merged.status === "kept"
        ? "changed"
        : merged.status === "unreadable"
          ? "unreadable"
          : "missing";
  return { file: MCP_CONFIG_FILE, status, entry };
}
