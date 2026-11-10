/** The MCP server through a real MCP client, connected in memory (spec: mcp-server). */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scanFolder } from "../../src/adapters/discovery/file-walker.js";
import { createExtractor } from "../../src/adapters/extraction/extract.js";
import { openTaskStore } from "../../src/adapters/storage/task-store.js";
import { openWorkflowStore } from "../../src/adapters/storage/workflow-store.js";
import { answerPending } from "../../src/core/workflow.js";
import { installSkills } from "../../src/adapters/storage/skill-installer.js";
import { createProjectServer } from "../../src/cli/mcp-command.js";
import { runClean } from "../../src/cli/other-commands.js";
import { createReporter } from "../../src/cli/reporter.js";
import { holdsOnlyCclinicServer, stripCclinicServer } from "../../src/core/mcp-config.js";
import { makeTempFolder, writeProject } from "../support/helpers.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

const SPEC = "user-login";
const SPEC_FILES = {
  [`.cclinic/sdd/specs/${SPEC}/spec.md`]: "# user-login\n\n| FR-AUTH-001 | lock |\n",
  [`.cclinic/sdd/specs/${SPEC}/validation.md`]: "# validation\n",
  [`.cclinic/sdd/specs/${SPEC}/verification.md`]: "# verification\n",
  ".cclinic/sdd/README.md": "# SDD documentation\n\n| [user-login](specs/user-login/spec.md) |\n",
};
const FINDINGS = { blocking: 0, shouldFix: 1, nit: 0 };
const context = {
  reporter: createReporter({
    quiet: true,
    debug: false,
    color: "never",
    environment: {},
    stdout: { write: () => true },
    stderr: { write: () => true },
  }),
  environment: process.env,
  signal: new AbortController().signal,
  version: "0.1.0",
};

/** A Git project on `main` with generated docs, one spec, and tasks with the given dependencies. */
function makeProject(tasks: readonly (readonly number[])[] = []): string {
  const root = makeTempFolder();
  writeProject(root, SPEC_FILES);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  if (tasks.length > 0) {
    const store = openTaskStore(path.join(root, ".cclinic"), "create");
    tasks.forEach((dependsOn, index) =>
      store?.addTask({ title: `T${index + 1}`, spec: SPEC, dependsOn: [...dependsOn] }),
    );
    store?.close();
  }
  return root;
}

/** An answer, "answer|notes", or "decline" or "cancel". */
type Answer = string;
const open: Client[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
});

/** Connects a client. With answers, it supports elicitation and answers each question in turn ("answer|notes"). */
async function connect(root: string, answers?: Answer[]) {
  const server = await createProjectServer({ dir: root, approver: "user" }, context);
  const client = new Client(
    { name: "test", version: "1.0.0" },
    { capabilities: answers === undefined ? {} : { elicitation: {} } },
  );
  const asked: { message: string; answers: unknown }[] = [];
  if (answers !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      if (!("requestedSchema" in request.params)) throw new Error("Expected a form question");
      const answerField = request.params.requestedSchema.properties["answer"];
      asked.push({
        message: request.params.message,
        answers: answerField && "enum" in answerField ? answerField.enum : undefined,
      });
      const next = answers.shift() ?? "cancel";
      if (next === "decline" || next === "cancel") return { action: next };
      const [answer, notes] = next.split("|");
      return { action: "accept", content: { answer, ...(notes === undefined ? {} : { notes }) } };
    });
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  open.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    const text = content[0]?.text ?? "";
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { message: text };
    }
    return { ...body, isError: result.isError === true };
  };
  return { client, call, asked };
}

/** Drives a feature change to the given step, answering each gate as asked. */
async function driveTo(call: Awaited<ReturnType<typeof connect>>["call"], step: string, taskId?: number) {
  await call("workflow_begin", { changeType: "feature", spec: SPEC, ...(taskId === undefined ? {} : { taskId }) });
  const order = ["implement", "qa", "review", "preview", "approval"];
  for (const next of order) {
    if (next === "review") await call("qa_report", { passed: true });
    if (next === "preview") await call("review_report", { verdict: "approve", findings: FINDINGS });
    if (next === "approval") await call("preview_start");
    await call("workflow_advance", { to: next });
    if (next === step) return;
  }
}

function statusOf(root: string, id: number): string | undefined {
  const store = openTaskStore(path.join(root, ".cclinic"), "read");
  const status = store?.getTask(id)?.status;
  store?.close();
  return status;
}

describe("tools and resources", () => {
  it("TC-MCP-010: offers exactly the 17 tools and 3 resources, and reads a spec", async () => {
    const { client } = await connect(makeProject());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "workflow_status",
        "workflow_begin",
        "workflow_advance",
        "workflow_skip",
        "workflow_reset",
        "workflow_resume",
        "tasks_list",
        "task_get",
        "task_next",
        "task_start",
        "task_block",
        "task_add",
        "qa_handoff",
        "qa_report",
        "review_report",
        "preview_start",
        "auto_status",
      ].sort(),
    );
    expect((await client.listResources()).resources.map((resource) => resource.uri).sort()).toEqual([
      "cclinic://roadmap",
      "cclinic://specs",
    ]);
    expect((await client.listResourceTemplates()).resourceTemplates.map((item) => item.uriTemplate)).toEqual([
      "cclinic://specs/{name}",
    ]);
    const spec = await client.readResource({ uri: `cclinic://specs/${SPEC}` });
    const text = (spec.contents[0] as { text: string }).text;
    expect(text).toContain("FR-AUTH-001");
    expect(text).toContain("# validation");
    expect(text).toContain("# verification");
    const roadmap = await client.readResource({ uri: "cclinic://roadmap" });
    expect((roadmap.contents[0] as { text: string }).text).toBeTypeOf("string");
  });

  it("TC-MCP-011: invalid input names the field and changes nothing", async () => {
    const root = makeProject([[]]);
    const { call } = await connect(root);
    const empty = await call("task_add", { title: "" });
    expect(empty.isError).toBe(true);
    expect(JSON.stringify(empty)).toMatch(/title/);
    const badId = await call("task_start", { id: "abc" });
    expect(badId.isError).toBe(true);
    expect(JSON.stringify(badId)).toMatch(/id/);
    expect(statusOf(root, 1)).toBe("open");
    expect(statusOf(root, 2)).toBeUndefined();
  });

  it("TC-MCP-015: task tools match the task commands, and task_block records its reason", async () => {
    const root = makeProject([[], [1], [2]]);
    const store = openTaskStore(path.join(root, ".cclinic"), "update");
    store?.setStatus(1, "done");
    store?.close();
    const { call } = await connect(root);
    await call("workflow_begin", { changeType: "feature", spec: SPEC, taskId: 2 });
    const listed = await call("tasks_list");
    expect((listed["tasks"] as { id: number }[]).map((task) => task.id)).toEqual([2, 3]);
    expect(await call("task_get", { id: 2 })).toMatchObject({ task: { id: 2, dependsOn: [1] } });
    expect(await call("task_next")).toMatchObject({ task: { id: 2 } });
    expect(await call("task_start", { id: 2 })).toMatchObject({ task: { status: "in-progress" } });
    expect(await call("task_add", { title: "New", spec: SPEC })).toMatchObject({ task: { id: 4, title: "New" } });
    expect(await call("task_block", { id: 3, reason: "waiting on design" })).toMatchObject({
      task: { status: "blocked" },
    });
    const saved = readFileSync(path.join(root, ".cclinic/workflow/task-2.json"), "utf8");
    expect(saved).toContain("waiting on design");
  });

  it("TC-MCP-016: task_next returns none when every task is done", async () => {
    const root = makeProject([[]]);
    const store = openTaskStore(path.join(root, ".cclinic"), "update");
    store?.setStatus(1, "done");
    store?.close();
    const { call } = await connect(root);
    expect(await call("task_next")).toMatchObject({ task: null });
  });

  it("TC-MCP-017: refuses a task a running automated run holds", async () => {
    const root = makeProject([[], []]);
    writeProject(root, {
      ".cclinic/auto/.lock": JSON.stringify({ pid: process.pid, runId: "R1" }),
      ".cclinic/auto/R1/run.json": JSON.stringify({ runId: "R1", tasks: [{ taskId: 2, status: "running" }] }),
    });
    const { call } = await connect(root);
    const reply = await call("task_start", { id: 2 });
    expect(reply).toMatchObject({ isError: true });
    expect(reply["message"]).toContain("R1");
    expect(statusOf(root, 2)).toBe("open");
    expect(await call("task_start", { id: 1 })).toMatchObject({ task: { status: "in-progress" } });
  });

  it("TC-MCP-019: qa_handoff returns the spec's files and the changed files", async () => {
    const root = makeProject();
    const { call } = await connect(root, ["approve"]);
    await driveTo(call, "qa");
    writeFileSync(path.join(root, "a.ts"), "a");
    writeFileSync(path.join(root, "b.ts"), "b");
    const handoff = await call("qa_handoff");
    expect((handoff["specFiles"] as { file: string }[]).map((item) => item.file)).toEqual([
      "spec.md",
      "validation.md",
      "verification.md",
    ]);
    expect(handoff["changedFiles"]).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));
  });

  it("TC-MCP-020: auto_status reads the latest run, or the one named, and changes nothing", async () => {
    const root = makeProject();
    const run = (runId: string, spentUsd: number) =>
      JSON.stringify({
        runId,
        outcome: "partial",
        budgetUsd: 5,
        spentUsd,
        tasks: [{ taskId: 1, title: "T1", status: "done", rounds: {}, costUsd: 1, reason: null }],
      });
    writeProject(root, {
      ".cclinic/auto/20260101-000000/run.json": run("20260101-000000", 1),
      ".cclinic/auto/20260201-000000/run.json": run("20260201-000000", 2),
    });
    const before = readdirSync(path.join(root, ".cclinic/auto"));
    const { call } = await connect(root);
    expect(await call("auto_status")).toMatchObject({ run: { runId: "20260201-000000", spentUsd: 2 } });
    expect(await call("auto_status", { runId: "20260101-000000" })).toMatchObject({ run: { spentUsd: 1 } });
    expect(readdirSync(path.join(root, ".cclinic/auto"))).toEqual(before);
  });

  it("TC-MCP-021: auto_status says there's no run", async () => {
    const { call } = await connect(makeProject());
    expect(await call("auto_status")).toMatchObject({ isError: false, run: null });
  });
});

describe("steps and gates", () => {
  it("TC-MCP-012: workflow_status reports the step, counts and the user's decision", async () => {
    const { call } = await connect(makeProject([[]]), ["approve"]);
    await driveTo(call, "qa", 1);
    await call("qa_report", { passed: false, failures: ["TC-AUTH-001"] });
    expect(await call("workflow_status")).toMatchObject({
      change: {
        step: "qa",
        taskId: 1,
        spec: SPEC,
        changeType: "feature",
        qaRunsUsed: 1,
        codeReviewsUsed: 0,
        approverMode: "user",
        decisions: [{ gate: "G1", answer: "approve", approver: "user" }],
        skips: [],
      },
    });
  });

  it("TC-MCP-014: refuses a second change while one is open", async () => {
    const { call } = await connect(makeProject());
    await call("workflow_begin", { changeType: "feature", spec: SPEC });
    const second = await call("workflow_begin", { changeType: "bug", spec: SPEC });
    expect(second).toMatchObject({ isError: true });
    expect(second["message"]).toContain("branch-main");
  });

  it("TC-MCP-018: a task becomes done only when the change is approved", async () => {
    const root = makeProject([[]]);
    const { client, call } = await connect(root, ["approve", "approve"]);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.filter((name) => /done/.test(name))).toEqual([]);
    await driveTo(call, "approval", 1);
    await call("task_start", { id: 1 });
    expect(statusOf(root, 1)).toBe("in-progress");
    await call("workflow_advance", { to: "commit" });
    expect(statusOf(root, 1)).toBe("done");
  });

  it("TC-MCP-023: refuses G1 while a spec file is missing, without asking", async () => {
    const root = makeProject();
    const { call, asked } = await connect(root, ["approve"]);
    await call("workflow_begin", { changeType: "feature", spec: "new-spec" });
    writeProject(root, {
      ".cclinic/sdd/specs/new-spec/spec.md": "x",
      ".cclinic/sdd/specs/new-spec/verification.md": "x",
    });
    const reply = await call("workflow_advance", { to: "implement" });
    expect(reply).toMatchObject({ isError: true });
    expect(reply["message"]).toContain("validation.md");
    expect(asked).toEqual([]);
  });

  it("TC-MCP-024: refine returns the notes, review-doc limits the next answers, approve moves on", async () => {
    const { call, asked } = await connect(makeProject(), ["refine|add an error case", "review-doc", "approve"]);
    await call("workflow_begin", { changeType: "feature", spec: SPEC });
    const refined = await call("workflow_advance", { to: "implement" });
    expect(refined["message"]).toContain("add an error case");
    const reviewDoc = await call("workflow_advance", { to: "implement" });
    expect(reviewDoc["message"]).toContain("review-doc skill");
    await call("workflow_advance", { to: "implement" });
    expect(asked.map((question) => question.answers)).toEqual([
      ["approve", "refine", "review-doc"],
      ["approve", "refine", "review-doc"],
      ["approve", "refine"],
    ]);
    expect(await call("workflow_status")).toMatchObject({ change: { step: "implement" } });
  });

  it("TC-MCP-026 and TC-MCP-027: stops after 3 failed QA runs, and resumes when the user agrees", async () => {
    const { call } = await connect(makeProject(), ["approve", "yes"]);
    await driveTo(call, "qa");
    for (let run = 0; run < 3; run += 1) await call("qa_report", { passed: false });
    expect(await call("workflow_advance", { to: "review" })).toMatchObject({ isError: true });
    expect(await call("qa_report", { passed: true })).toMatchObject({ isError: true });
    await call("workflow_resume");
    expect(await call("workflow_status")).toMatchObject({ change: { status: "open", qaRunsUsed: 0 } });
    expect(await call("qa_report", { passed: true })).toMatchObject({ isError: false });
  });

  it("TC-MCP-065: a no to resuming ends the change, keeps the task as it was, and lets a new change start", async () => {
    const root = makeProject([[]]);
    const { call } = await connect(root, ["approve", "no"]);
    await driveTo(call, "qa", 1);
    await call("task_start", { id: 1 });
    for (let run = 0; run < 3; run += 1) await call("qa_report", { passed: false });
    expect(await call("workflow_resume")).toMatchObject({ isError: false });
    const ended = JSON.parse(readFileSync(path.join(root, ".cclinic/workflow/task-1.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(ended).toMatchObject({ status: "done", isCommitted: false, reason: "The user chose not to continue." });
    expect(statusOf(root, 1)).toBe("in-progress");
    expect(await call("workflow_begin", { changeType: "bug", spec: SPEC })).toMatchObject({ isError: false });
  });

  it("TC-MCP-029: a changes review sends the change back through QA and the review", async () => {
    const { call } = await connect(makeProject(), ["approve"]);
    await driveTo(call, "review");
    await call("review_report", { verdict: "changes", findings: FINDINGS });
    expect(await call("workflow_advance", { to: "preview" })).toMatchObject({ isError: true });
    expect(await call("workflow_status")).toMatchObject({ change: { step: "implement" } });
  });

  it("TC-MCP-032: preview_start runs the start command and records the link", async () => {
    const root = makeProject();
    writeProject(root, {
      ".cclinic/environment/environment.json": JSON.stringify({
        version: 1,
        alias: "app",
        parts: [{ name: "cli", type: "cli", start: "node -e \"console.log('built')\"", review: "Run node bin/app.js" }],
      }),
    });
    const { call } = await connect(root, ["approve"]);
    await driveTo(call, "preview");
    const reply = await call("preview_start");
    expect(reply).toMatchObject({ isError: false, preview: { isRunning: true } });
    expect(JSON.stringify(reply)).toContain("Run node bin/app.js");
    expect(await call("workflow_advance", { to: "approval" })).toMatchObject({ isError: false });
  });

  it("TC-MCP-033: a failing start command is returned with its output, and approval can still go ahead", async () => {
    const root = makeProject();
    writeProject(root, {
      ".cclinic/environment/environment.json": JSON.stringify({
        version: 1,
        alias: "app",
        parts: [
          { name: "cli", type: "cli", start: "node -e \"console.error('port in use'); process.exit(1)\"", review: "x" },
        ],
      }),
    });
    const { call } = await connect(root, ["approve"]);
    await driveTo(call, "preview");
    const reply = await call("preview_start");
    expect(reply).toMatchObject({ preview: { isRunning: false } });
    expect(JSON.stringify(reply)).toContain("port in use");
    expect(await call("workflow_advance", { to: "approval" })).toMatchObject({ isError: false });
  });

  it("TC-MCP-034: with no environment file, preview_start points to the local-env skill", async () => {
    const { call } = await connect(makeProject(), ["approve"]);
    await driveTo(call, "preview");
    expect(await call("workflow_advance", { to: "approval" })).toMatchObject({ isError: true });
    expect(JSON.stringify(await call("preview_start"))).toContain("local-env skill");
    expect(await call("workflow_advance", { to: "approval" })).toMatchObject({ isError: false });
  });

  it("TC-MCP-035 and TC-MCP-036: request changes goes back to implement, approve marks the task done", async () => {
    const root = makeProject([[]]);
    const { call } = await connect(root, ["approve", "request changes|rename the button", "approve", "approve"]);
    await driveTo(call, "approval", 1);
    await call("task_start", { id: 1 });
    const changes = await call("workflow_advance", { to: "commit" });
    expect(changes["message"]).toContain("rename the button");
    expect(await call("workflow_status")).toMatchObject({
      change: { step: "implement", qaRunsUsed: 0, codeReviewsUsed: 0 },
    });
    expect(statusOf(root, 1)).toBe("in-progress");
  });

  it("TC-MCP-037: commit yes gives instructions and the server commits nothing", async () => {
    const root = makeProject();
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "start"], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
    const { call } = await connect(root, ["approve", "approve", "yes"]);
    await driveTo(call, "approval");
    await call("workflow_advance", { to: "commit" });
    const done = await call("workflow_advance", { to: "done" });
    expect(done["message"]).toContain(".cclinic/reviews/");
    expect(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim()).toBe("1");
  });

  it("TC-MCP-038: a skip is recorded only when the user says yes", async () => {
    const { call } = await connect(makeProject(), ["approve", "no", "yes"]);
    await driveTo(call, "qa");
    await call("workflow_skip", { step: "review", reason: "user asked" });
    expect(await call("workflow_status")).toMatchObject({ change: { skips: [] } });
    await call("workflow_skip", { step: "review", reason: "user asked" });
    await call("qa_report", { passed: true });
    await call("workflow_advance", { to: "review" });
    expect(await call("workflow_advance", { to: "preview" })).toMatchObject({ isError: false });
  });

  it("TC-MCP-040: workflow_reset goes back to the spec, which is asked again", async () => {
    const { call, asked } = await connect(makeProject(), ["approve", "approve"]);
    await driveTo(call, "review");
    await call("workflow_reset", { reason: "the spec missed a case" });
    expect(await call("workflow_status")).toMatchObject({ change: { step: "spec" } });
    await call("workflow_advance", { to: "implement" });
    expect(asked).toHaveLength(2);
  });
});

describe("approvals", () => {
  it("TC-MCP-042: declined and cancelled questions leave the gate closed", async () => {
    const { call, asked } = await connect(makeProject(), ["decline", "cancel"]);
    await call("workflow_begin", { changeType: "feature", spec: SPEC });
    expect(await call("workflow_advance", { to: "implement" })).toMatchObject({ isError: true });
    expect(await call("workflow_advance", { to: "implement" })).toMatchObject({ isError: true });
    expect(asked[0]?.answers).toEqual(["approve", "refine", "review-doc"]);
    expect(await call("workflow_status")).toMatchObject({ change: { step: "spec" } });
  });

  it("TC-MCP-043: an approval can't be passed in as tool input", async () => {
    const { call } = await connect(makeProject(), ["decline"]);
    await call("workflow_begin", { changeType: "feature", spec: SPEC });
    expect(await call("workflow_advance", { to: "implement", approved: true })).toMatchObject({ isError: true });
    expect(await call("workflow_status")).toMatchObject({ change: { step: "spec", decisions: [] } });
  });

  it("TC-MCP-044: without elicitation, the question waits for cclinic approve", async () => {
    const root = makeProject();
    const { call } = await connect(root);
    await call("workflow_begin", { changeType: "feature", spec: SPEC });
    const reply = await call("workflow_advance", { to: "implement" });
    expect(reply).toMatchObject({ status: "waiting-for-approval", answers: ["approve", "refine", "review-doc"] });
    expect(reply["message"]).toContain("cclinic approve");
  });
});

describe("state and safety", () => {
  it("TC-MCP-056: the state survives a restart of the server", async () => {
    const root = makeProject();
    const first = await connect(root, ["approve"]);
    await driveTo(first.call, "review");
    const second = await connect(root);
    expect(await second.call("workflow_status")).toMatchObject({ change: { step: "review", qaRunsUsed: 1 } });
  });

  it("TC-MCP-059: secrets are redacted from the saved state", async () => {
    const root = makeProject();
    const secret = `sk-ant-api03-${"a".repeat(95)}AA`;
    const { call } = await connect(root, [`refine|use the key ${secret}`]);
    await call("workflow_begin", { changeType: "feature", spec: SPEC });
    await call("workflow_advance", { to: "implement" });
    const saved = readFileSync(path.join(root, ".cclinic/workflow/branch-main.json"), "utf8");
    expect(saved).toContain("use the key");
    expect(saved).not.toContain(secret);
  });

  it("TC-MCP-060: a whole manual change touches only the workflow folder and the task database", async () => {
    const root = makeProject([[]]);
    const before = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: root, encoding: "utf8" });
    const { call } = await connect(root, ["approve", "approve", "no"]);
    await driveTo(call, "approval", 1);
    await call("workflow_advance", { to: "commit" });
    await call("workflow_advance", { to: "done" });
    const after = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: root, encoding: "utf8" });
    const added = after.split("\n").filter((line) => line !== "" && !before.includes(line));
    expect(added.every((line) => line.includes(".cclinic/workflow/"))).toBe(true);
  });

  it("TC-MCP-061: cclinic clean keeps the workflow state", async () => {
    const root = makeProject();
    const { call } = await connect(root);
    await call("workflow_begin", { changeType: "feature", spec: SPEC });
    await runClean(root, { yes: true }, context);
    expect(existsSync(path.join(root, ".cclinic/workflow/branch-main.json"))).toBe(true);
  });
});

describe("gates after rework, QA", () => {
  it("TC-MCP-029: after a changes review, the preview is reached only after a new passing QA run", async () => {
    const { call } = await connect(makeProject(), ["approve"]);
    await driveTo(call, "review");
    await call("review_report", { verdict: "changes", findings: FINDINGS });
    await call("workflow_advance", { to: "qa" });
    await call("workflow_advance", { to: "review" });
    await call("review_report", { verdict: "approve", findings: FINDINGS });
    expect(await call("workflow_advance", { to: "preview" })).toMatchObject({ isError: true });
    expect(await call("workflow_status")).toMatchObject({ change: { qaRunsUsed: 1 } });
    expect(await call("workflow_status")).not.toMatchObject({ change: { step: "preview" } });
  });

  it("TC-MCP-035: after request changes, approval is reached only after new QA, a new review and a new preview", async () => {
    const { call } = await connect(makeProject(), ["approve", "request changes|rename the button", "approve"]);
    await driveTo(call, "approval");
    await call("workflow_advance", { to: "commit" });
    for (const step of ["qa", "review", "preview", "approval"]) await call("workflow_advance", { to: step });
    const { change } = (await call("workflow_status")) as { change: { step: string } };
    expect(change.step).not.toBe("approval");
  });
});

describe(".mcp.json", () => {
  const ENTRY = { command: "npx", args: ["cclinic", "mcp"] };
  const install = (root: string) =>
    installSkills({ target: root, out: path.join(root, ".cclinic/sdd"), isForced: false });
  const config = (root: string) =>
    JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
  const statusOfConfig = async (root: string) =>
    (await install(root)).find((entry) => entry.path === ".mcp.json")?.status;

  it("TC-MCP-005: creates .mcp.json with cclinic's server", async () => {
    const root = makeTempFolder();
    expect(await statusOfConfig(root)).toBe("installed");
    expect(config(root).mcpServers).toEqual({ cclinic: ENTRY });
  });

  it("TC-MCP-006: keeps every other server", async () => {
    const root = makeTempFolder();
    writeProject(root, { ".mcp.json": JSON.stringify({ mcpServers: { a: { command: "a" }, b: { command: "b" } } }) });
    expect(await statusOfConfig(root)).toBe("updated");
    expect(config(root).mcpServers).toEqual({ a: { command: "a" }, b: { command: "b" }, cclinic: ENTRY });
  });

  it("TC-MCP-007: leaves a cclinic entry the user changed, and says so", async () => {
    const root = makeTempFolder();
    const mine = JSON.stringify({ mcpServers: { cclinic: { command: "node", args: ["my-cclinic"] } } });
    writeProject(root, { ".mcp.json": mine });
    expect(await statusOfConfig(root)).toBe("skipped: not created by cclinic");
    expect(readFileSync(path.join(root, ".mcp.json"), "utf8")).toBe(mine);
  });

  it("TC-MCP-064: the scan leaves out a .mcp.json with only cclinic's entry, and analyses the rest without it", async () => {
    const root = makeTempFolder();
    writeProject(root, { "index.ts": "export const a = 1;\n" });
    await install(root);
    const scan = (target: string) =>
      scanFolder({ target, outFolder: path.join(target, ".cclinic/sdd"), include: [], exclude: [], maxFileSizeMib: 1 });
    expect((await scan(root)).included.map((file) => file.path)).not.toContain(".mcp.json");
    const servers = { a: { command: "a" } };
    writeProject(root, { ".mcp.json": JSON.stringify({ mcpServers: { ...servers, cclinic: ENTRY } }) });
    const file = (await scan(root)).included.find((item) => item.path === ".mcp.json");
    if (file === undefined) throw new Error(".mcp.json wasn't scanned");
    const withCclinic = await createExtractor().extract(file);
    writeProject(root, { ".mcp.json": JSON.stringify({ mcpServers: servers }) });
    const without = await createExtractor().extract(file);
    expect(withCclinic.sha256).toBe(without.sha256);
    expect(JSON.stringify(withCclinic)).not.toContain("cclinic");
  });

  it("TC-MCP-064: analysis leaves out cclinic's own entry", () => {
    const onlyCclinic = `${JSON.stringify({ mcpServers: { cclinic: ENTRY } }, null, 2)}\n`;
    expect(holdsOnlyCclinicServer(onlyCclinic)).toBe(true);
    const withOther = JSON.stringify({ mcpServers: { a: { command: "a" }, cclinic: ENTRY } });
    expect(holdsOnlyCclinicServer(withOther)).toBe(false);
    expect(stripCclinicServer(withOther)).toContain('"a"');
    expect(stripCclinicServer(withOther)).not.toContain("cclinic");
    expect(stripCclinicServer(withOther)).toBe(
      stripCclinicServer(JSON.stringify({ mcpServers: { a: { command: "a" } } })),
    );
  });
});

describe("architecture, QA", () => {
  it("TC-MCP-009 and TC-QUAL-022: the check fails when the MCP SDK is imported outside its adapter", () => {
    const copy = makeTempFolder();
    for (const entry of ["src", ".dependency-cruiser.cjs", "tsconfig.json", "package.json"])
      cpSync(path.join(REPO, entry), path.join(copy, entry), { recursive: true });
    symlinkSync(path.join(REPO, "node_modules"), path.join(copy, "node_modules"));
    const check = () =>
      spawnSync(path.join(REPO, "node_modules/.bin/depcruise"), ["src", "--config", ".dependency-cruiser.cjs"], {
        cwd: copy,
        encoding: "utf8",
      });
    expect(check().status).toBe(0);
    for (const file of ["src/application/qa-mcp-import.ts", "src/adapters/storage/qa-mcp-import.ts"]) {
      writeProject(copy, {
        [file]:
          'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nexport const server = McpServer;\n',
      });
      const failed = check();
      expect(failed.status, file).not.toBe(0);
      expect(failed.stdout, file).toContain(`mcp-sdk-only-in-mcp-adapter: ${file}`);
      rmSync(path.join(copy, file));
    }
    expect(check().status).toBe(0);
    expect(readFileSync(path.join(REPO, ".cclinic/sdd/stack.md"), "utf8")).toMatch(
      /@modelcontextprotocol\/sdk \(MIT\).*FR-MCP-006/,
    );
  });
});

describe("review fixes", () => {
  it("TC-MCP-038: an answer from cclinic approve is used even when the agent rewords its skip reason", async () => {
    const root = makeProject();
    const answering = await connect(root, ["approve"]);
    await driveTo(answering.call, "qa");
    const { call } = await connect(root);
    expect(await call("workflow_skip", { step: "review", reason: "user asked" })).toMatchObject({
      status: "waiting-for-approval",
    });
    const store = openWorkflowStore(root);
    const [waiting] = await store.list();
    if (waiting === undefined) throw new Error("No state");
    const answered = answerPending(waiting, "yes", null, new Date().toISOString());
    if ("refusal" in answered) throw new Error(answered.refusal);
    await store.save(answered.state);
    await call("workflow_skip", { step: "review", reason: "the user asked to skip it" });
    expect(await call("workflow_status")).toMatchObject({
      change: { skips: [{ step: "review" }], waitingQuestion: null },
    });
  });

  it("TC-MCP-036: the approval is kept when the task was removed meanwhile", async () => {
    const root = makeProject([[]]);
    const { call } = await connect(root, ["approve", "approve"]);
    await driveTo(call, "approval", 1);
    const store = openTaskStore(path.join(root, ".cclinic"), "update");
    store?.removeTask(1);
    store?.close();
    const reply = await call("workflow_advance", { to: "commit" });
    expect(reply).toMatchObject({ isError: false });
    expect(reply["message"]).toBe(
      "The approval is recorded, but task 1 couldn't be marked done: Task 1 doesn't exist.",
    );
    expect(reply).toMatchObject({ answer: "approve" });
    expect(await call("workflow_status")).toMatchObject({ change: { step: "commit" } });
  });

  it("TC-MCP-020: auto_status refuses a damaged run state with a clear message", async () => {
    const root = makeProject();
    writeProject(root, { ".cclinic/auto/20260101-000000/run.json": "{oops" });
    const { call } = await connect(root);
    const reply = await call("auto_status");
    expect(reply).toMatchObject({ isError: true });
    expect(JSON.stringify(reply)).toContain("isn't readable");
  });
});

describe("approval timeout", () => {
  it("TC-MCP-042: an answer given after the SDK's one-minute default still counts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const root = makeProject();
      let release: (() => void) | undefined;
      const server = await createProjectServer({ dir: root, approver: "user" }, context);
      const client = new Client({ name: "slow", version: "1.0.0" }, { capabilities: { elicitation: {} } });
      client.setRequestHandler(ElicitRequestSchema, async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return { action: "accept", content: { answer: "approve" } };
      });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      await client.connect(clientSide);
      open.push(client);
      await client.callTool({ name: "workflow_begin", arguments: { changeType: "feature", spec: SPEC } });
      const advancing = client.callTool({ name: "workflow_advance", arguments: { to: "implement" } }, undefined, {
        timeout: 2 * 3_600_000,
      });
      await vi.waitFor(() => {
        expect(release).toBeDefined();
      });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      release?.();
      expect((await advancing).isError).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("waiting questions", () => {
  it("TC-MCP-044: an answer given in the host clears the same question waiting for cclinic approve", async () => {
    const root = makeProject();
    const answering = await connect(root, ["approve"]);
    await driveTo(answering.call, "qa");
    const withoutQuestions = await connect(root);
    await withoutQuestions.call("workflow_skip", { step: "review", reason: "user asked" });
    const withQuestions = await connect(root, ["no"]);
    await withQuestions.call("workflow_skip", { step: "review", reason: "user asked" });
    expect(await withQuestions.call("workflow_status")).toMatchObject({ change: { waitingQuestion: null, skips: [] } });
  });
});

describe("review run 3 fixes", () => {
  it("TC-MCP-066: a reset clears a waiting question, so an old answer can't pass G5 later", async () => {
    const root = makeProject();
    const answering = await connect(root, ["approve"]);
    await driveTo(answering.call, "approval");
    const { call } = await connect(root);
    expect(await call("workflow_advance", { to: "commit" })).toMatchObject({ status: "waiting-for-approval" });
    await call("workflow_reset", { reason: "the spec missed a case" });
    expect(await call("workflow_status")).toMatchObject({ change: { step: "spec", waitingQuestion: null } });
    const store = openWorkflowStore(root);
    const [state] = await store.list();
    expect(state?.pending).toBeNull();
  });

  it("TC-MCP-067: the workflow folder is ignored by Git and not listed as changed", async () => {
    const root = makeProject();
    const { call } = await connect(root, ["approve"]);
    await driveTo(call, "qa");
    expect(readFileSync(path.join(root, ".cclinic/workflow/.gitignore"), "utf8")).toBe("*\n");
    const status = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: root, encoding: "utf8" });
    expect(status).not.toContain(".cclinic/workflow/");
    const handoff = await call("qa_handoff");
    expect(JSON.stringify(handoff["changedFiles"])).not.toContain(".cclinic/workflow/");
  });
});

describe("reset and the ignored workflow folder, QA", () => {
  const ENVIRONMENT = {
    ".cclinic/environment/environment.json": JSON.stringify({
      version: 1,
      alias: "app",
      parts: [{ name: "cli", type: "cli", start: "node -e \"console.log('built')\"", review: "Run node bin/app.js" }],
    }),
  };

  /** Hashes of every file outside .git, the workflow folder and the task database. */
  function snapshot(root: string): Record<string, string> {
    const result: Record<string, string> = {};
    const walk = (folder: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        const relative = path.relative(root, full);
        if (relative === ".git" || relative === ".cclinic/workflow" || relative.startsWith(".cclinic/tasks.db"))
          continue;
        if (entry.isDirectory()) walk(full);
        else result[relative] = readFileSync(full, "utf8");
      }
    };
    walk(root);
    return result;
  }

  it("TC-MCP-066: after a reset, an old G5 answer can't be given, and G5 is asked again", async () => {
    const root = makeProject();
    const answering = await connect(root, ["approve"]);
    await driveTo(answering.call, "approval");
    const { call } = await connect(root);
    expect(await call("workflow_advance", { to: "commit" })).toMatchObject({ status: "waiting-for-approval" });
    await call("workflow_reset", { reason: "the spec missed a case" });
    const [state] = await openWorkflowStore(root).list();
    if (state === undefined) throw new Error("No state");
    expect(answerPending(state, "approve", null, new Date().toISOString())).toEqual({
      refusal: "No question is waiting.",
    });
    const again = await connect(root, ["approve", "request changes|again"]);
    await again.call("workflow_advance", { to: "implement" });
    await again.call("workflow_advance", { to: "qa" });
    await again.call("qa_report", { passed: true });
    await again.call("workflow_advance", { to: "review" });
    await again.call("review_report", { verdict: "approve", findings: FINDINGS });
    await again.call("workflow_advance", { to: "preview" });
    await again.call("preview_start");
    await again.call("workflow_advance", { to: "approval" });
    expect(await again.call("workflow_advance", { to: "commit" })).toMatchObject({ answer: "request changes" });
    expect(again.asked.map((question) => question.message)).toEqual([
      expect.stringContaining("Approve the spec change"),
      expect.stringContaining("Approve the implementation"),
    ]);
    expect(await again.call("workflow_status")).toMatchObject({ change: { step: "implement" } });
  });

  it("TC-MCP-066: a reset also clears a waiting skip question", async () => {
    const root = makeProject();
    const answering = await connect(root, ["approve"]);
    await driveTo(answering.call, "qa");
    const { call } = await connect(root);
    expect(await call("workflow_skip", { step: "review", reason: "asked" })).toMatchObject({
      status: "waiting-for-approval",
    });
    expect(await call("workflow_reset", { reason: "wrong spec" })).toMatchObject({ isError: false });
    expect(await call("workflow_status")).toMatchObject({ change: { step: "spec", waitingQuestion: null } });
  });

  it("TC-MCP-067: preview logs and state stay out of git status and qa_handoff, also in an existing folder", async () => {
    const root = makeProject();
    writeProject(root, { ...ENVIRONMENT, ".cclinic/workflow/notes.txt": "older file\n" });
    const { call } = await connect(root, ["approve"]);
    await driveTo(call, "preview");
    expect(await call("preview_start")).toMatchObject({ isError: false });
    expect(readdirSync(path.join(root, ".cclinic/workflow")).some((name) => name.endsWith(".log"))).toBe(true);
    expect(readFileSync(path.join(root, ".cclinic/workflow/.gitignore"), "utf8")).toBe("*\n");
    const status = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: root, encoding: "utf8" });
    expect(status).not.toContain(".cclinic/workflow/");
    expect(JSON.stringify((await call("qa_handoff"))["changedFiles"])).not.toContain(".cclinic/workflow/");
  });

  it("TC-MCP-067: an existing .gitignore in the workflow folder is left as it is", async () => {
    const root = makeProject();
    writeProject(root, { ".cclinic/workflow/.gitignore": "*.log\n" });
    const { call } = await connect(root);
    await call("workflow_begin", { changeType: "feature", spec: SPEC });
    expect(readFileSync(path.join(root, ".cclinic/workflow/.gitignore"), "utf8")).toBe("*.log\n");
  });

  it("TC-MCP-060: a whole manual change changes no file outside the workflow folder and task database, and runs no git commit or push", async () => {
    const root = makeProject([[]]);
    writeProject(root, ENVIRONMENT);
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"], {
      cwd: root,
    });
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapper = makeTempFolder();
    const gitLog = path.join(wrapper, "git-calls.log");
    writeFileSync(path.join(wrapper, "git"), `#!/bin/sh\necho "$@" >> "${gitLog}"\nexec "${realGit}" "$@"\n`, {
      mode: 0o755,
    });
    const before = snapshot(root);
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    const server = await createProjectServer(
      { dir: root, approver: "user" },
      { ...context, environment: { ...process.env, PATH: `${wrapper}:${process.env["PATH"] ?? ""}` } },
    );
    const answers = ["approve", "approve", "yes"];
    const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, () => ({
      action: "accept",
      content: { answer: answers.shift() ?? "no" },
    }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    open.push(client);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}") as Record<string, unknown>;
    };
    await driveTo(call, "approval", 1);
    await call("qa_handoff");
    await call("workflow_advance", { to: "commit" });
    await call("workflow_advance", { to: "done" });
    expect(snapshot(root)).toEqual(before);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).toBe(headBefore);
    const gitCalls = existsSync(gitLog) ? readFileSync(gitLog, "utf8") : "";
    expect(gitCalls).not.toBe("");
    expect(gitCalls).not.toMatch(/(^|\s)(commit|push)(\s|$)/m);
    expect(statusOf(root, 1)).toBe("done");
  });
});

describe("preview after a stop", () => {
  it("TC-MCP-068: a stopped change can show a preview, which isn't recorded or counted for G4", async () => {
    const root = makeProject();
    writeProject(root, {
      ".cclinic/environment/environment.json": JSON.stringify({
        version: 1,
        alias: "app",
        parts: [{ name: "cli", type: "cli", start: "node -e \"console.log('built')\"", review: "Run node bin/app.js" }],
      }),
    });
    const { call } = await connect(root, ["approve", "yes"]);
    await driveTo(call, "qa");
    for (let run = 0; run < 3; run += 1) await call("qa_report", { passed: false });
    expect(await call("preview_start")).toMatchObject({ isError: false, preview: { isRunning: true } });
    expect(await call("workflow_status")).toMatchObject({ change: { status: "stopped", preview: null } });
    await call("workflow_resume");
    await call("qa_report", { passed: true });
    await call("workflow_advance", { to: "review" });
    await call("review_report", { verdict: "approve", findings: FINDINGS });
    await call("workflow_advance", { to: "preview" });
    expect(await call("workflow_advance", { to: "approval" })).toMatchObject({ isError: true });
    await call("preview_start");
    expect(await call("workflow_advance", { to: "approval" })).toMatchObject({ isError: false });
  });
});
