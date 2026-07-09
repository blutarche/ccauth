import { describe, it, expect } from "vitest";
import { KeychainCredentialStore } from "../../src/keychain.js";

// Opt-in integration test: round-trips a throwaway item through the REAL
// macOS keychain. Never touches "Claude Code-credentials" or the real
// ~/.claude.json -- only the dedicated "ccauth:__test__" service.
const runIntegration = process.env.CCAUTH_INTEGRATION === "1";

describe.skipIf(!runIntegration)("KeychainCredentialStore (real keychain)", () => {
  const SERVICE = "ccauth:__test__";

  it("round-trips write/read/delete", () => {
    const store = new KeychainCredentialStore();
    try {
      store.write(SERVICE, JSON.stringify({ claudeAiOauth: { accessToken: "test" } }));
      const read = store.read(SERVICE);
      expect(read).toBe(JSON.stringify({ claudeAiOauth: { accessToken: "test" } }));
    } finally {
      store.delete(SERVICE);
    }
    expect(store.read(SERVICE)).toBeNull();
  });
});
