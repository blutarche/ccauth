import { describe, it, expect } from "vitest";
import { listCommand } from "../../src/commands/list.js";
import { writeIndex } from "../../src/profiles.js";
import { createTestDeps, TEST_PATHS } from "../fakes/testDeps.js";
import { profileService, LIVE_SERVICE } from "../../src/types.js";

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

describe("list --usage", () => {
  // createTestDeps clock: 2026-07-10T12:00:00.000Z
  const FUTURE = Date.parse("2026-07-10T20:00:00.000Z");
  const PAST = Date.parse("2026-07-10T08:00:00.000Z");

  const blob = (accessToken: string, expiresAt: number): string =>
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: "rt", expiresAt } });

  const entry = (email: string, uuid: string) => ({
    email,
    org: undefined,
    accountUuid: uuid,
    savedAt: "2026-07-10T11:00:00.000Z",
    oauthAccount: { accountUuid: uuid, organizationUuid: `org-${uuid}` },
  });

  it("renders remaining percent and reset horizon for fresh tokens", async () => {
    const { deps, fs, store, fetchUsage, stdoutLines } = createTestDeps();
    fs.files.set(TEST_PATHS.claudeConfigPath, "{}");
    writeIndex(deps, { version: 1, profiles: { work: entry("w@x.com", "w-1") } });
    store.write(profileService("work"), blob("tok-w", FUTURE));
    fetchUsage.responses.set("tok-w", {
      kind: "ok",
      fiveHour: { utilization: 22, resetsAt: Date.parse("2026-07-10T14:00:00.000Z") },
      sevenDay: { utilization: 59, resetsAt: Date.parse("2026-07-14T12:00:00.000Z") },
    });

    await listCommand(deps, { usage: true });

    expect(stdoutLines[0]).toMatch(/EXPIRES\s+5H\s+WEEK$/);
    const line = stdoutLines.find((l) => l.includes("work"));
    expect(line).toMatch(/78% \(2h\)/);
    expect(line).toMatch(/41% \(4d\)$/);
  });

  it("keeps plain list identical: no usage columns, no fetches", async () => {
    const { deps, fs, store, fetchUsage, stdoutLines } = createTestDeps();
    fs.files.set(TEST_PATHS.claudeConfigPath, "{}");
    writeIndex(deps, { version: 1, profiles: { work: entry("w@x.com", "w-1") } });
    store.write(profileService("work"), blob("tok-w", FUTURE));

    await listCommand(deps);

    expect(stdoutLines[0]).toMatch(/EXPIRES$/);
    expect(fetchUsage.calls).toEqual([]);
  });

  it("renders stale without calling the API when the stored token is expired", async () => {
    const { deps, fs, store, fetchUsage, stdoutLines } = createTestDeps();
    fs.files.set(TEST_PATHS.claudeConfigPath, "{}");
    writeIndex(deps, { version: 1, profiles: { work: entry("w@x.com", "w-1") } });
    store.write(profileService("work"), blob("tok-w", PAST));

    await listCommand(deps, { usage: true });

    expect(fetchUsage.calls).toEqual([]);
    expect(stdoutLines.find((l) => l.includes("work"))).toMatch(/stale\s+stale$/);
    expect(stdoutLines.at(-1)).toBe(
      "stale: run `ccauth refresh` to update usage-readout tokens",
    );
  });

  it("falls back to the live token for the active profile", async () => {
    const { deps, fs, store, fetchUsage, stdoutLines } = createTestDeps();
    fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({
        oauthAccount: { accountUuid: "w-1", organizationUuid: "org-w-1" },
      }),
    );
    writeIndex(deps, { version: 1, profiles: { work: entry("w@x.com", "w-1") } });
    store.write(profileService("work"), blob("tok-stale", PAST));
    store.write(LIVE_SERVICE, blob("tok-live", FUTURE));
    fetchUsage.responses.set("tok-live", {
      kind: "ok",
      fiveHour: { utilization: 50, resetsAt: undefined },
      sevenDay: undefined,
    });

    await listCommand(deps, { usage: true });

    expect(fetchUsage.calls).toEqual(["tok-live"]);
    expect(stdoutLines.find((l) => l.includes("work"))).toMatch(/50%\s+-$/);
  });

  it("renders stale when both stored and live tokens are expired for the active profile", async () => {
    const { deps, fs, store, fetchUsage, stdoutLines } = createTestDeps();
    fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({
        oauthAccount: { accountUuid: "w-1", organizationUuid: "org-w-1" },
      }),
    );
    writeIndex(deps, { version: 1, profiles: { work: entry("w@x.com", "w-1") } });
    store.write(profileService("work"), blob("tok-stale", PAST));
    store.write(LIVE_SERVICE, blob("tok-live", PAST));

    await listCommand(deps, { usage: true });

    expect(fetchUsage.calls).toEqual([]);
    expect(stdoutLines.find((l) => l.includes("work"))).toMatch(/stale\s+stale$/);
  });

  it("renders stale when the API rejects the token as unauthorized", async () => {
    const { deps, fs, store, fetchUsage, stdoutLines } = createTestDeps();
    fs.files.set(TEST_PATHS.claudeConfigPath, "{}");
    writeIndex(deps, { version: 1, profiles: { work: entry("w@x.com", "w-1") } });
    store.write(profileService("work"), blob("tok-w", FUTURE));
    fetchUsage.responses.set("tok-w", { kind: "auth" });

    await listCommand(deps, { usage: true });

    expect(fetchUsage.calls).toEqual(["tok-w"]);
    expect(stdoutLines.find((l) => l.includes("work"))).toMatch(/stale\s+stale$/);
    expect(stdoutLines.at(-1)).toBe(
      "stale: run `ccauth refresh` to update usage-readout tokens",
    );
  });

  it("renders limited on 429 and error on failures, without the stale footer", async () => {
    const { deps, fs, store, fetchUsage, stdoutLines } = createTestDeps();
    fs.files.set(TEST_PATHS.claudeConfigPath, "{}");
    writeIndex(deps, {
      version: 1,
      profiles: { a: entry("a@x.com", "a-1"), b: entry("b@x.com", "b-1") },
    });
    store.write(profileService("a"), blob("tok-a", FUTURE));
    store.write(profileService("b"), blob("tok-b", FUTURE));
    fetchUsage.responses.set("tok-a", { kind: "limited" });
    fetchUsage.responses.set("tok-b", { kind: "error" });

    await listCommand(deps, { usage: true });

    expect(stdoutLines.find((l) => l.includes("a@x.com"))).toMatch(/limited\s+limited$/);
    expect(stdoutLines.find((l) => l.includes("b@x.com"))).toMatch(/error\s+error$/);
    expect(stdoutLines.some((l) => l.startsWith("stale:"))).toBe(false);
  });

  it("renders - for a missing keychain blob", async () => {
    const { deps, fs, fetchUsage, stdoutLines } = createTestDeps();
    fs.files.set(TEST_PATHS.claudeConfigPath, "{}");
    writeIndex(deps, { version: 1, profiles: { work: entry("w@x.com", "w-1") } });

    await listCommand(deps, { usage: true });

    expect(fetchUsage.calls).toEqual([]);
    expect(stdoutLines.find((l) => l.includes("work"))).toMatch(/-\s+-$/);
  });

  it("renders - for a blob that is not a Claude login", async () => {
    const { deps, fs, store, fetchUsage, stdoutLines } = createTestDeps();
    fs.files.set(TEST_PATHS.claudeConfigPath, "{}");
    writeIndex(deps, { version: 1, profiles: { work: entry("w@x.com", "w-1") } });
    store.write(profileService("work"), "not json at all");

    await listCommand(deps, { usage: true });

    expect(fetchUsage.calls).toEqual([]);
    expect(stdoutLines.find((l) => l.includes("work"))).toMatch(/-\s+-$/);
    expect(stdoutLines.some((l) => l.startsWith("stale:"))).toBe(false);
  });

  it("renders stale for a valid blob whose access token is unusable", async () => {
    // Seen in the wild: Claude Code stores accessToken "" with expiresAt 0.
    const { deps, fs, store, fetchUsage, stdoutLines } = createTestDeps();
    fs.files.set(TEST_PATHS.claudeConfigPath, "{}");
    writeIndex(deps, { version: 1, profiles: { work: entry("w@x.com", "w-1") } });
    store.write(
      profileService("work"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "", refreshToken: "rt", expiresAt: 0 },
      }),
    );

    await listCommand(deps, { usage: true });

    expect(fetchUsage.calls).toEqual([]);
    expect(stdoutLines.find((l) => l.includes("work"))).toMatch(/stale\s+stale$/);
    expect(stdoutLines.at(-1)).toBe(
      "stale: run `ccauth refresh` to update usage-readout tokens",
    );
  });

  it("clamps utilization above 100 to 0% remaining", async () => {
    const { deps, fs, store, fetchUsage, stdoutLines } = createTestDeps();
    fs.files.set(TEST_PATHS.claudeConfigPath, "{}");
    writeIndex(deps, { version: 1, profiles: { work: entry("w@x.com", "w-1") } });
    store.write(profileService("work"), blob("tok-w", FUTURE));
    fetchUsage.responses.set("tok-w", {
      kind: "ok",
      fiveHour: { utilization: 130, resetsAt: undefined },
      sevenDay: { utilization: 0, resetsAt: undefined },
    });

    await listCommand(deps, { usage: true });

    expect(stdoutLines.find((l) => l.includes("work"))).toMatch(/0%\s+100%$/);
  });
});
