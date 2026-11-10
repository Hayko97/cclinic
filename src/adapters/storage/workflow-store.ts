/** The saved state of each change in `.cclinic/workflow/`, one file per change (FR-MCP-038). */
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { JSON_INDENT } from "../../core/constants/terminal.js";
import { WORKFLOW_FOLDER } from "../../core/constants/workflow.js";
import { UsageError } from "../../core/errors.js";
import { redact } from "../../core/redaction.js";
import { workflowStateSchema, type WorkflowState } from "../../core/workflow.js";
import { ensureIgnoredFolder } from "./document-store.js";

const STATE_EXTENSION = ".json";

export interface WorkflowStore {
  list(): Promise<readonly WorkflowState[]>;
  save(state: WorkflowState): Promise<void>;
}

export function workflowFolder(target: string): string {
  return path.join(target, WORKFLOW_FOLDER);
}

async function readState(file: string): Promise<WorkflowState | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: ReturnType<typeof workflowStateSchema.safeParse> | undefined;
  try {
    parsed = workflowStateSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  if (parsed?.success !== true)
    throw new UsageError(`${file} isn't a readable workflow state. Delete it to start the change again.`);
  return parsed.data;
}

export function openWorkflowStore(target: string): WorkflowStore {
  const folder = workflowFolder(target);
  return {
    list: async () => {
      const names = await readdir(folder).catch(() => []);
      const states = await Promise.all(
        names.filter((name) => name.endsWith(STATE_EXTENSION)).map((name) => readState(path.join(folder, name))),
      );
      return states.filter((state): state is WorkflowState => state !== undefined);
    },
    // Written to a temporary file and renamed, so a failed write leaves the last state whole (FR-MCP-038, FR-MCP-039).
    save: async (state) => {
      // The state and preview logs stay on this machine, so they're never listed or committed as changes.
      await ensureIgnoredFolder(folder);
      const file = path.join(folder, `${state.key}${STATE_EXTENSION}`);
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, `${redact(JSON.stringify(state, null, JSON_INDENT)).text}\n`);
      await rename(temporary, file);
    },
  };
}
