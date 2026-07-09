import { describe, it, expect } from "vitest";
import { validateName, slugify } from "../../src/util/names.js";
import { CcauthError } from "../../src/types.js";

describe("validateName", () => {
  it("accepts a normal name", () => {
    expect(() => validateName("work")).not.toThrow();
  });

  it("rejects empty names", () => {
    expect(() => validateName("")).toThrow(CcauthError);
  });

  it("rejects names with a colon", () => {
    expect(() => validateName("a:b")).toThrow(CcauthError);
  });

  it("rejects names with whitespace", () => {
    expect(() => validateName("a b")).toThrow(CcauthError);
  });

  it("rejects the reserved _autosave name by default", () => {
    expect(() => validateName("_autosave")).toThrow(CcauthError);
  });

  it("allows _autosave when allowReserved is set", () => {
    expect(() => validateName("_autosave", { allowReserved: true })).not.toThrow();
  });
});

describe("slugify", () => {
  it("lowercases and replaces non-alphanumeric runs with a dash", () => {
    expect(slugify("Me@Work.com")).toBe("me-work-com");
  });

  it("trims leading/trailing dashes", () => {
    expect(slugify("--Hello--")).toBe("hello");
  });
});
