import type { Deps, UsageFetchResult, UsageWindow } from "../types.js";
import { AUTOSAVE_NAME, profileService } from "../types.js";
import { readOauthAccount } from "../claudeConfig.js";
import { readIndex } from "../profiles.js";
import { sameAccount } from "../util/identity.js";
import { humanizeAgo, humanizeCompact } from "../util/humanize.js";
import { formatExpiryCell } from "../util/expiry.js";
import type { OauthAccessToken } from "../util/oauthBlob.js";
import { parseOauthAccessToken } from "../util/oauthBlob.js";

export async function listCommand(
  deps: Deps,
  opts: { all?: boolean; usage?: boolean } = {},
): Promise<void> {
  const index = readIndex(deps);
  const names = Object.keys(index.profiles)
    .filter((name) => opts.all || name !== AUTOSAVE_NAME)
    .sort();

  if (names.length === 0) {
    deps.stdout("No saved profiles yet. Run `ccauth save <name>` to create one.");
    return;
  }

  const liveAccount = readOauthAccount(deps);
  const now = deps.now();
  const activeNames = new Set(
    names.filter((name) =>
      sameAccount(index.profiles[name]?.oauthAccount, liveAccount),
    ),
  );

  const usage = opts.usage
    ? await fetchUsageCells(deps, names, activeNames, now)
    : undefined;

  const rows = names.map((name) => {
    const entry = index.profiles[name]!;
    const cells = usage?.get(name);
    return {
      name: activeNames.has(name) ? `* ${name}` : `  ${name}`,
      email: entry.email ?? "-",
      org: entry.org ?? "-",
      saved: humanizeAgo(new Date(entry.savedAt), now),
      expires: formatExpiryCell(entry.refreshTokenExpiresAt, now),
      fiveH: cells?.fiveH ?? "",
      week: cells?.week ?? "",
    };
  });

  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    email: Math.max(5, ...rows.map((r) => r.email.length)),
    org: Math.max(3, ...rows.map((r) => r.org.length)),
    saved: Math.max(5, ...rows.map((r) => r.saved.length)),
    expires: Math.max(7, ...rows.map((r) => r.expires.length)),
    fiveH: Math.max(2, ...rows.map((r) => r.fiveH.length)),
  };

  const lead = (r: { name: string; email: string; org: string; saved: string }): string =>
    `${pad(r.name, widths.name)}  ${pad(r.email, widths.email)}  ${pad(r.org, widths.org)}  ${pad(r.saved, widths.saved)}`;
  const HEADER = { name: "NAME", email: "EMAIL", org: "ORG", saved: "SAVED" };

  if (usage === undefined) {
    deps.stdout(`${lead(HEADER)}  EXPIRES`);
    for (const row of rows) {
      deps.stdout(`${lead(row)}  ${row.expires}`);
    }
    return;
  }

  deps.stdout(
    `${lead(HEADER)}  ${pad("EXPIRES", widths.expires)}  ${pad("5H", widths.fiveH)}  WEEK`,
  );
  for (const row of rows) {
    deps.stdout(
      `${lead(row)}  ${pad(row.expires, widths.expires)}  ${pad(row.fiveH, widths.fiveH)}  ${row.week}`,
    );
  }

  if (rows.some((r) => r.fiveH === STALE_CELLS.fiveH)) {
    deps.stdout("");
    deps.stdout("stale: run `ccauth refresh` to update usage-readout tokens");
  }
}

interface UsageCells {
  fiveH: string;
  week: string;
}

const STALE_CELLS: UsageCells = { fiveH: "stale", week: "stale" };
const MISSING_CELLS: UsageCells = { fiveH: "-", week: "-" };

/**
 * Resolves the usage cells for every row before rendering (column widths
 * need the full set). Read-only by design: stored tokens are used as-is,
 * never refreshed -- a stale token renders `stale` and the remedy is
 * `ccauth refresh` (docs/plans/2026-07-12-ccauth-usage-design.md).
 */
async function fetchUsageCells(
  deps: Deps,
  names: string[],
  activeNames: ReadonlySet<string>,
  now: Date,
): Promise<Map<string, UsageCells>> {
  // The live slot's token, read lazily at most once: only an active row
  // whose stored token has gone stale needs it (Claude Code keeps the live
  // token fresh, so the active row stays readable without a refresh).
  let liveTokenMemo: { token: string | undefined } | undefined;
  const liveToken = (): string | undefined => {
    if (liveTokenMemo === undefined) {
      const blob = deps.store.read(deps.liveService);
      liveTokenMemo = {
        token:
          blob === null
            ? undefined
            : freshAccessToken(parseOauthAccessToken(blob), now),
      };
    }
    return liveTokenMemo.token;
  };

  const entries = await Promise.all(
    names.map(async (name): Promise<[string, UsageCells]> => {
      const blob = deps.store.read(profileService(name));
      if (blob === null) return [name, MISSING_CELLS];
      const creds = parseOauthAccessToken(blob);
      // Not a Claude login at all -- same "no data" bucket as a missing
      // blob. A valid blob whose access token is merely unusable (empty,
      // expired, no expiry -- Claude Code sometimes stores exactly that)
      // falls through to the stale path instead: `ccauth refresh` fixes it.
      if (creds === undefined) return [name, MISSING_CELLS];

      const token =
        freshAccessToken(creds, now) ??
        (activeNames.has(name) ? liveToken() : undefined);
      if (token === undefined) return [name, STALE_CELLS];

      return [name, toUsageCells(await deps.fetchUsage(token), now)];
    }),
  );
  return new Map(entries);
}

function freshAccessToken(
  creds: OauthAccessToken | undefined,
  now: Date,
): string | undefined {
  if (creds?.accessToken === undefined || creds.expiresAt === undefined) {
    return undefined;
  }
  return creds.expiresAt > now.getTime() ? creds.accessToken : undefined;
}

function toUsageCells(result: UsageFetchResult, now: Date): UsageCells {
  switch (result.kind) {
    case "ok":
      return {
        fiveH: formatWindowCell(result.fiveHour, now),
        week: formatWindowCell(result.sevenDay, now),
      };
    case "auth":
      // Same remedy as a stale-by-clock token, so same vocabulary.
      return STALE_CELLS;
    case "limited":
      return { fiveH: "limited", week: "limited" };
    case "error":
      return { fiveH: "error", week: "error" };
  }
}

/** `78% (2h)` = percent of the window remaining, reset horizon in parens. */
function formatWindowCell(window: UsageWindow | undefined, now: Date): string {
  if (window === undefined) return "-";
  // Two-sided clamp: the API shouldn't send utilization outside 0-100, but a
  // percentage readout must never render outside that range regardless.
  const remaining = Math.min(100, Math.max(0, 100 - Math.round(window.utilization)));
  if (window.resetsAt === undefined) return `${remaining}%`;
  return `${remaining}% (${humanizeCompact(new Date(window.resetsAt), now)})`;
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - value.length));
}
