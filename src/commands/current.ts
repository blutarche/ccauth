import type { Deps } from "../types.js";
import { readOauthAccount } from "../claudeConfig.js";
import { readIndex } from "../profiles.js";
import { extractDisplayFields, sameAccount } from "../util/identity.js";

export async function currentCommand(deps: Deps): Promise<void> {
  const liveAccount = readOauthAccount(deps);
  const display = extractDisplayFields(liveAccount);

  if (!liveAccount) {
    deps.stdout("No active Claude Code identity found in ~/.claude.json.");
    return;
  }

  deps.stdout(`Email: ${display.email ?? "(unknown)"}`);
  deps.stdout(`Org:   ${display.org ?? "(unknown)"}`);

  const index = readIndex(deps);
  const match = Object.entries(index.profiles).find(([, entry]) =>
    sameAccount(entry.oauthAccount, liveAccount),
  );

  if (match) {
    deps.stdout(`Matches saved profile: "${match[0]}"`);
  } else {
    deps.stdout("Does not match any saved profile.");
  }
}
