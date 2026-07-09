/**
 * Core seams for dependency injection. Every command depends only on these
 * interfaces, never directly on `node:child_process`/`node:fs`/etc, so unit
 * tests can swap in in-memory fakes and never touch the real keychain or the
 * real `~/.claude.json`.
 */

/** Reads/writes/deletes macOS keychain generic-password items. */
export interface CredentialStore {
  /** Returns the stored secret, or null if no item exists for `service`. */
  read(service: string): string | null;
  /** Creates or updates (in place) the item for `service`. */
  write(service: string, secret: string): void;
  /** Deletes the item for `service`. No-op (does not throw) if absent. */
  delete(service: string): void;
}

/** Minimal filesystem seam used by claudeConfig.ts and profiles.ts. */
export interface FileSystem {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string): void;
  renameSync(oldPath: string, newPath: string): void;
  mkdirSync(path: string): void;
  copyFileSync(src: string, dest: string): void;
}

/** Filesystem locations ccauth reads/writes. */
export interface Paths {
  /** `~/.claude.json` */
  claudeConfigPath: string;
  /** `~/.claude/ccauth` */
  ccauthDir: string;
  /** `~/.claude/ccauth/profiles.json` */
  profilesIndexPath: string;
  /** `~/.claude/ccauth/claude.json.bak` */
  claudeConfigBackupPath: string;
}

/** Raw identity metadata as it appears in `oauthAccount`. Opaque on purpose. */
export type OauthAccount = Record<string, unknown>;

export interface ProfileEntry {
  email: string | undefined;
  org: string | undefined;
  accountUuid: string | undefined;
  savedAt: string;
  /**
   * The full, opaque `oauthAccount` object as it existed at save time.
   * `email`/`org`/`accountUuid` above are a display-friendly cache derived
   * from this (see docs/plans/2026-07-10-ccauth-design.md open item #1) --
   * this field is what actually gets restored into `~/.claude.json` on
   * `ccauth use`, so no identity keys are ever lost.
   */
  oauthAccount: OauthAccount | undefined;
}

export interface ProfilesIndex {
  version: 1;
  profiles: Record<string, ProfileEntry>;
}

export interface Deps {
  store: CredentialStore;
  fs: FileSystem;
  paths: Paths;
  /**
   * The keychain service name for the LIVE Claude Code credential item.
   * Normally `"Claude Code-credentials"`, but Claude Code appends a hash
   * suffix when `CLAUDE_CONFIG_DIR`/`CLAUDE_SECURESTORAGE_CONFIG_DIR` is set
   * (see `keychain.ts#computeLiveServiceName`) -- this is computed once when
   * building the real Deps so commands never hardcode the service name.
   */
  liveService: string;
  /** Prompts y/N; resolves true for yes. */
  confirm: (question: string) => Promise<boolean>;
  /** True if a `claude` process currently appears to be running. */
  isClaudeRunning: () => boolean;
  /** Clock seam, defaults to `() => new Date()`. */
  now: () => Date;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** User-facing error: message is printed as-is, no stack trace. */
export class CcauthError extends Error {}

/**
 * Default live-credential service name (no `CLAUDE_CONFIG_DIR`/
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` set). Used as the default `liveService`
 * in tests; the real CLI computes the actual value via
 * `keychain.ts#computeLiveServiceName` since it can vary per-environment.
 */
export const LIVE_SERVICE = "Claude Code-credentials";
export const AUTOSAVE_NAME = "_autosave";

export function profileService(name: string): string {
  return `ccauth:${name}`;
}
