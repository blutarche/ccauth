import type { Deps, UsageFetchResult, UsageWindow } from "./types.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** The usage endpoint currently requires this beta header. */
const BETA_HEADER = "oauth-2025-04-20";
/**
 * The endpoint serves the Claude Code OAuth client, so it expects a
 * claude-code User-Agent. The real version is detected from the installed
 * `claude` CLI (see `resolveClaudeCodeVersion`); this pinned string is the
 * fallback when detection fails.
 */
const FALLBACK_VERSION = "2.1.0";
const TIMEOUT_MS = 10_000;

/**
 * Real `Deps.fetchUsage`. Never rejects; see `UsageFetchResult`. The
 * `fetchImpl` parameter exists for tests only.
 */
export async function realFetchUsage(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  userAgent: string = `claude-code/${FALLBACK_VERSION}`,
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
    // Only an absent/null scope counts as the overall window. A scope in any
    // unrecognized shape is treated as scoped (skipped), not as overall.
    const scope = entry.scope;
    if (
      scope != null &&
      (typeof scope !== "object" || (scope as { model?: unknown }).model != null)
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

/** How long a detected `claude --version` result stays cached: 1 day. */
const VERSION_CACHE_TTL_MS = 86_400_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;

type VersionDeps = Pick<Deps, "fs" | "paths" | "runClaude" | "now">;

/**
 * Resolves the installed Claude Code CLI version for the User-Agent header.
 * Spawns `claude --version` at most once per day: a successful detection is
 * snapshotted to `paths.claudeVersionCachePath` and reused until the TTL
 * lapses. Detection failures fall back to `FALLBACK_VERSION` and are NOT
 * cached, so a transient failure retries on the next run. Readout path:
 * never throws (a broken cache file just re-detects; a failed cache write
 * is ignored).
 */
export function resolveClaudeCodeVersion(deps: VersionDeps): string {
  const cached = readVersionCache(deps);
  if (cached !== undefined) return cached;

  const res = deps.runClaude(["--version"], {
    timeoutMs: VERSION_PROBE_TIMEOUT_MS,
  });
  const version = res.code === 0 ? parseClaudeVersion(res.stdout) : undefined;
  if (version === undefined) return FALLBACK_VERSION;

  writeVersionCache(deps, version);
  return version;
}

/** `claude --version` prints e.g. "2.1.207 (Claude Code)" -> "2.1.207". */
function parseClaudeVersion(stdout: string): string | undefined {
  const token = stdout.trim().split(/\s+/)[0] ?? "";
  return /^\d+\.\d+\.\d+/.test(token) ? token : undefined;
}

function readVersionCache(deps: VersionDeps): string | undefined {
  const { fs, paths } = deps;
  if (!fs.existsSync(paths.claudeVersionCachePath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(paths.claudeVersionCachePath));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { version, fetchedAt } = parsed as {
    version?: unknown;
    fetchedAt?: unknown;
  };
  if (typeof version !== "string" || typeof fetchedAt !== "number") {
    return undefined;
  }
  const age = deps.now().getTime() - fetchedAt;
  return age >= 0 && age < VERSION_CACHE_TTL_MS ? version : undefined;
}

function writeVersionCache(deps: VersionDeps, version: string): void {
  const { fs, paths } = deps;
  try {
    if (!fs.existsSync(paths.ccauthDir)) {
      fs.mkdirSync(paths.ccauthDir);
    }
    fs.writeFileSync(
      paths.claudeVersionCachePath,
      JSON.stringify({ version, fetchedAt: deps.now().getTime() }) + "\n",
    );
  } catch {
    // Best-effort cache: failing to persist must never break the readout.
  }
}
