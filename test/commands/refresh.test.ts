import { describe, it, expect, vi } from "vitest";
import { refreshCommand } from "../../src/commands/refresh.js";
import { readOauthAccount } from "../../src/claudeConfig.js";
import { readIndex, writeIndex } from "../../src/profiles.js";
import {
  AUTOSAVE_NAME,
  CcauthError,
  LIVE_SERVICE,
  profileService,
} from "../../src/types.js";
import type { OauthAccount, ProfileEntry } from "../../src/types.js";
import { createTestDeps, TEST_PATHS } from "../fakes/testDeps.js";

type Harness = ReturnType<typeof createTestDeps>;

function seedLive(
  h: Harness,
  liveBlob: object,
  liveAccount: OauthAccount | undefined,
) {
  h.store.write(LIVE_SERVICE, JSON.stringify(liveBlob));
  h.fs.files.set(
    TEST_PATHS.claudeConfigPath,
    JSON.stringify({ oauthAccount: liveAccount, unrelated: "keep" }),
  );
}

function seedProfile(
  h: Harness,
  name: string,
  blob: object,
  entry: Partial<ProfileEntry> = {},
) {
  h.store.write(profileService(name), JSON.stringify(blob));
  const index = readIndex(h.deps);
  index.profiles[name] = {
    email: undefined,
    org: undefined,
    accountUuid: undefined,
    savedAt: "2026-01-01T00:00:00.000Z",
    oauthAccount: undefined,
    ...entry,
  };
  writeIndex(h.deps, index);
}

/** Registers an index entry with no matching keychain item (a "missing" target). */
function seedIndexOnly(h: Harness, name: string, entry: Partial<ProfileEntry> = {}) {
  const index = readIndex(h.deps);
  index.profiles[name] = {
    email: undefined,
    org: undefined,
    accountUuid: undefined,
    savedAt: "2026-01-01T00:00:00.000Z",
    oauthAccount: undefined,
    ...entry,
  };
  writeIndex(h.deps, index);
}

describe("refresh command", () => {
  it("happy path: swap -> runClaude -> re-capture writes rotated blob into ccauth:P BEFORE restore runs", async () => {
    const h = createTestDeps();
    const originalBlob = { claudeAiOauth: { accessToken: "orig" } };
    const originalAccount = { email: "me@personal.com", accountUuid: "p-1" };
    seedLive(h, originalBlob, originalAccount);

    const workBlob = { claudeAiOauth: { accessToken: "work-token", expiresAt: 1000 } };
    seedProfile(h, "work", workBlob, {
      accountUuid: "w-1",
      oauthAccount: { email: "me@work.com", accountUuid: "w-1" },
    });

    const rotatedBlob = {
      claudeAiOauth: {
        accessToken: "work-token-ROTATED",
        expiresAt: 2000,
        refreshTokenExpiresAt: 99999,
      },
    };

    // Track write order to prove re-capture (ccauth:work) happens before the
    // finally-restore write into the live slot.
    const writeLog: string[] = [];
    const originalWrite = h.store.write.bind(h.store);
    h.store.write = (service: string, secret: string) => {
      writeLog.push(service);
      originalWrite(service, secret);
    };

    h.runClaude.handler = () => {
      // Simulate Claude Code rotating the live credential.
      h.store.write(LIVE_SERVICE, JSON.stringify(rotatedBlob));
      return { code: 0, stdout: "pong", stderr: "", timedOut: false };
    };

    await refreshCommand(h.deps, { name: "work" });

    expect(h.runClaude.calls).toHaveLength(1);
    expect(h.runClaude.calls[0]?.args).toEqual([
      "-p",
      "--model",
      "haiku",
      "reply with the single word pong",
    ]);
    expect(h.runClaude.calls[0]?.opts.timeoutMs).toBe(120_000);

    // Re-capture wrote R into ccauth:work.
    expect(h.store.read(profileService("work"))).toBe(JSON.stringify(rotatedBlob));
    // Restore put the ORIGINAL back into live (work != active identity).
    expect(h.store.read(LIVE_SERVICE)).toBe(JSON.stringify(originalBlob));
    const config = JSON.parse(h.fs.files.get(TEST_PATHS.claudeConfigPath)!);
    expect(config.oauthAccount).toEqual(originalAccount);

    // Order: rotated blob written to live (inside handler), then re-capture
    // into ccauth:work, then finally-restore back into live.
    const workWriteIdx = writeLog.lastIndexOf(profileService("work"));
    const lastLiveWriteIdx = writeLog.lastIndexOf(LIVE_SERVICE);
    expect(workWriteIdx).toBeGreaterThan(-1);
    expect(lastLiveWriteIdx).toBeGreaterThan(workWriteIdx);

    // Index cache updated from the re-captured blob.
    const finalIndex = readIndex(h.deps);
    expect(finalIndex.profiles["work"]?.refreshTokenExpiresAt).toBe(99999);
  });

  it("runClaude non-zero exit: status failed, loop continues, restore still runs", async () => {
    const h = createTestDeps();
    const originalBlob = { claudeAiOauth: { accessToken: "orig" } };
    seedLive(h, originalBlob, { email: "me@personal.com", accountUuid: "p-1" });
    seedProfile(h, "work", { claudeAiOauth: { accessToken: "work" } }, {
      accountUuid: "w-1",
      oauthAccount: { accountUuid: "w-1" },
    });

    h.runClaude.handler = () => ({
      code: 1,
      stdout: "",
      stderr: "boom",
      timedOut: false,
    });

    await refreshCommand(h.deps, { name: "work" });

    expect(h.store.read(LIVE_SERVICE)).toBe(JSON.stringify(originalBlob));
    expect(h.stdoutLines.some((l) => /failed\s+1/.test(l))).toBe(true);
    expect(
      h.stdoutLines.some((l) => l.includes("ccauth use work") && l.includes("/login")),
    ).toBe(true);
  });

  it("visits multiple profiles sequentially, sorted, skipping _autosave when no name given", async () => {
    const h = createTestDeps();
    seedLive(h, { claudeAiOauth: { accessToken: "orig" } }, {
      email: "me@personal.com",
      accountUuid: "p-1",
    });
    seedProfile(h, "b", { claudeAiOauth: { accessToken: "b" } }, {
      accountUuid: "b-1",
      oauthAccount: { accountUuid: "b-1" },
    });
    seedProfile(h, "a", { claudeAiOauth: { accessToken: "a" } }, {
      accountUuid: "a-1",
      oauthAccount: { accountUuid: "a-1" },
    });
    seedProfile(h, AUTOSAVE_NAME, { claudeAiOauth: { accessToken: "auto" } }, {
      oauthAccount: { accountUuid: "auto-1" },
    });

    const visitedOrder: (string | undefined)[] = [];
    h.runClaude.handler = () => {
      const account = readOauthAccount(h.deps);
      visitedOrder.push(account?.accountUuid as string | undefined);
      return { code: 0, stdout: "pong", stderr: "", timedOut: false };
    };

    await refreshCommand(h.deps, {});

    expect(h.runClaude.calls).toHaveLength(2);
    expect(visitedOrder).toEqual(["a-1", "b-1"]);
  });

  it("prints a message and does nothing when there are no saved profiles", async () => {
    const h = createTestDeps();
    seedLive(h, { claudeAiOauth: { accessToken: "orig" } }, { accountUuid: "p-1" });

    await refreshCommand(h.deps, {});

    expect(h.runClaude.calls).toHaveLength(0);
    expect(h.stdoutLines).toContain("No saved profiles to refresh.");
  });

  it("active-profile edge: originally-active identity is a target and rotates -> live ends on the ROTATED blob", async () => {
    const h = createTestDeps();
    const personalBlob = { claudeAiOauth: { accessToken: "personal" } };
    const personalAccount = { email: "me@personal.com", accountUuid: "p-1" };
    seedLive(h, personalBlob, personalAccount);
    seedProfile(h, "personal", personalBlob, {
      accountUuid: "p-1",
      oauthAccount: personalAccount,
    });

    const rotatedBlob = {
      claudeAiOauth: { accessToken: "personal-ROTATED", refreshTokenExpiresAt: 555 },
    };
    h.runClaude.handler = () => {
      h.store.write(LIVE_SERVICE, JSON.stringify(rotatedBlob));
      return { code: 0, stdout: "pong", stderr: "", timedOut: false };
    };

    await refreshCommand(h.deps, { name: "personal" });

    // NOT the stale original -- the freshly rotated blob.
    expect(h.store.read(LIVE_SERVICE)).toBe(JSON.stringify(rotatedBlob));
    expect(h.store.read(LIVE_SERVICE)).not.toBe(JSON.stringify(personalBlob));
    const config = JSON.parse(h.fs.files.get(TEST_PATHS.claudeConfigPath)!);
    expect(config.oauthAccount).toEqual(personalAccount);
  });

  it("refuses when claude is running and --force is not passed; no swaps happen", async () => {
    const h = createTestDeps({ isClaudeRunning: () => true });
    const originalBlob = { claudeAiOauth: { accessToken: "orig" } };
    seedLive(h, originalBlob, { accountUuid: "p-1" });
    seedProfile(h, "work", { claudeAiOauth: { accessToken: "work" } }, {
      accountUuid: "w-1",
      oauthAccount: { accountUuid: "w-1" },
    });

    await expect(refreshCommand(h.deps, { name: "work" })).rejects.toThrow(CcauthError);

    expect(h.runClaude.calls).toHaveLength(0);
    expect(h.store.read(LIVE_SERVICE)).toBe(JSON.stringify(originalBlob));
  });

  it("proceeds when claude is running and --force is passed", async () => {
    const h = createTestDeps({ isClaudeRunning: () => true });
    seedLive(h, { claudeAiOauth: { accessToken: "orig" } }, { accountUuid: "p-1" });
    seedProfile(h, "work", { claudeAiOauth: { accessToken: "work" } }, {
      accountUuid: "w-1",
      oauthAccount: { accountUuid: "w-1" },
    });

    await refreshCommand(h.deps, { name: "work", force: true });

    expect(h.runClaude.calls).toHaveLength(1);
  });

  it("errors clearly when an explicitly-named profile does not exist", async () => {
    const h = createTestDeps();
    seedLive(h, { claudeAiOauth: {} }, { accountUuid: "p-1" });

    await expect(refreshCommand(h.deps, { name: "nope" })).rejects.toThrow(
      /No such profile/,
    );
    expect(h.runClaude.calls).toHaveLength(0);
  });

  it("missing profile blob (index entry with no keychain item): status missing, no crash", async () => {
    const h = createTestDeps();
    seedLive(h, { claudeAiOauth: { accessToken: "orig" } }, { accountUuid: "p-1" });
    seedIndexOnly(h, "ghost", { accountUuid: "g-1", oauthAccount: { accountUuid: "g-1" } });

    await refreshCommand(h.deps, {});

    expect(h.runClaude.calls).toHaveLength(0);
    expect(h.stdoutLines.some((l) => /missing\s+1/.test(l))).toBe(true);
    expect(
      h.stdoutLines.some((l) => l.includes("ccauth use ghost") && l.includes("/login")),
    ).toBe(true);
  });

  it("restore runs even if runClaude throws mid-loop (defensive: Deps.runClaude should never throw, but restore must be unconditional)", async () => {
    const h = createTestDeps();
    const originalBlob = { claudeAiOauth: { accessToken: "orig" } };
    seedLive(h, originalBlob, { accountUuid: "p-1" });
    seedProfile(h, "work", { claudeAiOauth: { accessToken: "work" } }, {
      accountUuid: "w-1",
      oauthAccount: { accountUuid: "w-1" },
    });

    h.runClaude.handler = () => {
      throw new Error("boom");
    };

    await expect(refreshCommand(h.deps, { name: "work" })).rejects.toThrow("boom");

    expect(h.store.read(LIVE_SERVICE)).toBe(JSON.stringify(originalBlob));
  });

  it("SIGINT mid-loop runs restore and exits 130", async () => {
    const h = createTestDeps();
    const originalBlob = { claudeAiOauth: { accessToken: "orig" } };
    seedLive(h, originalBlob, { accountUuid: "p-1" });
    seedProfile(h, "work", { claudeAiOauth: { accessToken: "work" } }, {
      accountUuid: "w-1",
      oauthAccount: { accountUuid: "w-1" },
    });

    const sigintCountBefore = process.listenerCount("SIGINT");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    h.runClaude.handler = () => {
      // Simulate a mid-call interrupt: the signal handler fires synchronously.
      process.emit("SIGINT");
      return { code: 0, stdout: "pong", stderr: "", timedOut: false };
    };

    await refreshCommand(h.deps, { name: "work" });

    expect(exitSpy).toHaveBeenCalledWith(130);
    expect(h.store.read(LIVE_SERVICE)).toBe(JSON.stringify(originalBlob));
    // Handlers were removed in `finally`, no listener leak.
    expect(process.listenerCount("SIGINT")).toBe(sigintCountBefore);

    exitSpy.mockRestore();
  });

  it("no live credential at start: restore deletes the live slot (not left on the last profile) and restores the original identity", async () => {
    const h = createTestDeps();
    // No store.write for LIVE_SERVICE -- originalBlob reads as null (no
    // live credential existed before the run). oauthAccount is set but
    // matches no saved profile.
    const originalAccount = { email: "someone@nomatch.com", accountUuid: "no-match-1" };
    h.fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({ oauthAccount: originalAccount, unrelated: "keep" }),
    );

    seedProfile(h, "a", { claudeAiOauth: { accessToken: "a" } }, {
      accountUuid: "a-1",
      oauthAccount: { accountUuid: "a-1" },
    });
    seedProfile(h, "b", { claudeAiOauth: { accessToken: "b" } }, {
      accountUuid: "b-1",
      oauthAccount: { accountUuid: "b-1" },
    });

    h.runClaude.handler = () => ({ code: 0, stdout: "pong", stderr: "", timedOut: false });

    await refreshCommand(h.deps, {});

    expect(h.runClaude.calls).toHaveLength(2);
    // Live slot returned to its original absent state -- not left holding
    // the last-processed profile's ("b") credential.
    expect(h.store.read(LIVE_SERVICE)).toBeNull();
    const config = JSON.parse(h.fs.files.get(TEST_PATHS.claudeConfigPath)!);
    expect(config.oauthAccount).toEqual(originalAccount);
  });

  it("FIX A regression: active target shares its account with a second saved profile -> live ends on the ROTATED blob, not stale original", async () => {
    const h = createTestDeps();
    const personalBlob = { claudeAiOauth: { accessToken: "personal" } };
    const sharedAccount = {
      email: "me@personal.com",
      accountUuid: "p-1",
      organizationUuid: "org-1",
    };
    // The live blob IS profile "b"'s blob -- "b" is the actually-active
    // target. "a" merely shares the same identity metadata, so the OLD
    // `.find(sameAccount(...))` logic (which walks profiles in insertion
    // order) picks "a" as "originallyActiveName" even though "a"'s blob was
    // never live. That misdetection must no longer matter.
    seedLive(h, personalBlob, sharedAccount);
    seedProfile(h, "a", { claudeAiOauth: { accessToken: "a-stale" } }, {
      accountUuid: "p-1",
      oauthAccount: sharedAccount,
    });
    seedProfile(h, "b", personalBlob, {
      accountUuid: "p-1",
      oauthAccount: sharedAccount,
    });

    const rotatedBlob = {
      claudeAiOauth: { accessToken: "personal-ROTATED", refreshTokenExpiresAt: 777 },
    };
    h.runClaude.handler = () => {
      h.store.write(LIVE_SERVICE, JSON.stringify(rotatedBlob));
      return { code: 0, stdout: "pong", stderr: "", timedOut: false };
    };

    await refreshCommand(h.deps, { name: "b" });

    expect(h.store.read(LIVE_SERVICE)).toBe(JSON.stringify(rotatedBlob));
    expect(h.store.read(LIVE_SERVICE)).not.toBe(JSON.stringify(personalBlob));
  });

  it("FIX A regression: active login has undefined oauthAccount identity but its blob matches a target -> live ends on the ROTATED blob", async () => {
    const h = createTestDeps();
    const sharedBlob = { claudeAiOauth: { accessToken: "shared" } };
    // Live identity is undefined (readOauthAccount() -> undefined), so the
    // OLD `sameAccount(target, undefined)` check can never match any
    // profile, and the target is never promoted -- reproducing the logout
    // bug even more directly than the "shared account" case.
    seedLive(h, sharedBlob, undefined);
    seedProfile(h, "t", sharedBlob, {
      accountUuid: "t-1",
      oauthAccount: { accountUuid: "t-1" },
    });

    const rotatedBlob = {
      claudeAiOauth: { accessToken: "shared-ROTATED", refreshTokenExpiresAt: 888 },
    };
    h.runClaude.handler = () => {
      h.store.write(LIVE_SERVICE, JSON.stringify(rotatedBlob));
      return { code: 0, stdout: "pong", stderr: "", timedOut: false };
    };

    await refreshCommand(h.deps, { name: "t" });

    expect(h.store.read(LIVE_SERVICE)).toBe(JSON.stringify(rotatedBlob));
    expect(h.store.read(LIVE_SERVICE)).not.toBe(JSON.stringify(sharedBlob));
  });

  it("FIX A: no live credential at start but a stale account happens to identity-match a target -> restore DELETES the live slot, doesn't create a login", async () => {
    const h = createTestDeps();
    // No write to LIVE_SERVICE -- originalBlob reads as null. The leftover
    // config identity happens to match target "b" by accountUuid/org, which
    // would make the OLD sameAccount-based logic promote "b"'s rotated blob
    // into the live slot on restore (fabricating a login that never
    // existed). Blob-equality can't do that: originalBlob is null, so
    // `isActive` is always false.
    const staleAccount = { accountUuid: "b-1", organizationUuid: "org-b" };
    h.fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({ oauthAccount: staleAccount, unrelated: "keep" }),
    );
    seedProfile(h, "b", { claudeAiOauth: { accessToken: "b" } }, {
      accountUuid: "b-1",
      oauthAccount: staleAccount,
    });

    h.runClaude.handler = () => {
      h.store.write(LIVE_SERVICE, JSON.stringify({ claudeAiOauth: { accessToken: "R" } }));
      return { code: 0, stdout: "pong", stderr: "", timedOut: false };
    };

    await refreshCommand(h.deps, { name: "b" });

    expect(h.store.read(LIVE_SERVICE)).toBeNull();
  });

  it("FIX B: a target with a malformed stored blob is skipped as failed, never written to the live slot, and the loop continues", async () => {
    const h = createTestDeps();
    const originalBlob = { claudeAiOauth: { accessToken: "orig" } };
    seedLive(h, originalBlob, { accountUuid: "p-1" });

    seedIndexOnly(h, "bad", { accountUuid: "b-1", oauthAccount: { accountUuid: "b-1" } });
    h.store.write(profileService("bad"), "not-json");

    seedProfile(h, "good", { claudeAiOauth: { accessToken: "good" } }, {
      accountUuid: "g-1",
      oauthAccount: { accountUuid: "g-1" },
    });

    const liveValuesSeenDuringRun: (string | null)[] = [];
    h.runClaude.handler = () => {
      liveValuesSeenDuringRun.push(h.store.read(LIVE_SERVICE));
      return { code: 0, stdout: "pong", stderr: "", timedOut: false };
    };

    await refreshCommand(h.deps, {});

    // Only "good" ever reached runClaude -- "bad" was skipped before the
    // live-slot write.
    expect(h.runClaude.calls).toHaveLength(1);
    expect(liveValuesSeenDuringRun).toEqual([JSON.stringify({
      claudeAiOauth: { accessToken: "good" },
    })]);
    // The malformed blob was never written into the live slot at any point.
    expect(liveValuesSeenDuringRun.every((v) => v !== "not-json")).toBe(true);

    expect(h.stdoutLines.some((l) => /failed\s+1/.test(l))).toBe(true);
    expect(
      h.stdoutLines.some((l) => l.includes("ccauth use bad") && l.includes("/login")),
    ).toBe(true);

    // Restore ran and put the original back.
    expect(h.store.read(LIVE_SERVICE)).toBe(JSON.stringify(originalBlob));
  });

  it("FIX D regression: two duplicate-active profiles share the original live blob; the first rotates, the second is a stale no-op rotate -> live ends on the ROTATED blob, not the dead original", async () => {
    const h = createTestDeps();
    const oldBlob = { claudeAiOauth: { accessToken: "OLD", refreshTokenExpiresAt: 111 } };
    const newBlob = { claudeAiOauth: { accessToken: "NEW", refreshTokenExpiresAt: 222 } };
    seedLive(h, oldBlob, { accountUuid: "p-1" });
    // Both "a" and "b" were saved from the same login before either was ever
    // refreshed, so they store the byte-identical OLD blob.
    seedProfile(h, "a", oldBlob, {
      accountUuid: "p-1",
      oauthAccount: { accountUuid: "p-1" },
    });
    seedProfile(h, "b", oldBlob, {
      accountUuid: "p-1",
      oauthAccount: { accountUuid: "p-1" },
    });

    // Targets are visited sorted: "a" then "b". "a" (the first to consume
    // the shared refresh token) rotates OLD -> NEW. "b" is handed OLD too
    // (its own stored blob, still OLD at that point) but the refresh token
    // was already consumed by "a", so claude uses the still-valid access
    // token without rotating -- the live slot is left exactly as handed.
    let call = 0;
    h.runClaude.handler = () => {
      call++;
      if (call === 1) {
        h.store.write(LIVE_SERVICE, JSON.stringify(newBlob));
      }
      // call === 2: no-op, live slot stays whatever it was swapped to.
      return { code: 0, stdout: "pong", stderr: "", timedOut: false };
    };

    await refreshCommand(h.deps, {});

    expect(h.runClaude.calls).toHaveLength(2);
    // Must end on the valid rotated blob, not the dead OLD one.
    expect(h.store.read(LIVE_SERVICE)).toBe(JSON.stringify(newBlob));
    expect(h.store.read(LIVE_SERVICE)).not.toBe(JSON.stringify(oldBlob));
  });

  it("FIX E: index-write failure after a successful active rotation -> restore still writes the ROTATED blob, not the stale original", async () => {
    const h = createTestDeps();
    const oldBlob = { claudeAiOauth: { accessToken: "OLD", refreshTokenExpiresAt: 111 } };
    const newBlob = { claudeAiOauth: { accessToken: "NEW", refreshTokenExpiresAt: 222 } };
    seedLive(h, oldBlob, { accountUuid: "p-1" });
    seedProfile(h, "work", oldBlob, {
      accountUuid: "p-1",
      oauthAccount: { accountUuid: "p-1" },
    });

    h.runClaude.handler = () => {
      h.store.write(LIVE_SERVICE, JSON.stringify(newBlob));
      return { code: 0, stdout: "pong", stderr: "", timedOut: false };
    };

    // writeIndex does writeFileSync(tmp) then renameSync(tmp, profiles.json)
    // -- make just that rename (the fallible half of the atomic index
    // write) throw, simulating a real filesystem failure. Other renameSync
    // calls (e.g. the claude.json identity swap) must keep working, or
    // restore() itself would throw for an unrelated reason.
    const originalRenameSync = h.fs.renameSync.bind(h.fs);
    const renameError = new Error("ENOSPC: simulated rename failure");
    h.fs.renameSync = (oldPath: string, newPath: string) => {
      if (newPath === TEST_PATHS.profilesIndexPath) {
        throw renameError;
      }
      originalRenameSync(oldPath, newPath);
    };

    await expect(refreshCommand(h.deps, { name: "work" })).rejects.toThrow(renameError);

    // Promotion of restoreBlob must have happened BEFORE the throwable
    // writeIndex call -- the finally-restore ends live on the freshly
    // rotated NEW blob, not the stale pre-loop OLD one, even though the
    // index write itself failed.
    expect(h.store.read(LIVE_SERVICE)).toBe(JSON.stringify(newBlob));
    expect(h.store.read(LIVE_SERVICE)).not.toBe(JSON.stringify(oldBlob));
  });

  it("FIX F: a failed run that mutates live to an unrelated dead blob must never be promoted or persisted, even after another profile's successful rotation", async () => {
    const h = createTestDeps();
    const oldBlob = { claudeAiOauth: { accessToken: "OLD", refreshTokenExpiresAt: 111 } };
    const newBlob = { claudeAiOauth: { accessToken: "NEW", refreshTokenExpiresAt: 222 } };
    const deadBlob = { claudeAiOauth: { accessToken: "DEAD", refreshTokenExpiresAt: 0 } };
    seedLive(h, oldBlob, { accountUuid: "p-1" });
    // "a" and "b" both stored the same OLD blob; "a" is the active login.
    seedProfile(h, "a", oldBlob, {
      accountUuid: "p-1",
      oauthAccount: { accountUuid: "p-1" },
    });
    seedProfile(h, "b", oldBlob, {
      accountUuid: "b-1",
      oauthAccount: { accountUuid: "b-1" },
    });

    let call = 0;
    h.runClaude.handler = () => {
      call++;
      if (call === 1) {
        // "a": succeeds and rotates OLD -> NEW; gets promoted (isActive).
        h.store.write(LIVE_SERVICE, JSON.stringify(newBlob));
        return { code: 0, stdout: "pong", stderr: "", timedOut: false };
      }
      // "b": fails, but still leaves a *different*, dead blob in the live
      // slot -- e.g. a partial/garbage write from the failed invocation.
      h.store.write(LIVE_SERVICE, JSON.stringify(deadBlob));
      return { code: 1, stdout: "", stderr: "boom", timedOut: false };
    };

    await refreshCommand(h.deps, {});

    expect(h.runClaude.calls).toHaveLength(2);
    // "b"'s dead blob must never have been written into ccauth:b.
    expect(h.store.read(profileService("b"))).toBe(JSON.stringify(oldBlob));
    // restoreBlob must have stayed on "a"'s valid NEW rotation -- the dead
    // blob from "b"'s failed run must never overwrite it as the restore
    // source. Final live state is NEW, never DEAD.
    expect(h.store.read(LIVE_SERVICE)).toBe(JSON.stringify(newBlob));
    expect(h.store.read(LIVE_SERVICE)).not.toBe(JSON.stringify(deadBlob));
  });

  it("FIX C: claude not on PATH -> refuses up front with zero swaps", async () => {
    const h = createTestDeps({ isClaudeInstalled: () => false });
    const originalBlob = { claudeAiOauth: { accessToken: "orig" } };
    seedLive(h, originalBlob, { accountUuid: "p-1" });
    seedProfile(h, "work", { claudeAiOauth: { accessToken: "work" } }, {
      accountUuid: "w-1",
      oauthAccount: { accountUuid: "w-1" },
    });

    await expect(refreshCommand(h.deps, { name: "work" })).rejects.toThrow(CcauthError);

    expect(h.runClaude.calls).toHaveLength(0);
    expect(h.store.read(LIVE_SERVICE)).toBe(JSON.stringify(originalBlob));
  });
});
