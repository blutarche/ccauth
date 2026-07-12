/** Humanizes the delta between `from` and `to` as "N unit(s) ago" / "just now". */
export function humanizeAgo(from: Date, to: Date): string {
  const deltaMs = to.getTime() - from.getTime();
  const deltaSec = Math.floor(deltaMs / 1000);

  if (deltaSec < 60) return "just now";

  const units: Array<[string, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];

  for (const [label, secondsPerUnit] of units) {
    const value = Math.floor(deltaSec / secondsPerUnit);
    if (value >= 1) {
      return `${value} ${label}${value === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

/** Humanizes the delta between `from` and `future` as "in N unit(s)" / "expired". */
export function humanizeUntil(future: Date, from: Date): string {
  const deltaMs = future.getTime() - from.getTime();

  if (deltaMs <= 0) return "expired";

  const deltaSec = Math.floor(deltaMs / 1000);

  const units: Array<[string, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];

  for (const [label, secondsPerUnit] of units) {
    const value = Math.floor(deltaSec / secondsPerUnit);
    if (value >= 1) {
      return `in ${value} ${label}${value === 1 ? "" : "s"}`;
    }
  }
  return "in less than a minute";
}

/**
 * Humanizes a future delta as a compact single unit: "45m", "2h", "3d".
 * Sub-minute and non-positive deltas render "<1m" (readout path: a reset
 * time already in the past is not worth a special case).
 */
export function humanizeCompact(future: Date, from: Date): string {
  const deltaSec = Math.floor((future.getTime() - from.getTime()) / 1000);

  const units: Array<[string, number]> = [
    ["y", 60 * 60 * 24 * 365],
    ["mo", 60 * 60 * 24 * 30],
    ["d", 60 * 60 * 24],
    ["h", 60 * 60],
    ["m", 60],
  ];

  for (const [label, secondsPerUnit] of units) {
    const value = Math.floor(deltaSec / secondsPerUnit);
    if (value >= 1) return `${value}${label}`;
  }
  return "<1m";
}
