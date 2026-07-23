import { describe, it, expect } from "vitest";
import { useCommand } from "../../src/commands/use.js";
import { readIndex, writeIndex } from "../../src/profiles.js";
import {
  AUTOSAVE_NAME,
  CcauthError,
  LIVE_SERVICE,
  profileService,
} from "../../src/types.js";
import { createTestDeps, TEST_PATHS } from "../fakes/testDeps.js";

function seed(
  deps: ReturnType<typeof createTestDeps>["deps"],
  store: ReturnType<typeof createTestDeps>["store"],
  fs: ReturnType<typeof createTestDeps>["fs"],
  liveBlob: object,
  liveAccount: object,
) {
  store.write(LIVE_SERVICE, JSON.stringify(liveBlob));
  fs.files.set(
    TEST_PATHS.claudeConfigPath,
    JSON.stringify({ oauthAccount: liveAccount, unrelated: "keep" }),
  );
}

describe("use command", () => {
  it("switches to a saved profile: keychain first, then config, autosaving the OLD live creds first", async () => {
    const { deps, store, fs } = createTestDeps();

    const oldLiveBlob = { claudeAiOauth: { accessToken: "personal-token" } };
    const oldLiveAccount = { email: "me@personal.com", accountUuid: "p-1" };
    seed(deps, store, fs, oldLiveBlob, oldLiveAccount);

    const workBlob = { claudeAiOauth: { accessToken: "work-token" } };
    store.write(profileService("work"), JSON.stringify(workBlob));
    const index = readIndex(deps);
    index.profiles["work"] = {
      email: "me@work.com",
      org: "Acme",
      accountUuid: "w-1",
      savedAt: "2026-01-01T00:00:00.000Z",
      oauthAccount: { email: "me@work.com", org: "Acme", accountUuid: "w-1" },
    };
    writeIndex(deps, index);

    await useCommand(deps, "work");

    // _autosave holds the OLD live creds, not the new ones.
    expect(store.read(profileService(AUTOSAVE_NAME))).toBe(
      JSON.stringify(oldLiveBlob),
    );
    const finalIndex = readIndex(deps);
    expect(finalIndex.profiles[AUTOSAVE_NAME]?.oauthAccount).toEqual(
      oldLiveAccount,
    );

    // Live keychain item now holds work's blob.
    expect(store.read(LIVE_SERVICE)).toBe(JSON.stringify(workBlob));

    // Config now shows work's identity, unrelated keys preserved.
    const config = JSON.parse(fs.files.get(TEST_PATHS.claudeConfigPath)!);
    expect(config.oauthAccount).toEqual({
      email: "me@work.com",
      org: "Acme",
      accountUuid: "w-1",
    });
    expect(config.unrelated).toBe("keep");
  });

  it("validates the source blob BEFORE writing autosave or touching the target", async () => {
    const { deps, store, fs } = createTestDeps();
    const oldLiveBlob = { claudeAiOauth: { accessToken: "personal-token" } };
    seed(deps, store, fs, oldLiveBlob, { email: "me@personal.com" });

    store.write(profileService("broken"), "not valid json");

    await expect(useCommand(deps, "broken")).rejects.toThrow(CcauthError);

    // Nothing should have changed: no autosave, live untouched.
    expect(store.read(profileService(AUTOSAVE_NAME))).toBeNull();
    expect(store.read(LIVE_SERVICE)).toBe(JSON.stringify(oldLiveBlob));
    const config = JSON.parse(fs.files.get(TEST_PATHS.claudeConfigPath)!);
    expect(config.oauthAccount).toEqual({ email: "me@personal.com" });
  });

  it("errors clearly when the target profile does not exist", async () => {
    const { deps, store, fs } = createTestDeps();
    seed(deps, store, fs, { claudeAiOauth: {} }, { email: "me@personal.com" });

    await expect(useCommand(deps, "nope")).rejects.toThrow(/No such profile/);
  });

  it("warns (non-blocking) when a claude process is running", async () => {
    const { deps, store, fs, stderrLines } = createTestDeps({
      isClaudeRunning: () => true,
    });
    seed(deps, store, fs, { claudeAiOauth: {} }, { email: "me@personal.com" });
    store.write(profileService("work"), JSON.stringify({ claudeAiOauth: {} }));

    await useCommand(deps, "work");

    expect(stderrLines.some((l) => /restart/i.test(l))).toBe(true);
    // It's non-blocking: the switch still went through.
    expect(store.read(LIVE_SERVICE)).toBe(JSON.stringify({ claudeAiOauth: {} }));
  });

  it("does not warn when no claude process is running", async () => {
    const { deps, store, fs, stderrLines } = createTestDeps({
      isClaudeRunning: () => false,
    });
    seed(deps, store, fs, { claudeAiOauth: {} }, { email: "me@personal.com" });
    store.write(profileService("work"), JSON.stringify({ claudeAiOauth: {} }));

    await useCommand(deps, "work");

    expect(stderrLines.some((l) => /restart/i.test(l))).toBe(false);
  });

  it("supports `use _autosave` as an escape hatch without clobbering the snapshot", async () => {
    const { deps, store, fs } = createTestDeps();

    // Pretend we already switched once: _autosave holds the ORIGINAL personal
    // creds, and the live keychain item currently holds work's creds.
    const personalBlob = { claudeAiOauth: { accessToken: "personal-token" } };
    store.write(profileService(AUTOSAVE_NAME), JSON.stringify(personalBlob));
    let index = readIndex(deps);
    index.profiles[AUTOSAVE_NAME] = {
      email: "me@personal.com",
      org: undefined,
      accountUuid: "p-1",
      savedAt: "2026-01-01T00:00:00.000Z",
      oauthAccount: { email: "me@personal.com", accountUuid: "p-1" },
    };
    writeIndex(deps, index);

    const workBlob = { claudeAiOauth: { accessToken: "work-token" } };
    seed(deps, store, fs, workBlob, { email: "me@work.com", accountUuid: "w-1" });

    await useCommand(deps, AUTOSAVE_NAME);

    // Live should now hold the ORIGINAL personal creds, not work's.
    expect(store.read(LIVE_SERVICE)).toBe(JSON.stringify(personalBlob));
    const config = JSON.parse(fs.files.get(TEST_PATHS.claudeConfigPath)!);
    expect(config.oauthAccount).toEqual({
      email: "me@personal.com",
      accountUuid: "p-1",
    });
  });

  it("caches refreshTokenExpiresAt from the live blob into the _autosave entry", async () => {
    const { deps, store, fs } = createTestDeps();

    const oldLiveBlob = {
      claudeAiOauth: {
        accessToken: "personal-token",
        expiresAt: 1000,
        refreshTokenExpiresAt: 987654321,
      },
    };
    seed(deps, store, fs, oldLiveBlob, { email: "me@personal.com" });
    store.write(profileService("work"), JSON.stringify({ claudeAiOauth: {} }));

    await useCommand(deps, "work");

    const index = readIndex(deps);
    expect(index.profiles[AUTOSAVE_NAME]?.refreshTokenExpiresAt).toBe(
      987654321,
    );
  });

  it("warns on stderr when the target snapshot's access token is already expired", async () => {
    const { deps, store, fs, stderrLines } = createTestDeps();
    seed(deps, store, fs, { claudeAiOauth: {} }, { email: "me@personal.com" });
    store.write(
      profileService("work"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "t", expiresAt: 1_000 }, // long past
      }),
    );

    await useCommand(deps, "work");

    expect(stderrLines.some((l) => /expired/i.test(l))).toBe(true);
    // Non-blocking: the switch still happened.
    expect(store.read(LIVE_SERVICE)).toContain("claudeAiOauth");
  });

  it("does not warn when the target snapshot's access token is still valid or unknown", async () => {
    const { deps, store, fs, stderrLines } = createTestDeps();
    seed(deps, store, fs, { claudeAiOauth: {} }, { email: "me@personal.com" });
    const future = new Date("2026-07-10T12:00:00.000Z").getTime() + 3_600_000;
    store.write(
      profileService("work"),
      JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: future } }),
    );
    store.write(
      profileService("mystery"),
      JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), // no expiresAt
    );

    await useCommand(deps, "work");
    await useCommand(deps, "mystery");

    expect(stderrLines.some((l) => /expired/i.test(l))).toBe(false);
  });

  it("does not clobber _autosave with an expired live blob byte-equal to a stored profile of the SAME identity", async () => {
    const { deps, store, fs } = createTestDeps();

    // _autosave currently holds the only fresh copy of some other account.
    const freshOther = { claudeAiOauth: { accessToken: "fresh-other" } };
    store.write(profileService(AUTOSAVE_NAME), JSON.stringify(freshOther));

    // Live blob: expired AND byte-equal to saved profile "dead", same identity.
    const deadBlob = {
      claudeAiOauth: { accessToken: "dead", expiresAt: 1_000 },
    };
    seed(deps, store, fs, deadBlob, {
      accountUuid: "d-1",
      organizationUuid: "o-1",
    });
    store.write(profileService("dead"), JSON.stringify(deadBlob));
    store.write(profileService("work"), JSON.stringify({ claudeAiOauth: {} }));
    const index = readIndex(deps);
    index.profiles["dead"] = {
      email: "dead@x.com", org: undefined, accountUuid: "d-1",
      savedAt: "2026-01-01T00:00:00.000Z",
      oauthAccount: { accountUuid: "d-1", organizationUuid: "o-1" },
    };
    writeIndex(deps, index);

    await useCommand(deps, "work");

    // _autosave preserved -- the expired duplicate added nothing.
    expect(store.read(profileService(AUTOSAVE_NAME))).toBe(
      JSON.stringify(freshOther),
    );
    // Switch still happened.
    expect(store.read(LIVE_SERVICE)).toBe(JSON.stringify({ claudeAiOauth: {} }));
  });

  it("preserves _autosave (split-brain) when the byte-equal stored profile's identity does NOT match the live identity", async () => {
    const { deps, store, fs } = createTestDeps();

    // _autosave currently holds a fresh copy of a THIRD account (C).
    const freshC = { claudeAiOauth: { accessToken: "fresh-c" } };
    store.write(profileService(AUTOSAVE_NAME), JSON.stringify(freshC));

    // Live blob is byte-equal to saved profile "dead" (identity B), but the
    // live identity in ~/.claude.json is a different identity (A) -- a
    // blob's tokens belong to one login, so this pairing is inconsistent
    // (split-brain) and must not be captured into _autosave either.
    const deadBlob = {
      claudeAiOauth: { accessToken: "dead", expiresAt: 1_000 },
    };
    seed(deps, store, fs, deadBlob, { accountUuid: "other-1" }); // identity A
    store.write(profileService("dead"), JSON.stringify(deadBlob)); // identity B
    store.write(profileService("work"), JSON.stringify({ claudeAiOauth: {} }));
    const index = readIndex(deps);
    index.profiles["dead"] = {
      email: "dead@x.com", org: undefined, accountUuid: "d-1",
      savedAt: "2026-01-01T00:00:00.000Z",
      oauthAccount: { accountUuid: "d-1", organizationUuid: "o-1" },
    };
    writeIndex(deps, index);

    await useCommand(deps, "work");

    // _autosave still holds C -- the split-brain live blob was never captured.
    expect(store.read(profileService(AUTOSAVE_NAME))).toBe(
      JSON.stringify(freshC),
    );
  });

  it("still captures an expired live blob into _autosave when it is NOT stored anywhere", async () => {
    const { deps, store, fs } = createTestDeps();
    const expiredUnique = {
      claudeAiOauth: { accessToken: "unique", expiresAt: 1_000 },
    };
    seed(deps, store, fs, expiredUnique, { email: "u@x.com" });
    store.write(profileService("work"), JSON.stringify({ claudeAiOauth: {} }));

    await useCommand(deps, "work");

    // Expired but unique: might still be the only copy -- keep capturing it.
    expect(store.read(profileService(AUTOSAVE_NAME))).toBe(
      JSON.stringify(expiredUnique),
    );
  });

  it("still captures a NON-expired live blob into _autosave even when byte-equal to a stored profile", async () => {
    const { deps, store, fs } = createTestDeps();
    const future = new Date("2026-07-10T12:00:00.000Z").getTime() + 3_600_000;
    const liveDup = {
      claudeAiOauth: { accessToken: "dup", expiresAt: future },
    };
    seed(deps, store, fs, liveDup, { email: "dup@x.com" });
    store.write(profileService("dup"), JSON.stringify(liveDup));
    store.write(profileService("work"), JSON.stringify({ claudeAiOauth: {} }));

    await useCommand(deps, "work");

    expect(store.read(profileService(AUTOSAVE_NAME))).toBe(
      JSON.stringify(liveDup),
    );
  });
});

describe("use command - write-back on switch-away", () => {
  // Common fixture: live login is "dev" (rotated past its snapshot), target is "dev2".
  const devAccount = { accountUuid: "a-1", organizationUuid: "o-1", emailAddress: "dev@x.com" };
  const dev2Account = { accountUuid: "a-2", organizationUuid: "o-1", emailAddress: "dev2@x.com" };
  const staleDevBlob = {
    claudeAiOauth: {
      accessToken: "dev-old",
      refreshToken: "dev-refresh",
      refreshTokenExpiresAt: 1_000,
    },
  };
  const freshDevBlob = {
    claudeAiOauth: {
      accessToken: "dev-new",
      refreshToken: "dev-refresh",
      refreshTokenExpiresAt: 2_000,
    },
  };
  const dev2Blob = {
    claudeAiOauth: {
      accessToken: "dev2-tok",
      refreshToken: "dev2-refresh",
      refreshTokenExpiresAt: 5_000,
    },
  };

  function seedTwoProfiles(harness: ReturnType<typeof createTestDeps>) {
    const { deps, store, fs } = harness;
    // Live slot: dev, already rotated ahead of its snapshot.
    store.write(LIVE_SERVICE, JSON.stringify(freshDevBlob));
    fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({ oauthAccount: devAccount }),
    );
    // Saved profiles: dev (stale) and dev2.
    store.write(profileService("dev"), JSON.stringify(staleDevBlob));
    store.write(profileService("dev2"), JSON.stringify(dev2Blob));
    const index = readIndex(deps);
    index.profiles["dev"] = {
      email: "dev@x.com", org: undefined, accountUuid: "a-1",
      savedAt: "2026-01-01T00:00:00.000Z", refreshTokenExpiresAt: 1_000,
      oauthAccount: devAccount,
    };
    index.profiles["dev2"] = {
      email: "dev2@x.com", org: undefined, accountUuid: "a-2",
      savedAt: "2026-01-01T00:00:00.000Z", refreshTokenExpiresAt: 5_000,
      oauthAccount: dev2Account,
    };
    writeIndex(deps, index);
  }

  it("writes the fresher live blob back into the identity-matching profile", async () => {
    const harness = createTestDeps();
    seedTwoProfiles(harness);

    await useCommand(harness.deps, "dev2");

    expect(harness.store.read(profileService("dev"))).toBe(
      JSON.stringify(freshDevBlob),
    );
    const index = readIndex(harness.deps);
    expect(index.profiles["dev"]?.refreshTokenExpiresAt).toBe(2_000);
    expect(index.profiles["dev"]?.savedAt).toBe("2026-07-10T12:00:00.000Z");
    // dev2 (different identity) untouched.
    expect(harness.store.read(profileService("dev2"))).toBe(
      JSON.stringify(dev2Blob),
    );
    // Switch itself still happened normally.
    expect(harness.store.read(LIVE_SERVICE)).toBe(JSON.stringify(dev2Blob));
  });

  it("never downgrades: live refreshTokenExpiresAt not strictly newer -> no write-back", async () => {
    const harness = createTestDeps();
    seedTwoProfiles(harness);
    // Live blob is OLDER than the snapshot (e.g. restored-then-never-rotated).
    const olderLive = {
      claudeAiOauth: {
        accessToken: "dev-older",
        refreshToken: "dev-refresh",
        refreshTokenExpiresAt: 500,
      },
    };
    harness.store.write(LIVE_SERVICE, JSON.stringify(olderLive));

    await useCommand(harness.deps, "dev2");

    expect(harness.store.read(profileService("dev"))).toBe(
      JSON.stringify(staleDevBlob),
    );
    expect(readIndex(harness.deps).profiles["dev"]?.savedAt).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("skips write-back when the live blob has no refreshTokenExpiresAt (can't prove freshness)", async () => {
    const harness = createTestDeps();
    seedTwoProfiles(harness);
    harness.store.write(
      LIVE_SERVICE,
      JSON.stringify({
        claudeAiOauth: { accessToken: "dev-mystery", refreshToken: "dev-refresh" },
      }),
    );

    await useCommand(harness.deps, "dev2");

    expect(harness.store.read(profileService("dev"))).toBe(
      JSON.stringify(staleDevBlob),
    );
  });

  it("skips write-back when the stored blob lacks refreshTokenExpiresAt (unknown age, never downgrade)", async () => {
    const harness = createTestDeps();
    seedTwoProfiles(harness);
    const noRteStored = { claudeAiOauth: { accessToken: "dev-ancient" } };
    harness.store.write(profileService("dev"), JSON.stringify(noRteStored));

    await useCommand(harness.deps, "dev2");

    expect(harness.store.read(profileService("dev"))).toBe(
      JSON.stringify(noRteStored),
    );
  });

  it("skips write-back when live identity is missing either uuid", async () => {
    const harness = createTestDeps();
    seedTwoProfiles(harness);
    harness.fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({ oauthAccount: { accountUuid: "a-1" } }), // no organizationUuid
    );

    await useCommand(harness.deps, "dev2");

    expect(harness.store.read(profileService("dev"))).toBe(
      JSON.stringify(staleDevBlob),
    );
  });

  it("skips write-back (but still switches) when the live blob is structurally invalid", async () => {
    const harness = createTestDeps();
    seedTwoProfiles(harness);
    harness.store.write(LIVE_SERVICE, JSON.stringify({ notClaudeAiOauth: true }));

    await useCommand(harness.deps, "dev2");

    expect(harness.store.read(profileService("dev"))).toBe(
      JSON.stringify(staleDevBlob),
    );
    expect(harness.store.read(LIVE_SERVICE)).toBe(JSON.stringify(dev2Blob));
  });

  it("writes back into ALL profiles sharing the live account+org", async () => {
    const harness = createTestDeps();
    seedTwoProfiles(harness);
    // A second name for the same dev identity, also stale.
    harness.store.write(profileService("dev-copy"), JSON.stringify(staleDevBlob));
    const index = readIndex(harness.deps);
    index.profiles["dev-copy"] = {
      email: "dev@x.com", org: undefined, accountUuid: "a-1",
      savedAt: "2026-01-01T00:00:00.000Z", refreshTokenExpiresAt: 1_000,
      oauthAccount: devAccount,
    };
    writeIndex(harness.deps, index);

    await useCommand(harness.deps, "dev2");

    expect(harness.store.read(profileService("dev"))).toBe(
      JSON.stringify(freshDevBlob),
    );
    expect(harness.store.read(profileService("dev-copy"))).toBe(
      JSON.stringify(freshDevBlob),
    );
  });

  it("switching to a profile of the LIVE account restores the upgraded blob, not the stale snapshot", async () => {
    const harness = createTestDeps();
    seedTwoProfiles(harness);

    await useCommand(harness.deps, "dev"); // dev is live AND the target

    // Store upgraded...
    expect(harness.store.read(profileService("dev"))).toBe(
      JSON.stringify(freshDevBlob),
    );
    // ...and the live slot keeps the FRESH blob -- restoring staleDevBlob
    // here would be the original bug in miniature.
    expect(harness.store.read(LIVE_SERVICE)).toBe(JSON.stringify(freshDevBlob));
  });

  it("restores the LIVE blob (not the stale snapshot) even when the target's own write-back write fails", async () => {
    const harness = createTestDeps();
    seedTwoProfiles(harness);
    harness.store.failWritesFor.add(profileService("dev"));

    await useCommand(harness.deps, "dev"); // dev is live AND the target

    // The write-back write to "dev" failed and was skipped -- the stored
    // snapshot is untouched.
    expect(harness.store.read(profileService("dev"))).toBe(
      JSON.stringify(staleDevBlob),
    );
    // But the restore decision doesn't depend on that write's success: the
    // live slot still ends up with the fresher LIVE blob, never the stale
    // snapshot that was just proven superseded.
    expect(harness.store.read(LIVE_SERVICE)).toBe(JSON.stringify(freshDevBlob));
    expect(harness.stderrLines.some((l) => l.includes("dev"))).toBe(true);
  });

  it("never writes the live blob back into _autosave via the write-back path twice", async () => {
    const harness = createTestDeps();
    seedTwoProfiles(harness);

    await useCommand(harness.deps, "dev2");

    // _autosave still captured exactly once with the live blob (existing behavior).
    expect(harness.store.read(profileService(AUTOSAVE_NAME))).toBe(
      JSON.stringify(freshDevBlob),
    );
  });

  it("skips write-back when the live blob has no usable access token", async () => {
    const harness = createTestDeps();
    seedTwoProfiles(harness);
    harness.store.write(
      LIVE_SERVICE,
      JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: 9_999_999_999_999 } }),
    );

    await useCommand(harness.deps, "dev2");

    expect(harness.store.read(profileService("dev"))).toBe(
      JSON.stringify(staleDevBlob),
    );
    // Switch itself still happened.
    expect(harness.store.read(LIVE_SERVICE)).toBe(JSON.stringify(dev2Blob));
  });

  it("a keychain read failure for one unrelated profile does not abort the switch", async () => {
    const harness = createTestDeps();
    seedTwoProfiles(harness);
    harness.store.write(profileService("dev-copy"), JSON.stringify(staleDevBlob));
    const index = readIndex(harness.deps);
    index.profiles["dev-copy"] = {
      email: "dev@x.com", org: undefined, accountUuid: "a-1",
      savedAt: "2026-01-01T00:00:00.000Z", refreshTokenExpiresAt: 1_000,
      oauthAccount: devAccount,
    };
    writeIndex(harness.deps, index);
    // Reading "dev-copy"'s stored blob throws -- it must be skipped, not abort the switch.
    harness.store.failReadsFor.add(profileService("dev-copy"));

    await useCommand(harness.deps, "dev2");
    harness.store.failReadsFor.delete(profileService("dev-copy"));

    // "dev-copy" was skipped (its read failed) -- untouched.
    expect(harness.store.read(profileService("dev-copy"))).toBe(
      JSON.stringify(staleDevBlob),
    );
    // "dev" (an unaffected profile) still upgraded normally.
    expect(harness.store.read(profileService("dev"))).toBe(
      JSON.stringify(freshDevBlob),
    );
    // Switch still completed.
    expect(harness.store.read(LIVE_SERVICE)).toBe(JSON.stringify(dev2Blob));
  });

  it("a keychain write failure for one profile does not abort write-back for others or the switch", async () => {
    const harness = createTestDeps();
    seedTwoProfiles(harness);
    harness.store.write(profileService("dev-copy"), JSON.stringify(staleDevBlob));
    const index = readIndex(harness.deps);
    index.profiles["dev-copy"] = {
      email: "dev@x.com", org: undefined, accountUuid: "a-1",
      savedAt: "2026-01-01T00:00:00.000Z", refreshTokenExpiresAt: 1_000,
      oauthAccount: devAccount,
    };
    writeIndex(harness.deps, index);
    harness.store.failWritesFor.add(profileService("dev"));

    await useCommand(harness.deps, "dev2");

    // "dev" write-back failed and was skipped, warned on stderr.
    expect(harness.store.read(profileService("dev"))).toBe(
      JSON.stringify(staleDevBlob),
    );
    expect(harness.stderrLines.some((l) => l.includes("dev"))).toBe(true);
    // "dev-copy" (same identity) still upgraded.
    expect(harness.store.read(profileService("dev-copy"))).toBe(
      JSON.stringify(freshDevBlob),
    );
    // Switch still completed.
    expect(harness.store.read(LIVE_SERVICE)).toBe(JSON.stringify(dev2Blob));
  });

  it("skips the entire write-back block when a byte-equal stored blob belongs to a different identity (split-brain)", async () => {
    const harness = createTestDeps();
    seedTwoProfiles(harness);
    // Live blob is byte-equal to dev2's stored blob, but ~/.claude.json
    // still claims the live identity is "dev" -- a previous switch must
    // have crashed between the keychain write and the config swap.
    harness.store.write(LIVE_SERVICE, JSON.stringify(dev2Blob));

    await useCommand(harness.deps, "dev2");

    // "dev"'s stale snapshot is NOT overwritten with dev2's blob.
    expect(harness.store.read(profileService("dev"))).toBe(
      JSON.stringify(staleDevBlob),
    );
  });

  it("reconciles a stale index refreshTokenExpiresAt when the stored blob already matches the live blob", async () => {
    const harness = createTestDeps();
    seedTwoProfiles(harness);
    // "dev"'s stored blob already equals the live blob (a previous run's
    // keychain write landed but its writeIndex step failed), yet the index
    // still shows the old refreshTokenExpiresAt.
    harness.store.write(profileService("dev"), JSON.stringify(freshDevBlob));

    await useCommand(harness.deps, "dev2");

    expect(harness.store.read(profileService("dev"))).toBe(
      JSON.stringify(freshDevBlob),
    );
    expect(readIndex(harness.deps).profiles["dev"]?.refreshTokenExpiresAt).toBe(
      2_000,
    );
  });
});
