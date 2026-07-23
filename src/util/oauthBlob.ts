import { parseJsonObject } from "./blob.js";

export interface OauthExpiry {
  expiresAt: number | undefined; // access token, ms epoch
  refreshTokenExpiresAt: number | undefined; // refresh token, ms epoch
}

export interface OauthAccessToken {
  accessToken: string | undefined;
  expiresAt: number | undefined; // ms epoch
}

/**
 * Reads `claudeAiOauth.{expiresAt,refreshTokenExpiresAt}` out of a stored
 * credential blob. This is the readout path (`list`/`current`), so it must
 * NEVER throw: malformed JSON, a missing `claudeAiOauth`, or non-number
 * fields all degrade silently to `undefined` rather than erroring.
 */
export function parseOauthExpiry(blob: string): OauthExpiry {
  const oauth = readClaudeAiOauth(blob);
  return {
    expiresAt: asFiniteNumber(oauth?.expiresAt),
    refreshTokenExpiresAt: asFiniteNumber(oauth?.refreshTokenExpiresAt),
  };
}

/**
 * Reads `claudeAiOauth.{accessToken,expiresAt}` for the `list --usage`
 * readout. Returns undefined when the blob isn't a Claude login at all
 * (unparseable JSON or no `claudeAiOauth` object), so callers can tell
 * "broken blob" from "valid login whose token fields are unusable"; within
 * a valid blob, individual fields degrade to undefined. Never throws.
 */
export function parseOauthAccessToken(
  blob: string,
): OauthAccessToken | undefined {
  const oauth = readClaudeAiOauth(blob);
  if (oauth === undefined) return undefined;
  const token = oauth.accessToken;
  return {
    accessToken: typeof token === "string" && token !== "" ? token : undefined,
    expiresAt: asFiniteNumber(oauth.expiresAt),
  };
}

function readClaudeAiOauth(blob: string): Record<string, unknown> | undefined {
  const oauth = parseJsonObject(blob)?.claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) {
    return undefined;
  }
  return oauth as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Whether a stored blob's access token is already past its expiry. Readout
 * convention: a missing/unparseable `expiresAt` means "unknown", which is
 * treated as NOT expired -- this predicate only ever adds warnings/guards,
 * so unknown must never trigger them. Never throws.
 */
export function accessTokenExpired(blob: string, now: Date): boolean {
  const expiresAt = parseOauthExpiry(blob).expiresAt;
  return expiresAt !== undefined && expiresAt <= now.getTime();
}

/**
 * Whether a blob carries BOTH an access token and a refresh token usable
 * for propagation -- write-back needs a login that Claude Code can actually
 * refresh, not just a live-looking access token. A blank/whitespace-only
 * string counts as absent. Never throws.
 */
export function hasUsableTokens(blob: string): boolean {
  const oauth = readClaudeAiOauth(blob);
  return isNonBlankString(oauth?.accessToken) && isNonBlankString(oauth?.refreshToken);
}

function isNonBlankString(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}
