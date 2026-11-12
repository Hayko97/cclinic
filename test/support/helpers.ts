/** Shared test helpers: temp projects, sample documents and a fake LLM provider. */
import type { CanvasPorts } from "../../src/application/gui-canvas.js";
import type { AnswerPorts } from "../../src/application/gui-answers.js";
import { createPlanner, type Planner } from "../../src/application/gui-planning.js";
import { UsageError } from "../../src/core/errors.js";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { afterEach } from "vitest";
import type { CommandContext } from "../../src/cli/command-context.js";
import { createReporter } from "../../src/cli/reporter.js";
import type { LlmProvider, LlmRequest, LlmResult, Logger } from "../../src/core/ports.js";
import { moduleSummarySchema, projectDataSchema, specContentSchema } from "../../src/core/schemas.js";

const temporaryFolders: string[] = [];

afterEach(() => {
  for (const folder of temporaryFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

export function makeTempFolder(): string {
  const folder = mkdtempSync(path.join(tmpdir(), "cclinic-test-"));
  temporaryFolders.push(folder);
  return folder;
}

export function writeProject(root: string, files: Readonly<Record<string, string | Uint8Array>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** A small but valid PDF, with one text string per page. An empty string makes an image-like page. */
export function makePdf(pages: readonly string[]): Uint8Array {
  const objects: string[] = [];
  const pageIds = pages.map((_page, index) => 4 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, index) => {
    const pageId = pageIds[index] ?? 0;
    const stream = text === "" ? "" : `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, id) => {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${object}\nendobj\n`;
  });
  const start = body.length;
  const entries = objects.map((_object, id) => `${String(offsets[id]).padStart(10, "0")} 00000 n \n`).filter(Boolean);
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n${entries.join("")}`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

function makeZip(files: Readonly<Record<string, string>>): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(files).length;
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

export function makeDocx(
  paragraphs: readonly { readonly heading?: boolean; readonly text: string }[],
  tableCells: readonly string[] = [],
): Uint8Array {
  const body = paragraphs
    .map(({ heading, text }) => {
      const style = heading === true ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : "";
      return `<w:p>${style}<w:r><w:t>${text}</w:t></w:r></w:p>`;
    })
    .join("");
  const table =
    tableCells.length === 0
      ? ""
      : `<w:tbl><w:tr>${tableCells.map((cell) => `<w:tc><w:p><w:r><w:t>${cell}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr></w:tbl>`;
  return makeZip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}${table}</w:body></w:document>`,
  });
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, debug: () => undefined };

export function recordingLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  const add = (line: string): void => {
    lines.push(line);
  };
  return { lines, info: add, warn: add, debug: add };
}

function firstEvidence(prompt: string): string[] {
  const content = /<file path="([^"]+)"/.exec(prompt);
  if (content?.[1] !== undefined) return [`${content[1]}:1`];
  const list = /^- (.+)$/m.exec(prompt.slice(prompt.indexOf("Files analysed")));
  return [`${list?.[1] ?? "unknown"}:1`];
}

export function defaultResponse(request: LlmRequest<unknown>): unknown {
  const evidence = firstEvidence(request.prompt);
  if (request.schema === moduleSummarySchema) {
    return {
      purpose: "Does a thing.",
      capabilities: [{ name: "thing", description: "Does the thing", evidence }],
      dataAndInterfaces: [],
      businessRules: [],
      technologies: [],
      conventions: [],
      commands: [],
    };
  }
  if (request.schema === projectDataSchema) {
    return {
      overview: { purpose: "A sample project.", users: ["Developers"], scope: ["Things"], nonGoals: [], glossary: [] },
      stack: [{ category: "Language", name: "TypeScript", version: "6", evidence }],
      architecture: { parts: [], dataFlow: [], externalSystems: [], problems: [] },
      guidelines: [{ section: "Naming", guidance: "Use camelCase.", label: "observed", evidence }],
      specs: [
        { name: "alpha", area: "ALPHA", goal: "Do alpha.", modules: [] },
        { name: "beta", area: "BETA", goal: "Do beta.", modules: [] },
      ],
      openQuestions: [],
    };
  }
  if (request.schema === specContentSchema) {
    const area = /Area code: ([A-Z]+)\./.exec(request.prompt)?.[1] ?? "ALPHA";
    return makeSpecContent(area, evidence);
  }
  throw new Error("FakeLlm has no default response for this schema");
}

export function makeSpecContent(area: string, evidence: readonly string[]) {
  return {
    goal: `Do ${area}.`,
    requirements: [{ id: `FR-${area}-001`, statement: `It must do ${area}.`, status: "code-only", evidence }],
    edgeCases: [],
    nonGoals: [],
    testSetup: [],
    acceptanceCriteria: [
      { id: `VAL-${area}-001`, covers: [`FR-${area}-001`], userNeed: "I need it", acceptedWhen: "It happens" },
    ],
    testCases: [
      {
        id: `TC-${area}-001`,
        covers: [`FR-${area}-001`],
        level: "unit",
        given: "Setup",
        when: "Runs",
        then: "Happens",
      },
    ],
    openQuestions: [],
  };
}

export class FakeLlm implements LlmProvider {
  readonly name = "claude-cli" as const;
  readonly isSubscription = false;
  readonly calls: LlmRequest<unknown>[] = [];
  active = 0;
  maxActive = 0;

  constructor(private readonly handler?: (request: LlmRequest<unknown>, callIndex: number) => unknown) {}

  describeAuth(): Promise<string> {
    return Promise.resolve("fake");
  }

  estimateTokens(text: string): Promise<number> {
    return Promise.resolve(Math.ceil(text.length / 4));
  }

  async generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const data = (await this.handler?.(request, this.calls.length - 1)) ?? defaultResponse(request);
      return {
        data: request.schema.parse(data),
        actualModel: "claude-sonnet-5-5",
        costUsd: 0.01,
        inputTokens: 10,
        outputTokens: 20,
      };
    } finally {
      this.active -= 1;
    }
  }
}

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** A rule for the fake `claude` (see FAKE_CLAUDE_SCRIPT in test/fixtures/fake-claude/claude). */
export interface FakeClaudeRule {
  readonly match?: string;
  readonly times?: number;
  readonly output?: unknown;
  readonly message?: string;
  readonly cost?: number;
  readonly exitCode?: number;
  readonly delayMs?: number;
  readonly hang?: boolean;
  readonly silent?: boolean;
  readonly write?: Readonly<Record<string, string>>;
}

export interface FakeClaudeCall {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly prompt: string;
  /** With `--session-id`: whether the run's session file existed when the agent started. */
  readonly sessionRecorded: boolean | null;
}

/** Runs commands in-process with a fake `claude` on PATH, scripted replies, and captured output. */
export function agentHarness(
  options: { rules?: readonly FakeClaudeRule[]; withClaude?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  const bin = makeTempFolder();
  symlinkSync(process.execPath, path.join(bin, "node"));
  if (options.withClaude !== false) {
    copyFileSync(path.join(REPO_ROOT, "test/fixtures/fake-claude/claude"), path.join(bin, "claude"));
    chmodSync(path.join(bin, "claude"), 0o755);
  }
  const work = makeTempFolder();
  const record = path.join(work, "calls.jsonl");
  const script = path.join(work, "script.json");
  writeFileSync(script, JSON.stringify(options.rules ?? []));
  const home = makeTempFolder();
  const environment: NodeJS.ProcessEnv = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    FAKE_CLAUDE_RECORD: record,
    FAKE_CLAUDE_SCRIPT: script,
    ...options.env,
  };
  const output = { out: "", err: "" };
  const reporter = createReporter({
    quiet: false,
    debug: false,
    color: "never",
    environment,
    stdout: { write: (text: string) => (output.out += text) },
    stderr: { write: (text: string) => (output.err += text) },
  });
  const controller = new AbortController();
  const context: CommandContext = { reporter, environment, signal: controller.signal, version: "0.1.0" };
  const calls = (): FakeClaudeCall[] =>
    existsSync(record)
      ? readFileSync(record, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeClaudeCall)
      : [];
  return { context, controller, environment, output, calls, bin };
}

/** A canvas for GUI tests that don't use it: empty, and never asked to save or read a transcript. */
export const EMPTY_CANVAS: CanvasPorts = {
  readSources: () =>
    Promise.resolve({ overview: { roadmaps: [], unassigned: [] }, runs: [], workflows: [], problems: [] }),
  readLayout: () => Promise.resolve(undefined),
  hasDocuments: () => true,
  updateLayout: () => Promise.resolve(),
  locateTranscript: () => Promise.resolve({ kind: "missing" }),
  readTranscript: () =>
    Promise.resolve({ lines: [], next: { offset: 0, fileId: "" }, isRestart: false, isTruncated: false }),
  readTranscriptTail: () => Promise.resolve({ lines: [], modifiedAt: new Date(0) }),
  now: () => new Date(0),
  every: () => () => undefined,
};

/** No changes to answer, for GUI tests that don't answer questions. */
export const NO_ANSWERS: AnswerPorts = {
  update: (_key, decide) => Promise.resolve(decide(undefined).value),
  now: () => new Date(0),
};

/** A planner for GUI tests that don't plan: every start is refused. */
export const NO_PLANNER: Planner = createPlanner({
  prepare: () => Promise.reject(new UsageError("Planning isn't part of this test.")),
});
