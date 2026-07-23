import type { Deps } from "../types.js";
import { AUTOSAVE_NAME, CcauthError, profileService } from "../types.js";
import { readOauthAccount, writeOauthAccount } from "../claudeConfig.js";
import { readIndex, writeIndex } from "../profiles.js";
import { validateName } from "../util/names.js";
import { extractDisplayFields, sameAccount } from "../util/identity.js";
import { validateCredentialBlob } from "../util/blob.js";
import {
  accessTokenExpired,
  hasUsableTokens,
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
  // shared by the autosave guard, the split-brain guard, and the write-back
  // loop. The target is seeded from the validated `targetRaw` read above,
  // never re-read: a transient second read must not be able to disagree with
  // the blob this command has already committed to restoring.
  const storedBlobs = new Map<string, string | null>();
  storedBlobs.set(name, targetRaw);
  const unreadable: string[] = [];
  for (const profileName of Object.keys(index.profiles)) {
    if (profileName === AUTOSAVE_NAME || profileName === name) continue;
    try {
      storedBlobs.set(profileName, deps.store.read(profileService(profileName)));
    } catch {
      unreadable.push(profileName);
    }
  }
  // An unreadable profile is UNKNOWN state, not "absent" -- it could be
  // hiding a blob byte-equal to the live one under a mismatched identity
  // (concealed split-brain), which the guards below can only catch by
  // actually reading it. So a read failure anywhere skips BOTH the
  // `_autosave` capture and the whole write-back block for this run rather
  // than just the one profile: guessing wrong in either direction could
  // propagate one account's credentials onto another's profiles. The
  // requested switch itself still proceeds.
  if (unreadable.length > 0) {
    deps.stderr(
      `  ⚠  Could not read stored credentials for: ${unreadable.join(", ")} -- ` +
        `treating as unknown state (an unreadable profile could hide a mismatched ` +
        `identity). Skipping auto-snapshot and write-back for this switch -- the ` +
        `outgoing login is NOT being captured and may be unrecoverable after the ` +
        `switch unless it is already saved under a profile.`,
    );
  }

  // Split-brain guard: if some named profile's stored blob is already
  // byte-equal to the live blob but that profile's saved identity does NOT
  // match the live identity in ~/.claude.json, the live blob provably
  // belongs to a different login than the config claims -- config/keychain
  // can diverge if a previous switch crashed between the keychain write and
  // the config swap. A blob's tokens belong to one login, so this pairing is
  // inconsistent: it must not be written back into any profile (would
  // overwrite every profile of that identity with another account's
  // credentials) AND must not be captured into `_autosave` either (would
  // record garbage and could destroy the only fresh copy of a different
  // account already sitting there).
  const splitBrain =
    unreadable.length === 0 &&
    liveBlob !== null &&
    Object.entries(index.profiles).some(
      ([p, entry]) =>
        p !== AUTOSAVE_NAME &&
        storedBlobs.get(p) === liveBlob &&
        !sameAccount(liveAccount, entry.oauthAccount),
    );

  // Contagion guard: an EXPIRED live blob that is byte-identical to a stored
  // profile of the SAME identity adds no information (the same dead snapshot
  // already exists under a name), while overwriting `_autosave` could destroy
  // the only fresh copy of a different account. Expired-but-unique and
  // fresh-but-duplicate blobs of the same identity are still captured;
  // byte-equal under a mismatched identity is the split-brain case above.
  const skipAutosave =
    unreadable.length > 0 ||
    splitBrain ||
    (liveBlob !== null &&
      accessTokenExpired(liveBlob, deps.now()) &&
      Object.entries(index.profiles).some(
        ([p, entry]) =>
          p !== AUTOSAVE_NAME &&
          storedBlobs.get(p) === liveBlob &&
          sameAccount(liveAccount, entry.oauthAccount),
      ));
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

  // (b) Write the live blob BACK into every saved profile for this same
  // account+org whose snapshot it supersedes. Claude Code rotates refresh
  // tokens (effectively single-use), so a snapshot frozen at `save` time
  // dies the first time its token is consumed -- without this, switching
  // away strands the only fresh copy in `_autosave`, which the next `use`
  // clobbers. Gated forward-only: a live blob that is invalid, identity-less,
  // missing a usable access+refresh token pair (propagation must land a
  // login Claude Code can actually refresh), byte-equal, or not provably
  // fresher (refreshTokenExpiresAt moves on every rotation, and an unknown
  // stored age is never provably older) never touches a snapshot.
  //
  // `supersededByLive` tracks profiles the live blob has PROVABLY superseded
  // (all freshness gates passed), regardless of whether persisting that
  // write-back actually succeeds. The restore decision below keys off this,
  // not off a successful keychain write -- a keychain failure on the
  // write-back is a persistence problem, not evidence that the stale
  // snapshot is still the right thing to restore.
  const supersededByLive = new Set<string>();
  if (
    unreadable.length === 0 &&
    !splitBrain &&
    liveBlob !== null &&
    isValidBlob(liveBlob) &&
    hasUsableTokens(liveBlob)
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
        supersededByLive.add(profileName);
        try {
          deps.store.write(profileService(profileName), liveBlob);
          index.profiles[profileName] = {
            ...entry,
            savedAt: deps.now().toISOString(),
            refreshTokenExpiresAt: liveRte,
          };
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

  // If the live blob superseded the TARGET itself (switching to a profile of
  // the currently-live account), restore the live blob -- reinstating the
  // stale `targetRaw` would resurrect a consumed refresh token. Keyed off
  // `supersededByLive` rather than a successful persist, so a keychain
  // failure on the target's own write-back never demotes the restore back to
  // the stale snapshot.
  const restoreRaw =
    supersededByLive.has(name) && liveBlob !== null ? liveBlob : targetRaw;

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
