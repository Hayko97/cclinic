/** Who may call the local GUI, what it serves, and the jobs it runs (spec: gui). Pure: no I/O. */
import { z } from "zod";
import {
  GUI_ASSETS,
  GUI_CONTENT_SECURITY_POLICY,
  GUI_COOKIE_PREFIX,
  GUI_HOST_NAMES,
  GUI_MAX_PATTERN_LENGTH,
  GUI_MAX_PATTERNS,
  GUI_TOKEN_HEADER,
  GUI_TOKEN_QUERY,
  HTTP_DEFAULT_PORT,
  HTTP_STATUS,
} from "./constants/gui.js";
import { LIMITS } from "./constants/limits.js";
import { PROVIDER_CHOICES } from "./constants/llm.js";
import { EXIT_CODES } from "./errors.js";

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
  | { readonly name: "start-job" }
  | { readonly name: "job"; readonly id: string }
  | { readonly name: "job-events"; readonly id: string }
  | { readonly name: "cancel-job"; readonly id: string };

const ASSET_FILES: ReadonlySet<string> = new Set(GUI_ASSETS.files);
const JOB_PATH = "/api/jobs/(job-[1-9][0-9]{0,5})";

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
  { method: "POST", pattern: /^\/api\/jobs$/, route: () => ({ name: "start-job" }) },
  { method: "GET", pattern: new RegExp(`^${JOB_PATH}$`), route: (id) => ({ name: "job", id }) },
  { method: "GET", pattern: new RegExp(`^${JOB_PATH}/events$`), route: (id) => ({ name: "job-events", id }) },
  { method: "POST", pattern: new RegExp(`^${JOB_PATH}/cancel$`), route: (id) => ({ name: "cancel-job", id }) },
];

export function matchRoute(method: string, path: string): Route | undefined {
  for (const entry of ROUTES) {
    const match = entry.method === method ? entry.pattern.exec(path) : null;
    if (match !== null) return entry.route(match[1] ?? "");
  }
  return undefined;
}

const patternSchema = z.string().min(1).max(GUI_MAX_PATTERN_LENGTH);
const modelValueSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/);
const limit = (bounds: { readonly minimum: number; readonly maximum: number }) =>
  z.number().int().min(bounds.minimum).max(bounds.maximum).optional();

/** FR-GUI-015: generate's options, checked with the CLI's own limits. */
export const generateOptionsSchema = z.strictObject({
  provider: z.enum(PROVIDER_CHOICES).optional(),
  model: modelValueSchema.optional(),
  effort: modelValueSchema.optional(),
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
  maxFiles: limit(LIMITS.maxFiles),
  maxInputTokens: limit(LIMITS.maxInputTokens),
  maxFileSizeMib: limit(LIMITS.maxFileSizeMib),
  maxBudgetUsd: z.number().positive().optional(),
  concurrency: limit(LIMITS.concurrency),
  timeoutMinutes: limit(LIMITS.timeoutMinutes),
  maxRetries: limit(LIMITS.maxRetries),
});

/** The commands the GUI can run. Text from the browser is only ever an option's value (FR-GUI-013). */
export const jobRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("doctor") }),
  z.strictObject({ command: z.literal("skills"), force: z.boolean().default(false) }),
  z.strictObject({ command: z.literal("clean") }),
  z.strictObject({ command: z.literal("model-list") }),
  z.strictObject({ command: z.literal("model-reset") }),
  // The user answered the CLI's confirmation in the GUI, so the run is started with --yes.
  z.strictObject({ command: z.literal("generate"), confirmed: z.literal(true), options: generateOptionsSchema }),
]);
export type JobRequest = z.output<typeof jobRequestSchema>;
export type JobKind = JobRequest["command"];

type GenerateOptions = z.output<typeof generateOptionsSchema>;

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
    case "generate":
      return ["--json", "--yes", ...generateArgs(request.options)];
  }
}

/** How a job is shown: the command a user would type, with values quoted where needed. */
export function describeJob(args: readonly string[]): string {
  return ["cclinic", ...args.map((arg) => (/^[\w./=:@-]+$/.test(arg) ? arg : JSON.stringify(arg)))].join(" ");
}

/** FR-GUI-035: commands that change the same files, of which only one may run. Others, such as doctor, may run side by side. */
const CONFLICTING: ReadonlySet<JobKind> = new Set<JobKind>(["generate", "clean", "skills"]);

/** The running job that stops this one from starting, if any (FR-GUI-035). */
export function blockingJob<T extends { readonly kind: JobKind }>(kind: JobKind, running: readonly T[]): T | undefined {
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
