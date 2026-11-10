/** The workflow state store's atomic writes (spec: mcp-server FR-MCP-038). */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import { beginChange, stateKey } from "../../src/core/workflow.js";
import { makeTempFolder } from "../support/helpers.js";

const failure = vi.hoisted(() => ({ isRenameFailing: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (from: string, to: string) =>
      failure.isRenameFailing ? Promise.reject(new Error("rename interrupted")) : actual.rename(from, to),
  };
});

const NOW = "2026-11-10T09:00:00.000Z";

describe("workflow store", () => {
  it("TC-MCP-058: a write whose rename fails leaves the previous state intact", async () => {
    const root = makeTempFolder();
    const store = openWorkflowStore(root);
    const first = beginChange(
      { changeType: "feature", spec: "user-login" },
      { key: stateKey(null, "main"), approverMode: "user", now: NOW },
    );
    await store.save(first);
    const file = path.join(root, ".cclinic/workflow/branch-main.json");
    const before = readFileSync(file, "utf8");
    failure.isRenameFailing = true;
    try {
      await expect(store.save({ ...first, step: "implement" })).rejects.toThrow("rename interrupted");
    } finally {
      failure.isRenameFailing = false;
    }
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(await store.list()).toEqual([first]);
  });
});
