import type { Deps } from "../types.js";
import { CcauthError, profileService } from "../types.js";
import { readIndex, writeIndex } from "../profiles.js";
import { validateName } from "../util/names.js";

export interface RemoveOptions {
  yes?: boolean;
}

export async function removeCommand(
  deps: Deps,
  name: string,
  options: RemoveOptions,
): Promise<void> {
  validateName(name);

  const index = readIndex(deps);
  if (!index.profiles[name]) {
    throw new CcauthError(`No such profile: "${name}".`);
  }

  if (!options.yes) {
    const confirmed = await deps.confirm(`Remove profile "${name}"?`);
    if (!confirmed) {
      deps.stdout("Aborted; nothing was changed.");
      return;
    }
  }

  deps.store.delete(profileService(name));
  delete index.profiles[name];
  writeIndex(deps, index);

  deps.stdout(`Removed profile "${name}".`);
}
