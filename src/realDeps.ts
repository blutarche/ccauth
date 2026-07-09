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
  } catch {
    return false;
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
    now: () => new Date(),
    stdout: (line: string) => {
      console.log(line);
    },
    stderr: (line: string) => {
      console.error(line);
    },
  };
}
