import type { Deps, OauthAccount } from "./types.js";
import { CcauthError } from "./types.js";

/**
 * Reads the live `oauthAccount` identity block out of `~/.claude.json`.
 * Returns undefined if the file has no `oauthAccount` key (identity absent).
 */
export function readOauthAccount(deps: Deps): OauthAccount | undefined {
  const { parsed } = readConfig(deps);
  const value = parsed.oauthAccount;
  return value === undefined ? undefined : (value as OauthAccount);
}

/**
 * Reads `~/.claude.json`, returning both the raw text (so writers can preserve
 * its formatting) and the parsed object. Throws a friendly error if the file
 * is missing or does not parse.
 */
function readConfig(deps: Deps): { raw: string; parsed: Record<string, unknown> } {
  const { fs, paths } = deps;
  if (!fs.existsSync(paths.claudeConfigPath)) {
    throw new CcauthError(
      `${paths.claudeConfigPath} not found. Is Claude Code installed and have you logged in at least once?`,
    );
  }
  const raw = fs.readFileSync(paths.claudeConfigPath);
  try {
    return { raw, parsed: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    throw new CcauthError(
      `${paths.claudeConfigPath} does not parse as JSON; refusing to write. ` +
        `A backup (if one was ever taken) is at ${paths.claudeConfigBackupPath}. ` +
        `Fix or restore the file manually before retrying.`,
    );
  }
}

/**
 * Atomically swaps the ENTIRE `oauthAccount` object in `~/.claude.json` for
 * `newValue` (or removes the key entirely if `newValue` is undefined). Never
 * cherry-picks sub-keys -- the object is treated as an opaque JSON value.
 * All unrelated top-level keys are preserved exactly.
 *
 * Before the first-ever modification, the original file is copied to the
 * one-time backup path (no-op if that backup already exists).
 */
export function writeOauthAccount(
  deps: Deps,
  newValue: OauthAccount | undefined,
): void {
  const { fs, paths } = deps;
  const { raw, parsed } = readConfig(deps);

  ensureCcauthDir(deps);
  if (!fs.existsSync(paths.claudeConfigBackupPath)) {
    fs.copyFileSync(paths.claudeConfigPath, paths.claudeConfigBackupPath);
  }

  if (newValue === undefined) {
    delete parsed.oauthAccount;
  } else {
    parsed.oauthAccount = newValue;
  }

  // Preserve the file's original formatting (Claude Code writes it compact;
  // reformatting it would churn the whole file and get reverted on the next
  // Claude Code write). Match the original indentation and trailing newline.
  const indent = detectIndent(raw);
  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  const serialized = JSON.stringify(parsed, null, indent) + trailingNewline;
  const tmpPath = `${paths.claudeConfigPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, serialized);
  fs.renameSync(tmpPath, paths.claudeConfigPath);
}

/**
 * Sniffs the indentation of a JSON document so a rewrite matches the original.
 * Returns a number of spaces, a `"\t"`, or `0` for compact (single-line) JSON.
 */
function detectIndent(raw: string): number | string {
  const match = raw.match(/\n(\t+|[ ]+)\S/);
  if (!match) return 0;
  const ws = match[1];
  return ws.startsWith("\t") ? "\t" : ws.length;
}

export function ensureCcauthDir(deps: Pick<Deps, "fs" | "paths">): void {
  const { fs, paths } = deps;
  if (!fs.existsSync(paths.ccauthDir)) {
    fs.mkdirSync(paths.ccauthDir);
  }
}
