import type { Deps } from "../types.js";
import { AUTOSAVE_NAME, CcauthError, profileService } from "../types.js";
import { readOauthAccount, writeOauthAccount } from "../claudeConfig.js";
import { readIndex, writeIndex } from "../profiles.js";
import { validateName } from "../util/names.js";
import { extractDisplayFields } from "../util/identity.js";
import { validateCredentialBlob } from "../util/blob.js";

export async function useCommand(deps: Deps, name: string): Promise<void> {
  validateName(name, { allowReserved: true });

  // Read everything we need from the TARGET profile up front, before making
  // any destructive writes. This matters even for the `_autosave` escape
  // hatch itself: if we wrote the live state into `ccauth:_autosave` before
  // reading it back out as the target, `use _autosave` would clobber the
  // very snapshot it's meant to restore.
  const targetRaw = deps.store.read(profileService(name));
  if (targetRaw === null) {
    throw new CcauthError(
      `No such profile: "${name}". Run \`ccauth list\` to see saved profiles.`,
    );
  }
  validateCredentialBlob(targetRaw, name);

  const index = readIndex(deps);
  const targetEntry = index.profiles[name];

  // (a) Auto-snapshot the LIVE state into `_autosave`, so nothing is lost --
  // always re-read the live blob here rather than trusting any previously
  // stored snapshot, since refresh tokens rotate (see design doc §8).
  const liveBlob = deps.store.read(deps.liveService);
  const liveAccount = readOauthAccount(deps);
  if (liveBlob !== null) {
    deps.store.write(profileService(AUTOSAVE_NAME), liveBlob);
    const display = extractDisplayFields(liveAccount);
    index.profiles[AUTOSAVE_NAME] = {
      email: display.email,
      org: display.org,
      accountUuid: display.accountUuid,
      savedAt: deps.now().toISOString(),
      oauthAccount: liveAccount,
    };
    writeIndex(deps, index);
  }

  // (c) Keychain write first...
  deps.store.write(deps.liveService, targetRaw);
  // (d) ...then the config swap.
  writeOauthAccount(deps, targetEntry?.oauthAccount);

  deps.stdout(`Switched to profile "${name}".`);
  if (!targetEntry?.oauthAccount) {
    deps.stdout(
      "Note: no saved identity for this profile -- the displayed account in Claude Code was cleared.",
    );
  }
  if (deps.isClaudeRunning()) {
    deps.stderr(
      "  ⚠  `claude` is running — restart it for a clean switch.",
    );
  }
}
