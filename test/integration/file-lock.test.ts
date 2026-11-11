/** The shared file lock: one holder at a time, even when processes start together (FR-CLI-022, FR-AUTO-032, FR-GUI-007). */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock } from "../../src/adapters/storage/document-store.js";
import { takeLock } from "../../src/adapters/storage/file-lock.js";
import { acquireGuiLock } from "../../src/adapters/storage/gui-store.js";
import { acquireRunLock } from "../../src/adapters/storage/run-store.js";
import { GUI_FOLDER, GUI_LOCK_FILE } from "../../src/core/constants/gui.js";
import { UsageError } from "../../src/core/errors.js";
import { makeTempFolder } from "../support/helpers.js";

const ROUNDS = 25;
/** No process has this ID: process IDs are far smaller on every supported system. */
const ENDED_PID = 2 ** 30;

/** Starts two takers at the same moment, and returns how many got the lock, releasing whatever was taken. */
async function race(take: () => Promise<{ release: () => Promise<void> }>): Promise<number> {
  const results = await Promise.allSettled([take(), take()]);
  for (const result of results) {
    if (result.status === "rejected") expect(result.reason).toBeInstanceOf(UsageError);
  }
  const held = results.filter((result) => result.status === "fulfilled");
  for (const result of held) await result.value.release();
  return held.length;
}

describe("file locks", () => {
  it("TC-GUI-110: two GUIs starting at the same moment: exactly one gets the lock", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const root = makeTempFolder();
      expect(await race(() => acquireGuiLock(root))).toBe(1);
    }
  });

  it("TC-AUTO-038: two runs starting at the same moment: exactly one gets the lock", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const root = makeTempFolder();
      expect(await race(async () => ({ release: await acquireRunLock(root, `run-${round}`) }))).toBe(1);
    }
  });

  it("TC-CLI-027: two runs on the same folder at the same moment: exactly one gets the lock", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const lockFile = path.join(makeTempFolder(), ".cclinic/.lock");
      expect(await race(async () => ({ release: await acquireLock(lockFile) }))).toBe(1);
    }
  });

  it("TC-GUI-111: a lock is released only by its own holder", async () => {
    const lockFile = path.join(makeTempFolder(), "gui.lock");
    const first = await takeLock(lockFile, {}, { signal: AbortSignal.timeout(1_000) });
    // Another process took the lock over, for example after this one was thought abandoned.
    const other = JSON.stringify({ pid: process.pid, owner: "someone else" });
    writeFileSync(lockFile, other);
    await first.release();
    expect(readFileSync(lockFile, "utf8")).toBe(other);
  });

  it("TC-CLI-027: a live lock, also in the old bare-process-ID format, refuses a second run", async () => {
    for (const content of [String(process.pid), JSON.stringify({ pid: process.pid })]) {
      const lockFile = path.join(makeTempFolder(), ".lock");
      writeFileSync(lockFile, content);
      await expect(acquireLock(lockFile)).rejects.toThrow(`process ${process.pid}`);
    }
  });

  it("TC-CLI-028: a lock left by a process that has ended, in either format, is replaced", async () => {
    for (const content of [String(ENDED_PID), JSON.stringify({ pid: ENDED_PID })]) {
      const lockFile = path.join(makeTempFolder(), ".lock");
      writeFileSync(lockFile, content);
      const release = await acquireLock(lockFile);
      expect(JSON.parse(readFileSync(lockFile, "utf8"))).toMatchObject({ pid: process.pid });
      await release();
      expect(existsSync(lockFile)).toBe(false);
    }
  });

  // Through the GUI's own lock.
  it("TC-GUI-111: a GUI whose lock was taken over neither rewrites nor removes the other's lock", async () => {
    const root = makeTempFolder();
    const lockFile = path.join(root, GUI_FOLDER, GUI_LOCK_FILE);
    const gui = await acquireGuiLock(root);
    const other = JSON.stringify({ pid: process.pid, owner: "another GUI", port: 9 });
    writeFileSync(lockFile, other);
    await gui.setPort(1234);
    expect(readFileSync(lockFile, "utf8")).toBe(other);
    await gui.release();
    expect(readFileSync(lockFile, "utf8")).toBe(other);
  });

  it("TC-GUI-111: a GUI whose lock was removed doesn't put it back when it records its port", async () => {
    const root = makeTempFolder();
    const lockFile = path.join(root, GUI_FOLDER, GUI_LOCK_FILE);
    const gui = await acquireGuiLock(root);
    rmSync(lockFile);
    await gui.setPort(1234);
    expect(existsSync(lockFile)).toBe(false);
    await gui.release();
  });

  it("TC-GUI-112: a lock path that's a folder is waited on without spinning, then refused with the lock's path", async () => {
    const lockFile = path.join(makeTempFolder(), ".lock");
    mkdirSync(lockFile);
    const waitMs = 400;
    const startedAt = performance.now();
    const cpuBefore = process.cpuUsage();
    await expect(takeLock(lockFile, {}, { signal: AbortSignal.timeout(waitMs) })).rejects.toThrow(lockFile);
    const cpu = process.cpuUsage(cpuBefore);
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(waitMs - 5);
    // A busy loop would use about as much CPU as time passed.
    expect((cpu.user + cpu.system) / 1000).toBeLessThan(elapsedMs / 2);
  });
});
