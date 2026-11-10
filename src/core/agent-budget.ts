/** Spending limits shared by the PM, developer and QA agents (FR-PLAN-015, FR-AUTO-025). */

export interface Spending {
  readonly spentUsd: number;
  /** The most one call has cost so far, used to estimate the next call. */
  readonly highestCallUsd: number;
}

export const NO_SPENDING: Spending = { spentUsd: 0, highestCallUsd: 0 };

export function recordCall(spending: Spending, costUsd: number | null): Spending {
  const cost = costUsd ?? 0;
  return { spentUsd: spending.spentUsd + cost, highestCallUsd: Math.max(spending.highestCallUsd, cost) };
}

/** A call starts only when the budget left covers the most expensive call so far. */
export function canStartCall(spending: Spending, budgetUsd: number): boolean {
  return spending.spentUsd < budgetUsd && spending.spentUsd + spending.highestCallUsd <= budgetUsd;
}

export function remainingUsd(spending: Spending, budgetUsd: number): number {
  return Math.max(budgetUsd - spending.spentUsd, 0);
}
