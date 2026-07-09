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
});
