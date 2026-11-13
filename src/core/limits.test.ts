import { describe, expect, it } from "vitest";
import { isLimitReached, limitsFromEvent, limitsView, type PlanLimits } from "./limits.js";

const NOW = new Date("2026-11-13T01:00:00.000Z");

/** The event as Claude Code 2.1.322 wrote it in a `claude -p` stream. */
const event = (status: string, extra: Record<string, unknown> = {}) => ({
  type: "rate_limit_event",
  rate_limit_info: {
    status,
    resetsAt: 1794532800,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.25, resetsAt: 1794532800, status },
      seven_day: { utilization: 0.85, resetsAt: 1794927600, status: "allowed" },
    },
    ...extra,
  },
  uuid: "x",
  session_id: "y",
});

describe("plan limits", () => {
  it("TC-AUTO-063: reads both windows' use and reset times, and nothing about the account", () => {
    const limits = limitsFromEvent(event("allowed"), NOW);
    expect(limits).toEqual({
      version: 1,
      readAt: NOW.toISOString(),
      status: "allowed",
      resetsAt: new Date(1794532800 * 1000).toISOString(),
      session: { used: 0.25, resetsAt: new Date(1794532800 * 1000).toISOString(), status: "allowed" },
      week: { used: 0.85, resetsAt: new Date(1794927600 * 1000).toISOString(), status: "allowed" },
    });
    expect(JSON.stringify(limits)).not.toContain("overage");
    expect(isLimitReached(limits ?? ({} as never))).toBe(false);
  });

  it("TC-AUTO-063: other events, and events of another shape, are no limits at all", () => {
    expect(limitsFromEvent({ type: "assistant" }, NOW)).toBeUndefined();
    expect(limitsFromEvent({ type: "rate_limit_event" }, NOW)).toBeUndefined();
    expect(limitsFromEvent({ type: "rate_limit_event", rate_limit_info: { status: 3 } }, NOW)).toBeUndefined();
    expect(limitsFromEvent(null, NOW)).toBeUndefined();
  });

  it("a window it doesn't send is null, and use outside 0 to 1 is kept within it", () => {
    const limits = limitsFromEvent(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 1.4 } } },
      },
      NOW,
    );
    expect(limits).toMatchObject({
      resetsAt: null,
      session: { used: 1, resetsAt: null, status: "allowed" },
      week: null,
    });
  });

  it("FR-AUTO-025: a rejected window stops new work; a warning as a limit nears doesn't", () => {
    expect(isLimitReached(limitsFromEvent(event("rejected"), NOW) ?? ({} as never))).toBe(true);
    expect(isLimitReached(limitsFromEvent(event("allowed_warning"), NOW) ?? ({} as never))).toBe(false);
  });
});

describe("limits view", () => {
  it("TC-GUI-134: marks a reached limit as the run's rule does, until its reset time passes, and sends the high-use share", () => {
    const reached = limitsFromEvent(event("rejected"), NOW) as PlanLimits;
    expect(limitsView(reached, NOW)).toMatchObject({ isReached: true, highUse: 0.8 });
    const afterReset = limitsView(reached, new Date(1794532800 * 1000));
    expect(afterReset.isReached).toBe(false);
    expect([afterReset.session?.hasReset, afterReset.week?.hasReset]).toEqual([true, false]);
    expect(limitsView(reached, NOW).session?.hasReset).toBe(false);
    expect(limitsView(limitsFromEvent(event("allowed_warning"), NOW) as PlanLimits, NOW).isReached).toBe(false);
  });
});
