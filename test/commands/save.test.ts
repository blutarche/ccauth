import { describe, it, expect } from "vitest";
import { saveCommand } from "../../src/commands/save.js";
import { readIndex, writeIndex } from "../../src/profiles.js";
import { LIVE_SERVICE, profileService, CcauthError } from "../../src/types.js";
import { createTestDeps, TEST_PATHS } from "../fakes/testDeps.js";

function seedLive(fs: any, store: any, blob: object, oauthAccount?: object) {
  store.write(LIVE_SERVICE, JSON.stringify(blob));
  fs.files.set(
    TEST_PATHS.claudeConfigPath,
    JSON.stringify(oauthAccount ? { oauthAccount } : {}),
  );
}

/** Seeds an EXISTING saved profile (keychain item + index entry). */
function seedExistingProfile(
  deps: ReturnType<typeof createTestDeps>["deps"],
  store: any,
  name: string,
  blob: object,
) {
  store.write(profileService(name), JSON.stringify(blob));
  const index = readIndex(deps);
  index.profiles[name] = {
    email: `${name}@example.com`,
    org: undefined,
    accountUuid: `${name}-uuid`,
    savedAt: "2026-01-01T00:00:00.000Z",
    oauthAccount: { emailAddress: `${name}@example.com` },
  };
  writeIndex(deps, index);
}

describe("save command", () => {
  it("errors clearly when there is no active login", async () => {
    const { deps } = createTestDeps();
    fs_setEmptyConfig(deps);

    await expect(saveCommand(deps, {})).rejects.toThrow(
      /No active Claude Code login found/,
    );
  });

  it("saves a new profile, deriving the name from the account email", async () => {
    const { deps, store, fs } = createTestDeps();
    seedLive(
      fs,
      store,
      { claudeAiOauth: { accessToken: "abc" } },
      { emailAddress: "Me@Work.com", organizationName: "Acme", accountUuid: "uuid-1" },
    );

    await saveCommand(deps, {});

    expect(store.read(profileService("me-work-com"))).toBe(
      JSON.stringify({ claudeAiOauth: { accessToken: "abc" } }),
    );
    const index = readIndex(deps);
    expect(index.profiles["me-work-com"]).toMatchObject({
      email: "Me@Work.com",
      org: "Acme",
      accountUuid: "uuid-1",
    });
  });

  it("saves under an explicit name", async () => {
    const { deps, store, fs } = createTestDeps();
    seedLive(fs, store, { claudeAiOauth: { accessToken: "abc" } }, {
      emailAddress: "me@work.com",
    });

    await saveCommand(deps, { name: "work" });

    expect(store.read(profileService("work"))).not.toBeNull();
  });

  it("prompts before overwriting an existing profile, and aborts on 'no'", async () => {
    const { deps, store, fs } = createTestDeps({
      confirm: async () => false,
    });
    seedLive(fs, store, { claudeAiOauth: { accessToken: "new" } }, {
      emailAddress: "me@work.com",
    });
    seedExistingProfile(deps, store, "work", {
      claudeAiOauth: { accessToken: "old" },
    });

    await saveCommand(deps, { name: "work" });

    // Unchanged: the "no" answer must abort the overwrite.
    expect(store.read(profileService("work"))).toBe(
      JSON.stringify({ claudeAiOauth: { accessToken: "old" } }),
    );
  });

  it("overwrites when confirmed", async () => {
    const { deps, store, fs } = createTestDeps({
      confirm: async () => true,
    });
    seedLive(fs, store, { claudeAiOauth: { accessToken: "new" } }, {
      emailAddress: "me@work.com",
    });
    seedExistingProfile(deps, store, "work", {
      claudeAiOauth: { accessToken: "old" },
    });

    await saveCommand(deps, { name: "work" });

    expect(store.read(profileService("work"))).toBe(
      JSON.stringify({ claudeAiOauth: { accessToken: "new" } }),
    );
  });

  it("skips the confirmation prompt with --yes", async () => {
    let confirmCalled = false;
    const { deps, store, fs } = createTestDeps({
      confirm: async () => {
        confirmCalled = true;
        return false;
      },
    });
    seedLive(fs, store, { claudeAiOauth: { accessToken: "new" } }, {
      emailAddress: "me@work.com",
    });
    seedExistingProfile(deps, store, "work", {
      claudeAiOauth: { accessToken: "old" },
    });

    await saveCommand(deps, { name: "work", yes: true });

    expect(confirmCalled).toBe(false);
    expect(store.read(profileService("work"))).toBe(
      JSON.stringify({ claudeAiOauth: { accessToken: "new" } }),
    );
  });

  it("rejects the reserved _autosave name", async () => {
    const { deps, store, fs } = createTestDeps();
    seedLive(fs, store, { claudeAiOauth: {} }, { emailAddress: "me@work.com" });

    await expect(saveCommand(deps, { name: "_autosave" })).rejects.toThrow(
      CcauthError,
    );
  });

  it("saves credentials-only when there is no live identity, and notes it", async () => {
    const { deps, store, fs } = createTestDeps();
    seedLive(fs, store, { claudeAiOauth: { accessToken: "abc" } });

    await saveCommand(deps, { name: "anon" });

    const index = readIndex(deps);
    expect(index.profiles["anon"]?.email).toBeUndefined();
    expect(index.profiles["anon"]?.accountUuid).toBeUndefined();
  });

  it("caches refreshTokenExpiresAt from the live blob into the index", async () => {
    const { deps, store, fs } = createTestDeps();
    seedLive(
      fs,
      store,
      {
        claudeAiOauth: {
          accessToken: "abc",
          expiresAt: 1000,
          refreshTokenExpiresAt: 123456789,
        },
      },
      { emailAddress: "me@work.com" },
    );

    await saveCommand(deps, { name: "work" });

    const index = readIndex(deps);
    expect(index.profiles["work"]?.refreshTokenExpiresAt).toBe(123456789);
  });

  it("leaves refreshTokenExpiresAt undefined when the blob lacks the field", async () => {
    const { deps, store, fs } = createTestDeps();
    seedLive(fs, store, { claudeAiOauth: { accessToken: "abc" } }, {
      emailAddress: "me@work.com",
    });

    await saveCommand(deps, { name: "work" });

    const index = readIndex(deps);
    expect(index.profiles["work"]?.refreshTokenExpiresAt).toBeUndefined();
  });
});

function fs_setEmptyConfig(deps: ReturnType<typeof createTestDeps>["deps"]) {
  (deps.fs as any).files.set(TEST_PATHS.claudeConfigPath, "{}");
}
