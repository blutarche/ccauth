import type { CredentialStore } from "../../src/types.js";

/** In-memory CredentialStore fake. Never touches the real macOS keychain. */
export class FakeCredentialStore implements CredentialStore {
  readonly items = new Map<string, string>();
  /** Services whose next write() throws, to simulate a keychain failure. */
  readonly failWritesFor = new Set<string>();
  /** Services whose next read() throws, to simulate a keychain failure. */
  readonly failReadsFor = new Set<string>();
  /** Number of read() calls per service, to assert against redundant reads. */
  readonly readCounts = new Map<string, number>();

  read(service: string): string | null {
    this.readCounts.set(service, (this.readCounts.get(service) ?? 0) + 1);
    if (this.failReadsFor.has(service)) {
      throw new Error(`fake keychain read failure for "${service}"`);
    }
    return this.items.has(service) ? this.items.get(service)! : null;
  }

  write(service: string, secret: string): void {
    if (this.failWritesFor.has(service)) {
      throw new Error(`fake keychain write failure for "${service}"`);
    }
    this.items.set(service, secret);
  }

  delete(service: string): void {
    this.items.delete(service);
  }
}
