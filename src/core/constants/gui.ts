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
export const GUI_ASSETS = {
  page: "index.html",
  files: ["app.js", "api.js", "canvas.js", "panel.js", "list.js", "jobs.js", "icons.js", "styles.css"],
} as const;
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

/** FR-GUI-022, FR-GUI-042, FR-GUI-075: how often the canvas and an open transcript are checked for changes. */
export const CANVAS_POLL_MS = 1_000;
export const TRANSCRIPT_POLL_MS = 1_000;
/** FR-GUI-077: an interactive session seen within this long counts as working now. */
export const SESSION_ACTIVITY_MS = 300_000;
/** A transcript shows at most its newest entries, and each entry's text is cut to this length. */
export const TRANSCRIPT_MAX_ENTRIES = 2_000;
export const TRANSCRIPT_MAX_TEXT_CHARS = 4_000;
/** Claude Code's own session IDs are UUIDs; this also allows any ID cclinic records, and nothing path-like. */
export const SESSION_ID_PATTERN = "[A-Za-z0-9][A-Za-z0-9_-]{0,99}";

/** FR-GUI-073, FR-GUI-074: the saved canvas layout, and the automatic one's sizes in canvas pixels. */
export const GUI_LAYOUT_FILE = "layout.json";
export const LAYOUT_VERSION = 1;
export const LAYOUT_MAX_ITEMS = 5_000;
export const LAYOUT_MAX_COORDINATE = 1_000_000;
export const LAYOUT = {
  cardWidth: 220,
  cardHeight: 140,
  columnGap: 32,
  rowGap: 20,
  framePadding: 24,
  frameHeader: 96,
  frameGap: 80,
} as const;
/** At most this much of a transcript is read at once; for a larger one, only its newest part is shown. */
export const TRANSCRIPT_MAX_READ_BYTES = 16_777_216;
/** The most dependencies a task added from the GUI may name. */
export const GUI_MAX_DEPENDENCIES = 100;
