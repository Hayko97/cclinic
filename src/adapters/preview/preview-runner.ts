/** Starts the project's local environment for a preview, and leaves it running (FR-MCP-023). */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  PREVIEW_OUTPUT_MAX_CHARS,
  PREVIEW_SETTLE_MS,
  WORKFLOW_FOLDER,
  WORKFLOW_PREVIEW_LOG_PREFIX,
} from "../../core/constants/workflow.js";
import type { EnvironmentFile } from "../../core/environment.js";

export interface PreviewResult {
  readonly isRunning: boolean;
  readonly detail: string;
}

type PartOutcome = { readonly kind: "finished" | "running" } | { readonly kind: "failed"; readonly output: string };

/** A command still going after the settle time is a server, so it's left running on its own. */
async function startPart(command: string, target: string, log: string): Promise<PartOutcome> {
  mkdirSync(path.dirname(log), { recursive: true });
  const output = openSync(log, "w");
  const child = spawn(command, { cwd: target, shell: true, detached: true, stdio: ["ignore", output, output] });
  closeSync(output);
  const exitCode = await new Promise<number | null | "running">((resolve) => {
    const timer = setTimeout(() => {
      resolve("running");
    }, PREVIEW_SETTLE_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  child.unref();
  if (exitCode === "running") return { kind: "running" };
  if (exitCode === 0) return { kind: "finished" };
  const text = await readFile(log, "utf8").catch(() => "");
  return { kind: "failed", output: text.slice(-PREVIEW_OUTPUT_MAX_CHARS) };
}

export async function startPreview(target: string, environment: EnvironmentFile): Promise<PreviewResult> {
  const lines: string[] = [];
  let isRunning = true;
  for (const part of environment.parts) {
    const log = path.join(
      target,
      WORKFLOW_FOLDER,
      `${WORKFLOW_PREVIEW_LOG_PREFIX}${part.name.replace(/[^\w.-]/g, "-")}.log`,
    );
    const outcome = await startPart(part.start, target, log);
    if (outcome.kind === "failed") {
      isRunning = false;
      lines.push(`${part.name}: "${part.start}" failed. Output:\n${outcome.output}`);
      continue;
    }
    const link = part.url ?? part.fallbackUrl;
    lines.push(`${part.name}: ${link === undefined ? "" : `${link}. `}${part.review}`);
  }
  return { isRunning, detail: lines.join("\n") };
}
