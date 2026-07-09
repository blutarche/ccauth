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
NAME        EMAIL              ORG        SAVED
* personal  me@gmail.com       -          just now
  work      me@company.com     Acme Inc   2 hours ago

$ ccauth use work
Switched to profile "work".
```

| Command                       | What it does                                              |
| ----------------------------- | --------------------------------------------------------- |
| `ccauth save [name]`          | Snapshot the live login (name defaults to email slug)     |
| `ccauth use <name>`           | Switch the live login to a saved profile                  |
| `ccauth list` / `ls`          | List profiles; `*` = active, `--all` includes `_autosave` |
| `ccauth current`              | Show the active account and matching profile              |
| `ccauth rename <old> <new>`   | Rename a profile                                          |
| `ccauth remove <name>` / `rm` | Delete a profile (`-y` skips the prompt)                  |

## How it works

Claude Code keeps its OAuth credentials in the macOS Keychain and the account identity in `~/.claude.json`. `ccauth` snapshots both into named profiles (each its own Keychain item — secrets never touch disk) and swaps them back on `use`.

Details that matter:

- `use` auto-snapshots the current login to `_autosave` first, so a switch is always undoable: `ccauth use _autosave`.
- The `~/.claude.json` swap is atomic, with a one-time `.bak` on first write.
- Tokens are moved as opaque blobs — never refreshed, decoded, or sent anywhere. Expired profile? Claude Code refreshes it on next launch, same as always.
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
