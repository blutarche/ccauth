import type { Deps, ProfilesIndex } from "./types.js";
import { CcauthError } from "./types.js";
import { ensureCcauthDir } from "./claudeConfig.js";

/** Reads `~/.claude/ccauth/profiles.json`, or an empty index if absent. */
export function readIndex(deps: Deps): ProfilesIndex {
  const { fs, paths } = deps;
  if (!fs.existsSync(paths.profilesIndexPath)) {
    return { version: 1, profiles: {} };
  }
  const raw = fs.readFileSync(paths.profilesIndexPath);
  try {
    return JSON.parse(raw) as ProfilesIndex;
  } catch {
    throw new CcauthError(
      `${paths.profilesIndexPath} does not parse as JSON; refusing to continue. ` +
        `Fix or remove the file manually before retrying.`,
    );
  }
}

/** Writes the index atomically (temp file + rename), creating the ccauth dir if needed. */
export function writeIndex(deps: Deps, index: ProfilesIndex): void {
  const { fs, paths } = deps;
  ensureCcauthDir(deps);
  const serialized = JSON.stringify(index, null, 2) + "\n";
  const tmpPath = `${paths.profilesIndexPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, serialized);
  fs.renameSync(tmpPath, paths.profilesIndexPath);
}
