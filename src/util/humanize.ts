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
