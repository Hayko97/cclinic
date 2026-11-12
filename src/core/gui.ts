/** Who may call the local GUI, what it serves, and the jobs it runs (spec: gui). Pure: no I/O. */
import { z } from "zod";
import {
  GUI_ASSETS,
  GUI_CONTENT_SECURITY_POLICY,
  GUI_COOKIE_PREFIX,
  GUI_HOST_NAMES,
  GUI_MAX_DEPENDENCIES,
  GUI_MAX_PATTERN_LENGTH,
  GUI_MAX_PATTERNS,
  GUI_TOKEN_HEADER,
  GUI_TOKEN_QUERY,
  HTTP_DEFAULT_PORT,
  HTTP_STATUS,
  SESSION_ID_PATTERN,
  TRANSCRIPT_MAX_TEXT_CHARS,
} from "./constants/gui.js";
import { AUTO_LIMITS, RUN_ID_SOURCE } from "./constants/agents.js";
import { LIMITS } from "./constants/limits.js";
import { PROVIDER_CHOICES } from "./constants/llm.js";
import { parseEffort, parseModel } from "./models.js";
import {
  invalidOptionMessage,
  oneOfRule,
  POSITIVE_NUMBER_RULE,
  unknownEffortMessage,
  unknownModelMessage,
  wholeNumberRule,
} from "./option-rules.js";
import { EXIT_CODES } from "./errors.js";
import { idSchema, specNameSchema, TASK_LIMITS, textSchema, titleSchema } from "./tasks.js";

export interface GuiRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Read only once access is allowed and the route needs it, so a refused request costs nothing (FR-GUI-008). */
  readonly readBody: () => Promise<unknown>;
}

/** Sends one Server-Sent Event. */
export type SendEvent = (event: string, data: unknown) => void;

export type GuiResponse =
  | {
      readonly kind: "body";
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    }
  | {
      readonly kind: "events";
      readonly headers: Readonly<Record<string, string>>;
      /** Starts sending, and returns what stops it when the browser goes away. `finish` ends the stream. */
      readonly open: (send: SendEvent, finish: () => void) => () => void;
    };

/** FR-GUI-012: sent with every response. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": GUI_CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/** How a browser writes the GUI's address: without the port when it's HTTP's default. */
function addresses(port: number): string[] {
  return GUI_HOST_NAMES.flatMap((name) =>
    port === HTTP_DEFAULT_PORT ? [name, `${name}:${port}`] : [`${name}:${port}`],
  );
}

/** FR-GUI-009: only this machine's own names for the GUI, which stops DNS rebinding. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  return addresses(port).some((address) => host === address);
}

/** FR-GUI-009: a change may only come from the GUI's own pages. A request with no Origin isn't from a page. */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  return origin === undefined || addresses(port).some((address) => origin === `http://${address}`);
}

/** Compares in time that doesn't depend on where the first difference is. */
export function isSameSecret(given: string | undefined, secret: string): boolean {
  if (given?.length !== secret.length) return false;
  let difference = 0;
  for (let index = 0; index < secret.length; index += 1)
    difference |= given.charCodeAt(index) ^ secret.charCodeAt(index);
  return difference === 0;
}

/** Named by port, so two projects' GUIs on one machine don't share a cookie. */
export function tokenCookieName(port: number): string {
  return `${GUI_COOKIE_PREFIX}${port}`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

export function tokenCookie(port: number, token: string): string {
  return `${tokenCookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export type Access =
  | { readonly kind: "allowed"; readonly isFirstLoad: boolean }
  | { readonly kind: "denied"; readonly status: typeof HTTP_STATUS.unauthorized | typeof HTTP_STATUS.forbidden };

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** FR-GUI-008, FR-GUI-009: the host and origin first, then the token in a header, the cookie, or the first page load. */
export function checkAccess(request: GuiRequest, gui: { readonly port: number; readonly token: string }): Access {
  if (!isAllowedHost(request.headers["host"], gui.port)) return { kind: "denied", status: HTTP_STATUS.forbidden };
  if (!SAFE_METHODS.has(request.method) && !isAllowedOrigin(request.headers["origin"], gui.port))
    return { kind: "denied", status: HTTP_STATUS.forbidden };
  const cookie = readCookie(request.headers["cookie"], tokenCookieName(gui.port));
  if (isSameSecret(request.headers[GUI_TOKEN_HEADER], gui.token) || isSameSecret(cookie, gui.token))
    return { kind: "allowed", isFirstLoad: false };
  if (request.method === "GET" && request.path === "/" && isSameSecret(request.query[GUI_TOKEN_QUERY], gui.token))
    return { kind: "allowed", isFirstLoad: true };
  return { kind: "denied", status: HTTP_STATUS.unauthorized };
}

export type Route =
  | { readonly name: "page" }
  | { readonly name: "asset"; readonly file: string }
  | { readonly name: "project" }
  | { readonly name: "jobs" }
  | { readonly name: "setup" }
  | { readonly name: "start-job" }
  | { readonly name: "job"; readonly id: string }
  | { readonly name: "job-events"; readonly id: string }
  | { readonly name: "cancel-job"; readonly id: string }
  | { readonly name: "canvas" }
  | { readonly name: "canvas-events" }
  | { readonly name: "save-layout" }
  | { readonly name: "tidy-layout" }
  | { readonly name: "session"; readonly id: string }
  | { readonly name: "session-events"; readonly id: string }
  | { readonly name: "answer"; readonly key: string }
  | { readonly name: "run-files"; readonly id: string }
  | { readonly name: "stop-run" }
  | { readonly name: "plan" }
  | { readonly name: "plan-events" }
  | { readonly name: "plan-start" }
  | { readonly name: "plan-answer" }
  | { readonly name: "plan-review" }
  | { readonly name: "plan-cancel" };

const ASSET_FILES: ReadonlySet<string> = new Set(GUI_ASSETS.files);
const JOB_PATH = "/api/jobs/(job-[1-9][0-9]{0,5})";
const SESSION_PATH = `/api/sessions/(${SESSION_ID_PATTERN})`;
/** A change's key (FR-MCP-038). It's only looked up among the saved states, never used as a path. */
const CHANGE_PATH = "/api/changes/([\\w.-]{1,300})";

/** FR-GUI-010: every route, with each parameter's pattern. Anything else is not found. */
const ROUTES: readonly {
  readonly method: string;
  readonly pattern: RegExp;
  readonly route: (parameter: string) => Route | undefined;
}[] = [
  { method: "GET", pattern: /^\/$/, route: () => ({ name: "page" }) },
  {
    method: "GET",
    pattern: /^\/assets\/([\w.-]+)$/,
    route: (file) => (ASSET_FILES.has(file) ? { name: "asset", file } : undefined),
  },
  { method: "GET", pattern: /^\/api\/project$/, route: () => ({ name: "project" }) },
  { method: "GET", pattern: /^\/api\/jobs$/, route: () => ({ name: "jobs" }) },
  { method: "GET", pattern: /^\/api\/setup$/, route: () => ({ name: "setup" }) },
  { method: "POST", pattern: /^\/api\/jobs$/, route: () => ({ name: "start-job" }) },
  { method: "GET", pattern: new RegExp(`^${JOB_PATH}$`), route: (id) => ({ name: "job", id }) },
  { method: "GET", pattern: new RegExp(`^${JOB_PATH}/events$`), route: (id) => ({ name: "job-events", id }) },
  { method: "POST", pattern: new RegExp(`^${JOB_PATH}/cancel$`), route: (id) => ({ name: "cancel-job", id }) },
  { method: "GET", pattern: /^\/api\/canvas$/, route: () => ({ name: "canvas" }) },
  { method: "GET", pattern: /^\/api\/canvas\/events$/, route: () => ({ name: "canvas-events" }) },
  { method: "PUT", pattern: /^\/api\/layout$/, route: () => ({ name: "save-layout" }) },
  { method: "POST", pattern: /^\/api\/layout\/tidy$/, route: () => ({ name: "tidy-layout" }) },
  { method: "GET", pattern: new RegExp(`^${SESSION_PATH}$`), route: (id) => ({ name: "session", id }) },
  { method: "GET", pattern: new RegExp(`^${SESSION_PATH}/events$`), route: (id) => ({ name: "session-events", id }) },
  { method: "POST", pattern: new RegExp(`^${CHANGE_PATH}/answer$`), route: (key) => ({ name: "answer", key }) },
  // FR-GUI-032: a run's report and logs, by run ID only.
  { method: "GET", pattern: new RegExp(`^/api/runs/(${RUN_ID_SOURCE})$`), route: (id) => ({ name: "run-files", id }) },
  // FR-GUI-023 to FR-GUI-026: the one planning session.
  { method: "GET", pattern: /^\/api\/plan$/, route: () => ({ name: "plan" }) },
  { method: "GET", pattern: /^\/api\/plan\/events$/, route: () => ({ name: "plan-events" }) },
  { method: "POST", pattern: /^\/api\/plan$/, route: () => ({ name: "plan-start" }) },
  { method: "POST", pattern: /^\/api\/plan\/answer$/, route: () => ({ name: "plan-answer" }) },
  { method: "POST", pattern: /^\/api\/plan\/review$/, route: () => ({ name: "plan-review" }) },
  { method: "POST", pattern: /^\/api\/plan\/cancel$/, route: () => ({ name: "plan-cancel" }) },
  // FR-GUI-031: stops the run the GUI started.
  { method: "POST", pattern: /^\/api\/run\/stop$/, route: () => ({ name: "stop-run" }) },
];

export function matchRoute(method: string, path: string): Route | undefined {
  for (const entry of ROUTES) {
    const match = entry.method === method ? entry.pattern.exec(path) : null;
    if (match !== null) return entry.route(match[1] ?? "");
  }
  return undefined;
}

const patternSchema = z.string().min(1).max(GUI_MAX_PATTERN_LENGTH);

/** FR-GUI-038: an answer to a change's waiting question, naming the question the user saw. */
export const answerRequestSchema = z.strictObject({
  // The question as the page shows it: cut to the shown-text length, plus its ellipsis.
  question: z
    .string()
    .min(1)
    .max(TRANSCRIPT_MAX_TEXT_CHARS + 1),
  answer: z.string().min(1).max(TASK_LIMITS.title),
  notes: z
    .string()
    .max(TASK_LIMITS.text, `Notes for the agent can be at most ${TASK_LIMITS.text} characters.`)
    .nullable()
    .optional(),
});

/** FR-GUI-015: each value is refused as the CLI refuses it, in the CLI's own words. */
const limit = (flag: string, bounds: { readonly minimum: number; readonly maximum: number }) =>
  z
    .unknown()
    .refine((value) => Number.isInteger(value) && Number(value) >= bounds.minimum && Number(value) <= bounds.maximum, {
      error: (issue) => invalidOptionMessage(flag, issue.input, wholeNumberRule(bounds.minimum, bounds.maximum)),
    })
    .transform(Number)
    .optional();
const budgetSchema = z
  .unknown()
  .refine((value) => typeof value === "number" && Number.isFinite(value) && value > 0, {
    error: (issue) => invalidOptionMessage("--max-budget-usd <n>", issue.input, POSITIVE_NUMBER_RULE),
  })
  .transform(Number);
const modelValueSchema = z.string().refine((value) => parseModel(value) !== undefined, {
  error: (issue) => unknownModelMessage(String(issue.input), "--model"),
});
const effortValueSchema = z.string().refine((value) => parseEffort(value) !== undefined, {
  error: (issue) => unknownEffortMessage(String(issue.input), "--effort"),
});

/** FR-GUI-015: generate's options, checked with the CLI's own limits. */
export const generateOptionsSchema = z.strictObject({
  provider: z
    .string()
    .refine((value) => PROVIDER_CHOICES.some((choice) => choice === value), {
      error: (issue) => invalidOptionMessage("--provider <name>", issue.input, oneOfRule(PROVIDER_CHOICES)),
    })
    .optional(),
  model: modelValueSchema.optional(),
  effort: effortValueSchema.optional(),
  include: z.array(patternSchema).max(GUI_MAX_PATTERNS).default([]),
  exclude: z.array(patternSchema).max(GUI_MAX_PATTERNS).default([]),
  dryRun: z.boolean().default(false),
  force: z.boolean().default(false),
  noCache: z.boolean().default(false),
  noSkills: z.boolean().default(false),
  noGit: z.boolean().default(false),
  allowBroadTarget: z.boolean().default(false),
  /** True sets up the environment, false never offers it. */
  environment: z.boolean().optional(),
  maxFiles: limit("--max-files <n>", LIMITS.maxFiles),
  maxInputTokens: limit("--max-input-tokens <n>", LIMITS.maxInputTokens),
  maxFileSizeMib: limit("--max-file-size-mib <n>", LIMITS.maxFileSizeMib),
  maxBudgetUsd: budgetSchema.optional(),
  concurrency: limit("--concurrency <n>", LIMITS.concurrency),
  timeoutMinutes: limit("--timeout-minutes <n>", LIMITS.timeoutMinutes),
  maxRetries: limit("--max-retries <n>", LIMITS.maxRetries),
});

/** FR-GUI-017: `cclinic environment`'s options. */
export const environmentOptionsSchema = z.strictObject({
  model: modelValueSchema.optional(),
  effort: effortValueSchema.optional(),
  maxBudgetUsd: budgetSchema.optional(),
  force: z.boolean().default(false),
  allowBroadTarget: z.boolean().default(false),
});

/** FR-GUI-023: what `cclinic plan` plans, and its options, checked with the CLI's own limits. */
export const planRequestSchema = z.strictObject({
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("new-roadmap") }),
    z.strictObject({ kind: z.literal("extend-roadmap"), roadmapId: idSchema }),
    z.strictObject({ kind: z.literal("task"), roadmapId: idSchema.nullable() }),
  ]),
  model: modelValueSchema.optional(),
  effort: effortValueSchema.optional(),
  maxBudgetUsd: budgetSchema.optional(),
  timeoutMinutes: limit("--timeout-minutes <n>", LIMITS.timeoutMinutes),
});
export type PlanRequest = z.output<typeof planRequestSchema>;

/** FR-GUI-024: an answer to the PM's question. */
export const planAnswerSchema = z.strictObject({
  text: z.string().trim().min(1, "Type an answer for the PM.").max(TASK_LIMITS.text),
});

/** FR-GUI-024: the user's choice on a proposal; refine carries feedback for the PM. */
export const planReviewSchema = z
  .strictObject({
    choice: z.enum(["approve", "refine", "cancel"]),
    feedback: z.string().trim().max(TASK_LIMITS.text).default(""),
  })
  .refine((review) => review.choice !== "refine" || review.feedback !== "", {
    message: "Type your feedback for the PM.",
    path: ["feedback"],
  });

/** FR-GUI-027: `cclinic auto`'s options, checked with the CLI's own limits. */
export const autoOptionsSchema = z.strictObject({
  roadmap: idSchema,
  maxBudgetUsd: budgetSchema,
  developers: limit("--developers <n>", AUTO_LIMITS.developers),
  model: modelValueSchema.optional(),
  effort: effortValueSchema.optional(),
  timeoutMinutes: limit("--timeout-minutes <n>", LIMITS.timeoutMinutes),
});
export type AutoOptions = z.output<typeof autoOptionsSchema>;

/** FR-AUTO-040: what `cclinic auto --dry-run --json` prints. */
export const autoPlanSchema = z.object({
  status: z.literal("plan"),
  roadmapId: z.number(),
  plan: z.string(),
  runnable: z.array(z.number()),
  blocked: z.array(z.number()),
});
export type AutoPlan = z.output<typeof autoPlanSchema>;

function autoArgs(options: AutoOptions): string[] {
  const valued: [string, string | number | undefined][] = [
    ["--roadmap", options.roadmap],
    ["--max-budget-usd", options.maxBudgetUsd],
    ["--developers", options.developers],
    ["--model", options.model],
    ["--effort", options.effort],
    ["--timeout-minutes", options.timeoutMinutes],
  ];
  return valued.flatMap(([flag, value]) => (value === undefined ? [] : [`${flag}=${value}`]));
}

function environmentArgs(options: z.output<typeof environmentOptionsSchema>): string[] {
  return [
    ...(options.model === undefined ? [] : [`--model=${options.model}`]),
    ...(options.effort === undefined ? [] : [`--effort=${options.effort}`]),
    ...(options.maxBudgetUsd === undefined ? [] : [`--max-budget-usd=${options.maxBudgetUsd}`]),
    ...(options.force ? ["--force"] : []),
    ...(options.allowBroadTarget ? ["--allow-broad-target"] : []),
  ];
}

/** The commands the GUI can run. Text from the browser is only ever an option's value (FR-GUI-013). */
export const jobRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("doctor") }),
  z.strictObject({ command: z.literal("skills"), force: z.boolean().default(false) }),
  z.strictObject({ command: z.literal("clean") }),
  z.strictObject({ command: z.literal("model-list") }),
  z.strictObject({ command: z.literal("model-reset") }),
  // FR-MODEL-015: saved without the menus.
  z.strictObject({ command: z.literal("model-set"), model: modelValueSchema, effort: effortValueSchema }),
  // FR-GUI-017: the user agreed in the GUI's dialog, so it runs with --yes.
  z.strictObject({ command: z.literal("environment"), confirmed: z.literal(true), options: environmentOptionsSchema }),
  // FR-GUI-016: unconfirmed, the GUI answers with the CLI's questions; confirmed, it runs with --yes.
  z.strictObject({
    command: z.literal("generate"),
    confirmed: z.boolean().default(false),
    options: generateOptionsSchema,
  }),
  // The dry run whose summary the questions are asked from (FR-GUI-016).
  z.strictObject({ command: z.literal("generate-preview"), options: generateOptionsSchema }),
  // FR-GUI-027: unconfirmed, the GUI answers with the plan from a dry run; confirmed, the run starts with --yes.
  z.strictObject({ command: z.literal("auto"), confirmed: z.boolean().default(false), options: autoOptionsSchema }),
  z.strictObject({ command: z.literal("auto-preview"), options: autoOptionsSchema }),
  // FR-GUI-020: every `cclinic tasks` change. Creating a roadmap or milestone isn't one (FR-GUI-021).
  z.strictObject({
    command: z.literal("tasks-add"),
    title: titleSchema,
    description: textSchema.optional(),
    spec: specNameSchema.optional(),
    dependsOn: z.array(idSchema).max(GUI_MAX_DEPENDENCIES).default([]),
  }),
  z.strictObject({ command: z.enum(["tasks-depend", "tasks-undepend"]), id: idSchema, on: idSchema }),
  z.strictObject({
    command: z.enum(["tasks-start", "tasks-done", "tasks-remove", "milestone-remove", "roadmap-remove"]),
    id: idSchema,
  }),
]);
export type JobRequest = z.output<typeof jobRequestSchema>;
export type JobKind = JobRequest["command"];

export type GenerateOptions = z.output<typeof generateOptionsSchema>;

function generateArgs(options: GenerateOptions): string[] {
  const valued: [string, string | number | undefined][] = [
    ["--provider", options.provider],
    ["--model", options.model],
    ["--effort", options.effort],
    ["--max-files", options.maxFiles],
    ["--max-input-tokens", options.maxInputTokens],
    ["--max-file-size-mib", options.maxFileSizeMib],
    ["--max-budget-usd", options.maxBudgetUsd],
    ["--concurrency", options.concurrency],
    ["--timeout-minutes", options.timeoutMinutes],
    ["--max-retries", options.maxRetries],
  ];
  const switches: [string, boolean][] = [
    ["--dry-run", options.dryRun],
    ["--force", options.force],
    ["--no-cache", options.noCache],
    ["--no-skills", options.noSkills],
    ["--no-git", options.noGit],
    ["--allow-broad-target", options.allowBroadTarget],
    ["--environment", options.environment === true],
    ["--no-environment", options.environment === false],
  ];
  return [
    ...valued.flatMap(([flag, value]) => (value === undefined ? [] : [`${flag}=${value}`])),
    // Joined with "=", so a value that looks like an option, such as "--force", stays a value.
    ...options.include.map((pattern) => `--include=${pattern}`),
    ...options.exclude.map((pattern) => `--exclude=${pattern}`),
    ...switches.flatMap(([flag, isOn]) => (isOn ? [flag] : [])),
  ];
}

const TASKS_PREFIX = "tasks-";

/** FR-GUI-013, FR-GUI-033: the arguments of the `cclinic` child process, run in the project's folder. */
export function jobArgs(request: JobRequest): string[] {
  switch (request.command) {
    case "doctor":
      return ["doctor", "--json"];
    case "skills":
      return ["skills", ...(request.force ? ["--force"] : []), "--json"];
    case "clean":
      return ["clean", "--yes"];
    case "model-list":
      return ["model", "--list", "--json"];
    case "model-reset":
      return ["model", "--reset", "--json"];
    case "model-set":
      return ["model", `--model=${request.model}`, `--effort=${request.effort}`, "--json"];
    case "environment":
      return ["environment", "--yes", ...environmentArgs(request.options), "--json"];
    case "generate":
      return ["--json", "--yes", ...generateArgs(request.options)];
    case "generate-preview":
      return ["--dry-run", "--json", ...generateArgs(request.options)];
    case "auto":
      return ["auto", ...autoArgs(request.options), "--yes", "--json"];
    case "auto-preview":
      return ["auto", ...autoArgs(request.options), "--dry-run", "--json"];
    case "tasks-add":
      return [
        "tasks",
        "add",
        `--title=${request.title}`,
        ...(request.description === undefined ? [] : [`--description=${request.description}`]),
        ...(request.spec === undefined ? [] : [`--spec=${request.spec}`]),
        ...request.dependsOn.map((id) => `--depends-on=${id}`),
        "--json",
      ];
    case "tasks-depend":
    case "tasks-undepend":
      return ["tasks", request.command.slice(TASKS_PREFIX.length), String(request.id), `--on=${request.on}`, "--json"];
    case "tasks-start":
    case "tasks-done":
    case "tasks-remove":
      return ["tasks", request.command.slice(TASKS_PREFIX.length), String(request.id), "--json"];
    case "milestone-remove":
      return ["tasks", "milestone", "remove", String(request.id), "--json"];
    case "roadmap-remove":
      return ["tasks", "roadmap", "remove", String(request.id), "--json"];
  }
}

/** How a job is shown: the command a user would type, with values quoted where needed. */
export function describeJob(args: readonly string[]): string {
  return ["cclinic", ...args.map((arg) => (/^[\w./=:@-]+$/.test(arg) ? arg : JSON.stringify(arg)))].join(" ");
}

/** FR-GUI-035: commands that change the same files, of which only one may run. Others, such as doctor, may run side by side. */
const CONFLICTING: ReadonlySet<JobKind> = new Set<JobKind>(["generate", "clean", "skills", "environment"]);

/** The running job that stops this one from starting, if any (FR-GUI-035). Only one auto run goes at a time. */
export function blockingJob<T extends { readonly kind: JobKind }>(kind: JobKind, running: readonly T[]): T | undefined {
  if (kind === "auto") return running.find((job) => job.kind === "auto");
  return CONFLICTING.has(kind) ? running.find((job) => CONFLICTING.has(job.kind)) : undefined;
}

export type OutputStream = "stdout" | "stderr";

export interface OutputLine {
  readonly stream: OutputStream;
  readonly text: string;
}

export interface JobOutput {
  readonly lines: readonly OutputLine[];
  /** Older lines dropped to keep the newest within the limit (FR-GUI-034). */
  readonly dropped: number;
}

export const NO_OUTPUT: JobOutput = { lines: [], dropped: 0 };

export function appendOutput(output: JobOutput, lines: readonly OutputLine[], maxLines: number): JobOutput {
  const all = [...output.lines, ...lines];
  const over = Math.max(0, all.length - maxLines);
  return { lines: all.slice(over), dropped: output.dropped + over };
}

/** Whole lines from a chunk of output, and the unfinished rest to join with the next chunk. */
export function splitLines(carry: string, chunk: string): { readonly lines: string[]; readonly carry: string } {
  const parts = `${carry}${chunk}`.split(/\r?\n/);
  return { lines: parts.slice(0, -1), carry: parts.at(-1) ?? "" };
}

const EXIT_MEANINGS: Readonly<Record<number, string>> = {
  [EXIT_CODES.success]: "Finished",
  [EXIT_CODES.internal]: "Failed, or finished with problems",
  [EXIT_CODES.usage]: "Not started: a usage or precondition problem",
  [EXIT_CODES.noProvider]: "No way to reach Claude",
  [EXIT_CODES.llm]: "A Claude call failed",
  [EXIT_CODES.validation]: "The generated documents didn't pass validation",
  [EXIT_CODES.sigint]: "Stopped",
  [EXIT_CODES.sigterm]: "Stopped",
};

/** FR-GUI-033: what an exit code means, as the CLI uses it. */
export function exitMeaning(code: number): string {
  return EXIT_MEANINGS[code] ?? `Exited with code ${code}`;
}
