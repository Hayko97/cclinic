/** QA run 3: edge cases of reading whole transcript lines, shared by the full read and the tail (spec: gui). */
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readTranscriptLines, readTranscriptTail } from "../../src/adapters/transcripts/transcript-reader.js";
import { TRANSCRIPT_TAIL_BYTES } from "../../src/core/constants/gui.js";
import { makeTempFolder } from "../support/helpers.js";

const line = (text: string) => `${JSON.stringify({ type: "assistant", message: { content: text } })}\n`;
const transcript = (name: string) => path.join(makeTempFolder(), name);

describe("QA run 3: transcript whole-line reading", () => {
  it("FR-GUI-042: an empty file gives no lines and stays at offset 0", async () => {
    const file = transcript("empty.jsonl");
    writeFileSync(file, "");
    const read = await readTranscriptLines(file);
    expect(read).toMatchObject({ lines: [], next: { offset: 0 }, isRestart: false, isTruncated: false });
    expect((await readTranscriptTail(file)).lines).toEqual([]);
  });

  it("FR-GUI-042: a file with no newline at all gives no lines until the line ends, then gives it once", async () => {
    const file = transcript("partial.jsonl");
    writeFileSync(file, line("only").trimEnd());
    const first = await readTranscriptLines(file);
    expect(first.lines).toEqual([]);
    expect(first.next.offset).toBe(0);
    expect((await readTranscriptTail(file)).lines).toEqual([]);
    appendFileSync(file, "\n");
    const second = await readTranscriptLines(file, first.next);
    expect(second.lines).toEqual([line("only").trim()]);
    const third = await readTranscriptLines(file, second.next);
    expect(third.lines).toEqual([]);
    expect(third.next.offset).toBe(second.next.offset);
  });

  it("FR-GUI-042: reading again with no new bytes gives no lines and keeps the offset", async () => {
    const file = transcript("same.jsonl");
    writeFileSync(file, line("a") + line("b"));
    const first = await readTranscriptLines(file);
    expect(first.lines).toHaveLength(2);
    const again = await readTranscriptLines(file, first.next);
    expect(again).toMatchObject({ lines: [], next: first.next, isRestart: false, isTruncated: false });
  });

  it("FR-GUI-042: blank lines are skipped without moving past unread bytes", async () => {
    const file = transcript("blank.jsonl");
    writeFileSync(file, `${line("a")}\n  \n${line("b")}`);
    const read = await readTranscriptLines(file);
    expect(read.lines).toEqual([line("a").trim(), line("b").trim()]);
    expect(read.next.offset).toBe(Buffer.byteLength(`${line("a")}\n  \n${line("b")}`));
  });

  it("FR-GUI-057: the tail of a file smaller than the tail size has every whole line, and not the unfinished one", async () => {
    const file = transcript("small.jsonl");
    writeFileSync(file, `${line("one")}${line("two")}{"type":"assist`);
    const tail = await readTranscriptTail(file);
    expect(tail.lines).toEqual([line("one").trim(), line("two").trim()]);
    expect(tail.modifiedAt).toBeInstanceOf(Date);
  });

  it("FR-GUI-057: the tail of a file exactly the tail size keeps its first line", async () => {
    const file = transcript("exact.jsonl");
    const head = line("first");
    const pad = line("p".repeat(TRANSCRIPT_TAIL_BYTES - Buffer.byteLength(head) - Buffer.byteLength(line(""))));
    writeFileSync(file, head + pad);
    expect(Buffer.byteLength(head + pad)).toBe(TRANSCRIPT_TAIL_BYTES);
    const tail = await readTranscriptTail(file);
    expect(tail.lines[0]).toBe(head.trim());
    expect(tail.lines).toHaveLength(2);
  });

  it("FR-GUI-057: a tail cut mid-line drops only the cut part, and every line it returns is whole", async () => {
    const file = transcript("cut.jsonl");
    const filler = line("y".repeat(997));
    writeFileSync(file, filler.repeat(Math.ceil(TRANSCRIPT_TAIL_BYTES / filler.length) + 3) + line("newest"));
    const tail = await readTranscriptTail(file);
    expect(tail.lines.at(-1)).toBe(line("newest").trim());
    for (const text of tail.lines) expect(() => void JSON.parse(text)).not.toThrow();
  });

  it("FR-GUI-057: a tail starting exactly on a line boundary returns only whole lines, ending with the newest", async () => {
    const file = transcript("boundary.jsonl");
    const older = line("older");
    const newest = line("newest");
    const pad = line("q".repeat(TRANSCRIPT_TAIL_BYTES - Buffer.byteLength(newest) - Buffer.byteLength(line(""))));
    // The tail starts at the first byte of `pad`, right after the newline that ends `older`.
    writeFileSync(file, older + pad + newest);
    expect(Buffer.byteLength(pad + newest)).toBe(TRANSCRIPT_TAIL_BYTES);
    const tail = await readTranscriptTail(file);
    expect(tail.lines.at(-1)).toBe(newest.trim());
    for (const text of tail.lines) expect(() => void JSON.parse(text)).not.toThrow();
    expect(tail.lines).not.toContain(older.trim());
  });

  it("FR-GUI-057: a tail whose window holds no newline after the cut gives no lines", async () => {
    const file = transcript("long-line.jsonl");
    writeFileSync(file, line("start") + line("z".repeat(TRANSCRIPT_TAIL_BYTES * 2)).trimEnd());
    expect((await readTranscriptTail(file)).lines).toEqual([]);
  });

  it("FR-GUI-042: multibyte text across reads is never split", async () => {
    const file = transcript("utf8.jsonl");
    const text = line("héllo — 日本語 🙂");
    const bytes = Buffer.from(text);
    writeFileSync(file, bytes.subarray(0, 20));
    const first = await readTranscriptLines(file);
    expect(first.lines).toEqual([]);
    appendFileSync(file, bytes.subarray(20));
    const second = await readTranscriptLines(file, first.next);
    expect(second.lines).toEqual([text.trim()]);
  });
});
