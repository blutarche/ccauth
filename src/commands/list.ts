import type {
  Deps,
  OauthAccount,
  ProfilesIndex,
  UsageFetchResult,
  UsageWindow,
} from "../types.js";
import { AUTOSAVE_NAME, profileService } from "../types.js";
import { readOauthAccount } from "../claudeConfig.js";
import { readIndex } from "../profiles.js";
import { sameAccount } from "../util/identity.js";
import { humanizeAgo, humanizeCompact } from "../util/humanize.js";
import { formatExpiryCell } from "../util/expiry.js";
import { parseOauthAccessToken } from "../util/oauthBlob.js";
import { validateCredentialBlob } from "../util/blob.js";

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

  const usage = opts.usage
    ? await fetchUsageCells(deps, index, names, liveAccount, now)
    : undefined;

  const rows = names.map((name) => {
    const entry = index.profiles[name]!;
    const active = sameAccount(entry.oauthAccount, liveAccount);
    const cells = usage?.get(name);
    return {
      name: active ? `* ${name}` : `  ${name}`,
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

  if (rows.some((r) => r.fiveH === "stale")) {
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
  index: ProfilesIndex,
  names: string[],
  liveAccount: OauthAccount | undefined,
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
        token: blob === null ? undefined : freshAccessToken(blob, now),
      };
    }
    return liveTokenMemo.token;
  };

  const entries = await Promise.all(
    names.map(async (name): Promise<[string, UsageCells]> => {
      const blob = deps.store.read(profileService(name));
      if (blob === null) return [name, MISSING_CELLS];
      try {
        validateCredentialBlob(blob, name);
      } catch {
        // Not a Claude login at all -- same "no data" bucket as a missing
        // blob. A VALID blob whose access token is merely unusable (empty,
        // no expiry -- Claude Code sometimes stores exactly that) falls
        // through to the stale path instead: `ccauth refresh` fixes it.
        return [name, MISSING_CELLS];
      }

      const stored = parseOauthAccessToken(blob);
      const storedFresh =
        stored.accessToken !== undefined &&
        stored.expiresAt !== undefined &&
        stored.expiresAt > now.getTime();
      const active = sameAccount(index.profiles[name]?.oauthAccount, liveAccount);
      const token = storedFresh ? stored.accessToken : active ? liveToken() : undefined;
      if (token === undefined) return [name, STALE_CELLS];

      return [name, toUsageCells(await deps.fetchUsage(token), now)];
    }),
  );
  return new Map(entries);
}

function freshAccessToken(blob: string, now: Date): string | undefined {
  const { accessToken, expiresAt } = parseOauthAccessToken(blob);
  const fresh =
    accessToken !== undefined && expiresAt !== undefined && expiresAt > now.getTime();
  return fresh ? accessToken : undefined;
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
  const remaining = Math.max(0, 100 - Math.round(window.utilization));
  if (window.resetsAt === undefined) return `${remaining}%`;
  return `${remaining}% (${humanizeCompact(new Date(window.resetsAt), now)})`;
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - value.length));
}
