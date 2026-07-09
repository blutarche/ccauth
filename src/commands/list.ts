import type { Deps } from "../types.js";
import { AUTOSAVE_NAME } from "../types.js";
import { readOauthAccount } from "../claudeConfig.js";
import { readIndex } from "../profiles.js";
import { sameAccount } from "../util/identity.js";
import { humanizeAgo } from "../util/humanize.js";

export async function listCommand(
  deps: Deps,
  opts: { all?: boolean } = {},
): Promise<void> {
  const index = readIndex(deps);
  const names = Object.keys(index.profiles)
    .filter((name) => opts.all || name !== AUTOSAVE_NAME)
    .sort();

  if (names.length === 0) {
    deps.stdout("No saved profiles yet. Run `ccauth save <name>` to create one.");
    return;
  }

  const liveAccount = readOauthAccount(deps);
  const now = deps.now();

  const rows = names.map((name) => {
    const entry = index.profiles[name]!;
    const active = sameAccount(entry.oauthAccount, liveAccount);
    return {
      name: active ? `* ${name}` : `  ${name}`,
      email: entry.email ?? "-",
      org: entry.org ?? "-",
      saved: humanizeAgo(new Date(entry.savedAt), now),
    };
  });

  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    email: Math.max(5, ...rows.map((r) => r.email.length)),
    org: Math.max(3, ...rows.map((r) => r.org.length)),
  };

  const header = `${pad("NAME", widths.name)}  ${pad("EMAIL", widths.email)}  ${pad("ORG", widths.org)}  SAVED`;
  deps.stdout(header);
  for (const row of rows) {
    deps.stdout(
      `${pad(row.name, widths.name)}  ${pad(row.email, widths.email)}  ${pad(row.org, widths.org)}  ${row.saved}`,
    );
  }

}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - value.length));
}
