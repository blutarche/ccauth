import type { FileSystem } from "../../src/types.js";

/** In-memory FileSystem fake. Never touches the real disk. */
export class FakeFileSystem implements FileSystem {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();

  existsSync(p: string): boolean {
    return this.files.has(p) || this.dirs.has(p);
  }

  readFileSync(p: string): string {
    const value = this.files.get(p);
    if (value === undefined) {
      throw new Error(`ENOENT: no such file, open '${p}'`);
    }
    return value;
  }

  writeFileSync(p: string, data: string): void {
    this.files.set(p, data);
  }

  renameSync(oldPath: string, newPath: string): void {
    if (!this.files.has(oldPath)) {
      throw new Error(`ENOENT: no such file, rename '${oldPath}'`);
    }
    this.files.set(newPath, this.files.get(oldPath)!);
    this.files.delete(oldPath);
  }

  mkdirSync(p: string): void {
    this.dirs.add(p);
  }

  copyFileSync(src: string, dest: string): void {
    if (!this.files.has(src)) {
      throw new Error(`ENOENT: no such file, copyfile '${src}'`);
    }
    this.files.set(dest, this.files.get(src)!);
  }
}
