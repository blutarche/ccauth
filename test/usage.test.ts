import { describe, it, expect } from "vitest";
import {
  parseUsageResponse,
  realFetchUsage,
  resolveClaudeCodeVersion,
} from "../src/usage.js";
import { createTestDeps, TEST_PATHS } from "./fakes/testDeps.js";

describe("parseUsageResponse", () => {
  it("parses flat five_hour and seven_day windows", () => {
    expect(
      parseUsageResponse({
        five_hour: { utilization: 22, resets_at: "2026-07-10T14:00:00.000Z" },
        seven_day: { utilization: 59, resets_at: "2026-07-14T12:00:00.000Z" },
      }),
    ).toEqual({
      kind: "ok",
      fiveHour: { utilization: 22, resetsAt: Date.parse("2026-07-10T14:00:00.000Z") },
      sevenDay: { utilization: 59, resetsAt: Date.parse("2026-07-14T12:00:00.000Z") },
    });
  });

  it("falls back to a non-model-scoped weekly limits[] entry when seven_day is absent", () => {
    expect(
      parseUsageResponse({
        five_hour: { utilization: 10 },
        limits: [
          {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 80,
            resets_at: "2026-07-14T12:00:00.000Z",
            scope: { model: { id: "opus", display_name: "Opus" } },
          },
          { group: "weekly", percent: 35, resets_at: "2026-07-14T12:00:00.000Z" },
        ],
      }),
    ).toEqual({
      kind: "ok",
      fiveHour: { utilization: 10, resetsAt: undefined },
      sevenDay: { utilization: 35, resetsAt: Date.parse("2026-07-14T12:00:00.000Z") },
    });
  });

  it("degrades malformed windows and resets_at to undefined", () => {
    expect(
      parseUsageResponse({
        five_hour: { utilization: "high" },
        seven_day: { utilization: 12, resets_at: "not a date" },
      }),
    ).toEqual({
      kind: "ok",
      fiveHour: undefined,
      sevenDay: { utilization: 12, resetsAt: undefined },
    });
  });

  it("returns error for a non-object body", () => {
    expect(parseUsageResponse(null)).toEqual({ kind: "error" });
    expect(parseUsageResponse("nope")).toEqual({ kind: "error" });
    expect(parseUsageResponse([])).toEqual({ kind: "error" });
  });

  it("skips a weekly limits[] entry whose scope has an unrecognized shape", () => {
    expect(
      parseUsageResponse({
        limits: [{ group: "weekly", percent: 80, scope: "opus" }],
      }),
    ).toEqual({ kind: "ok", fiveHour: undefined, sevenDay: undefined });
  });
});

describe("realFetchUsage status mapping", () => {
  const okBody = JSON.stringify({ five_hour: { utilization: 1 } });
  const respond = (status: number, body = okBody): typeof fetch =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  it("maps 200 to parsed ok", async () => {
    expect(await realFetchUsage("t", respond(200))).toEqual({
      kind: "ok",
      fiveHour: { utilization: 1, resetsAt: undefined },
      sevenDay: undefined,
    });
  });

  it("maps 401 to auth", async () => {
    expect(await realFetchUsage("t", respond(401))).toEqual({ kind: "auth" });
  });

  it("maps 429 to limited", async () => {
    expect(await realFetchUsage("t", respond(429))).toEqual({ kind: "limited" });
  });

  it("maps other statuses to error", async () => {
    expect(await realFetchUsage("t", respond(500))).toEqual({ kind: "error" });
  });

  it("maps a network failure to error", async () => {
    const failing = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    expect(await realFetchUsage("t", failing)).toEqual({ kind: "error" });
  });

  it("maps a malformed 200 body to error", async () => {
    expect(await realFetchUsage("t", respond(200, "not json"))).toEqual({
      kind: "error",
    });
  });

  it("sends the Bearer token and required headers to the usage URL", async () => {
    let seen: { url?: string; headers?: Record<string, string> } = {};
    const capture = (async (
      url: unknown,
      init?: { headers?: Record<string, string> },
    ) => {
      seen = { url: String(url), headers: init?.headers };
      return new Response(okBody, { status: 200 });
    }) as unknown as typeof fetch;

    await realFetchUsage("tok-123", capture);

    expect(seen.url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(seen.headers?.Authorization).toBe("Bearer tok-123");
    expect(seen.headers?.["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(seen.headers?.["User-Agent"]).toMatch(/^claude-code\//);
  });

  it("sends an explicitly provided User-Agent", async () => {
    let seen: string | undefined;
    const capture = (async (
      _url: unknown,
      init?: { headers?: Record<string, string> },
    ) => {
      seen = init?.headers?.["User-Agent"];
      return new Response(okBody, { status: 200 });
    }) as unknown as typeof fetch;

    await realFetchUsage("t", capture, "claude-code/2.1.207");

    expect(seen).toBe("claude-code/2.1.207");
  });
});

describe("resolveClaudeCodeVersion", () => {
  // createTestDeps clock: 2026-07-10T12:00:00.000Z
  const NOW = Date.parse("2026-07-10T12:00:00.000Z");

  const harness = () => {
    const h = createTestDeps();
    h.runClaude.handler = () => ({
      code: 0,
      stdout: "2.1.207 (Claude Code)\n",
      stderr: "",
      timedOut: false,
    });
    return h;
  };

  it("detects via `claude --version` and snapshots the result", () => {
    const { deps, fs, runClaude } = harness();

    expect(resolveClaudeCodeVersion(deps)).toBe("2.1.207");

    expect(runClaude.calls).toEqual([
      { args: ["--version"], opts: { timeoutMs: 10_000 } },
    ]);
    expect(
      JSON.parse(fs.files.get(TEST_PATHS.claudeVersionCachePath)!),
    ).toEqual({ version: "2.1.207", fetchedAt: NOW });
  });

  it("uses a fresh cache without spawning", () => {
    const { deps, fs, runClaude } = harness();
    fs.files.set(
      TEST_PATHS.claudeVersionCachePath,
      JSON.stringify({ version: "9.9.9", fetchedAt: NOW - 3600_000 }),
    );

    expect(resolveClaudeCodeVersion(deps)).toBe("9.9.9");
    expect(runClaude.calls).toEqual([]);
  });

  it("re-detects when the cache is older than a day", () => {
    const { deps, fs, runClaude } = harness();
    fs.files.set(
      TEST_PATHS.claudeVersionCachePath,
      JSON.stringify({ version: "9.9.9", fetchedAt: NOW - 25 * 3600_000 }),
    );

    expect(resolveClaudeCodeVersion(deps)).toBe("2.1.207");
    expect(runClaude.calls).toHaveLength(1);
    expect(
      JSON.parse(fs.files.get(TEST_PATHS.claudeVersionCachePath)!),
    ).toEqual({ version: "2.1.207", fetchedAt: NOW });
  });

  it("re-detects when the cache file is corrupt", () => {
    const { deps, fs } = harness();
    fs.files.set(TEST_PATHS.claudeVersionCachePath, "not json");

    expect(resolveClaudeCodeVersion(deps)).toBe("2.1.207");
  });

  it("falls back without caching when the spawn fails", () => {
    const { deps, fs, runClaude } = harness();
    runClaude.handler = () => ({
      code: 1,
      stdout: "",
      stderr: "boom",
      timedOut: false,
    });

    expect(resolveClaudeCodeVersion(deps)).toBe("2.1.0");
    expect(runClaude.calls).toHaveLength(1);
    expect(fs.files.has(TEST_PATHS.claudeVersionCachePath)).toBe(false);
  });

  it("falls back without caching on unparseable version output", () => {
    const { deps, fs, runClaude } = harness();
    runClaude.handler = () => ({
      code: 0,
      stdout: "command not found: claude",
      stderr: "",
      timedOut: false,
    });

    expect(resolveClaudeCodeVersion(deps)).toBe("2.1.0");
    expect(fs.files.has(TEST_PATHS.claudeVersionCachePath)).toBe(false);
  });
});
