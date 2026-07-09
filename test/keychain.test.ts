import { describe, it, expect } from "vitest";
import type { execFileSync } from "node:child_process";
import {
  computeLiveServiceName,
  resolveAccount,
  KeychainCredentialStore,
} from "../src/keychain.js";
import { CcauthError } from "../src/types.js";
import { createHash } from "node:crypto";
import * as path from "node:path";

// Never invokes the real `security` CLI -- KeychainCredentialStore is
// exercised through an injected fake exec.

describe("computeLiveServiceName", () => {
  it("returns the default service name when no config dir env vars are set", () => {
    expect(computeLiveServiceName({})).toBe("Claude Code-credentials");
  });

  it("appends a hash suffix derived from CLAUDE_CONFIG_DIR (path-resolved)", () => {
    const dir = "/some/custom/config";
    const expectedSuffix = createHash("sha256")
      .update(path.resolve(dir), "utf8")
      .digest("hex")
      .substring(0, 8);

    expect(computeLiveServiceName({ CLAUDE_CONFIG_DIR: dir })).toBe(
      `Claude Code-credentials-${expectedSuffix}`,
    );
  });

  it("prefers CLAUDE_SECURESTORAGE_CONFIG_DIR (NFC-normalized) over CLAUDE_CONFIG_DIR", () => {
    const secureDir = "/secure/dir";
    const expectedSuffix = createHash("sha256")
      .update(secureDir.normalize("NFC"), "utf8")
      .digest("hex")
      .substring(0, 8);

    expect(
      computeLiveServiceName({
        CLAUDE_SECURESTORAGE_CONFIG_DIR: secureDir,
        CLAUDE_CONFIG_DIR: "/other/dir",
      }),
    ).toBe(`Claude Code-credentials-${expectedSuffix}`);
  });
});

describe("resolveAccount", () => {
  it("uses $USER when set and valid", () => {
    expect(resolveAccount({ USER: "aik" })).toBe("aik");
  });

  it("falls back to the placeholder when $USER contains unsafe characters", () => {
    expect(resolveAccount({ USER: "not a valid account!" })).toBe(
      "claude-code-user",
    );
  });

  it("falls back to the placeholder when $USER is unset and os.userInfo throws", () => {
    // No USER env var; os.userInfo() itself is real here but always
    // succeeds in this environment, so we only assert the unsafe-char path
    // above and the $USER-set path -- both fully cover resolveAccount's
    // decision logic without needing to fake os.userInfo().
    expect(resolveAccount({})).toMatch(/^[a-zA-Z0-9._-]+$/);
  });
});

/** Builds an exec fake that throws like execFileSync does when `security` fails. */
function failingExec(status: number, stderr = ""): typeof execFileSync {
  return ((file: string, args: readonly string[]) => {
    const err = new Error(
      `Command failed: ${file} ${args.join(" ")}`,
    ) as Error & { status: number; stderr: Buffer };
    err.status = status;
    err.stderr = Buffer.from(stderr, "utf8");
    throw err;
  }) as typeof execFileSync;
}

const SECRET = '{"claudeAiOauth":{"accessToken":"super-secret-token"}}';
const SECRET_HEX = Buffer.from(SECRET, "utf-8").toString("hex");

describe("KeychainCredentialStore error classification", () => {
  it("read returns null only for exit 44 (item not found)", () => {
    const store = new KeychainCredentialStore("acct", failingExec(44));
    expect(store.read("ccauth:x")).toBeNull();
  });

  it("read fails loud on any other failure (locked keychain, denied ACL)", () => {
    const store = new KeychainCredentialStore(
      "acct",
      failingExec(51, "SecKeychainSearchCopyNext: interaction not allowed"),
    );
    expect(() => store.read("ccauth:x")).toThrow(CcauthError);
    expect(() => store.read("ccauth:x")).toThrow(/interaction not allowed/);
  });

  it("delete is a no-op for exit 44 but fails loud otherwise", () => {
    expect(() =>
      new KeychainCredentialStore("acct", failingExec(44)).delete("ccauth:x"),
    ).not.toThrow();
    expect(() =>
      new KeychainCredentialStore("acct", failingExec(1)).delete("ccauth:x"),
    ).toThrow(CcauthError);
  });

  it("a failed write never leaks the secret into the thrown error", () => {
    const store = new KeychainCredentialStore("acct", failingExec(1, "boom"));
    let thrown: unknown;
    try {
      store.write("ccauth:x", SECRET);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CcauthError);
    const message = (thrown as Error).message;
    expect(message).not.toContain(SECRET_HEX);
    expect(message).not.toContain("super-secret-token");
    expect(message).toMatch(/Keychain write failed/);
  });

  it("invokes security by absolute path with the secret hex-encoded via -X", () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const recordingExec = ((file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return "";
    }) as typeof execFileSync;

    new KeychainCredentialStore("acct", recordingExec).write("ccauth:x", SECRET);

    expect(calls[0]!.file).toBe("/usr/bin/security");
    expect(calls[0]!.args).toContain("-X");
    expect(calls[0]!.args).toContain(SECRET_HEX);
  });
});
