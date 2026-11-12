/** QA: the workflow store's `update`, used to answer from the GUI under the `cclinic mcp` lock (spec: gui FR-GUI-038). */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { takeLock } from "../../src/adapters/storage/file-lock.js";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import { beginChange, stateKey, withPending, type PendingQuestion } from "../../src/core/workflow.js";
import { makeTempFolder } from "../support/helpers.js";

const NOW = "2026-11-10T09:00:00.000Z";
const G6: PendingQuestion = {
  kind: "gate",
  gate: "G6",
  step: null,
  reason: null,
  question: 'Commit this change to spec "auth"?',
  answers: ["yes", "no"],
  answer: null,
  notes: null,
};

const change = () =>
  withPending(
    beginChange({ changeType: "bug", spec: "auth" }, { key: stateKey(null, "fix-x"), approverMode: "user", now: NOW }),
    G6,
    NOW,
  );

const workflow = (root: string) => path.join(root, ".cclinic/workflow");

describe("QA: workflow store update", () => {
  it("with no workflow folder, decides on nothing and creates no files", async () => {
    const root = makeTempFolder();
    const seen: unknown[] = [];
    const value = await openWorkflowStore(root).update("branch-fix-x", (state) => {
      seen.push(state);
      return { save: change(), value: "decided" };
    });
    expect(value).toBe("decided");
    expect(seen).toEqual([undefined]);
    expect(readdirSync(root)).toEqual([]);
  });

  it("a key not among the saved states writes nothing, even with a save, and leaves no lock", async () => {
    const root = makeTempFolder();
    const store = openWorkflowStore(root);
    await store.save(change());
    const before = readdirSync(workflow(root)).sort();
    const file = path.join(workflow(root), "branch-fix-x.json");
    const content = readFileSync(file, "utf8");
    for (const key of ["branch-other", "../../escape", "branch-fix-x.json"]) {
      const value = await store.update(key, (state) => ({ save: change(), value: state }));
      expect(value).toBeUndefined();
    }
    expect(readdirSync(workflow(root)).sort()).toEqual(before);
    expect(readFileSync(file, "utf8")).toBe(content);
    expect(readdirSync(root).sort()).toEqual([".cclinic"]);
  });

  it("saves the decided state on the change's own file and returns the value", async () => {
    const root = makeTempFolder();
    const store = openWorkflowStore(root);
    await store.save(change());
    const value = await store.update("branch-fix-x", (state) =>
      state === undefined ? { value: 0 } : { save: { ...state, step: "implement" as const }, value: 7 },
    );
    expect(value).toBe(7);
    expect((await store.list()).map((state) => state.step)).toEqual(["implement"]);
  });

  it("no save leaves the file untouched", async () => {
    const root = makeTempFolder();
    const store = openWorkflowStore(root);
    await store.save(change());
    const file = path.join(workflow(root), "branch-fix-x.json");
    const content = readFileSync(file, "utf8");
    await store.update("branch-fix-x", () => ({ value: null }));
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  it("a decide that throws rejects, releases the lock, and the next save and update work", async () => {
    const root = makeTempFolder();
    const store = openWorkflowStore(root);
    await store.save(change());
    await expect(
      store.update("branch-fix-x", () => {
        throw new Error("decide failed");
      }),
    ).rejects.toThrow("decide failed");
    expect(existsSync(path.join(workflow(root), ".state.lock"))).toBe(false);
    await store.save({ ...change(), step: "implement" });
    expect(await store.update("branch-fix-x", (state) => ({ value: state?.step }))).toBe("implement");
  });

  it("waits for the lock another writer holds, then decides on what that writer saved", async () => {
    const root = makeTempFolder();
    const store = openWorkflowStore(root);
    await store.save(change());
    const held = await takeLock(
      path.join(workflow(root), ".state.lock"),
      {},
      { signal: AbortSignal.timeout(5000), staleAfterMs: 60_000 },
    );
    let decided = false;
    const pending = store.update("branch-fix-x", (state) => {
      decided = true;
      return { value: state?.step };
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(decided).toBe(false);
    writeFileSync(
      path.join(workflow(root), "branch-fix-x.json"),
      `${JSON.stringify({ ...change(), step: "qa" }, null, 2)}\n`,
    );
    await held.release();
    expect(await pending).toBe("qa");
  });

  it("parallel updates each see the previous one's save", async () => {
    const root = makeTempFolder();
    const store = openWorkflowStore(root);
    await store.save(change());
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        openWorkflowStore(root).update("branch-fix-x", (state) =>
          state?.pending?.answer === null
            ? { save: { ...state, pending: { ...state.pending, answer: "yes" } }, value: "saved" }
            : { value: "refused" },
        ),
      ),
    );
    expect(results.filter((result) => result === "saved")).toHaveLength(1);
    expect(results.filter((result) => result === "refused")).toHaveLength(4);
  });
});
