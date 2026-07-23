import { describe, it, expect } from "vitest";
import {
  parseOauthExpiry,
  parseOauthAccessToken,
  accessTokenExpired,
} from "../../src/util/oauthBlob.js";

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

describe("parseOauthAccessToken", () => {
  it("parses token and expiry from a full valid blob", () => {
    const blob = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-x",
        refreshToken: "sk-ant-ort01-x",
        expiresAt: 1783704731286,
        refreshTokenExpiresAt: 1785938875286,
      },
    });

    expect(parseOauthAccessToken(blob)).toEqual({
      accessToken: "sk-ant-oat01-x",
      expiresAt: 1783704731286,
    });
  });

  it("returns undefined for malformed JSON (not a Claude login)", () => {
    expect(parseOauthAccessToken("not json")).toBeUndefined();
  });

  it("returns undefined when claudeAiOauth is absent (not a Claude login)", () => {
    expect(parseOauthAccessToken(JSON.stringify({ foo: 1 }))).toBeUndefined();
  });

  it("drops a non-string or empty accessToken", () => {
    expect(
      parseOauthAccessToken(
        JSON.stringify({ claudeAiOauth: { accessToken: 42, expiresAt: 1 } }),
      ),
    ).toEqual({ accessToken: undefined, expiresAt: 1 });
    expect(
      parseOauthAccessToken(
        JSON.stringify({ claudeAiOauth: { accessToken: "", expiresAt: 1 } }),
      ),
    ).toEqual({ accessToken: undefined, expiresAt: 1 });
  });

  it("drops a non-number expiresAt", () => {
    expect(
      parseOauthAccessToken(
        JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: "soon" } }),
      ),
    ).toEqual({ accessToken: "t", expiresAt: undefined });
  });
});

describe("accessTokenExpired", () => {
  const now = new Date("2026-07-23T12:00:00.000Z"); // 1784894400000 ms

  it("true when expiresAt is in the past", () => {
    const blob = JSON.stringify({ claudeAiOauth: { expiresAt: now.getTime() - 1 } });
    expect(accessTokenExpired(blob, now)).toBe(true);
  });

  it("true when expiresAt equals now (boundary counts as expired)", () => {
    const blob = JSON.stringify({ claudeAiOauth: { expiresAt: now.getTime() } });
    expect(accessTokenExpired(blob, now)).toBe(true);
  });

  it("false when expiresAt is in the future", () => {
    const blob = JSON.stringify({ claudeAiOauth: { expiresAt: now.getTime() + 60_000 } });
    expect(accessTokenExpired(blob, now)).toBe(false);
  });

  it("false when expiresAt is missing, non-numeric, or blob is malformed", () => {
    expect(accessTokenExpired(JSON.stringify({ claudeAiOauth: {} }), now)).toBe(false);
    expect(
      accessTokenExpired(JSON.stringify({ claudeAiOauth: { expiresAt: "soon" } }), now),
    ).toBe(false);
    expect(accessTokenExpired("not json", now)).toBe(false);
  });
});
