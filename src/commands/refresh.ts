import type { Deps, OauthAccount } from "../types.js";
import { AUTOSAVE_NAME, CcauthError, profileService } from "../types.js";
import { readOauthAccount, writeOauthAccount } from "../claudeConfig.js";
import { readIndex, writeIndex } from "../profiles.js";
import { validateCredentialBlob } from "../util/blob.js";
import { parseOauthExpiry } from "../util/oauthBlob.js";

type Status = "refreshed" | "valid" | "failed" | "failed(timeout)" | "missing";

interface TargetResult {
  name: string;
  status: Status;
}

/**
 * `ccauth refresh [name]` — swaps each target profile into the live
 * keychain slot, runs a trivial `claude -p` so Claude Code refreshes its own
 * token if it needs to, re-captures the (possibly rotated) blob back into
 * the profile, then restores the originally-active login. See
 * docs/plans/2026-07-10-ccauth-refresh-design.md §4-§6 for the two
 * invariants this must preserve (re-capture before restore; never reinstate
 * a dead token for the active profile).
 */
export async function refreshCommand(
  deps: Deps,
  opts: { name?: string; force?: boolean },
): Promise<void> {
  if (deps.isClaudeRunning() && !opts.force) {
    throw new CcauthError(
      "a claude session is running; refreshing swaps the live credential repeatedly " +
        "and could disrupt it. Re-run with --force to override.",
    );
  }

  if (!deps.isClaudeInstalled()) {
    throw new CcauthError(
      "claude not found on PATH. Install Claude Code or ensure `claude` is on your PATH.",
    );
  }

  const index = readIndex(deps);

  let targets: string[];
  if (opts.name) {
    if (deps.store.read(profileService(opts.name)) === null) {
      throw new CcauthError(
        `No such profile: "${opts.name}". Run \`ccauth list\` to see saved profiles.`,
      );
    }
    targets = [opts.name];
  } else {
    targets = Object.keys(index.profiles)
      .filter((n) => n !== AUTOSAVE_NAME)
      .sort();
    if (targets.length === 0) {
      deps.stdout("No saved profiles to refresh.");
      return;
    }
  }

  // ORIGINAL live state, captured before any swap. `restoreBlob`/
  // `restoreAccount` start out equal to this, but `restoreBlob` may be
  // advanced to a re-captured blob mid-loop (invariant 2, below).
  const originalBlob = deps.store.read(deps.liveService);
  const originalAccount = readOauthAccount(deps);

  let restoreBlob = originalBlob;
  let restoreAccount: OauthAccount | undefined = originalAccount;

  const restore = (): void => {
    if (restoreBlob !== null) {
      deps.store.write(deps.liveService, restoreBlob);
    } else {
      // No live credential existed before we started (user had no active
      // login) -- return the slot to that original absent state, don't
      // leave it holding the last-processed profile's credential.
      deps.store.delete(deps.liveService);
    }
    writeOauthAccount(deps, restoreAccount);
  };

  const onSignal = (): void => {
    restore();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const results: TargetResult[] = [];

  try {
    for (const name of targets) {
      const blobP = deps.store.read(profileService(name));
      if (blobP === null) {
        results.push({ name, status: "missing" });
        continue;
      }
      const entryP = index.profiles[name];

      // BLOB equality, not identity metadata, is the "this target is the
      // active login" signal -- captured before the swap. Identity metadata
      // can be missing/undefined, or shared by two profiles (in which case
      // `.find` would pick an arbitrary name); a blob is the actual live
      // credential, so comparing it directly can't misfire that way.
      const isActive = originalBlob !== null && blobP === originalBlob;

      try {
        validateCredentialBlob(blobP, name);
      } catch {
        // A corrupt stored profile must never be written into the live
        // keychain slot. Record it as failed and move on -- one bad profile
        // shouldn't abort refreshing the rest, and `continue` here still
        // hits the loop's end, leaving `finally`'s restore() to run as usual.
        results.push({ name, status: "failed" });
        continue;
      }

      deps.store.write(deps.liveService, blobP);
      writeOauthAccount(deps, entryP?.oauthAccount);

      const res = deps.runClaude(
        ["-p", "--model", "haiku", "reply with the single word pong"],
        { timeoutMs: 120_000 },
      );

      // Re-capture BEFORE moving on to the next target / before restore()
      // runs -- see invariant 1 in the design doc. If we skipped this, a
      // rotated live blob would be lost and `ccauth:P` would keep a dead,
      // rotated-away refresh token.
      const rotatedBlob = deps.store.read(deps.liveService);
      if (rotatedBlob !== null) {
        deps.store.write(profileService(name), rotatedBlob);
        if (index.profiles[name]) {
          index.profiles[name] = {
            ...index.profiles[name],
            refreshTokenExpiresAt: parseOauthExpiry(rotatedBlob).refreshTokenExpiresAt,
          };
          writeIndex(deps, index);
        }
      }

      const rotated = rotatedBlob !== null && rotatedBlob !== blobP;
      const status: Status =
        res.code === 0
          ? rotated
            ? "refreshed"
            : "valid"
          : res.timedOut
            ? "failed(timeout)"
            : "failed";
      results.push({ name, status });

      // Invariant 2: if the target we just refreshed IS the originally-
      // active login (by blob equality, captured above), the restore source
      // must become the freshly re-captured (possibly rotated) blob --
      // restoring the stale pre-loop snapshot here would reinstate a token
      // Claude Code just rotated away, logging the user out.
      //
      // Gate on `rotated`, not merely `rotatedBlob !== null`: if two saved
      // profiles share the same original live blob (duplicate active), the
      // first target to process rotates the shared refresh token and
      // promotes restoreBlob to the new blob. The second duplicate is also
      // `isActive` (still blob-equal to `originalBlob`) but its refresh
      // token was already consumed by the first target, so Claude Code
      // can't rotate it again -- `rotated` is false for it. Without this
      // gate, that second no-op pass would downgrade restoreBlob back to
      // the stale pre-rotation blob, and the final restore() would log the
      // user out with a dead, already-rotated-away refresh token.
      if (isActive && rotated) {
        restoreBlob = rotatedBlob;
      }
    }
  } finally {
    restore();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  printSummary(deps, results);
}

function printSummary(deps: Deps, results: TargetResult[]): void {
  const total = results.length;
  let refreshed = 0;
  let valid = 0;
  let failed = 0;
  let missing = 0;
  for (const r of results) {
    if (r.status === "refreshed") refreshed++;
    else if (r.status === "valid") valid++;
    else if (r.status === "missing") missing++;
    else failed++; // "failed" | "failed(timeout)"
  }

  deps.stdout(`refresh: ${total} profile${total === 1 ? "" : "s"}`);
  deps.stdout(`  refreshed  ${refreshed}`);
  deps.stdout(`  valid      ${valid}`);
  deps.stdout(`  failed     ${failed}`);
  deps.stdout(`  missing    ${missing}`);
  for (const r of results) {
    if (r.status === "missing" || r.status.startsWith("failed")) {
      deps.stdout(`  ${r.name}  -> run \`ccauth use ${r.name}\` then \`/login\``);
    }
  }
}
