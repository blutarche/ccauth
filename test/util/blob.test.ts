import { describe, it, expect } from "vitest";
import { validateCredentialBlob } from "../../src/util/blob.js";
import { CcauthError } from "../../src/types.js";

describe("validateCredentialBlob", () => {
  it("accepts a blob with claudeAiOauth", () => {
    expect(() =>
      validateCredentialBlob(
        JSON.stringify({ claudeAiOauth: { accessToken: "x" } }),
        "work",
      ),
    ).not.toThrow();
  });

  it("rejects invalid JSON", () => {
    expect(() => validateCredentialBlob("not json", "work")).toThrow(
      CcauthError,
    );
  });

  it("rejects JSON missing claudeAiOauth", () => {
    expect(() => validateCredentialBlob(JSON.stringify({ foo: 1 }), "work")).toThrow(
      CcauthError,
    );
  });
});
