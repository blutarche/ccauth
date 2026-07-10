import { humanizeUntil } from "./humanize.js";

/** Refresh tokens within this window of expiring are flagged as "dying". */
export const DYING_THRESHOLD = 3 * 86400_000;

/**
 * Renders a cached `refreshTokenExpiresAt` as the `EXPIRES` cell shown by
 * `list` and `current`: `-` when unknown, `expired` when past, a flagged
 * "in N unit(s) ⚠" when dying soon, else a plain "in N unit(s)".
 */
export function formatExpiryCell(
  refreshTokenExpiresAt: number | undefined,
  now: Date,
): string {
  if (refreshTokenExpiresAt === undefined) return "-";

  const remainingMs = refreshTokenExpiresAt - now.getTime();
  if (remainingMs <= 0) return "expired";

  const until = humanizeUntil(new Date(refreshTokenExpiresAt), now);
  return remainingMs <= DYING_THRESHOLD ? `${until} ⚠` : until;
}
