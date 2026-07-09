import { describe, it, expect } from "vitest";
import { readOauthAccount, writeOauthAccount } from "../src/claudeConfig.js";
import { CcauthError } from "../src/types.js";
import { createTestDeps, TEST_PATHS } from "./fakes/testDeps.js";

describe("claudeConfig", () => {
  it("reads the live oauthAccount", () => {
    const { deps, fs } = createTestDeps();
    fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({ oauthAccount: { email: "a@b.com" }, other: 1 }),
    );

    expect(readOauthAccount(deps)).toEqual({ email: "a@b.com" });
  });

  it("returns undefined when oauthAccount is absent", () => {
    const { deps, fs } = createTestDeps();
    fs.files.set(TEST_PATHS.claudeConfigPath, JSON.stringify({ other: 1 }));

    expect(readOauthAccount(deps)).toBeUndefined();
  });

  it("wholesale-replaces oauthAccount and preserves unrelated keys", () => {
    const { deps, fs } = createTestDeps();
    fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({
        oauthAccount: { email: "old@b.com", extraKey: "keep-shape" },
        unrelated: { nested: true },
      }),
    );

    writeOauthAccount(deps, { email: "new@b.com" });

    const written = JSON.parse(fs.files.get(TEST_PATHS.claudeConfigPath)!);
    expect(written.oauthAccount).toEqual({ email: "new@b.com" });
    expect(written.unrelated).toEqual({ nested: true });
  });

  it("removes the oauthAccount key entirely when swapping to undefined", () => {
    const { deps, fs } = createTestDeps();
    fs.files.set(
      TEST_PATHS.claudeConfigPath,
      JSON.stringify({ oauthAccount: { email: "old@b.com" }, unrelated: 1 }),
    );

    writeOauthAccount(deps, undefined);

    const written = JSON.parse(fs.files.get(TEST_PATHS.claudeConfigPath)!);
    expect("oauthAccount" in written).toBe(false);
    expect(written.unrelated).toBe(1);
  });

  it("takes a one-time backup before the first modification, and never again", () => {
    const { deps, fs } = createTestDeps();
    const original = JSON.stringify({ oauthAccount: { email: "a@b.com" } });
    fs.files.set(TEST_PATHS.claudeConfigPath, original);

    writeOauthAccount(deps, { email: "b@b.com" });
    expect(fs.files.get(TEST_PATHS.claudeConfigBackupPath)).toBe(original);

    writeOauthAccount(deps, { email: "c@b.com" });
    // Backup must still hold the ORIGINAL content, not the intermediate one.
    expect(fs.files.get(TEST_PATHS.claudeConfigBackupPath)).toBe(original);
  });

  it("preserves compact formatting (no reindent churn)", () => {
    const { deps, fs } = createTestDeps();
    // Claude Code writes ~/.claude.json compact (single line, no spaces).
    const compact = '{"oauthAccount":{"email":"old@b.com"},"projects":{"a":1}}';
    fs.files.set(TEST_PATHS.claudeConfigPath, compact);

    writeOauthAccount(deps, { email: "new@b.com" });

    const written = fs.files.get(TEST_PATHS.claudeConfigPath)!;
    // Still single-line compact, only the value changed -- no pretty-printing.
    expect(written).toBe(
      '{"oauthAccount":{"email":"new@b.com"},"projects":{"a":1}}',
    );
  });

  it("preserves 2-space indentation when the original was pretty-printed", () => {
    const { deps, fs } = createTestDeps();
    const pretty = JSON.stringify({ oauthAccount: { email: "old@b.com" } }, null, 2);
    fs.files.set(TEST_PATHS.claudeConfigPath, pretty);

    writeOauthAccount(deps, { email: "new@b.com" });

    const written = fs.files.get(TEST_PATHS.claudeConfigPath)!;
    expect(written).toContain('\n  "oauthAccount"');
  });

  it("refuses to write and points at the backup if the config is corrupt", () => {
    const { deps, fs } = createTestDeps();
    fs.files.set(TEST_PATHS.claudeConfigPath, "{ not json");

    expect(() => writeOauthAccount(deps, { email: "x@y.com" })).toThrow(
      CcauthError,
    );
    // Must not have written anything.
    expect(fs.files.get(TEST_PATHS.claudeConfigPath)).toBe("{ not json");
  });
});
