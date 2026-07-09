import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { CredentialStore } from "./types.js";
import { CcauthError } from "./types.js";

// Claude Code does not append a suffix in production installs.
const OAUTH_FILE_SUFFIX = "";

// Absolute path: a `security` planted earlier in $PATH must never intercept
// credential traffic.
const SECURITY = "/usr/bin/security";

// `security` exits 44 (errSecItemNotFound) when no matching item exists --
// the only failure that legitimately means "absent" rather than "broken"
// (locked keychain, denied ACL, ...), which must fail loud instead.
const EXIT_NOT_FOUND = 44;

const ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;
const FALLBACK_ACCOUNT = "claude-code-user";

/**
 * Replicates Claude Code's own live keychain service-name computation, so
 * ccauth finds the right item even when the user has a custom config dir
 * (verified against the real `claude` binary, v2.1.205):
 *
 *   service = "Claude Code" + OAUTH_FILE_SUFFIX + "-credentials" + configSuffix
 *
 * `configSuffix` is empty unless `CLAUDE_SECURESTORAGE_CONFIG_DIR` or
 * `CLAUDE_CONFIG_DIR` is set, in which case it's `-` + the first 8 hex chars
 * of the sha256 of that directory (NFC-normalized for
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR`, path-resolved for `CLAUDE_CONFIG_DIR`).
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` takes precedence over `CLAUDE_CONFIG_DIR`.
 */
export function computeLiveServiceName(
  env: NodeJS.ProcessEnv = process.env,
): string {
  let configSuffix = "";

  if (env.CLAUDE_SECURESTORAGE_CONFIG_DIR) {
    configSuffix = `-${sha256Hex8(env.CLAUDE_SECURESTORAGE_CONFIG_DIR.normalize("NFC"))}`;
  } else if (env.CLAUDE_CONFIG_DIR) {
    configSuffix = `-${sha256Hex8(path.resolve(env.CLAUDE_CONFIG_DIR))}`;
  }

  return `Claude Code${OAUTH_FILE_SUFFIX}-credentials${configSuffix}`;
}

function sha256Hex8(value: string): string {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex")
    .substring(0, 8);
}

/**
 * Resolves the keychain account: `$USER`, falling back to
 * `os.userInfo().username`, falling back to a fixed placeholder if neither
 * is usable or doesn't look like a safe account name.
 */
export function resolveAccount(env: NodeJS.ProcessEnv = process.env): string {
  let candidate: string | undefined = env.USER;
  if (!candidate) {
    try {
      candidate = os.userInfo().username;
    } catch {
      candidate = undefined;
    }
  }
  if (candidate && ACCOUNT_PATTERN.test(candidate)) {
    return candidate;
  }
  return FALLBACK_ACCOUNT;
}

/**
 * Real macOS keychain-backed CredentialStore, shelling out to the `security`
 * CLI. Writes use `-X <hex>` (hex-encoded UTF-8 JSON), matching exactly how
 * Claude Code itself writes the live credential item (byte-safe, avoids
 * `-w`'s shell-quoting pitfalls for arbitrary JSON). Reads use `-w`, which
 * round-trips correctly against items written via `-X`.
 *
 * Known trade-off (documented, not worked around per spec): the secret is
 * still passed as an argv entry (hex-encoded), so it is briefly visible to
 * `ps`/equivalents for the same local user.
 */
export class KeychainCredentialStore implements CredentialStore {
  private readonly account: string;
  private readonly exec: typeof execFileSync;

  constructor(
    account: string = resolveAccount(),
    exec: typeof execFileSync = execFileSync,
  ) {
    this.account = account;
    this.exec = exec;
  }

  read(service: string): string | null {
    try {
      const out = this.exec(
        SECURITY,
        ["find-generic-password", "-a", this.account, "-w", "-s", service],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ) as string;
      return out.replace(/\n$/, "");
    } catch (err) {
      if (exitStatus(err) === EXIT_NOT_FOUND) return null;
      throw keychainError("read", service, err);
    }
  }

  write(service: string, secret: string): void {
    const hex = Buffer.from(secret, "utf-8").toString("hex");
    try {
      this.exec(
        SECURITY,
        ["add-generic-password", "-U", "-a", this.account, "-s", service, "-X", hex],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (err) {
      // Never rethrow the raw error: execFileSync embeds the full argv --
      // including the hex-encoded secret -- in its message, and the CLI
      // prints non-CcauthError messages verbatim.
      throw keychainError("write", service, err);
    }
  }

  delete(service: string): void {
    try {
      this.exec(
        SECURITY,
        ["delete-generic-password", "-s", service, "-a", this.account],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (err) {
      // Absent item: no-op, matches CredentialStore contract.
      if (exitStatus(err) === EXIT_NOT_FOUND) return;
      throw keychainError("delete", service, err);
    }
  }
}

function exitStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Wraps a failed `security` invocation in a CcauthError carrying only
 * `security`'s own stderr (which never contains the secret) -- the raw
 * exec error must not escape (see write()).
 */
function keychainError(
  op: "read" | "write" | "delete",
  service: string,
  err: unknown,
): CcauthError {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  const detail =
    typeof stderr === "string"
      ? stderr.trim()
      : Buffer.isBuffer(stderr)
        ? stderr.toString("utf8").trim()
        : "";
  return new CcauthError(
    `Keychain ${op} failed for "${service}"${detail ? `: ${detail}` : ""} ` +
      `(exit ${exitStatus(err) ?? "?"}). Is the keychain locked?`,
  );
}
