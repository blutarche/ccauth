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
});
