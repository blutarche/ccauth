import { describe, it, expect } from "vitest";
import { humanizeAgo } from "../../src/util/humanize.js";

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
