import { describe, it, expect } from "vitest";
import { resolveClaudeCodeVersion } from "../src/claudeVersion.js";
import { createTestDeps, TEST_PATHS } from "./fakes/testDeps.js";

describe("resolveClaudeCodeVersion", () => {
  // createTestDeps clock: 2026-07-10T12:00:00.000Z
  const NOW = Date.parse("2026-07-10T12:00:00.000Z");

  const harness = () => {
    const h = createTestDeps();
    h.runClaude.handler = () => ({
      code: 0,
      stdout: "2.1.207 (Claude Code)\n",
      stderr: "",
      timedOut: false,
    });
    return h;
  };

  it("detects via `claude --version` and snapshots the result", () => {
    const { deps, fs, runClaude } = harness();

    expect(resolveClaudeCodeVersion(deps)).toBe("2.1.207");

    expect(runClaude.calls).toEqual([
      { args: ["--version"], opts: { timeoutMs: 10_000 } },
    ]);
    expect(
      JSON.parse(fs.files.get(TEST_PATHS.claudeVersionCachePath)!),
    ).toEqual({ version: "2.1.207", fetchedAt: NOW });
  });

  it("uses a fresh cache without spawning", () => {
    const { deps, fs, runClaude } = harness();
    fs.files.set(
      TEST_PATHS.claudeVersionCachePath,
      JSON.stringify({ version: "9.9.9", fetchedAt: NOW - 3600_000 }),
    );

    expect(resolveClaudeCodeVersion(deps)).toBe("9.9.9");
    expect(runClaude.calls).toEqual([]);
  });

  it("re-detects when the cache is older than a day", () => {
    const { deps, fs, runClaude } = harness();
    fs.files.set(
      TEST_PATHS.claudeVersionCachePath,
      JSON.stringify({ version: "9.9.9", fetchedAt: NOW - 25 * 3600_000 }),
    );

    expect(resolveClaudeCodeVersion(deps)).toBe("2.1.207");
    expect(runClaude.calls).toHaveLength(1);
    expect(
      JSON.parse(fs.files.get(TEST_PATHS.claudeVersionCachePath)!),
    ).toEqual({ version: "2.1.207", fetchedAt: NOW });
  });

  it("re-detects when the cache file is corrupt", () => {
    const { deps, fs } = harness();
    fs.files.set(TEST_PATHS.claudeVersionCachePath, "not json");

    expect(resolveClaudeCodeVersion(deps)).toBe("2.1.207");
  });

  it("falls back without caching when the spawn fails", () => {
    const { deps, fs, runClaude } = harness();
    runClaude.handler = () => ({
      code: 1,
      stdout: "",
      stderr: "boom",
      timedOut: false,
    });

    expect(resolveClaudeCodeVersion(deps)).toBe("2.1.0");
    expect(runClaude.calls).toHaveLength(1);
    expect(fs.files.has(TEST_PATHS.claudeVersionCachePath)).toBe(false);
  });

  it("falls back without caching on unparseable version output", () => {
    const { deps, fs, runClaude } = harness();
    runClaude.handler = () => ({
      code: 0,
      stdout: "command not found: claude",
      stderr: "",
      timedOut: false,
    });

    expect(resolveClaudeCodeVersion(deps)).toBe("2.1.0");
    expect(fs.files.has(TEST_PATHS.claudeVersionCachePath)).toBe(false);
  });
});
