import { CcauthError } from "../types.js";

/**
 * Validates that a stored credential blob parses as JSON and contains the
 * expected `claudeAiOauth` key, WITHOUT mutating anything. Used to validate
 * the source profile's blob before touching the live keychain item/config.
 */
export function validateCredentialBlob(raw: string, profileName: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CcauthError(
      `Stored credentials for "${profileName}" are not valid JSON. Refusing to switch; ` +
        `your current login is untouched.`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("claudeAiOauth" in parsed)
  ) {
    throw new CcauthError(
      `Stored credentials for "${profileName}" don't look like a Claude Code login ` +
        `(missing "claudeAiOauth"). Refusing to switch; your current login is untouched.`,
    );
  }
}
