import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { execFileSync } from "node:child_process";
import type { Deps, FileSystem, Paths } from "./types.js";
import { KeychainCredentialStore, computeLiveServiceName } from "./keychain.js";

class RealFileSystem implements FileSystem {
  existsSync(p: string): boolean {
    return fs.existsSync(p);
  }
  readFileSync(p: string): string {
    return fs.readFileSync(p, "utf8");
  }
  writeFileSync(p: string, data: string): void {
    fs.writeFileSync(p, data, "utf8");
  }
  renameSync(oldPath: string, newPath: string): void {
    fs.renameSync(oldPath, newPath);
  }
  mkdirSync(p: string): void {
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  }
  copyFileSync(src: string, dest: string): void {
    fs.copyFileSync(src, dest);
  }
}

export function buildRealPaths(): Paths {
  const home = os.homedir();
  const ccauthDir = path.join(home, ".claude", "ccauth");
  return {
    claudeConfigPath: path.join(home, ".claude.json"),
    ccauthDir,
    profilesIndexPath: path.join(ccauthDir, "profiles.json"),
    claudeConfigBackupPath: path.join(ccauthDir, "claude.json.bak"),
  };
}

async function realConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function realIsClaudeRunning(): boolean {
  try {
    execFileSync("/usr/bin/pgrep", ["-x", "claude"], { stdio: "ignore" });
    return true;
  } catch (err) {
    // pgrep's own documented exit code for "ran fine, no process matched" is
    // 1 -- that's the only case that genuinely means "not running". Any
    // other failure (couldn't exec pgrep, ENOENT, permission denied, exit
    // >1, ...) means we don't actually know, so fail CLOSED: report running
    // so `refresh` refuses without --force rather than silently swapping
    // live credentials while a session might be active.
    const status = (err as { status?: number | null } | null)?.status;
    return status !== 1;
  }
}

function realIsClaudeInstalled(): boolean {
  try {
    execFileSync("/usr/bin/which", ["claude"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function toStr(value: string | Buffer | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

/**
 * Wraps `execFileSync("claude", args)`. Never lets the underlying error
 * escape: a non-zero exit, a timeout, or a spawn failure are all folded into
 * the return value so callers can loop over many invocations without a
 * try/catch around each one.
 */
function realRunClaude(
  args: string[],
  opts: { timeoutMs: number },
): { code: number | null; stdout: string; stderr: string; timedOut: boolean } {
  try {
    const stdout = execFileSync("claude", args, {
      encoding: "utf8",
      timeout: opts.timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "", timedOut: false };
  } catch (err) {
    const e = err as {
      status?: number | null;
      signal?: string | null;
      code?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const timedOut = e.signal === "SIGTERM" || e.code === "ETIMEDOUT";
    return {
      code: e.status ?? null,
      stdout: toStr(e.stdout),
      stderr: toStr(e.stderr),
      timedOut,
    };
  }
}

export function buildRealDeps(): Deps {
  return {
    store: new KeychainCredentialStore(),
    fs: new RealFileSystem(),
    paths: buildRealPaths(),
    liveService: computeLiveServiceName(),
    confirm: realConfirm,
    isClaudeRunning: realIsClaudeRunning,
    isClaudeInstalled: realIsClaudeInstalled,
    runClaude: realRunClaude,
    now: () => new Date(),
    stdout: (line: string) => {
      console.log(line);
    },
    stderr: (line: string) => {
      console.error(line);
    },
  };
}
