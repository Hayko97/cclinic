/** The workflow state's lock on a file system without hard links (spec: mcp-server). */
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import { LOCK_WRITE_GRACE_MS } from "../../src/core/constants/limits.js";
import { beginChange, linkSession, stateKey, type WorkflowState } from "../../src/core/workflow.js";
import { makeTempFolder } from "../support/helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  link: () => Promise.reject(Object.assign(new Error("Operation not permitted"), { code: "EPERM" })),
}));

describe("workflow state lock without hard links", () => {
  it("TC-MCP-071: saves and links still work, and nothing is left behind", async () => {
    const root = makeTempFolder();
    const store = openWorkflowStore(root);
    const state = beginChange(
      { changeType: "feature", spec: "refunds", taskId: 3 },
      { key: stateKey(3, "main"), approverMode: "user", now: "2026-11-11T10:00:00.000Z" },
    );
    await store.save(state);
    await Promise.all(
      ["s1", "s2", "s3"].map((id) =>
        store.updateOpen((open) => linkSession(open, { sessionId: id, transcriptPath: "t" }, "now")),
      ),
    );
    const [saved] = await store.list();
    expect(saved?.sessions.map((session) => session.sessionId).sort()).toEqual(["s1", "s2", "s3"]);
    expect(existsSync(path.join(root, ".luseen/workflow/.state.lock"))).toBe(false);
  });

  it("TC-MCP-071: an empty lock is given time to be written, and replaced once that time has passed", async () => {
    const root = makeTempFolder();
    const store = openWorkflowStore(root);
    await store.save(
      beginChange(
        { changeType: "feature", spec: "refunds", taskId: 3 },
        { key: stateKey(3, "main"), approverMode: "user", now: "2026-11-11T10:00:00.000Z" },
      ),
    );
    const lock = path.join(root, ".luseen/workflow/.state.lock");
    const add = (id: string) => (open: WorkflowState) =>
      linkSession(open, { sessionId: id, transcriptPath: "t" }, "now");
    writeFileSync(lock, "");
    const stopped = new AbortController();
    stopped.abort();
    await expect(store.updateOpen(add("s1"), stopped.signal)).rejects.toThrow("Another luseen process holds");
    expect(readFileSync(lock, "utf8")).toBe("");
    const old = new Date(Date.now() - LOCK_WRITE_GRACE_MS - 1_000);
    utimesSync(lock, old, old);
    await store.updateOpen(add("s2"));
    expect((await store.list())[0]?.sessions.map((session) => session.sessionId)).toEqual(["s2"]);
    expect(existsSync(lock)).toBe(false);
  });
});
