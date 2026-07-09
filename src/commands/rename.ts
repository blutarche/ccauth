import type { Deps } from "../types.js";
import { CcauthError, profileService } from "../types.js";
import { readIndex, writeIndex } from "../profiles.js";
import { validateName } from "../util/names.js";

export async function renameCommand(
  deps: Deps,
  oldName: string,
  newName: string,
): Promise<void> {
  validateName(oldName);
  validateName(newName);

  const index = readIndex(deps);
  if (!index.profiles[oldName]) {
    throw new CcauthError(`No such profile: "${oldName}".`);
  }
  if (index.profiles[newName]) {
    throw new CcauthError(
      `Profile "${newName}" already exists. Remove it first or choose a different name.`,
    );
  }

  const blob = deps.store.read(profileService(oldName));
  if (blob === null) {
    throw new CcauthError(
      `Profile "${oldName}" is listed in the index but has no keychain item. Aborting rename.`,
    );
  }

  deps.store.write(profileService(newName), blob);
  deps.store.delete(profileService(oldName));

  index.profiles[newName] = index.profiles[oldName]!;
  delete index.profiles[oldName];
  writeIndex(deps, index);

  deps.stdout(`Renamed profile "${oldName}" to "${newName}".`);
}
