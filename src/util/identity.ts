import type { OauthAccount } from "../types.js";

/**
 * Derives the display-only fields (email/org/accountUuid) from the opaque
 * `oauthAccount` object for `list`/`current` and the profile-index cache.
 * Key names verified against a live `~/.claude.json` (Claude Code v2.1.x).
 * `accountUuid` is what drives active-profile detection; the full object is
 * always stored and restored verbatim regardless of what's read here.
 */
export function extractDisplayFields(account: OauthAccount | undefined): {
  email: string | undefined;
  org: string | undefined;
  accountUuid: string | undefined;
  organizationUuid: string | undefined;
} {
  return {
    email: asString(account?.emailAddress),
    org: asString(account?.organizationName),
    accountUuid: asString(account?.accountUuid),
    organizationUuid: asString(account?.organizationUuid),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Whether two logins are the same account *in the same org/workspace*. A
 * Claude account keeps one `accountUuid` across all its orgs, so matching on
 * that alone marks every profile for the same person active at once -- the
 * `organizationUuid` disambiguates the workspace. Both uuids must be present
 * and equal; a login with no identity never matches anything.
 */
export function sameAccount(
  a: OauthAccount | undefined,
  b: OauthAccount | undefined,
): boolean {
  const x = extractDisplayFields(a);
  const y = extractDisplayFields(b);
  return (
    x.accountUuid !== undefined &&
    x.accountUuid === y.accountUuid &&
    x.organizationUuid === y.organizationUuid
  );
}
