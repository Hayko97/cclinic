/** Who may call the local GUI, what it serves, and the jobs it runs (spec: gui). Pure: no I/O. */
import { z } from "zod";
import {
  GUI_ASSETS,
  GUI_CONTENT_SECURITY_POLICY,
  GUI_COOKIE_PREFIX,
  GUI_HOST_NAMES,
  GUI_MAX_DEPENDENCIES,
  GUI_MAX_UPLOAD_NAME_CHARS,
  GUI_MAX_PATTERN_LENGTH,
  GUI_MAX_PATTERNS,
  GUI_TOKEN_HEADER,
  GUI_TOKEN_QUERY,
  HTTP_DEFAULT_PORT,
  HTTP_STATUS,
  SESSION_ID_PATTERN,
  TRANSCRIPT_MAX_TEXT_CHARS,
} from "./constants/gui.js";
import {
  ATTACHMENT_LIMITS,
  AUTO_LIMITS,
  PLAN_ID_PATTERN,
  PLAN_ID_SOURCE,
  PLAN_LIMITS,
  RUN_ID_SOURCE,
} from "./constants/agents.js";
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
import type { TranscriptEntry } from "./canvas.js";
import {
  activityOf,
  ANSWER_LAST_MESSAGE,
  repeatedMessageOf,
  isPlanningNote,
  projectDesignArgs,
  projectSpecsArgs,
  sourceSchema,
  sourcesSchema,
  suggestionsSchema,
  userPartOf,
} from "./planning.js";
import { idSchema, specNameSchema, TASK_LIMITS, textSchema, titleSchema } from "./tasks.js";

export interface GuiRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Read only once access is allowed and the route needs it, so a refused request costs nothing (FR-GUI-008). */
  readonly readBody: (maxBytes?: number) => Promise<unknown>;
}

/** Sends one Server-Sent Event. */
export type SendEvent = (event: string, data: unknown) => void;

export type GuiResponse =
  | {
      readonly kind: "body";
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      /** Text, or a file's bytes, such as an attached image (FR-PLAN-037). */
      readonly body: string | Uint8Array;
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

/**
 * FR-GUI-089: the design agent's style guide is shown as written, so it's sandboxed: no scripts, no requests, only its
 * own styles, images and fonts.
 */
export const STYLE_GUIDE_HEADERS: Readonly<Record<string, string>> = {
  ...SECURITY_HEADERS,
  "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
  "content-type": "text/html; charset=utf-8",
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
  | { readonly name: "plan-open" }
  | { readonly name: "plan-new" }
  | { readonly name: "plan-message" }
  | { readonly name: "plan-propose" }
  | { readonly name: "plan-stop" }
  | { readonly name: "plan-retry" }
  | { readonly name: "plan-approve" }
  | { readonly name: "plan-cancel" }
  | { readonly name: "plan-design" }
  | { readonly name: "style-guide" }
  | { readonly name: "plan-upload" }
  | { readonly name: "plan-upload-check" }
  | { readonly name: "plan-remove-upload"; readonly id: string }
  | { readonly name: "plan-attachment"; readonly planId: string; readonly file: string };

const ASSET_FILES: ReadonlySet<string> = new Set(GUI_ASSETS.files);
/** A file's name with nothing that could leave its folder: no separators, and not "." or "..". */
export function isPlainFileName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\\0]/.test(name);
}

/** FR-PLAN-037: the type an attached image is served with, by its extension. */
export const IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** A file uploaded for the next planning message (FR-PLAN-033): its prefix, then random bytes as hex. */
export const UPLOAD_ID_PREFIX = "upload-";
export const UPLOAD_ID_BYTES = 8;
const HEX_DIGITS_PER_BYTE = 2;
export const UPLOAD_ID_SOURCE = `${UPLOAD_ID_PREFIX}[0-9a-f]{${UPLOAD_ID_BYTES * HEX_DIGITS_PER_BYTE}}`;
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
  { method: "POST", pattern: /^\/api\/plan\/open$/, route: () => ({ name: "plan-open" }) },
  { method: "POST", pattern: /^\/api\/plan\/new$/, route: () => ({ name: "plan-new" }) },
  { method: "POST", pattern: /^\/api\/plan\/message$/, route: () => ({ name: "plan-message" }) },
  { method: "POST", pattern: /^\/api\/plan\/propose$/, route: () => ({ name: "plan-propose" }) },
  { method: "POST", pattern: /^\/api\/plan\/stop$/, route: () => ({ name: "plan-stop" }) },
  { method: "POST", pattern: /^\/api\/plan\/retry$/, route: () => ({ name: "plan-retry" }) },
  { method: "POST", pattern: /^\/api\/plan\/approve$/, route: () => ({ name: "plan-approve" }) },
  { method: "POST", pattern: /^\/api\/plan\/cancel$/, route: () => ({ name: "plan-cancel" }) },
  // FR-GUI-089: after a failed design step, a new project continues without a design system; and its style guide.
  { method: "POST", pattern: /^\/api\/plan\/design$/, route: () => ({ name: "plan-design" }) },
  { method: "GET", pattern: /^\/api\/design\/style-guide$/, route: () => ({ name: "style-guide" }) },
  // FR-PLAN-037: an image a session's message has, by its stored file name, for its thumbnail.
  {
    method: "GET",
    pattern: new RegExp(`^/api/plan/sessions/(${PLAN_ID_SOURCE}/attachments/[^/]{1,255})$`),
    route: (parameter) => {
      const [planId = "", , encoded = ""] = parameter.split("/");
      let file: string;
      try {
        file = decodeURIComponent(encoded);
      } catch {
        return undefined;
      }
      return isPlainFileName(file) ? { name: "plan-attachment", planId, file } : undefined;
    },
  },
  // FR-PLAN-033: one file at a time, checked with the limits of FR-PLAN-022.
  { method: "POST", pattern: /^\/api\/plan\/uploads$/, route: () => ({ name: "plan-upload" }) },
  // FR-PLAN-022: a file's name and size, checked before it's sent, so one too large to send is refused by name.
  { method: "POST", pattern: /^\/api\/plan\/uploads\/check$/, route: () => ({ name: "plan-upload-check" }) },
  {
    method: "POST",
    pattern: new RegExp(`^/api/plan/uploads/(${UPLOAD_ID_SOURCE})/remove$`),
    route: (id) => ({ name: "plan-remove-upload", id }),
  },
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

/** FR-GUI-017: `luseen environment`'s options. */
export const environmentOptionsSchema = z.strictObject({
  model: modelValueSchema.optional(),
  effort: effortValueSchema.optional(),
  maxBudgetUsd: budgetSchema.optional(),
  force: z.boolean().default(false),
  allowBroadTarget: z.boolean().default(false),
});

/** FR-GUI-023, FR-PLAN-035: the model, reasoning and time limit a session's PM turns use, as `luseen plan` takes them. */
const planOptionsShape = {
  model: modelValueSchema.optional(),
  effort: effortValueSchema.optional(),
  timeoutMinutes: limit("--timeout-minutes <n>", LIMITS.timeoutMinutes),
};
export const planOptionsSchema = z.strictObject(planOptionsShape);
export type PlanOptionsRequest = z.output<typeof planOptionsSchema>;

const uploadIdsSchema = z
  .array(z.string().regex(new RegExp(`^${UPLOAD_ID_SOURCE}$`)))
  .max(ATTACHMENT_LIMITS.perMessage, {
    message: `A message can have at most ${ATTACHMENT_LIMITS.perMessage} files.`,
  });
const messageTextSchema = z
  .string()
  .max(PLAN_LIMITS.maxUserMessageChars, `A message can be at most ${PLAN_LIMITS.maxUserMessageChars} characters.`);

/** FR-PLAN-021, FR-PLAN-036: a message to the PM, with the files uploaded for it. */
export const planMessageSchema = z.strictObject({ text: messageTextSchema, uploads: uploadIdsSchema.default([]) });
export type PlanMessage = z.output<typeof planMessageSchema>;

/** FR-GUI-023, FR-PLAN-021: what a new session plans, its options, and the user's first message. */
export const planRequestSchema = z.strictObject({
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("new-roadmap") }),
    // FR-GUI-085: only in an empty folder.
    z.strictObject({ kind: z.literal("new-project") }),
    z.strictObject({ kind: z.literal("extend-roadmap"), roadmapId: idSchema }),
    z.strictObject({ kind: z.literal("task"), roadmapId: idSchema.nullable() }),
  ]),
  ...planOptionsShape,
  text: messageTextSchema,
  uploads: uploadIdsSchema.default([]),
});
export type PlanRequest = z.output<typeof planRequestSchema>;

const planIdBodySchema = z.string().regex(PLAN_ID_PATTERN, "That isn't a planning session's ID.");

/** FR-PLAN-034: a saved session to open, with the options its turns use. */
export const planOpenSchema = z.strictObject({ planId: planIdBodySchema, ...planOptionsShape });
/** FR-PLAN-039, FR-PLAN-045: a session whose proposal is approved or cancelled, from the panel or Needs you. */
export const planDecisionSchema = z.strictObject({ planId: planIdBodySchema });
/** FR-GUI-089: a new project that continues without a design system, after its design step failed. */
export const planDesignSchema = z.strictObject({ planId: planIdBodySchema });

/** FR-PLAN-033: one uploaded file, as base64. Its type and size are checked once decoded (FR-PLAN-022). */
export const planUploadSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(GUI_MAX_UPLOAD_NAME_CHARS)

    .refine((name) => !/[\u0000-\u001f\u007f]/.test(name), "A file's name can't have control characters."),
  contentBase64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, "The file's content isn't base64."),
  /** The page that holds it (FR-PLAN-022); a request with none counts as one page of its own. */
  pageId: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/, "That isn't a page's ID.")
    .default("api"),
});

/** FR-PLAN-022: a file the page is about to send, checked with the rules the upload is checked with. */
export const planUploadCheckSchema = z.strictObject({
  name: z.string().trim().min(1).max(GUI_MAX_UPLOAD_NAME_CHARS),
  sizeBytes: z.number().int().nonnegative(),
});

/** FR-GUI-027: `luseen auto`'s options, checked with the CLI's own limits. */
export const autoOptionsSchema = z.strictObject({
  roadmap: idSchema,
  developers: limit("--developers <n>", AUTO_LIMITS.developers),
  model: modelValueSchema.optional(),
  effort: effortValueSchema.optional(),
  timeoutMinutes: limit("--timeout-minutes <n>", LIMITS.timeoutMinutes),
});
export type AutoOptions = z.output<typeof autoOptionsSchema>;

/** FR-AUTO-040: what `luseen auto --dry-run --json` prints. */
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
  // FR-GUI-020: every `luseen tasks` change. Creating a roadmap or milestone isn't one (FR-GUI-021).
  z.strictObject({
    command: z.literal("tasks-add"),
    title: titleSchema,
    description: textSchema.optional(),
    spec: specNameSchema.optional(),
    dependsOn: z.array(idSchema).max(GUI_MAX_DEPENDENCIES).default([]),
  }),
  z.strictObject({ command: z.enum(["tasks-depend", "tasks-undepend"]), id: idSchema, on: idSchema }),
  // FR-GUI-088, FR-GUI-089: a new project's specs and design, started only by its planning session.
  z.strictObject({
    command: z.enum(["project-specs", "project-design"]),
    model: modelValueSchema,
    effort: effortValueSchema,
  }),
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

/** FR-GUI-013, FR-GUI-033: the arguments of the `luseen` child process, run in the project's folder. */
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
    case "project-specs":
      return ["--json", ...projectSpecsArgs(request.model, request.effort)];
    case "project-design":
      return [...projectDesignArgs(request.model, request.effort), "--json"];
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
  return ["luseen", ...args.map((arg) => (/^[\w./=:@-]+$/.test(arg) ? arg : JSON.stringify(arg)))].join(" ");
}

/** FR-GUI-035: commands that change the same files, of which only one may run. Others, such as doctor, may run side by side. */
const CONFLICTING: ReadonlySet<JobKind> = new Set<JobKind>([
  "generate",
  "clean",
  "skills",
  "environment",
  "project-specs",
  "project-design",
]);
/** FR-GUI-088: jobs only a new project's planning session starts, never a request from the page. */
export const SESSION_JOBS: ReadonlySet<JobKind> = new Set<JobKind>(["project-specs", "project-design"]);

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

/** FR-PLAN-042: one entry of the Plan panel's conversation, from the session's Claude transcript. */
export interface PlanChatItem {
  readonly kind: "user" | "pm" | "note" | "activity" | "result";
  readonly text: string;
  /** For an activity: the tool, so a `plan_propose` call can be shown as a proposal. */
  readonly tool: string | null;
  /** For a user message: the files it listed, each with its stored file name in the session (FR-PLAN-037). */
  readonly attachments: readonly { readonly name: string; readonly kind: string; readonly file: string }[];
  /** For a `plan_suggest` call: the web sources it gave, shown under that turn's message (FR-PLAN-037). */
  readonly sources: readonly { readonly title: string; readonly url: string }[];
  /** For a `plan_suggest` call: the answers it offered, shown as buttons while its turn is the newest. */
  readonly suggestions: readonly string[];
  /** For a tool call, its ID; for a tool result, the call it answers, so a refused call can be left out. */
  readonly toolUseId: string | null;
  /** For a tool result, or a call with input the tool refuses: the call was refused (FR-PLAN-007). */
  readonly isError: boolean;
  /** For luseen's request to answer a message again: that message, as the conversation shows it (FR-PLAN-014). */
  readonly repeats?: PlanChatItem | null;
  readonly at: string | null;
}

/** What the panel shows for luseen's request to answer the last message again. */
export const ANSWER_LAST_NOTE = "Asked the PM to answer your last message.";

/** How `buildUserMessage` lists a message's files (FR-PLAN-006). */
const ATTACHED_HEADING = /(?:^|\n\n)Attached \(new in this message\):\n/;
const ATTACHED_LINE = /^- (.+) \((image|document)\): (.+)$/;

function parsedInput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // A long input is cut short in the transcript view, so only the tool's name is shown.
    return {};
  }
}

/** The sources a `plan_suggest` call gave, as far as they're well formed. */
function sourcesOf(input: unknown): PlanChatItem["sources"] {
  const parsed = z.object({ sources: z.array(z.unknown()) }).safeParse(input);
  if (!parsed.success) return [];
  return parsed.data.sources.flatMap((source) => {
    const checked = sourceSchema.safeParse(source);
    return checked.success ? [checked.data] : [];
  });
}

/** What `plan_suggest` accepts besides its session, as the tool checks it (FR-PLAN-007). */
const suggestInputSchema = z.object({ suggestions: suggestionsSchema, sources: sourcesSchema.default([]) });

/** The suggested answers a `plan_suggest` call gave, as far as they're well formed. */
function suggestionsOf(input: unknown): readonly string[] {
  const parsed = z.object({ suggestions: z.array(z.unknown()) }).safeParse(input);
  if (!parsed.success) return [];
  return parsed.data.suggestions.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

/** A tool call's ID, or the call a tool result answers, and whether the tool refused it. */
export interface ToolLink {
  readonly toolUseId: string | null;
  readonly isError: boolean;
}

const toolBlockSchema = z.looseObject({
  type: z.string(),
  id: z.string().optional(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
});
const toolLineSchema = z.looseObject({ message: z.looseObject({ content: z.array(z.unknown()) }) });

/** The tool calls and results of one transcript line, in order, as `parseTranscriptLine` lists them. */
export function toolLinksOf(line: string): ToolLink[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // An unreadable line has no entries either.
    return [];
  }
  const content = toolLineSchema.safeParse(parsed);
  if (!content.success) return [];
  return content.data.message.content.flatMap((block): ToolLink[] => {
    const checked = toolBlockSchema.safeParse(block);
    if (!checked.success) return [];
    if (checked.data.type === "tool_use") return [{ toolUseId: checked.data.id ?? null, isError: false }];
    if (checked.data.type === "tool_result")
      return [{ toolUseId: checked.data.tool_use_id ?? null, isError: checked.data.is_error === true }];
    return [];
  });
}

/** FR-PLAN-037, FR-PLAN-042: transcript entries as the Plan panel shows them, with their tool links in order. */
export function toPlanChatItems(entries: readonly TranscriptEntry[], links: readonly ToolLink[] = []): PlanChatItem[] {
  let nextLink = 0;
  return entries.flatMap((entry): PlanChatItem[] => {
    const isTool = entry.kind === "tool-call" || entry.kind === "tool-result";
    const link = isTool ? links[nextLink++] : undefined;
    const base = {
      tool: null,
      attachments: [],
      sources: [],
      suggestions: [],
      toolUseId: link?.toolUseId ?? null,
      isError: link?.isError ?? false,
      at: entry.at,
    };
    switch (entry.kind) {
      case "assistant":
        return entry.text.trim() === "" ? [] : [{ ...base, kind: "pm", text: entry.text }];
      case "tool-call": {
        const input = parsedInput(entry.text);
        const isSuggest = /plan_suggest$/.test(entry.tool ?? "");
        // FR-PLAN-007: input the tool would refuse is marked refused here too, before its result is written.
        const isRefused = isSuggest && !suggestInputSchema.safeParse(input).success;
        return [
          {
            ...base,
            kind: "activity",
            tool: entry.tool,
            text: activityOf(entry.tool ?? "tool", input),
            sources: isSuggest && !isRefused ? sourcesOf(input) : [],
            suggestions: isSuggest && !isRefused ? suggestionsOf(input) : [],
            isError: isRefused,
          },
        ];
      }
      case "tool-result":
        return [{ ...base, kind: "result", text: entry.text }];
      case "user": {
        const own = userPartOf(entry.text);
        if (isPlanningNote(own)) {
          // FR-PLAN-014: asked to answer a message again, the PM is sent it after a blank line.
          const repeated = repeatedMessageOf(own);
          const repeats =
            repeated === null ? [] : toPlanChatItems([{ kind: "user", text: repeated, tool: null, at: entry.at }]);
          // Shown short: the message it repeats is the user's, shown as theirs (FR-PLAN-038).
          const text = own.startsWith(ANSWER_LAST_MESSAGE) ? ANSWER_LAST_NOTE : own;
          return [{ ...base, kind: "note", text, repeats: repeats[0] ?? null }];
        }
        const heading = ATTACHED_HEADING.exec(own);
        const text = heading === null ? own : own.slice(0, heading.index);
        const attachments =
          heading === null
            ? []
            : own
                .slice(heading.index + heading[0].length)
                .split("\n")
                .flatMap((line) => {
                  const match = ATTACHED_LINE.exec(line);
                  return match?.[1] === undefined || match[2] === undefined || match[3] === undefined
                    ? []
                    : [{ name: match[1], kind: match[2], file: match[3].split("/").at(-1) ?? "" }];
                });
        return text.trim() === "" && attachments.length === 0
          ? []
          : [{ ...base, kind: "user", text: text.trim(), attachments }];
      }
    }
  });
}
