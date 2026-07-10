import type { Deps, Paths } from "../../src/types.js";
import { LIVE_SERVICE } from "../../src/types.js";
import { FakeCredentialStore } from "./fakeCredentialStore.js";
import { FakeFileSystem } from "./fakeFs.js";
import { FakeRunClaude } from "./fakeRunClaude.js";

export const TEST_PATHS: Paths = {
  claudeConfigPath: "/home/tester/.claude.json",
  ccauthDir: "/home/tester/.claude/ccauth",
  profilesIndexPath: "/home/tester/.claude/ccauth/profiles.json",
  claudeConfigBackupPath: "/home/tester/.claude/ccauth/claude.json.bak",
};

export interface TestHarness {
  deps: Deps;
  store: FakeCredentialStore;
  fs: FakeFileSystem;
  runClaude: FakeRunClaude;
  stdoutLines: string[];
  stderrLines: string[];
}

export function createTestDeps(
  overrides: Partial<Deps> = {},
): TestHarness {
  const store = new FakeCredentialStore();
  const fs = new FakeFileSystem();
  const runClaude = new FakeRunClaude();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  const deps: Deps = {
    store,
    fs,
    paths: TEST_PATHS,
    liveService: LIVE_SERVICE,
    confirm: async () => true,
    isClaudeRunning: () => false,
    runClaude: runClaude.run,
    now: () => new Date("2026-07-10T12:00:00.000Z"),
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line),
    ...overrides,
  };

  return { deps, store, fs, runClaude, stdoutLines, stderrLines };
}
