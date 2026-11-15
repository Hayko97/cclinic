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
export const GUI_TOKEN_HEADER = "x-luseen-token";
export const GUI_TOKEN_QUERY = "token";
export const GUI_COOKIE_PREFIX = "luseen_token_";

/** FR-GUI-083: a plan-limit window at this share or more is marked, so a limit coming up is seen in time. */
export const LIMIT_HIGH_USE = 0.8;

/** FR-GUI-047: the GUI's only files, ignored by Git. */
export const GUI_FOLDER = `${TOOL_FOLDER_NAME}/gui`;
export const GUI_LOCK_FILE = "gui.lock";

/** FR-GUI-012: pages may load nothing from outside the GUI. */
export const GUI_CONTENT_SECURITY_POLICY =
  "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
/** FR-GUI-010: the only static files the GUI serves. */
export const GUI_ASSETS = {
  page: "index.html",
  files: [
    "app.js",
    "api.js",
    "canvas.js",
    "panel.js",
    "list.js",
    "jobs.js",
    "icons.js",
    "filters.js",
    "attention.js",
    "setup.js",
    "follow.js",
    "auto.js",
    "plan.js",
    "markdown.js",
    "router.js",
    "limits.js",
    "styles.css",
  ],
} as const;
/** The largest request body. */
export const GUI_MAX_BODY_BYTES = 1_048_576;
/**
 * FR-PLAN-033: the largest body of a planning upload, the one route that takes more: a 20 MB document, sent as
 * base64, which is a third larger, with room for the JSON around it.
 */
export const GUI_MAX_UPLOAD_BODY_BYTES = 28 * GUI_MAX_BODY_BYTES;
/** FR-PLAN-033: the longest name of an uploaded file. */
export const GUI_MAX_UPLOAD_NAME_CHARS = 255;
/** FR-PLAN-022: a waiting upload from another page is dropped after this long, as left behind by it. */
export const UPLOAD_ORPHAN_MS = 600_000;
/** FR-PLAN-042: how often the Plan panel's session is checked for changes made elsewhere. */
export const PLAN_VIEW_POLL_MS = 1_000;
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
/** Longer than the child's own clean stop, so SIGTERM only ends a job that hangs: to luseen it's a second signal. */
export const JOB_CANCEL_GRACE_MS = SHUTDOWN_TIMEOUT_MS + 1_000;
/** FR-GUI-004: how long the platform's opener may take before the GUI just prints the link. */
export const BROWSER_OPEN_TIMEOUT_MS = 10_000;

/** FR-GUI-022, FR-GUI-042, FR-GUI-075: how often the canvas and an open transcript are checked for changes. */
export const CANVAS_POLL_MS = 1_000;
export const TRANSCRIPT_POLL_MS = 1_000;
/** FR-GUI-077: an interactive session seen within this long counts as working now. */
export const SESSION_ACTIVITY_MS = 300_000;
/** FR-GUI-057: a live session whose transcript wasn't written to for this long is marked as quiet. */
export const SESSION_STALL_MS = 300_000;
/** FR-GUI-057: how much of a live transcript's end is read for its newest tool call, and its input's shown length. */
export const TRANSCRIPT_TAIL_BYTES = 65_536;
export const TOOL_INPUT_SHORT_CHARS = 80;
/** FR-GUI-059: a tool result longer than this many lines is folded. */
export const TRANSCRIPT_FOLD_LINES = 20;
/** A transcript shows at most its newest entries, and each entry's text is cut to this length. */
export const TRANSCRIPT_MAX_ENTRIES = 2_000;
export const TRANSCRIPT_MAX_TEXT_CHARS = 4_000;
/** Claude Code's own session IDs are UUIDs; this also allows any ID luseen records, and nothing path-like. */
export const SESSION_ID_PATTERN = "[A-Za-z0-9][A-Za-z0-9_-]{0,99}";

/** FR-GUI-073, FR-GUI-074: the saved canvas layout, and the automatic one's sizes in canvas pixels. */
export const GUI_LAYOUT_FILE = "layout.json";
export const LAYOUT_VERSION = 1;
export const LAYOUT_MAX_ITEMS = 5_000;
export const LAYOUT_MAX_COORDINATE = 1_000_000;
export const LAYOUT = {
  cardWidth: 220,
  cardHeight: 140,
  /** Room beside each card for its session nodes (FR-GUI-070), so they never cover the next column. */
  columnGap: 148,
  rowGap: 20,
  framePadding: 24,
  frameHeader: 96,
  frameGap: 80,
} as const;
/** At most this much of a transcript is read at once; for a larger one, only its newest part is shown. */
export const TRANSCRIPT_MAX_READ_BYTES = 16_777_216;
/** The most dependencies a task added from the GUI may name. */
export const GUI_MAX_DEPENDENCIES = 100;
