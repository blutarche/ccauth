import type { Deps } from "../types.js";
import { CcauthError, profileService } from "../types.js";
import { readOauthAccount } from "../claudeConfig.js";
import { readIndex, writeIndex } from "../profiles.js";
import { validateName, slugify } from "../util/names.js";
import { extractDisplayFields } from "../util/identity.js";

export interface SaveOptions {
  name?: string;
  yes?: boolean;
}

export async function saveCommand(
  deps: Deps,
  options: SaveOptions,
): Promise<void> {
  const liveBlob = deps.store.read(deps.liveService);
  if (liveBlob === null) {
    throw new CcauthError(
      "No active Claude Code login found — run `claude` and log in first.",
    );
  }

  const liveAccount = readOauthAccount(deps);
  const display = extractDisplayFields(liveAccount);

  let name = options.name;
  if (!name) {
    if (!display.email) {
      throw new CcauthError(
        "Could not derive a profile name (no active identity found). Pass a name explicitly: `ccauth save <name>`.",
      );
    }
    name = slugify(display.email);
    if (!name) {
      throw new CcauthError(
        "Could not derive a profile name from the active account email. Pass a name explicitly: `ccauth save <name>`.",
      );
    }
  }

  validateName(name);

  const index = readIndex(deps);
  if (index.profiles[name] && !options.yes) {
    const confirmed = await deps.confirm(
      `Profile "${name}" already exists. Overwrite it?`,
    );
    if (!confirmed) {
      deps.stdout("Aborted; nothing was changed.");
      return;
    }
  }

  deps.store.write(profileService(name), liveBlob);

  index.profiles[name] = {
    email: display.email,
    org: display.org,
    accountUuid: display.accountUuid,
    savedAt: deps.now().toISOString(),
    oauthAccount: liveAccount,
  };
  writeIndex(deps, index);

  if (!liveAccount) {
    deps.stdout(
      `Saved profile "${name}" (credentials only -- no active identity was found in ~/.claude.json, so email/org won't display).`,
    );
  } else {
    deps.stdout(`Saved profile "${name}".`);
  }
}
