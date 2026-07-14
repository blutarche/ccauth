import type { Deps, FileSystem, Paths } from "./types.js";
import { ensureCcauthDir } from "./claudeConfig.js";
import { parseJsonObject } from "./util/blob.js";

/**
 * Pinned fallback for when `claude --version` detection fails. The usage
 * endpoint serves the Claude Code OAuth client, so requests carry a
 * claude-code User-Agent either way.
 */
export const FALLBACK_CLAUDE_VERSION = "2.1.0";
/** How long a detected `claude --version` result stays cached: 1 day. */
const VERSION_CACHE_TTL_MS = 86_400_000;
/** Probe bound. It blocks the readout synchronously, so it stays tight. */
const VERSION_PROBE_TIMEOUT_MS = 2_000;

/** The seams version detection actually touches (a full `Deps` satisfies it). */
export interface ClaudeVersionDeps {
  fs: FileSystem;
  paths: Paths;
  runClaude: Deps["runClaude"];
  now: () => Date;
}

/** Formats the User-Agent for a claude-code version. Single format definition. */
export function claudeCodeUserAgent(version: string): string {
  return `claude-code/${version}`;
}

/**
 * Resolves the installed Claude Code CLI version for the User-Agent header.
 * Spawns `claude --version` at most once per day: a successful detection is
 * snapshotted to `paths.claudeVersionCachePath` and reused until the TTL
 * lapses. Detection failures fall back to `FALLBACK_CLAUDE_VERSION` and are
 * NOT cached, so a transient failure retries on the next run. Readout path:
 * never throws (a broken cache file just re-detects; a failed cache write
 * is ignored).
 */
export function resolveClaudeCodeVersion(deps: ClaudeVersionDeps): string {
  const cached = readVersionCache(deps);
  if (cached !== undefined) return cached;

  const res = deps.runClaude(["--version"], {
    timeoutMs: VERSION_PROBE_TIMEOUT_MS,
  });
  const version = res.code === 0 ? parseClaudeVersion(res.stdout) : undefined;
  if (version === undefined) return FALLBACK_CLAUDE_VERSION;

  writeVersionCache(deps, version);
  return version;
}

/** `claude --version` prints e.g. "2.1.207 (Claude Code)" -> "2.1.207". */
function parseClaudeVersion(stdout: string): string | undefined {
  const token = stdout.trim().split(/\s+/)[0] ?? "";
  return /^\d+\.\d+\.\d+/.test(token) ? token : undefined;
}

function readVersionCache(deps: ClaudeVersionDeps): string | undefined {
  const { fs, paths } = deps;
  if (!fs.existsSync(paths.claudeVersionCachePath)) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(paths.claudeVersionCachePath);
  } catch {
    return undefined;
  }
  const parsed = parseJsonObject(raw);
  if (parsed === undefined) return undefined;
  const { version, fetchedAt } = parsed as {
    version?: unknown;
    fetchedAt?: unknown;
  };
  if (typeof version !== "string" || typeof fetchedAt !== "number") {
    return undefined;
  }
  const age = deps.now().getTime() - fetchedAt;
  return age >= 0 && age < VERSION_CACHE_TTL_MS ? version : undefined;
}

function writeVersionCache(deps: ClaudeVersionDeps, version: string): void {
  try {
    ensureCcauthDir(deps);
    deps.fs.writeFileSync(
      deps.paths.claudeVersionCachePath,
      JSON.stringify({ version, fetchedAt: deps.now().getTime() }) + "\n",
    );
  } catch {
    // Best-effort cache: failing to persist must never break the readout.
  }
}
