/** Turns each format into text with positions. Runs locally, and one bad file never stops the others. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripManagedSection } from "../../core/agent-skills.js";
import { MIN_PDF_CHARS_PER_PAGE } from "../../core/constants/limits.js";
import { MANAGED_INSTRUCTION_FILES } from "../../core/constants/paths.js";
import { extensionOf } from "../../core/exclusion-rules.js";
import type { ContentExtractor, ExtractedFile, ScannedFile, TextUnit } from "../../core/ports.js";

const START_HEADING = "(start)";

function emptyResult(file: ScannedFile, sha256: string, warning: string): ExtractedFile {
  return {
    path: file.path,
    kind: file.kind,
    sha256,
    positioning: "line",
    units: [],
    warnings: [`${file.path}: ${warning}`],
  };
}

function decodeText(bytes: Buffer): { text: string; isValid: boolean } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), isValid: true };
  } catch {
    return { text: bytes.toString("utf8"), isValid: false };
  }
}

export function extractText(file: ScannedFile, bytes: Buffer, sha256: string): ExtractedFile {
  const { text, isValid } = decodeText(bytes);
  const cleaned = text.replace(/^﻿/, "");
  const lines = cleaned.length === 0 ? [] : cleaned.split(/\r?\n/);
  const units = lines.map((line, index) => ({ ref: String(index + 1), text: line }));
  return {
    path: file.path,
    kind: file.kind,
    sha256,
    positioning: "line",
    units,
    warnings: isValid ? [] : [`${file.path}: contains invalid UTF-8, which was replaced`],
  };
}

async function extractPdf(file: ScannedFile, bytes: Buffer, sha256: string): Promise<ExtractedFile> {
  const { getDocument, VerbosityLevel } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({ data: new Uint8Array(bytes), verbosity: VerbosityLevel.ERRORS });
  let document;
  try {
    document = await loadingTask.promise;
  } catch (error) {
    const isEncrypted = error instanceof Error && error.name === "PasswordException";
    return emptyResult(
      file,
      sha256,
      isEncrypted ? "is encrypted or password-protected, so it was skipped" : "is corrupt, so it was skipped",
    );
  }
  try {
    const units: TextUnit[] = [];
    const emptyPages: number[] = [];
    let totalChars = 0;
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : ""))
        .join("")
        .trim();
      totalChars += text.replace(/\s/g, "").length;
      if (text === "") emptyPages.push(number);
      units.push({ ref: String(number), text });
    }
    if (totalChars / Math.max(document.numPages, 1) < MIN_PDF_CHARS_PER_PAGE) {
      return emptyResult(file, sha256, "has no extractable text, and may be a scanned document");
    }
    return {
      path: file.path,
      kind: file.kind,
      sha256,
      positioning: "page",
      units,
      warnings: emptyPages.length === 0 ? [] : [`${file.path}: no text found on pages ${emptyPages.join(", ")}`],
    };
  } finally {
    await loadingTask.destroy();
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<\/(?:td|th)>/g, " | ")
    .replace(/<\/(?:p|tr|li|table)>/g, "\n")
    .replace(/<[^>]{0,2000}>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

const HEADING = /<h[1-6][^>]{0,500}>([\s\S]{0,2000}?)<\/h[1-6]>/g;

export function splitDocxHtml(html: string): TextUnit[] {
  const units: TextUnit[] = [];
  let heading = START_HEADING;
  let position = 0;
  const pushSection = (end: number): void => {
    const text = stripHtml(html.slice(position, end)).trim();
    if (text !== "") units.push({ ref: heading, text });
  };
  for (const match of html.matchAll(HEADING)) {
    pushSection(match.index);
    heading = stripHtml(match[1] ?? "").trim();
    units.push({ ref: heading, text: heading });
    position = match.index + match[0].length;
  }
  pushSection(html.length);
  return units;
}

async function extractDocx(file: ScannedFile, bytes: Buffer, sha256: string): Promise<ExtractedFile> {
  const { default: mammoth } = await import("mammoth");
  try {
    const { value } = await mammoth.convertToHtml({ buffer: bytes });
    return {
      path: file.path,
      kind: file.kind,
      sha256,
      positioning: "heading",
      units: splitDocxHtml(value),
      warnings: [],
    };
  } catch {
    return emptyResult(file, sha256, "is corrupt or encrypted, so it was skipped");
  }
}

export function createExtractor(): ContentExtractor {
  return {
    async extract(file) {
      const original = await readFile(file.absolutePath);
      // cclinic adds a section to these files, which must not count as a project change.
      const bytes = MANAGED_INSTRUCTION_FILES.includes(file.path)
        ? Buffer.from(stripManagedSection(original.toString("utf8")))
        : original;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      try {
        switch (extensionOf(file.path)) {
          case "pdf":
            return await extractPdf(file, bytes, sha256);
          case "docx":
            return await extractDocx(file, bytes, sha256);
          case "doc":
            return emptyResult(file, sha256, "is a legacy .doc file, which isn't supported. Save it as .docx");
          default:
            return extractText(file, bytes, sha256);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        return emptyResult(file, sha256, `couldn't be read: ${reason}`);
      }
    },
  };
}
