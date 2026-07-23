import type { Deps } from "../types.js";
import { AUTOSAVE_NAME, CcauthError, profileService } from "../types.js";
import { readOauthAccount, writeOauthAccount } from "../claudeConfig.js";
import { readIndex, writeIndex } from "../profiles.js";
import { validateName } from "../util/names.js";
import { extractDisplayFields, sameAccount } from "../util/identity.js";
import { validateCredentialBlob } from "../util/blob.js";
import {
  accessTokenExpired,
  parseOauthAccessToken,
  parseOauthExpiry,
} from "../util/oauthBlob.js";

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
  let indexDirty = false;

  // One read pass over every named (non-_autosave) profile's stored blob --
  // reused below for the autosave guard, the split-brain guard, and the
  // write-back loop, instead of re-reading the same keychain service three
  // times over.
  const storedBlobs = new Map<string, string | null>();
  for (const profileName of Object.keys(index.profiles)) {
    if (profileName === AUTOSAVE_NAME) continue;
    storedBlobs.set(profileName, deps.store.read(profileService(profileName)));
  }

  // Contagion guard: an EXPIRED live blob that is byte-identical to a stored
  // profile of the SAME identity adds no information (the same dead snapshot
  // already exists under a name), while overwriting `_autosave` could destroy
  // the only fresh copy of a different account. A byte-equal blob under a
  // mismatched identity is not redundant -- it's the only place that pairing
  // is captured, so it must still be saved. Expired-but-unique and
  // fresh-but-duplicate blobs are still captured as before.
  const skipAutosave =
    liveBlob !== null &&
    accessTokenExpired(liveBlob, deps.now()) &&
    Object.entries(index.profiles).some(
      ([p, entry]) =>
        p !== AUTOSAVE_NAME &&
        storedBlobs.get(p) === liveBlob &&
        sameAccount(liveAccount, entry.oauthAccount),
    );
  if (liveBlob !== null && !skipAutosave) {
    deps.store.write(profileService(AUTOSAVE_NAME), liveBlob);
    const display = extractDisplayFields(liveAccount);
    index.profiles[AUTOSAVE_NAME] = {
      email: display.email,
      org: display.org,
      accountUuid: display.accountUuid,
      savedAt: deps.now().toISOString(),
      refreshTokenExpiresAt: parseOauthExpiry(liveBlob).refreshTokenExpiresAt,
      oauthAccount: liveAccount,
    };
    indexDirty = true;
  }

  // Split-brain guard: if some named profile's stored blob is already
  // byte-equal to the live blob but that profile's saved identity does NOT
  // match the live identity in ~/.claude.json, the live blob provably
  // belongs to a different login than the config claims -- config/keychain
  // can diverge if a previous switch crashed between the keychain write and
  // the config swap. Propagating under the wrong identity would overwrite
  // every profile of that identity with another account's credentials, so
  // skip write-back entirely rather than risk it.
  const splitBrain =
    liveBlob !== null &&
    Object.entries(index.profiles).some(
      ([p, entry]) =>
        p !== AUTOSAVE_NAME &&
        storedBlobs.get(p) === liveBlob &&
        !sameAccount(liveAccount, entry.oauthAccount),
    );

  // (b) Write the live blob BACK into every saved profile for this same
  // account+org whose snapshot it supersedes. Claude Code rotates refresh
  // tokens (effectively single-use), so a snapshot frozen at `save` time
  // dies the first time its token is consumed -- without this, switching
  // away strands the only fresh copy in `_autosave`, which the next `use`
  // clobbers. Gated forward-only: a live blob that is invalid, identity-less,
  // missing a usable access token, byte-equal, or not provably fresher
  // (refreshTokenExpiresAt moves on every rotation, and an unknown stored age
  // is never provably older) never touches a snapshot.
  const upgraded = new Set<string>();
  if (
    !splitBrain &&
    liveBlob !== null &&
    isValidBlob(liveBlob) &&
    parseOauthAccessToken(liveBlob)?.accessToken !== undefined
  ) {
    const liveRte = parseOauthExpiry(liveBlob).refreshTokenExpiresAt;
    if (liveRte !== undefined) {
      for (const [profileName, entry] of Object.entries(index.profiles)) {
        if (profileName === AUTOSAVE_NAME) continue;
        if (!sameAccount(liveAccount, entry.oauthAccount)) continue;
        const storedBlob = storedBlobs.get(profileName) ?? null;
        if (storedBlob === null) continue;
        if (storedBlob === liveBlob) {
          // Metadata drift: the blob already matches (a previous run's
          // keychain write landed but its writeIndex failed) -- heal the
          // index without touching the keychain.
          if (entry.refreshTokenExpiresAt !== liveRte) {
            index.profiles[profileName] = { ...entry, refreshTokenExpiresAt: liveRte };
            indexDirty = true;
          }
          continue;
        }
        const storedRte = parseOauthExpiry(storedBlob).refreshTokenExpiresAt;
        if (storedRte === undefined) continue; // unknown age, never risk a downgrade
        if (liveRte <= storedRte) continue;
        try {
          deps.store.write(profileService(profileName), liveBlob);
          index.profiles[profileName] = {
            ...entry,
            savedAt: deps.now().toISOString(),
            refreshTokenExpiresAt: liveRte,
          };
          upgraded.add(profileName);
          indexDirty = true;
        } catch {
          deps.stderr(
            `  ⚠  Failed to write back credentials for profile "${profileName}" -- skipping.`,
          );
        }
      }
    }
  }
  if (indexDirty) {
    writeIndex(deps, index);
  }

  // If the write-back just upgraded the TARGET itself (switching to a
  // profile of the currently-live account), restore the fresh live blob --
  // reinstating the pre-upgrade `targetRaw` here would recreate the exact
  // stale-token restore this command is fixing.
  const restoreRaw = upgraded.has(name) && liveBlob !== null ? liveBlob : targetRaw;

  // (c) Keychain write first...
  deps.store.write(deps.liveService, restoreRaw);
  // (d) ...then the config swap.
  writeOauthAccount(deps, targetEntry?.oauthAccount);

  deps.stdout(`Switched to profile "${name}".`);
  if (accessTokenExpired(restoreRaw, deps.now())) {
    deps.stderr(
      `  ⚠  "${name}"'s snapshot is stale (access token expired) -- Claude Code ` +
        `will try to refresh it. If you end up logged out, run /login there, ` +
        `then \`ccauth save ${name}\`.`,
    );
  }
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

/** True when the blob passes structural validation. Write-back is best-effort,
 * so a broken live blob must skip it silently, never abort the switch. */
function isValidBlob(blob: string): boolean {
  try {
    validateCredentialBlob(blob, "live");
    return true;
  } catch {
    return false;
  }
}
