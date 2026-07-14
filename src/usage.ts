import type { UsageFetchResult, UsageWindow } from "./types.js";
import {
  FALLBACK_CLAUDE_VERSION,
  claudeCodeUserAgent,
} from "./claudeVersion.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** The usage endpoint currently requires this beta header. */
const BETA_HEADER = "oauth-2025-04-20";
const TIMEOUT_MS = 10_000;

/**
 * Real `Deps.fetchUsage`. Never rejects; see `UsageFetchResult`. The
 * `fetchImpl` parameter exists for tests only. The endpoint serves the
 * Claude Code OAuth client, so `userAgent` must be a claude-code UA --
 * callers pass the detected one (see `claudeVersion.ts`); the default
 * covers the fallback.
 */
export async function realFetchUsage(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  userAgent: string = claudeCodeUserAgent(FALLBACK_CLAUDE_VERSION),
): Promise<UsageFetchResult> {
  let response: Response;
  try {
    response = await fetchImpl(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "anthropic-beta": BETA_HEADER,
        "User-Agent": userAgent,
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
 * absent or malformed degrade to `undefined` individually (a valid window in
 * the same response is still shown); only a body that isn't a plain JSON
 * object is an `error`.
 */
export function parseUsageResponse(body: unknown): UsageFetchResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { kind: "error" };
  }
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
    // Only an absent/null scope is the overall window; any scope is narrower.
    if (entry.scope != null) continue;
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

