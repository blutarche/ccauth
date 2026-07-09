import { describe, it, expect } from "vitest";
import { renameCommand } from "../../src/commands/rename.js";
import { readIndex, writeIndex } from "../../src/profiles.js";
import { CcauthError, profileService } from "../../src/types.js";
import { createTestDeps } from "../fakes/testDeps.js";

function seedProfile(
  deps: ReturnType<typeof createTestDeps>["deps"],
  store: ReturnType<typeof createTestDeps>["store"],
  name: string,
  blob: object,
) {
  store.write(profileService(name), JSON.stringify(blob));
  const index = readIndex(deps);
  index.profiles[name] = {
    email: `${name}@example.com`,
    org: undefined,
    accountUuid: `${name}-uuid`,
    savedAt: "2026-07-10T00:00:00.000Z",
    oauthAccount: { email: `${name}@example.com`, accountUuid: `${name}-uuid` },
  };
  writeIndex(deps, index);
}

describe("rename command", () => {
  it("renames the keychain item and the index entry", async () => {
    const { deps, store } = createTestDeps();
    seedProfile(deps, store, "old", { claudeAiOauth: { accessToken: "x" } });

    await renameCommand(deps, "old", "new");

    expect(store.read(profileService("old"))).toBeNull();
    expect(store.read(profileService("new"))).toBe(
      JSON.stringify({ claudeAiOauth: { accessToken: "x" } }),
    );
    const index = readIndex(deps);
    expect(index.profiles["old"]).toBeUndefined();
    expect(index.profiles["new"]).toMatchObject({ email: "old@example.com" });
  });

  it("errors if the old profile does not exist", async () => {
    const { deps } = createTestDeps();
    await expect(renameCommand(deps, "ghost", "new")).rejects.toThrow(
      CcauthError,
    );
  });

  it("errors if the new name already exists", async () => {
    const { deps, store } = createTestDeps();
    seedProfile(deps, store, "old", { claudeAiOauth: {} });
    seedProfile(deps, store, "taken", { claudeAiOauth: {} });

    await expect(renameCommand(deps, "old", "taken")).rejects.toThrow(
      CcauthError,
    );
  });

  it("rejects invalid new names", async () => {
    const { deps, store } = createTestDeps();
    seedProfile(deps, store, "old", { claudeAiOauth: {} });

    await expect(renameCommand(deps, "old", "bad:name")).rejects.toThrow(
      CcauthError,
    );
  });
});
