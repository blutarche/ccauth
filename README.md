<h1 align="center">ccauth</h1>

<p align="center">
  You have 10 Claude accounts.<br>
  You're dreading the inevitable login ritual when one of them runs out of credits.
</p>

<p align="center"><strong>No more.</strong></p>

<p align="center">
  <img src="assets/demo.gif" alt="ccauth switching accounts inside a live Claude Code session" width="800"/>
</p>

```
$ ccauth use work
Switched to profile "work".
```

## Install

```sh
npm install -g @blutarche/ccauth
```

macOS only. Zero dependencies.

## Usage

```
$ ccauth save work
Saved profile "work".

$ claude   # /login with another account

$ ccauth save personal
Saved profile "personal".

$ ccauth list
NAME        EMAIL              ORG        SAVED        EXPIRES
* personal  me@gmail.com       -          just now     in 29 days
  work      me@company.com     Acme Inc   2 hours ago  in 3 days ⚠

$ ccauth use work
Switched to profile "work".
```

`EXPIRES` counts down each profile's refresh token (`⚠` when it's about to lapse, `expired` once it has). A lapsed profile needs a fresh `claude` `/login`; `ccauth refresh` warms the others without one. `ccauth list --usage` adds remaining-quota columns (5-hour and weekly windows) fetched read-only from Anthropic's usage API; rows shown as `stale` need a `ccauth refresh` first.

| Command                       | What it does                                              |
| ----------------------------- | --------------------------------------------------------- |
| `ccauth save [name]`          | Snapshot the live login (name defaults to email slug)     |
| `ccauth use <name>`           | Switch the live login to a saved profile                  |
| `ccauth list` / `ls`          | List profiles + refresh-token expiry; `*` = active, `--all` includes `_autosave`, `--usage` adds remaining quota (5h/weekly) |
| `ccauth current`              | Show the active account and matching profile              |
| `ccauth refresh [name]`       | Warm a profile's token via `claude` (all profiles if no name; `--force` past a running session) |
| `ccauth rename <old> <new>`   | Rename a profile                                          |
| `ccauth remove <name>` / `rm` | Delete a profile (`-y` skips the prompt)                  |

## How it works

Claude Code keeps its OAuth credentials in the macOS Keychain and the account identity in `~/.claude.json`. `ccauth` snapshots both into named profiles (each its own Keychain item — secrets never touch disk) and swaps them back on `use`.

Details that matter:

- `use` auto-snapshots the current login to `_autosave` first, so a switch is always undoable: `ccauth use _autosave`.
- The `~/.claude.json` swap is atomic, with a one-time `.bak` on first write.
- Tokens are moved as opaque blobs — `ccauth` itself never decodes them or touches the network. Expired profile? Claude Code refreshes it on next launch, same as always. The one exception: `ccauth list --usage` uses each stored access token for a single read-only usage query against Anthropic's API - nothing is written or refreshed.
- `ccauth refresh` warms a stored profile by swapping it live and running one throwaway `claude -p`, letting the genuine Claude Code client refresh and rotate its own token; `ccauth` re-captures the result and restores your original login. It can't extend a refresh token past its ~30-day login window — only a real `/login` resets that — so it's a "make a stale-but-not-dead profile just work" convenience, not a keep-alive.
- Profiles are keyed by account *and* organization, so the same account in two orgs is two distinct profiles.
- If `claude` is running during a switch, restart it — it caches credentials in memory.

## Development

```sh
npm run build     # tsc → dist/
npm test          # vitest, runs on fakes — no Keychain needed
```

Integration test against the real Keychain (touches only `ccauth:__test__`): `CCAUTH_INTEGRATION=1 npm test`.

## License

MIT

---

<p align="center">
  <sub><i>Cuz there ain't no way I'm paying the extra usage rate buh.</i></sub>
</p>
