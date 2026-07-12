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
 * readout. Same never-throw contract as `parseOauthExpiry`.
 */
export function parseOauthAccessToken(blob: string): OauthAccessToken {
  const oauth = readClaudeAiOauth(blob);
  const token = oauth?.accessToken;
  return {
    accessToken: typeof token === "string" && token !== "" ? token : undefined,
    expiresAt: asFiniteNumber(oauth?.expiresAt),
  };
}

function readClaudeAiOauth(blob: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("claudeAiOauth" in parsed)
  ) {
    return undefined;
  }
  const oauth = (parsed as { claudeAiOauth: unknown }).claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) {
    return undefined;
  }
  return oauth as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
