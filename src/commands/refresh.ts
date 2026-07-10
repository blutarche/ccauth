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

  // Known limitation: `deps.runClaude` shells out via execFileSync, so this
  // command's body is synchronous end-to-end -- a real OS signal delivered
  // while the `claude` child is running only gets dispatched to `onSignal`
  // after that child returns (Node processes signals between synchronous
  // ticks). In practice this handler and the `finally` below both restore
  // from the same `restoreBlob`, so the common case (Ctrl-C) is still safe.
  // A hard kill (SIGKILL, which can't be caught at all) leaves the live slot
  // on whatever valid, re-captured profile was in flight -- never a dead
  // token, per invariant 2 above -- and is recoverable with `ccauth use`. A
  // full async-spawn refactor (see docs/plans/2026-07-10-ccauth-refresh-design.md
  // §5) would let a signal interrupt mid-run, but is out of scope here.
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

      // Re-capture whatever `claude` left in the live slot. `claude -p`
      // refreshes its OAuth token (if needed) BEFORE running the prompt, so
      // a live blob that changed is a genuine, valid-by-construction
      // rotation regardless of whether the prompt step that follows
      // succeeds, fails, or times out -- Claude only ever mutates its own
      // live keychain item by successfully rotating; a failed refresh writes
      // nothing. `res.code`/`succeeded` therefore reflects the PROMPT
      // result, not the AUTH result, and must not gate promotion. What can
      // legitimately happen in the live slot after a run is only ever
      // "unchanged" or "validly rotated" -- so the only defensive check
      // needed here is structural validity, not exit status.
      const rotatedBlob = deps.store.read(deps.liveService);
      const rotated = rotatedBlob !== null && rotatedBlob !== blobP;
      let rotatedValid = false;
      if (rotated) {
        try {
          validateCredentialBlob(rotatedBlob!, name);
          rotatedValid = true;
        } catch {
          rotatedValid = false;
        }
      }

      // Invariants (in order, both load-bearing):
      //
      // 1. Promotion of `restoreBlob` happens FIRST -- before `writeIndex`,
      //    which does a fallible renameSync and can throw. If promotion ran
      //    after writeIndex (as it used to), an index-write failure would
      //    skip promotion entirely while `ccauth:<name>` (the profile store)
      //    already holds the rotated blob -- the `finally` restore would
      //    then reinstate the stale pre-loop blob into the live slot even
      //    though the on-disk profile has moved on, logging the user out
      //    with a dead refresh token. Promoting before the throwable call
      //    means a real rotation is locked in as the restore source
      //    atomically, regardless of what happens next.
      //
      // 2. Both persisting into the profile store AND promoting the restore
      //    source are gated on `rotated && rotatedValid` -- NOT on
      //    `succeeded`. Gating on exit code was the round-5 bug: a
      //    successful refresh followed by a failing/timing-out prompt still
      //    leaves the genuinely-rotated NEW blob live, and that rotation
      //    must be promoted/persisted even though `res.code !== 0`. What
      //    still must never be promoted is a live slot left holding
      //    something structurally invalid -- `rotatedValid` catches that.
      //    Gating on `rotated` (not merely `isActive`) also matters for
      //    duplicate-active profiles: if two saved profiles share the same
      //    original live blob, the first to process consumes the shared
      //    refresh token and promotes; the second is still `isActive`
      //    (blob-equal to `originalBlob`) but its token was already
      //    consumed, so it's a no-op (`rotated` is false) and correctly
      //    leaves `restoreBlob` alone rather than downgrading it back to the
      //    stale pre-rotation blob.
      //
      // 3. On no-rotation or an invalid rotation, `restoreBlob` is left
      //    exactly as it was going into this iteration (the original, or an
      //    earlier successful active promotion) -- the `finally` restore()
      //    then overwrites whatever the run left in the live slot with that
      //    known-good value.
      if (rotated && rotatedValid) {
        if (isActive) {
          restoreBlob = rotatedBlob;
        }
        deps.store.write(profileService(name), rotatedBlob);
        if (index.profiles[name]) {
          index.profiles[name] = {
            ...index.profiles[name],
            refreshTokenExpiresAt: parseOauthExpiry(rotatedBlob).refreshTokenExpiresAt,
          };
          writeIndex(deps, index);
        }
      }

      // A rotation is the goal of this command -- report it as "refreshed"
      // even if the trivial prompt that followed it errored out, since the
      // rotation itself (the thing the user actually cares about) succeeded.
      const status: Status = rotated
        ? "refreshed"
        : res.code === 0
          ? "valid"
          : res.timedOut
            ? "failed(timeout)"
            : "failed";
      results.push({ name, status });
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
