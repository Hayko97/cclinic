/** Reading transcripts: the newest part of a large one, and lines still being written (spec: gui). */
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { locateTranscript, readTranscriptLines } from "../../src/adapters/transcripts/transcript-reader.js";
import { TRANSCRIPT_MAX_READ_BYTES } from "../../src/core/constants/gui.js";
import { makeTempFolder } from "../support/helpers.js";

const line = (text: string) => `${JSON.stringify({ type: "assistant", message: { content: text } })}\n`;

describe("transcript reader", () => {
  it("TC-GUI-114: a transcript larger than the read limit is read from its newest whole line, and says so", async () => {
    const file = path.join(makeTempFolder(), "big.jsonl");
    const filler = line("x".repeat(1_000));
    writeFileSync(file, filler.repeat(Math.ceil(TRANSCRIPT_MAX_READ_BYTES / filler.length) + 10));
    appendFileSync(file, line("newest"));
    const read = await readTranscriptLines(file);
    expect(read.isTruncated).toBe(true);
    expect(read.lines.at(-1)).toBe(line("newest").trim());
    // The first line read is whole: the cut part before it was dropped.
    expect(() => {
      for (const text of read.lines) JSON.parse(text);
    }).not.toThrow();
    expect(read.lines.join("\n").length).toBeLessThanOrEqual(TRANSCRIPT_MAX_READ_BYTES);
  });

  it("TC-GUI-057: a line still being written is left for the next read, and nothing is read twice", async () => {
    const file = path.join(makeTempFolder(), "live.jsonl");
    writeFileSync(file, `${line("one")}{"type":"assistant","mess`);
    const first = await readTranscriptLines(file);
    expect(first.lines).toEqual([line("one").trim()]);
    appendFileSync(file, `age":{"content":"two"}}\n`);
    const second = await readTranscriptLines(file, first.next);
    expect(second.lines).toEqual([line("two").trim()]);
    expect(second.isRestart).toBe(false);
    writeFileSync(file, line("short"));
    const third = await readTranscriptLines(file, second.next);
    expect(third).toMatchObject({ isRestart: true, lines: [line("short").trim()] });
  });

  // Root reads any folder, and Windows has no such permissions, so the error can't be made there.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "TC-GUI-056: a transcript folder that can't be read is reported as an error, not as a missing transcript",
    async () => {
      const projects = path.join(makeTempFolder(), "projects");
      const locked = path.join(projects, "p");
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o000);
      try {
        await expect(locateTranscript(path.join(locked, "s.jsonl"), "s", projects)).rejects.toMatchObject({
          code: "EACCES",
        });
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );
});
