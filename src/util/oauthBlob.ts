export interface OauthExpiry {
  expiresAt: number | undefined; // access token, ms epoch
  refreshTokenExpiresAt: number | undefined; // refresh token, ms epoch
}

const EMPTY: OauthExpiry = {
  expiresAt: undefined,
  refreshTokenExpiresAt: undefined,
};

/**
 * Reads `claudeAiOauth.{expiresAt,refreshTokenExpiresAt}` out of a stored
 * credential blob. This is the readout path (`list`/`current`), so it must
 * NEVER throw: malformed JSON, a missing `claudeAiOauth`, or non-number
 * fields all degrade silently to `undefined` rather than erroring.
 */
export function parseOauthExpiry(blob: string): OauthExpiry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return EMPTY;
  }

  if (typeof parsed !== "object" || parsed === null || !("claudeAiOauth" in parsed)) {
    return EMPTY;
  }

  const oauth = (parsed as { claudeAiOauth: unknown }).claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) {
    return EMPTY;
  }

  const { expiresAt, refreshTokenExpiresAt } = oauth as {
    expiresAt?: unknown;
    refreshTokenExpiresAt?: unknown;
  };

  return {
    expiresAt: asFiniteNumber(expiresAt),
    refreshTokenExpiresAt: asFiniteNumber(refreshTokenExpiresAt),
  };
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
