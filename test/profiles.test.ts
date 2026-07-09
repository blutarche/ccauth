import { describe, it, expect } from "vitest";
import { readIndex, writeIndex } from "../src/profiles.js";
import { CcauthError } from "../src/types.js";
import { createTestDeps, TEST_PATHS } from "./fakes/testDeps.js";

describe("profiles index", () => {
  it("returns an empty index when the file does not exist", () => {
    const { deps } = createTestDeps();
    expect(readIndex(deps)).toEqual({ version: 1, profiles: {} });
  });

  it("round-trips through writeIndex/readIndex", () => {
    const { deps } = createTestDeps();
    writeIndex(deps, {
      version: 1,
      profiles: {
        work: {
          email: "me@work.com",
          org: "Acme",
          accountUuid: "uuid-1",
          savedAt: "2026-07-10T00:00:00.000Z",
          oauthAccount: { email: "me@work.com" },
        },
      },
    });

    expect(readIndex(deps)).toEqual({
      version: 1,
      profiles: {
        work: {
          email: "me@work.com",
          org: "Acme",
          accountUuid: "uuid-1",
          savedAt: "2026-07-10T00:00:00.000Z",
          oauthAccount: { email: "me@work.com" },
        },
      },
    });
  });

  it("throws a CcauthError on a corrupt index file", () => {
    const { deps, fs } = createTestDeps();
    fs.files.set(TEST_PATHS.profilesIndexPath, "{ nope");
    expect(() => readIndex(deps)).toThrow(CcauthError);
  });
});
