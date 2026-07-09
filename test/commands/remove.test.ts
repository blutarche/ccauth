import { describe, it, expect } from "vitest";
import { removeCommand } from "../../src/commands/remove.js";
import { readIndex, writeIndex } from "../../src/profiles.js";
import { CcauthError, profileService } from "../../src/types.js";
import { createTestDeps } from "../fakes/testDeps.js";

function seedProfile(
  deps: ReturnType<typeof createTestDeps>["deps"],
  store: ReturnType<typeof createTestDeps>["store"],
  name: string,
) {
  store.write(profileService(name), JSON.stringify({ claudeAiOauth: {} }));
  const index = readIndex(deps);
  index.profiles[name] = {
    email: `${name}@example.com`,
    org: undefined,
    accountUuid: `${name}-uuid`,
    savedAt: "2026-07-10T00:00:00.000Z",
    oauthAccount: { email: `${name}@example.com` },
  };
  writeIndex(deps, index);
}

describe("remove command", () => {
  it("removes the keychain item and index entry when confirmed", async () => {
    const { deps, store } = createTestDeps({ confirm: async () => true });
    seedProfile(deps, store, "work");

    await removeCommand(deps, "work", {});

    expect(store.read(profileService("work"))).toBeNull();
    expect(readIndex(deps).profiles["work"]).toBeUndefined();
  });

  it("aborts when not confirmed", async () => {
    const { deps, store } = createTestDeps({ confirm: async () => false });
    seedProfile(deps, store, "work");

    await removeCommand(deps, "work", {});

    expect(store.read(profileService("work"))).not.toBeNull();
    expect(readIndex(deps).profiles["work"]).toBeDefined();
  });

  it("skips confirmation with --yes", async () => {
    let called = false;
    const { deps, store } = createTestDeps({
      confirm: async () => {
        called = true;
        return false;
      },
    });
    seedProfile(deps, store, "work");

    await removeCommand(deps, "work", { yes: true });

    expect(called).toBe(false);
    expect(store.read(profileService("work"))).toBeNull();
  });

  it("errors if the profile does not exist", async () => {
    const { deps } = createTestDeps();
    await expect(removeCommand(deps, "ghost", {})).rejects.toThrow(
      CcauthError,
    );
  });

  it("rejects removing the reserved _autosave name", async () => {
    const { deps } = createTestDeps();
    await expect(removeCommand(deps, "_autosave", {})).rejects.toThrow(
      CcauthError,
    );
  });
});
