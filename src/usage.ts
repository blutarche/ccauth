import type { UsageFetchResult, UsageWindow } from "./types.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** The usage endpoint currently requires this beta header. */
const BETA_HEADER = "oauth-2025-04-20";
/**
 * The endpoint serves the Claude Code OAuth client, so it expects a
 * claude-code User-Agent. A pinned version string is deliberate: shelling
 * out to `claude --version` on every `list --usage` isn't worth the spawn.
 */
const USER_AGENT = "claude-code/2.1.0";
const TIMEOUT_MS = 10_000;

/**
 * Real `Deps.fetchUsage`. Never rejects; see `UsageFetchResult`. The
 * `fetchImpl` parameter exists for tests only.
 */
export async function realFetchUsage(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UsageFetchResult> {
  let response: Response;
  try {
    response = await fetchImpl(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "anthropic-beta": BETA_HEADER,
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { kind: "error" };
  }

  if (response.status === 401) return { kind: "auth" };
  if (response.status === 429) return { kind: "limited" };
  if (response.status !== 200) return { kind: "error" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "error" };
  }
  return parseUsageResponse(body);
}

/**
 * Parses a usage response body. Readout path: never throws. Windows that are
 * absent or malformed degrade to `undefined` individually; only a body that
 * isn't an object at all is an `error`.
 */
export function parseUsageResponse(body: unknown): UsageFetchResult {
  if (typeof body !== "object" || body === null) return { kind: "error" };
  const root = body as Record<string, unknown>;
  return {
    kind: "ok",
    fiveHour: parseWindow(root.five_hour),
    sevenDay: parseWindow(root.seven_day) ?? weeklyFromLimits(root.limits),
  };
}

function parseWindow(value: unknown): UsageWindow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { utilization, resets_at } = value as {
    utilization?: unknown;
    resets_at?: unknown;
  };
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
    return undefined;
  }
  return { utilization, resetsAt: parseIsoMs(resets_at) };
}

/**
 * Newer responses carry a flat `limits[]` array superseding the flat
 * `seven_day` field (see CodexBar's ClaudeOAuthUsageFetcher). The overall
 * weekly window is the first weekly entry not scoped to a specific model.
 */
function weeklyFromLimits(value: unknown): UsageWindow | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as {
      kind?: unknown;
      group?: unknown;
      percent?: unknown;
      resets_at?: unknown;
      scope?: unknown;
    };
    if (entry.group !== "weekly" && entry.kind !== "weekly") continue;
    const scope = entry.scope;
    if (
      typeof scope === "object" &&
      scope !== null &&
      (scope as { model?: unknown }).model != null
    ) {
      continue;
    }
    if (typeof entry.percent !== "number" || !Number.isFinite(entry.percent)) {
      continue;
    }
    return { utilization: entry.percent, resetsAt: parseIsoMs(entry.resets_at) };
  }
  return undefined;
}

function parseIsoMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
