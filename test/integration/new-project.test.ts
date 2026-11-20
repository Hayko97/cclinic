/** A new project from an empty folder, in the terminal, with a fake `claude` (roadmap-planning FR-PLAN-047 to 057). */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveDesignSystem } from "../../src/adapters/storage/design-store.js";
import { openPlanStore } from "../../src/adapters/storage/plan-store.js";
import { writeProjectBrief } from "../../src/adapters/storage/project-files.js";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { runGenerate, type GenerateOptions } from "../../src/cli/generate-command.js";
import { isEmptyProject } from "../../src/cli/new-project-ports.js";
import { runPlanCommand } from "../../src/cli/plan-command.js";
import { AgentSessionError, CancelledError } from "../../src/core/errors.js";
import type { PlanSession, RoadmapProposal } from "../../src/core/planning.js";
import { agentHarness, makeTempFolder, writeProject, type FakeClaudeRule } from "../support/helpers.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn(), select: vi.fn(), input: vi.fn() }));
const inputMock = vi.mocked(input);
const selectMock = vi.mocked(select);
const confirmMock = vi.mocked(confirm);

/** The PM, `luseen mcp --plan`, generation and the design step are child processes. */
const SLOW = 120_000;

const isTty = process.stdin.isTTY;
beforeEach(() => {
  process.stdin.isTTY = true;
});
afterEach(() => {
  process.stdin.isTTY = isTty;
  vi.resetAllMocks();
});

const BRIEF = [
  "# Clinic booking",
  "",
  "## What it is",
  "",
  "A web app where patients book visits with a clinic's doctors, and doctors see and manage their day.",
  "",
  "## Who uses it",
  "",
  "- Patient: books, moves and cancels visits",
  "- Doctor: sees the day's visits",
  "",
  "## Main features",
  "",
  "### Booking",
  "",
  "- A visit is 30 minutes",
  "- Cancel up to 2 hours before",
  "",
  "## Stack",
  "",
  "React with TypeScript, Vitest.",
  "",
  "## How we write code",
  "",
  "ESLint, Prettier, a test for every rule.",
  "",
  "## Out of scope for now",
  "",
  "Payments.",
].join("\n");

const ROADMAP: RoadmapProposal = {
  roadmap: { title: "First release", goal: "Patients book visits" },
  milestones: [
    {
      title: "Foundation",
      goal: "A runnable app shell",
      tasks: [
        { key: "shell", title: "Scaffold the app", description: "Vite, lint and tests", spec: null, dependsOn: [] },
        { key: "book", title: "Book a visit", description: "30-minute visits", spec: null, dependsOn: ["shell"] },
      ],
    },
  ],
  openQuestions: [],
};

/** The interview's turn proposes the brief; the roadmap request's turn proposes the roadmap. */
const RULES: FakeClaudeRule[] = [
  {
    match: "The specs are written in",
    message: "Here's the first release.",
    tools: [{ name: "plan_propose", input: { proposal: ROADMAP } }],
  },
  {
    match: "empty folder",
    message: "Here's the brief.",
    tools: [{ name: "brief_propose", input: { markdown: BRIEF, hasScreens: true } }],
  },
];

function emptyProject(): string {
  const root = makeTempFolder();
  mkdirSync(path.join(root, ".git"));
  return root;
}

function typing(...messages: string[]): void {
  for (const message of messages) inputMock.mockResolvedValueOnce(message);
}

async function onlySession(root: string): Promise<PlanSession> {
  const [session] = (await openPlanStore(root).list()).sessions;
  if (session === undefined) throw new Error("No planning session");
  return session;
}

function roadmapTitles(root: string): string[] {
  const store = openTaskStore(path.join(root, ".luseen"), "read");
  try {
    return store?.listRoadmaps().map((roadmap) => roadmap.title) ?? [];
  } finally {
    store?.close();
  }
}

const plan = (root: string, harness: ReturnType<typeof agentHarness>, resume?: string) =>
  runPlanCommand(
    { dir: root, timeoutMinutes: 5, model: "haiku", effort: "low", ...(resume === undefined ? {} : { resume }) },
    harness.context,
  );

describe("an empty folder", () => {
  it("TC-PLAN-080: counts as empty with only excluded files, and not with a README or documents", async () => {
    const root = emptyProject();
    writeProject(root, { "node_modules/x/index.js": "x\n" });
    expect(await isEmptyProject(root)).toBe(true);
    writeProject(root, { "README.md": "# App\n" });
    expect(await isEmptyProject(root)).toBe(false);
  });

  it("TC-PLAN-080: luseen plan in a folder with files but no documents still refuses", async () => {
    const root = emptyProject();
    writeProject(root, { "README.md": "# App\n" });
    await expect(plan(root, agentHarness())).rejects.toThrow("Run luseen in the project folder first");
  });
});

describe("the brief's files", () => {
  it("TC-PLAN-083: the brief becomes README.md, and the files are copied as they are to docs/", async () => {
    const root = emptyProject();
    writeProject(root, { "in/spec.pdf": "%PDF-1.4 bytes", "in/mock.png": "png bytes" });
    const written = await writeProjectBrief(root, BRIEF, [
      { path: "in/spec.pdf", name: "spec.pdf" },
      { path: "in/mock.png", name: "mock.png" },
    ]);
    expect(written).toEqual(["README.md", "docs/spec.pdf", "docs/mock.png"]);
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe(`${BRIEF}\n`);
    expect(readFileSync(path.join(root, "docs/spec.pdf"), "utf8")).toBe("%PDF-1.4 bytes");
    expect(readFileSync(path.join(root, "docs/mock.png"), "utf8")).toBe("png bytes");
  });

  it("TC-PLAN-084: an existing README.md refuses it all, and a name clash is numbered, never overwritten", async () => {
    const root = emptyProject();
    writeProject(root, { "README.md": "mine\n", "in/spec.pdf": "new", "docs/spec.pdf": "old" });
    await expect(writeProjectBrief(root, BRIEF, [{ path: "in/spec.pdf", name: "spec.pdf" }])).rejects.toThrow(
      "README.md already exists",
    );
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe("mine\n");
    rmSync(path.join(root, "README.md"));
    expect(await writeProjectBrief(root, BRIEF, [{ path: "in/spec.pdf", name: "spec.pdf" }])).toEqual([
      "README.md",
      "docs/spec-2.pdf",
    ]);
    expect(readFileSync(path.join(root, "docs/spec.pdf"), "utf8")).toBe("old");
    expect(readFileSync(path.join(root, "docs/spec-2.pdf"), "utf8")).toBe("new");
  });
});

describe("the brief's files, safely", () => {
  it("TC-PLAN-083: a file's name never reaches outside docs/, and one that's only dots is refused, writing nothing", async () => {
    const root = emptyProject();
    writeProject(root, { "in/x.png": "png" });
    expect(await writeProjectBrief(root, BRIEF, [{ path: "in/x.png", name: "../../x.png" }])).toEqual([
      "README.md",
      "docs/x.png",
    ]);
    expect(readFileSync(path.join(root, "docs/x.png"), "utf8")).toBe("png");

    const refused = emptyProject();
    writeProject(refused, { "in/x.png": "png" });
    await expect(writeProjectBrief(refused, BRIEF, [{ path: "in/x.png", name: ".." }])).rejects.toThrow(
      "can't be copied to docs/",
    );
    expect(existsSync(path.join(refused, "README.md"))).toBe(false);
    expect(existsSync(path.join(refused, "docs"))).toBe(false);
  });

  it("TC-PLAN-084: a copy that fails removes what was written, so the brief can be approved again", async () => {
    const root = emptyProject();
    writeProject(root, { "in/a.pdf": "a" });
    await expect(
      writeProjectBrief(root, BRIEF, [
        { path: "in/a.pdf", name: "a.pdf" },
        { path: "in/missing.pdf", name: "missing.pdf" },
      ]),
    ).rejects.toThrow();
    expect(existsSync(path.join(root, "README.md"))).toBe(false);
    expect(existsSync(path.join(root, "docs"))).toBe(false);
  });
});

describe("approving a design system", () => {
  const sections = [
    "Status",
    "Principles",
    "Color",
    "Typography",
    "Spacing and layout",
    "Shape and elevation",
    "Motion",
    "Accessibility",
    "Components",
    "Templates",
    "Decisions",
    "Sources",
    "Open questions",
  ];
  const design = (root: string, tokens: string | undefined) => {
    const markdown = sections.map((name) => `## ${name}\n\n${name === "Status" ? "draft" : "Text."}\n`).join("\n");
    writeProject(root, {
      ".luseen/design/design-system.md": `# Design system\n\n${markdown}`,
      ".luseen/design/style-guide.html": "<!doctype html><title>Style guide</title>",
      ...(tokens === undefined ? {} : { ".luseen/design/design.tokens.json": tokens }),
    });
  };

  it("TC-DSGN-067: a valid draft is approved; one that fails the checks is refused and unchanged", async () => {
    const valid = makeTempFolder();
    design(valid, JSON.stringify({ color: { $type: "color", blue: { $value: "#2563eb" } } }));
    expect(await approveDesignSystem(valid)).toContain("Approved");
    expect(readFileSync(path.join(valid, ".luseen/design/design-system.md"), "utf8")).toContain(
      "## Status\n\napproved\n",
    );
    const invalid = makeTempFolder();
    design(invalid, undefined);
    const before = readFileSync(path.join(invalid, ".luseen/design/design-system.md"), "utf8");
    await expect(approveDesignSystem(invalid)).rejects.toThrow("can't be approved");
    expect(readFileSync(path.join(invalid, ".luseen/design/design-system.md"), "utf8")).toBe(before);
  });
});

describe("a new project in the terminal", () => {
  it(
    "TC-PLAN-083, TC-PLAN-086, TC-PLAN-087, TC-PLAN-090, TC-DSGN-066: interview, brief, specs, roadmap, design, done",
    async () => {
      const root = emptyProject();
      // A file in the folder would make it not empty, so the user's brief is attached from elsewhere.
      const outside = makeTempFolder();
      writeProject(outside, { "brief.md": "# Our idea\n" });
      const harness = agentHarness({ rules: RULES, env: { FAKE_CLAUDE_FALLBACK: "1" } });
      typing(`A booking app for a clinic @${path.join(outside, "brief.md")}`, "/approve", "/approve");
      selectMock.mockResolvedValueOnce(true);
      await plan(root, harness);

      const calls = harness
        .calls()
        .filter((call) => call.args.includes("--session-id") || call.args.includes("--resume"));
      expect(calls[0]?.prompt).toContain("empty folder");
      const sessionId = calls[0]?.args[calls[0].args.indexOf("--session-id") + 1];
      // FR-PLAN-053: the roadmap is asked for in the same Claude session, with no message of the user's.
      const asked = calls.find((call) => call.prompt.startsWith("The specs are written in"));
      expect(asked?.args[asked.args.indexOf("--resume") + 1]).toBe(sessionId);
      expect(asked?.prompt).toContain("Foundation");

      expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe(`${BRIEF}\n`);
      expect(readFileSync(path.join(root, "docs/brief.md"), "utf8")).toBe("# Our idea\n");
      expect(existsSync(path.join(root, ".luseen/sdd/README.md"))).toBe(true);
      expect(existsSync(path.join(root, "AGENTS.md"))).toBe(true);
      expect(existsSync(path.join(root, ".mcp.json"))).toBe(true);
      // FR-PLAN-052: generation sets up no environment and no design itself.
      expect(existsSync(path.join(root, ".luseen/environment"))).toBe(false);
      expect(roadmapTitles(root)).toEqual(["First release"]);
      expect(readFileSync(path.join(root, ".luseen/design/design-system.md"), "utf8")).toContain(
        "## Status\n\napproved",
      );
      expect(vi.mocked(confirm)).not.toHaveBeenCalled();
      const session = await onlySession(root);
      expect(session).toMatchObject({
        status: "approved",
        target: { kind: "new-project" },
        project: { phase: "done" },
      });
      expect(harness.output.out + harness.output.err).toContain('say "work on task 1"');
    },
    SLOW,
  );

  it(
    "TC-PLAN-085, TC-PLAN-089: a failed generation waits at the specs, and resuming continues there",
    async () => {
      const root = emptyProject();
      const failing = agentHarness({
        rules: RULES,
        env: { FAKE_CLAUDE_FALLBACK: "1", FAKE_CLAUDE_MODE: "usage-limit" },
      });
      typing("A booking app for a clinic", "/approve");
      // FR-PLAN-052: the failure is shown with retry; stopping keeps the session at its specs.
      selectMock.mockResolvedValueOnce("later");
      const stopped = plan(root, failing);
      await expect(stopped).rejects.toThrow(AgentSessionError);
      await expect(stopped).rejects.toThrow("luseen plan --resume plan-1");
      expect(selectMock.mock.calls.map((call) => call[0].message)).toEqual([
        "Writing the specs didn't finish. What now?",
      ]);
      selectMock.mockClear();
      const waiting = await onlySession(root);
      expect(waiting.project?.phase).toBe("specs");
      expect(existsSync(path.join(root, "README.md"))).toBe(true);
      expect(existsSync(path.join(root, ".luseen/sdd"))).toBe(false);

      const resumed = agentHarness({ rules: RULES, env: { FAKE_CLAUDE_FALLBACK: "1", FAKE_CLAUDE_DESIGN: "none" } });
      typing("/approve");
      await plan(root, resumed, "plan-1");
      // The brief isn't asked for again: the only PM turn is the roadmap's.
      const turns = resumed.calls().filter((call) => call.args.includes("--resume"));
      expect(turns.map((call) => call.prompt.slice(0, 24))).toEqual(["The specs are written in"]);
      expect(turns[0]?.args).toContain(waiting.claudeSessionId);
      expect(existsSync(path.join(root, ".luseen/sdd/README.md"))).toBe(true);
      expect(roadmapTitles(root)).toEqual(["First release"]);
      // FR-DSGN-041: no design system was made, so there's nothing to approve, and the setup ends.
      expect(selectMock.mock.calls.map((call) => call[0].message)).toEqual([]);
      expect((await onlySession(root)).project?.phase).toBe("done");
    },
    SLOW,
  );

  it(
    "TC-PLAN-087: a failed design step offers retry or skip; skipping finishes the setup with no design system",
    async () => {
      const root = emptyProject();
      const harness = agentHarness({ rules: RULES, env: { FAKE_CLAUDE_FALLBACK: "1", FAKE_CLAUDE_DESIGN: "fail" } });
      typing("A booking app for a clinic", "/approve", "/approve");
      selectMock.mockResolvedValueOnce("retry").mockResolvedValueOnce("skip");
      await plan(root, harness);
      const asked = selectMock.mock.calls.map((call) => (call[0] as { message: string }).message);
      expect(asked).toEqual([
        "Drafting the design system didn't finish. What now?",
        "Drafting the design system didn't finish. What now?",
      ]);
      const choices = selectMock.mock.calls[0]?.[0].choices as readonly { value: string }[];
      expect(choices.map((choice) => choice.value)).toEqual(["retry", "skip", "later"]);
      expect(existsSync(path.join(root, ".luseen/design"))).toBe(false);
      expect(await onlySession(root)).toMatchObject({ status: "approved", project: { phase: "done" } });
      expect(harness.output.out + harness.output.err).not.toContain("The design system in .luseen/design/");
    },
    SLOW,
  );

  it(
    "TC-PLAN-088: cancelling at the brief writes nothing",
    async () => {
      const root = emptyProject();
      const harness = agentHarness({ rules: RULES, env: { FAKE_CLAUDE_FALLBACK: "1" } });
      typing("A booking app for a clinic", "/cancel");
      await plan(root, harness);
      expect(existsSync(path.join(root, "README.md"))).toBe(false);
      expect(existsSync(path.join(root, "docs"))).toBe(false);
      expect(existsSync(path.join(root, ".luseen/sdd"))).toBe(false);
      expect((await onlySession(root)).status).toBe("cancelled");
    },
    SLOW,
  );
});

describe("luseen in an empty folder", () => {
  const options: GenerateOptions = {
    include: [],
    exclude: [],
    cache: true,
    maxFiles: 100,
    maxInputTokens: 2_000_000,
    maxFileSizeMib: 1,
    concurrency: 2,
    timeoutMinutes: 1,
    maxRetries: 0,
  };

  it(
    "TC-CLI-086: no writes nothing; yes starts a new project at its brief",
    async () => {
      const root = emptyProject();
      const harness = agentHarness({ rules: RULES, env: { FAKE_CLAUDE_FALLBACK: "1" } });
      const started: string[] = [];
      const start = async (target: string, resume: string | undefined) => {
        started.push(`${target}:${resume ?? "new"}`);
        await plan(target, harness, resume);
      };
      confirmMock.mockResolvedValueOnce(false);
      await runGenerate(root, options, harness.context, start);
      expect(started).toEqual([]);
      expect(harness.output.out).toContain("Nothing was written.");

      confirmMock.mockResolvedValueOnce(true);
      typing("/cancel");
      await expect(runGenerate(root, options, harness.context, start)).rejects.toThrow(CancelledError);
      expect(started).toEqual([`${realpathSync(root)}:new`]);
      expect(harness.calls()).toEqual([]);
      expect(existsSync(path.join(root, "README.md"))).toBe(false);
    },
    SLOW,
  );
});
