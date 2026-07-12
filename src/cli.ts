#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CcauthError } from "./types.js";
import { buildRealDeps } from "./realDeps.js";
import { saveCommand } from "./commands/save.js";
import { useCommand } from "./commands/use.js";
import { listCommand } from "./commands/list.js";
import { currentCommand } from "./commands/current.js";
import { renameCommand } from "./commands/rename.js";
import { removeCommand } from "./commands/remove.js";
import { refreshCommand } from "./commands/refresh.js";

const USAGE = `Usage: ccauth <command> [args]

Commands:
  save [name]           Snapshot the live Claude Code login as a named profile
                         (defaults to a slug of the account email).
  use <name>             Switch the live Claude Code login to profile <name>.
                         Auto-snapshots the current live login as "_autosave" first.
  list, ls               List saved profiles (add --all to include "_autosave",
                         --usage to add usage-quota columns).
  current                Show the currently active account.
  rename <old> <new>      Rename a saved profile.
  remove <name>, rm       Delete a saved profile.
  refresh [name]          Warm a saved profile's token (all profiles if omitted).

Options:
  -y, --yes               Skip confirmation prompts.
  -h, --help              Show this help.
  -v, --version            Show the version.
  -u, --usage             Show usage quota (percent used, 5h/weekly) for list.
  --force                  Bypass the running-\`claude\` guard for \`refresh\`.
`;

interface ParsedArgs {
  positional: string[];
  yes: boolean;
  help: boolean;
  version: boolean;
  all: boolean;
  usage: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    positional: [],
    yes: false,
    help: false,
    version: false,
    all: false,
    usage: false,
    force: false,
  };
  for (const token of argv) {
    if (token === "-y" || token === "--yes") {
      result.yes = true;
    } else if (token === "-h" || token === "--help") {
      result.help = true;
    } else if (token === "-v" || token === "--version") {
      result.version = true;
    } else if (token === "-a" || token === "--all") {
      result.all = true;
    } else if (token === "-u" || token === "--usage") {
      result.usage = true;
    } else if (token === "--force") {
      result.force = true;
    } else {
      result.positional.push(token);
    }
  }
  return result;
}

function readVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.join(here, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    version: string;
  };
  return pkg.version;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(readVersion());
    return 0;
  }

  const command = args.positional[0];

  if (args.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  const rest = args.positional.slice(1);
  const deps = buildRealDeps();

  switch (command) {
    case "save":
      await saveCommand(deps, { name: rest[0], yes: args.yes });
      return 0;
    case "use":
      if (!rest[0]) {
        console.error("Usage: ccauth use <name>");
        return 1;
      }
      await useCommand(deps, rest[0]);
      return 0;
    case "list":
    case "ls":
      await listCommand(deps, { all: args.all, usage: args.usage });
      return 0;
    case "current":
      await currentCommand(deps);
      return 0;
    case "rename":
      if (!rest[0] || !rest[1]) {
        console.error("Usage: ccauth rename <old> <new>");
        return 1;
      }
      await renameCommand(deps, rest[0], rest[1]);
      return 0;
    case "remove":
    case "rm":
      if (!rest[0]) {
        console.error("Usage: ccauth remove <name>");
        return 1;
      }
      await removeCommand(deps, rest[0], { yes: args.yes });
      return 0;
    case "refresh":
      await refreshCommand(deps, { name: rest[0], force: args.force });
      return 0;
    default:
      console.error(`Unknown command: "${command}"\n`);
      console.error(USAGE);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof CcauthError) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error(err instanceof Error ? err.stack ?? err.message : err);
    }
    process.exitCode = 1;
  });
