/**
 * The Claude plan's usage limits, as Claude Code reports them in a `claude -p` stream's `rate_limit_event`
 * (spec: automated-mode FR-AUTO-041, gui FR-GUI-083). The event isn't documented, so it's read leniently: anything
 * missing or of another shape is no limit at all. Pure: no I/O.
 */
import { z } from "zod";
import { LIMIT_HIGH_USE } from "./constants/gui.js";
import { LIMIT_STATUS_MAX_CHARS as STATUS_MAX_CHARS, MS_PER_SECOND } from "./constants/limits.js";

export const LIMITS_VERSION = 1;

/** A window Claude Code reports, such as the 5-hour session or the 7-day week. */
const windowSchema = z.strictObject({
  /** The share of the window used, from 0 to 1. */
  used: z.number().min(0).max(1),
  resetsAt: z.string().nullable(),
  status: z.string().max(STATUS_MAX_CHARS),
});
export type LimitWindow = z.infer<typeof windowSchema>;

/** What `limits.json` holds: the newest windows, and when they were read. Nothing about the account or the work. */
export const planLimitsSchema = z.strictObject({
  version: z.literal(LIMITS_VERSION),
  readAt: z.string(),
  status: z.string().max(STATUS_MAX_CHARS),
  /** When the window that limits the account resets, if Claude Code said. */
  resetsAt: z.string().nullable(),
  session: windowSchema.nullable(),
  week: windowSchema.nullable(),
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;

const eventWindowSchema = z.object({
  utilization: z.number(),
  resetsAt: z.number().optional(),
  status: z.string().optional(),
});

const eventSchema = z.object({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.object({
    status: z.string(),
    resetsAt: z.number().optional(),
    unifiedWindows: z
      .object({ five_hour: eventWindowSchema.optional(), seven_day: eventWindowSchema.optional() })
      .optional(),
  }),
});

const isoFromSeconds = (seconds: number | undefined): string | null =>
  seconds === undefined || !Number.isFinite(seconds) ? null : new Date(seconds * MS_PER_SECOND).toISOString();

function windowOf(raw: z.infer<typeof eventWindowSchema> | undefined, status: string): LimitWindow | null {
  if (raw === undefined || !Number.isFinite(raw.utilization)) return null;
  return {
    used: Math.min(1, Math.max(0, raw.utilization)),
    resetsAt: isoFromSeconds(raw.resetsAt),
    status: (raw.status ?? status).slice(0, STATUS_MAX_CHARS),
  };
}

/** FR-AUTO-041: the limits in one stream event, or undefined for any other event or an event of another shape. */
export function limitsFromEvent(event: unknown, now: Date): PlanLimits | undefined {
  const parsed = eventSchema.safeParse(event);
  if (!parsed.success) return undefined;
  const info = parsed.data.rate_limit_info;
  const windows = info.unifiedWindows ?? {};
  return {
    version: LIMITS_VERSION,
    readAt: now.toISOString(),
    status: info.status.slice(0, STATUS_MAX_CHARS),
    resetsAt: isoFromSeconds(info.resetsAt),
    session: windowOf(windows.five_hour, info.status),
    week: windowOf(windows.seven_day, info.status),
  };
}

/** Statuses that let work go on; Claude Code also reports a warning one as a limit nears. */
const ALLOWED = /^allowed/;

/** FR-AUTO-025: whether these limits stop new work, because a window is used up. */
export function isLimitReached(limits: PlanLimits): boolean {
  return !ALLOWED.test(limits.status);
}

/** A window as the top bar shows it. */
export interface LimitWindowView extends LimitWindow {
  /** Its reset time has passed, so its saved use is old. */
  readonly hasReset: boolean;
}

/** FR-GUI-083: the limits as the top bar shows them, with the same rule a run stops on. */
export interface LimitsView extends Omit<PlanLimits, "session" | "week"> {
  readonly session: LimitWindowView | null;
  readonly week: LimitWindowView | null;
  /** Reached, and its reset time hasn't passed yet. */
  readonly isReached: boolean;
  /** The share at which a window is marked. */
  readonly highUse: number;
}

/** Worked out on the server, so the canvas it sends changes when a reset time passes. */
export function limitsView(limits: PlanLimits, now: Date): LimitsView {
  const hasPassed = (at: string | null) => at !== null && Date.parse(at) <= now.getTime();
  const windowView = (window: LimitWindow | null) =>
    window === null ? null : { ...window, hasReset: hasPassed(window.resetsAt) };
  return {
    ...limits,
    session: windowView(limits.session),
    week: windowView(limits.week),
    isReached: isLimitReached(limits) && !hasPassed(limits.resetsAt),
    highUse: LIMIT_HIGH_USE,
  };
}
