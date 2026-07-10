import type { Deps, OauthAccount } from "../types.js";
import { AUTOSAVE_NAME, CcauthError, profileService } from "../types.js";
import { readOauthAccount, writeOauthAccount } from "../claudeConfig.js";
import { readIndex, writeIndex } from "../profiles.js";
import { sameAccount } from "../util/identity.js";
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

  const originallyActiveName = Object.keys(index.profiles).find((n) =>
    sameAccount(index.profiles[n]?.oauthAccount, originalAccount),
  );

  const restore = (): void => {
    if (restoreBlob !== null) {
      deps.store.write(deps.liveService, restoreBlob);
      writeOauthAccount(deps, restoreAccount);
    }
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
      // active profile, the restore source must become the freshly
      // re-captured (possibly rotated) blob -- restoring the stale
      // pre-loop snapshot here would reinstate a token Claude Code just
      // rotated away, logging the user out.
      if (name === originallyActiveName && rotatedBlob !== null) {
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
