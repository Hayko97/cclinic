import { describe, expect, it } from "vitest";
import { GUI_CONTENT_SECURITY_POLICY, HTTP_STATUS } from "./constants/gui.js";
import {
  appendOutput,
  blockingJob,
  checkAccess,
  describeJob,
  exitMeaning,
  jobArgs,
  jobRequestSchema,
  matchRoute,
  NO_OUTPUT,
  readCookie,
  SECURITY_HEADERS,
  splitLines,
  type GuiRequest,
  type JobKind,
} from "./gui.js";

const PORT = 4417;
const TOKEN = "t".repeat(43);
const request = (change: Partial<GuiRequest> & { headers?: Record<string, string> }): GuiRequest => ({
  method: "GET",
  path: "/api/jobs",
  query: {},
  readBody: () => Promise.resolve(undefined),
  ...change,
  headers: { host: `127.0.0.1:${PORT}`, "x-cclinic-token": TOKEN, ...change.headers },
});
const access = (change: Parameters<typeof request>[0]) => checkAccess(request(change), { port: PORT, token: TOKEN });

describe("access", () => {
  it("TC-GUI-014: only this machine's own host names are served, and changes only come from the GUI's origin", () => {
    expect(access({ headers: { host: `evil.example:${PORT}` } })).toEqual({ kind: "denied", status: 403 });
    expect(access({ headers: { host: `127.0.0.1:${PORT}` } }).kind).toBe("allowed");
    expect(access({ headers: { host: `localhost:${PORT}` } }).kind).toBe("allowed");
    expect(access({ headers: { host: `127.0.0.1:${PORT + 1}` } }).kind).toBe("denied");
    expect(access({ method: "POST", headers: { origin: "http://evil.example" } })).toEqual({
      kind: "denied",
      status: HTTP_STATUS.forbidden,
    });
    expect(access({ method: "POST", headers: { origin: `http://localhost:${PORT}` } }).kind).toBe("allowed");
    expect(access({ method: "POST" }).kind).toBe("allowed");
    expect(access({ headers: { host: "127.0.0.1" } }).kind).toBe("denied");
  });

  it("TC-GUI-014: on port 80, browsers leave the port out of the host and origin, and that's allowed", () => {
    const onPort80 = (headers: Record<string, string>, method = "GET") =>
      checkAccess(request({ method, headers: { ...headers } }), { port: 80, token: TOKEN }).kind;
    expect(onPort80({ host: "127.0.0.1" })).toBe("allowed");
    expect(onPort80({ host: "localhost:80" })).toBe("allowed");
    expect(onPort80({ host: "127.0.0.1", origin: "http://127.0.0.1" }, "POST")).toBe("allowed");
    expect(onPort80({ host: "evil.example" })).toBe("denied");
  });

  it("TC-GUI-012: a missing or wrong token is refused; the header or the cookie lets a request in", () => {
    const noToken = { "x-cclinic-token": "" };
    expect(access({ headers: noToken })).toEqual({ kind: "denied", status: HTTP_STATUS.unauthorized });
    expect(access({ headers: { "x-cclinic-token": `${TOKEN.slice(1)}x` } }).kind).toBe("denied");
    expect(access({ headers: { ...noToken, cookie: `a=1; cclinic_token_${PORT}=${TOKEN}` } })).toEqual({
      kind: "allowed",
      isFirstLoad: false,
    });
    expect(access({ headers: { ...noToken, cookie: `cclinic_token_${PORT + 1}=${TOKEN}` } }).kind).toBe("denied");
  });

  it("TC-GUI-013: only the first page load may carry the token in its query", () => {
    const noToken = { "x-cclinic-token": "" };
    expect(access({ path: "/", query: { token: TOKEN }, headers: noToken })).toEqual({
      kind: "allowed",
      isFirstLoad: true,
    });
    expect(access({ path: "/api/jobs", query: { token: TOKEN }, headers: noToken }).kind).toBe("denied");
    expect(access({ method: "POST", path: "/", query: { token: TOKEN }, headers: noToken }).kind).toBe("denied");
    expect(readCookie("a=1; b=two=2", "b")).toBe("two=2");
  });

  it("TC-GUI-017: every response carries a content security policy of the GUI's own files only", () => {
    expect(SECURITY_HEADERS["content-security-policy"]).toBe(GUI_CONTENT_SECURITY_POLICY);
    const sources = GUI_CONTENT_SECURITY_POLICY.split(";").flatMap((part) => part.trim().split(" ").slice(1));
    expect(sources.every((source) => source === "'self'" || source === "'none'")).toBe(true);
  });
});

describe("routes", () => {
  it("TC-GUI-015: only listed paths and well-formed IDs are routes", () => {
    expect(matchRoute("GET", "/")).toEqual({ name: "page" });
    expect(matchRoute("GET", "/assets/app.js")).toEqual({ name: "asset", file: "app.js" });
    expect(matchRoute("GET", "/api/jobs/job-12/events")).toEqual({ name: "job-events", id: "job-12" });
    expect(matchRoute("POST", "/api/jobs/job-3/cancel")).toEqual({ name: "cancel-job", id: "job-3" });
    for (const path of [
      "/assets/index.ts",
      "/assets/../package.json",
      "/.env",
      "/api/jobs/1;rm",
      "/api/jobs/job-0",
      "/api/jobs/../x",
      "/api/jobs/job-1/../../x",
      "/api/project/x",
    ])
      expect(matchRoute("GET", path)).toBeUndefined();
    expect(matchRoute("DELETE", "/api/jobs")).toBeUndefined();
  });
});

describe("jobs", () => {
  const generate = (options: Record<string, unknown>) =>
    jobArgs(jobRequestSchema.parse({ command: "generate", confirmed: true, options }));

  it("TC-GUI-019: text from the browser is only ever an option's value", () => {
    const args = generate({ include: ["; rm -rf ~"], exclude: ["--force"], model: "sonnet" });
    expect(args).toContain("--include=; rm -rf ~");
    expect(args).toContain("--exclude=--force");
    expect(args).toContain("--model=sonnet");
    expect(args).not.toContain("--force");
    expect(jobRequestSchema.safeParse({ command: "rm" }).success).toBe(false);
    expect(
      jobRequestSchema.safeParse({ command: "generate", confirmed: true, options: { model: "--x" } }).success,
    ).toBe(false);
    expect(jobRequestSchema.safeParse({ command: "doctor", extra: "--force" }).success).toBe(false);
  });

  it("TC-GUI-022: generate's values are checked with the CLI's limits before a job starts", () => {
    const parse = (options: Record<string, unknown>) =>
      jobRequestSchema.safeParse({ command: "generate", confirmed: true, options }).success;
    expect(parse({ maxFiles: 0 })).toBe(false);
    expect(parse({ provider: "other" })).toBe(false);
    expect(parse({ concurrency: 4, maxBudgetUsd: 2.5 })).toBe(true);
    expect(jobRequestSchema.safeParse({ command: "generate", options: {} }).success).toBe(false);
  });

  it("TC-GUI-045: each command runs with --json where the CLI has it, and is shown as typed", () => {
    expect(jobArgs({ command: "doctor" })).toEqual(["doctor", "--json"]);
    expect(jobArgs({ command: "skills", force: true })).toEqual(["skills", "--force", "--json"]);
    expect(jobArgs({ command: "clean" })).toEqual(["clean", "--yes"]);
    expect(jobArgs({ command: "model-list" })).toEqual(["model", "--list", "--json"]);
    expect(jobArgs({ command: "model-reset" })).toEqual(["model", "--reset", "--json"]);
    expect(describeJob(["--include=a b", "doctor"])).toBe('cclinic "--include=a b" doctor');
    expect(exitMeaning(0)).toBe("Finished");
    expect(exitMeaning(130)).toBe("Stopped");
    expect(exitMeaning(9)).toBe("Exited with code 9");
  });

  it("TC-GUI-049: commands that change the same files never run together", () => {
    const running = (kind: JobKind) => [{ kind, id: "job-1" }];
    expect(blockingJob("clean", running("generate"))?.id).toBe("job-1");
    expect(blockingJob("skills", running("generate"))?.id).toBe("job-1");
    expect(blockingJob("generate", running("generate"))?.id).toBe("job-1");
    expect(blockingJob("doctor", running("generate"))).toBeUndefined();
    expect(blockingJob("doctor", running("doctor"))).toBeUndefined();
    const none: { readonly kind: JobKind }[] = [];
    expect(blockingJob("generate", none)).toBeUndefined();
  });

  it("TC-GUI-048: only the newest lines are kept, and the number dropped is counted", () => {
    const line = (text: string) => ({ stream: "stdout" as const, text });
    const first = appendOutput(NO_OUTPUT, ["a", "b", "c"].map(line), 4);
    const second = appendOutput(first, ["d", "e", "f"].map(line), 4);
    expect(second.lines.map((item) => item.text)).toEqual(["c", "d", "e", "f"]);
    expect(second.dropped).toBe(2);
    expect(splitLines("pa", "rt\r\nnext\nhal")).toEqual({ lines: ["part", "next"], carry: "hal" });
  });
});
