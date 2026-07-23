import { describe, it, expect } from "vitest";
import { sameAccount } from "../../src/util/identity.js";

describe("sameAccount", () => {
  it("matches when accountUuid and organizationUuid are both equal", () => {
    const a = { accountUuid: "a-1", organizationUuid: "o-1" };
    const b = { accountUuid: "a-1", organizationUuid: "o-1" };
    expect(sameAccount(a, b)).toBe(true);
  });

  it("matches when organizationUuid is undefined on both sides", () => {
    const a = { accountUuid: "a-1" };
    const b = { accountUuid: "a-1" };
    expect(sameAccount(a, b)).toBe(true);
  });

  it("does not match on differing organizationUuid", () => {
    const a = { accountUuid: "a-1", organizationUuid: "o-1" };
    const b = { accountUuid: "a-1", organizationUuid: "o-2" };
    expect(sameAccount(a, b)).toBe(false);
  });

  it("does not match when accountUuid is blank/whitespace on both sides", () => {
    const a = { accountUuid: "" };
    const b = { accountUuid: "" };
    expect(sameAccount(a, b)).toBe(false);
  });

  it("does not match when accountUuid is whitespace-only", () => {
    const a = { accountUuid: "   " };
    const b = { accountUuid: "   " };
    expect(sameAccount(a, b)).toBe(false);
  });

  it("does not match when either side has no identity", () => {
    expect(sameAccount(undefined, { accountUuid: "a-1" })).toBe(false);
    expect(sameAccount({ accountUuid: "a-1" }, undefined)).toBe(false);
  });
});
