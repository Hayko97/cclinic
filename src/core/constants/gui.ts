/** Values for the local GUI (spec: gui). */
import { SHUTDOWN_TIMEOUT_MS } from "./limits.js";
import { TOOL_FOLDER_NAME } from "./paths.js";

/** FR-GUI-002: the GUI is reachable from this machine only. */
export const GUI_HOST = "127.0.0.1";
export const GUI_HOST_NAMES = [GUI_HOST, "localhost"] as const;
/** FR-GUI-001: tried first when --port isn't given; a free port is used when it's taken. */
export const GUI_DEFAULT_PORT = 4417;
export const GUI_MAX_PORT = 65_535;
export const HTTP_DEFAULT_PORT = 80;
/** FR-GUI-003: 32 random bytes, well above the 128 bits required. */
export const GUI_TOKEN_BYTES = 32;
export const GUI_TOKEN_HEADER = "x-cclinic-token";
export const GUI_TOKEN_QUERY = "token";
export const GUI_COOKIE_PREFIX = "cclinic_token_";

/** FR-GUI-047: the GUI's only files, ignored by Git. */
export const GUI_FOLDER = `${TOOL_FOLDER_NAME}/gui`;
export const GUI_LOCK_FILE = "gui.lock";

/** FR-GUI-012: pages may load nothing from outside the GUI. */
export const GUI_CONTENT_SECURITY_POLICY =
  "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
/** FR-GUI-010: the only static files the GUI serves. */
export const GUI_ASSETS = { page: "index.html", files: ["app.js", "styles.css"] } as const;
export const GUI_MAX_BODY_BYTES = 1_048_576;
/** The longest include or exclude pattern, and the most of each, the GUI passes on. */
export const GUI_MAX_PATTERN_LENGTH = 500;
export const GUI_MAX_PATTERNS = 100;

export const HTTP_STATUS = {
  ok: 200,
  created: 201,
  accepted: 202,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  tooLarge: 413,
  internalError: 500,
} as const;

/** FR-GUI-033, FR-GUI-034: a job's newest output lines kept, and the wait between SIGINT and SIGTERM. */
export const JOB_OUTPUT_MAX_LINES = 5_000;
/** Longer than the child's own clean stop, so SIGTERM only ends a job that hangs: to cclinic it's a second signal. */
export const JOB_CANCEL_GRACE_MS = SHUTDOWN_TIMEOUT_MS + 1_000;
/** FR-GUI-004: how long the platform's opener may take before the GUI just prints the link. */
export const BROWSER_OPEN_TIMEOUT_MS = 10_000;
