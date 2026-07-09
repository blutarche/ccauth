import { AUTOSAVE_NAME, CcauthError } from "../types.js";

/**
 * Validates a user-supplied (or auto-derived) profile name.
 * Rejects names containing `:` or any whitespace, and empty names.
 * By default also rejects the reserved `_autosave` name; pass
 * `{ allowReserved: true }` for the one exception: `ccauth use _autosave`.
 */
export function validateName(
  name: string,
  options: { allowReserved?: boolean } = {},
): void {
  if (name.length === 0) {
    throw new CcauthError("Profile name must not be empty.");
  }
  if (/[:\s]/.test(name)) {
    throw new CcauthError(
      `Invalid profile name "${name}": names may not contain ":" or whitespace.`,
    );
  }
  if (!options.allowReserved && name === AUTOSAVE_NAME) {
    throw new CcauthError(
      `"${AUTOSAVE_NAME}" is a reserved name (used internally to hold your ` +
        `pre-switch snapshot). Choose a different name.`,
    );
  }
}

/** lowercase, non-alphanumeric -> "-", trim/collapse dashes. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
