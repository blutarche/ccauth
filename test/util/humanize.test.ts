import { describe, it, expect } from "vitest";
import { humanizeAgo, humanizeUntil, humanizeCompact } from "../../src/util/humanize.js";

describe("humanizeAgo", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");

  it("returns 'just now' for < 60s", () => {
    expect(humanizeAgo(new Date("2026-07-10T11:59:30.000Z"), now)).toBe(
      "just now",
    );
  });

  it("returns minutes", () => {
    expect(humanizeAgo(new Date("2026-07-10T11:55:00.000Z"), now)).toBe(
      "5 minutes ago",
    );
  });

  it("singularizes 1 minute", () => {
    expect(humanizeAgo(new Date("2026-07-10T11:59:00.000Z"), now)).toBe(
      "1 minute ago",
    );
  });

  it("returns hours", () => {
    expect(humanizeAgo(new Date("2026-07-10T09:00:00.000Z"), now)).toBe(
      "3 hours ago",
    );
  });

  it("returns days", () => {
    expect(humanizeAgo(new Date("2026-07-05T12:00:00.000Z"), now)).toBe(
      "5 days ago",
    );
  });
});

describe("humanizeUntil", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");

  it("returns days for a future date", () => {
    expect(humanizeUntil(new Date("2026-08-05T12:00:00.000Z"), now)).toBe(
      "in 26 days",
    );
  });

  it("singularizes 1 day", () => {
    expect(humanizeUntil(new Date("2026-07-11T12:00:00.000Z"), now)).toBe(
      "in 1 day",
    );
  });

  it("returns hours when under a day away", () => {
    expect(humanizeUntil(new Date("2026-07-10T17:00:00.000Z"), now)).toBe(
      "in 5 hours",
    );
  });

  it("returns 'expired' when future equals from", () => {
    expect(humanizeUntil(new Date("2026-07-10T12:00:00.000Z"), now)).toBe(
      "expired",
    );
  });

  it("returns 'expired' when future is in the past", () => {
    expect(humanizeUntil(new Date("2026-07-01T12:00:00.000Z"), now)).toBe(
      "expired",
    );
  });
});

describe("humanizeCompact", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");

  it("renders minutes", () => {
    expect(humanizeCompact(new Date("2026-07-10T12:45:00.000Z"), now)).toBe("45m");
  });

  it("renders hours, flooring partial units", () => {
    expect(humanizeCompact(new Date("2026-07-10T14:59:00.000Z"), now)).toBe("2h");
  });

  it("renders days", () => {
    expect(humanizeCompact(new Date("2026-07-13T12:00:00.000Z"), now)).toBe("3d");
  });

  it("renders <1m under a minute", () => {
    expect(humanizeCompact(new Date("2026-07-10T12:00:30.000Z"), now)).toBe("<1m");
  });

  it("renders <1m for a past instant", () => {
    expect(humanizeCompact(new Date("2026-07-10T11:00:00.000Z"), now)).toBe("<1m");
  });
});
