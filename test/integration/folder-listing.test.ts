import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listFolder } from "../../src/adapters/storage/folder-listing.js";
import { createRunFiles, createRunLister, runFolder } from "../../src/adapters/storage/run-store.js";
import type { RunState } from "../../src/core/automation.js";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import { makeTempFolder } from "../support/helpers.js";

const locked: string[] = [];

afterEach(() => {
  // Unlocked again, so the temporary folders can be removed.
  for (const folder of locked.splice(0)) chmodSync(folder, 0o755);
});

function lockedFolder(folder: string): string {
  mkdirSync(folder, { recursive: true });
  chmodSync(folder, 0o000);
  locked.push(folder);
  return folder;
}

describe("listing folders that may not exist (C1 review follow-up)", () => {
  it("a missing folder, or a file in its place, lists nothing", async () => {
    const root = makeTempFolder();
    expect(await listFolder(path.join(root, "none"))).toEqual({ kind: "listed", names: [] });
    writeFileSync(path.join(root, "file"), "x");
    expect(await listFolder(path.join(root, "file", "below"))).toEqual({ kind: "listed", names: [] });
  });

  it("a folder that can't be read is a problem, not an empty list", async () => {
    const folder = lockedFolder(path.join(makeTempFolder(), "secret"));
    const listing = await listFolder(folder);
    expect(listing.kind).toBe("unreadable");
    expect(listing.kind === "unreadable" ? listing.problem : "").toContain(`${folder} can't be read`);
  });

  it("TC-GUI-014: the workflow store reports an unreadable folder as a problem, which the canvas shows", async () => {
    const root = makeTempFolder();
    lockedFolder(path.join(root, ".cclinic/workflow"));
    const { states, problems } = await openWorkflowStore(root).listReadable();
    expect(states).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("can't be read");
  });
});

describe("a run whose sessions folder can't be read", () => {
  it("TC-GUI-014: the run is listed with no sessions and one problem, instead of hiding the failure", async () => {
    const root = makeTempFolder();
    const runId = "20261111-110000";
    const state: RunState = {
      runId,
      roadmapId: 1,
      roadmapTitle: "Roadmap 1",
      runBranch: `cclinic/auto/${runId}/run`,
      startedAt: "2026-11-11T11:00:00.000Z",
      finishedAt: "2026-11-11T11:30:00.000Z",
      outcome: "completed",
      budgetUsd: 10,
      spentUsd: 1,
      developers: 1,
      tasks: [],
      skippedInProgress: [],
    };
    await createRunFiles(runFolder(root, runId)).saveState(state);
    lockedFolder(path.join(runFolder(root, runId), "sessions"));
    const listing = await createRunLister(root)();
    expect(listing.runs).toHaveLength(1);
    expect(listing.runs[0]?.sessions).toEqual([]);
    expect(listing.problems).toHaveLength(1);
    expect(listing.problems[0]).toContain("can't be read");
  });
});
