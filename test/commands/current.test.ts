import { describe, it, expect } from "vitest";
import { currentCommand } from "../../src/commands/current.js";
import { writeIndex } from "../../src/profiles.js";
import { createTestDeps, TEST_PATHS } from "../fakes/testDeps.js";

describe("current command", () => {
  it("reports no active identity when oauthAccount is absent", async () => {
    const { deps, fs, stdoutLines } = createTestDeps();
    fs.files.set(TEST_PATHS.claudeConfigPath, "{}");

    await currentCommand(deps);

    expect(stdoutLines.some((l) => /No active Claude Code identity/.test(l))).toBe(
      true,
    );
  });

  it("prints email/org and the matching profile name by accountUuid", async () => {
    const { deps, fs, stdoutLines } = createTestDeps();
    fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({
        oauthAccount: {
          emailAddress: "me@work.com",
          organizationName: "Acme",
          accountUuid: "w-1",
        },
      }),
    );
    writeIndex(deps, {
      version: 1,
      profiles: {
        work: {
          email: "me@work.com",
          org: "Acme",
          accountUuid: "w-1",
          savedAt: "2026-07-10T00:00:00.000Z",
          oauthAccount: { email: "me@work.com", accountUuid: "w-1" },
        },
      },
    });

    await currentCommand(deps);

    expect(stdoutLines).toContain("Email: me@work.com");
    expect(stdoutLines).toContain("Org:   Acme");
    expect(stdoutLines.some((l) => /Matches saved profile: "work"/.test(l))).toBe(
      true,
    );
  });

  it("prints the refresh token expiry line when the matched entry has one cached", async () => {
    // now = 2026-07-10T12:00:00.000Z (see createTestDeps)
    const { deps, fs, stdoutLines } = createTestDeps();
    fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({
        oauthAccount: { email: "me@work.com", accountUuid: "w-1" },
      }),
    );
    writeIndex(deps, {
      version: 1,
      profiles: {
        work: {
          email: "me@work.com",
          org: "Acme",
          accountUuid: "w-1",
          savedAt: "2026-07-10T00:00:00.000Z",
          refreshTokenExpiresAt: new Date("2026-08-05T12:00:00.000Z").getTime(),
          oauthAccount: { email: "me@work.com", accountUuid: "w-1" },
        },
      },
    });

    await currentCommand(deps);

    expect(stdoutLines).toContain("Refresh token: in 26 days");
  });

  it("prints 'expired' for a matched entry whose refresh token is past its cached expiry", async () => {
    const { deps, fs, stdoutLines } = createTestDeps();
    fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({
        oauthAccount: { email: "me@work.com", accountUuid: "w-1" },
      }),
    );
    writeIndex(deps, {
      version: 1,
      profiles: {
        work: {
          email: "me@work.com",
          org: "Acme",
          accountUuid: "w-1",
          savedAt: "2026-07-10T00:00:00.000Z",
          refreshTokenExpiresAt: new Date("2026-07-01T12:00:00.000Z").getTime(),
          oauthAccount: { email: "me@work.com", accountUuid: "w-1" },
        },
      },
    });

    await currentCommand(deps);

    expect(stdoutLines).toContain("Refresh token: expired");
  });

  it("omits the refresh token line when the matched entry has no cached expiry", async () => {
    const { deps, fs, stdoutLines } = createTestDeps();
    fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({
        oauthAccount: { email: "me@work.com", accountUuid: "w-1" },
      }),
    );
    writeIndex(deps, {
      version: 1,
      profiles: {
        work: {
          email: "me@work.com",
          org: "Acme",
          accountUuid: "w-1",
          savedAt: "2026-07-10T00:00:00.000Z",
          oauthAccount: { email: "me@work.com", accountUuid: "w-1" },
        },
      },
    });

    await currentCommand(deps);

    expect(stdoutLines.some((l) => l.startsWith("Refresh token:"))).toBe(false);
  });

  it("reports no match when accountUuid does not correspond to any profile", async () => {
    const { deps, fs, stdoutLines } = createTestDeps();
    fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({ oauthAccount: { email: "me@other.com", accountUuid: "z-9" } }),
    );

    await currentCommand(deps);

    expect(stdoutLines.some((l) => /Does not match any saved profile/.test(l))).toBe(
      true,
    );
  });
});
