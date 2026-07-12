import { CcauthError } from "../types.js";

/**
 * Parses a string as JSON and returns it only when it is a plain JSON
 * object (not an array or primitive). Never throws. Shared by the
 * never-throw readout paths (`oauthBlob.ts`, `claudeVersion.ts`); the
 * throwing readers (`readConfig`, `readIndex`, `validateCredentialBlob`)
 * keep their own user-facing error messages.
 */
export function parseJsonObject(
  raw: string,
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

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
