export interface RunClaudeCall {
  args: string[];
  opts: { timeoutMs: number };
}

export interface RunClaudeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Programmable fake for `Deps.runClaude`. Records every call (args + opts)
 * so tests can assert call order/count, and defers to an overridable
 * `handler` for the result -- the default simulates a clean "pong" success
 * with no rotation. Tests that need to simulate Claude Code rotating the
 * live credential should have their `handler` write a new blob into the
 * fake `CredentialStore` themselves before returning.
 */
export class FakeRunClaude {
  readonly calls: RunClaudeCall[] = [];
  handler: (args: string[], opts: { timeoutMs: number }) => RunClaudeResult = () => ({
    code: 0,
    stdout: "pong",
    stderr: "",
    timedOut: false,
  });

  run = (args: string[], opts: { timeoutMs: number }): RunClaudeResult => {
    this.calls.push({ args, opts });
    return this.handler(args, opts);
  };
}
