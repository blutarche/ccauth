import { describe, it, expect } from "vitest";
import { listCommand } from "../../src/commands/list.js";
import { writeIndex } from "../../src/profiles.js";
import { createTestDeps, TEST_PATHS } from "../fakes/testDeps.js";

describe("list command", () => {
  it("prints a message when there are no profiles", async () => {
    const { deps, stdoutLines } = createTestDeps();
    await listCommand(deps);
    expect(stdoutLines.some((l) => /No saved profiles/.test(l))).toBe(true);
  });

  it("marks the active profile by accountUuid match", async () => {
    const { deps, fs, stdoutLines } = createTestDeps();
    fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({ oauthAccount: { email: "me@work.com", accountUuid: "w-1" } }),
    );
    writeIndex(deps, {
      version: 1,
      profiles: {
        work: {
          email: "me@work.com",
          org: "Acme",
          accountUuid: "w-1",
          savedAt: "2026-07-10T11:00:00.000Z",
          oauthAccount: { email: "me@work.com", accountUuid: "w-1" },
        },
        personal: {
          email: "me@personal.com",
          org: undefined,
          accountUuid: "p-1",
          savedAt: "2026-07-10T10:00:00.000Z",
          oauthAccount: { email: "me@personal.com", accountUuid: "p-1" },
        },
      },
    });

    await listCommand(deps);

    const workLine = stdoutLines.find((l) => l.includes("work"));
    const personalLine = stdoutLines.find((l) => l.includes("personal"));
    expect(workLine).toMatch(/^\* /);
    expect(personalLine).toMatch(/^ {2}/);
    expect(workLine).toMatch(/1 hour ago/);
  });

  it("does not mark two same-account profiles active when only the org differs", async () => {
    // One Claude account keeps a single accountUuid across all its orgs, so
    // matching on accountUuid alone marked every profile for the same person
    // active at once. organizationUuid must disambiguate the workspace.
    const { deps, fs, stdoutLines } = createTestDeps();
    fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({
        oauthAccount: { accountUuid: "acc-1", organizationUuid: "org-B" },
      }),
    );
    writeIndex(deps, {
      version: 1,
      profiles: {
        orga: {
          email: "me@x.com",
          org: "OrgA",
          accountUuid: "acc-1",
          savedAt: "2026-07-10T11:00:00.000Z",
          oauthAccount: { accountUuid: "acc-1", organizationUuid: "org-A" },
        },
        orgb: {
          email: "me@x.com",
          org: "OrgB",
          accountUuid: "acc-1",
          savedAt: "2026-07-10T11:30:00.000Z",
          oauthAccount: { accountUuid: "acc-1", organizationUuid: "org-B" },
        },
      },
    });

    await listCommand(deps);

    expect(stdoutLines.find((l) => l.includes("orgb"))).toMatch(/^\* /);
    expect(stdoutLines.find((l) => l.includes("orga"))).toMatch(/^ {2}/);
  });

  it("hides _autosave from the default listing entirely", async () => {
    const { deps, fs, stdoutLines } = createTestDeps();
    fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({ oauthAccount: { email: "me@work.com", accountUuid: "w-1" } }),
    );
    writeIndex(deps, {
      version: 1,
      profiles: {
        work: {
          email: "me@work.com",
          org: "Acme",
          accountUuid: "w-1",
          savedAt: "2026-07-10T11:00:00.000Z",
          oauthAccount: { email: "me@work.com", accountUuid: "w-1" },
        },
        _autosave: {
          email: "me@personal.com",
          org: undefined,
          accountUuid: "p-1",
          savedAt: "2026-07-10T11:59:00.000Z",
          oauthAccount: { email: "me@personal.com", accountUuid: "p-1" },
        },
      },
    });

    await listCommand(deps);

    expect(stdoutLines.some((l) => l.includes("_autosave"))).toBe(false);
    expect(stdoutLines.some((l) => l.includes("work"))).toBe(true);
  });

  it("shows _autosave with --all", async () => {
    const { deps, fs, stdoutLines } = createTestDeps();
    fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({ oauthAccount: { email: "me@work.com", accountUuid: "w-1" } }),
    );
    writeIndex(deps, {
      version: 1,
      profiles: {
        _autosave: {
          email: "me@personal.com",
          org: undefined,
          accountUuid: "p-1",
          savedAt: "2026-07-10T11:59:00.000Z",
          oauthAccount: { email: "me@personal.com", accountUuid: "p-1" },
        },
      },
    });

    await listCommand(deps, { all: true });

    const autosaveLine = stdoutLines.find((l) => /_autosave/.test(l) && l.includes("@"));
    expect(autosaveLine).toBeDefined();
    // With --all it's a real data row, not the parenthetical hint.
    expect(stdoutLines.some((l) => /hidden/.test(l))).toBe(false);
  });

  it("renders every EXPIRES state", async () => {
    // now = 2026-07-10T12:00:00.000Z (see createTestDeps)
    const { deps, fs, stdoutLines } = createTestDeps();
    fs.files.set(TEST_PATHS.claudeConfigPath, "{}");
    writeIndex(deps, {
      version: 1,
      profiles: {
        unknown: {
          email: "unknown@x.com",
          org: undefined,
          accountUuid: "u-1",
          savedAt: "2026-07-10T11:00:00.000Z",
          oauthAccount: { accountUuid: "u-1" },
        },
        expired: {
          email: "expired@x.com",
          org: undefined,
          accountUuid: "e-1",
          savedAt: "2026-07-10T11:00:00.000Z",
          refreshTokenExpiresAt: new Date("2026-07-01T12:00:00.000Z").getTime(),
          oauthAccount: { accountUuid: "e-1" },
        },
        dying: {
          email: "dying@x.com",
          org: undefined,
          accountUuid: "d-1",
          savedAt: "2026-07-10T11:00:00.000Z",
          refreshTokenExpiresAt: new Date("2026-07-12T12:00:00.000Z").getTime(),
          oauthAccount: { accountUuid: "d-1" },
        },
        healthy: {
          email: "healthy@x.com",
          org: undefined,
          accountUuid: "h-1",
          savedAt: "2026-07-10T11:00:00.000Z",
          refreshTokenExpiresAt: new Date("2026-08-05T12:00:00.000Z").getTime(),
          oauthAccount: { accountUuid: "h-1" },
        },
      },
    });

    await listCommand(deps);

    expect(stdoutLines[0]).toMatch(/EXPIRES$/);
    expect(stdoutLines.find((l) => l.includes("unknown@x.com"))).toMatch(/ -$/);
    expect(stdoutLines.find((l) => l.includes("expired@x.com"))).toMatch(/expired$/);
    expect(stdoutLines.find((l) => l.includes("dying@x.com"))).toMatch(/in 2 days ⚠$/);
    expect(stdoutLines.find((l) => l.includes("healthy@x.com"))).toMatch(/in 26 days$/);
  });
});
