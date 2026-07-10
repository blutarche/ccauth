import { describe, it, expect } from "vitest";
import { parseOauthExpiry } from "../../src/util/oauthBlob.js";

describe("parseOauthExpiry", () => {
  it("parses a full valid blob", () => {
    const blob = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-x",
        refreshToken: "sk-ant-ort01-x",
        expiresAt: 1783704731286,
        refreshTokenExpiresAt: 1785938875286,
        scopes: ["user:inference"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_5x",
      },
    });

    expect(parseOauthExpiry(blob)).toEqual({
      expiresAt: 1783704731286,
      refreshTokenExpiresAt: 1785938875286,
    });
  });

  it("returns undefined refreshTokenExpiresAt for older logins missing it", () => {
    const blob = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-x",
        refreshToken: "sk-ant-ort01-x",
        expiresAt: 1783704731286,
      },
    });

    expect(parseOauthExpiry(blob)).toEqual({
      expiresAt: 1783704731286,
      refreshTokenExpiresAt: undefined,
    });
  });

  it("returns all-undefined for malformed JSON", () => {
    expect(parseOauthExpiry("not json")).toEqual({
      expiresAt: undefined,
      refreshTokenExpiresAt: undefined,
    });
  });

  it("returns all-undefined when claudeAiOauth is absent", () => {
    expect(parseOauthExpiry(JSON.stringify({ foo: 1 }))).toEqual({
      expiresAt: undefined,
      refreshTokenExpiresAt: undefined,
    });
  });

  it("returns undefined for a non-number field", () => {
    const blob = JSON.stringify({
      claudeAiOauth: {
        expiresAt: "not-a-number",
        refreshTokenExpiresAt: 1785938875286,
      },
    });

    expect(parseOauthExpiry(blob)).toEqual({
      expiresAt: undefined,
      refreshTokenExpiresAt: 1785938875286,
    });
  });
});
