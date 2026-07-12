import type { UsageFetchResult } from "../../src/types.js";

/** Recording `fetchUsage` fake: canned results keyed by access token. */
export class FakeFetchUsage {
  readonly calls: string[] = [];
  readonly responses = new Map<string, UsageFetchResult>();

  fetch = async (accessToken: string): Promise<UsageFetchResult> => {
    this.calls.push(accessToken);
    return this.responses.get(accessToken) ?? { kind: "error" };
  };
}
