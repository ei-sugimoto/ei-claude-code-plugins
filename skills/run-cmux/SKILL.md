---
name: run-cmux
description: Use, drive, and inspect cmux — the macOS terminal multiplexer app at /Applications/cmux.app. Covers windows/workspaces/panes/surfaces topology, focus and move/reorder, read-screen/send, browser-surface automation, agent hook integrations, and config reload. Use when the user asks to run cmux, list/focus/move cmux workspaces or panes, send keys to a cmux terminal, screenshot a cmux browser surface, set up cmux hooks, edit cmux.json, or summarize cmux usage.
---

# run-cmux

cmux is an installed macOS app (`/Applications/cmux.app`) controlled entirely through the `cmux` CLI, which talks to a per-user Unix socket. There is no source build here — this skill documents how to **drive** the running app from any terminal.

Paths in this doc are absolute. The CLI lives at `/Applications/cmux.app/Contents/Resources/bin/cmux` and is on `PATH` as `cmux`.

## Smoke check (agent path — run this first)

```bash
"${CLAUDE_PLUGIN_ROOT}/skills/run-cmux/smoke.sh"
```

That runs `cmux ping → version → identify --json → tree` and exits non-zero if the daemon is unreachable. If it prints `PONG`, a version line, a JSON identify block, and a topology tree, the rest of this skill applies.

## Prerequisites

- macOS with cmux.app installed (verified: `cmux version` → `cmux 0.64.7 (87)`).
- The cmux daemon must be running (the app launches it). `cmux ping` returns `PONG` when reachable.
- Socket path: `~/Library/Application Support/cmux/cmux.sock`. Override with env `CMUX_SOCKET_PATH`, or auth password via `CMUX_SOCKET_PASSWORD`.

## Core model

cmux exposes a four-level hierarchy. Every command takes handles in this vocabulary:

| Level | What it is | Handle examples |
|---|---|---|
| **window** | Top-level macOS cmux window | `window:1`, UUID |
| **workspace** | Tab-like group inside a window | `workspace:5`, `--workspace 5` |
| **pane** | Split container inside a workspace | `pane:6` |
| **surface** | A tab inside a pane (terminal **or** browser) | `surface:9`, also `tab:9` for tab-action |

Outputs default to short refs (`workspace:5`). UUIDs are always accepted as input. Add `--id-format uuids|both` to get UUIDs in output.

`cmux identify --json` returns both `caller` (the surface the CLI was run from) and `focused` (the surface currently in focus). Most commands default to the caller's workspace/surface when no handle is given, which is what makes scripting easy from inside a cmux terminal.

## Cheat sheet (all verified on this machine)

### Inspect topology

```bash
cmux ping                       # daemon reachable?
cmux version
cmux capabilities               # JSON list of every RPC method the daemon exposes
cmux identify --json            # caller + focused + socket path
cmux tree                       # whole topology
cmux tree --all                 # include other windows
cmux list-windows
cmux list-workspaces
cmux list-panes
cmux list-pane-surfaces --pane pane:1
cmux current-window
cmux current-workspace
cmux top                        # per-surface CPU/mem/proc
cmux surface-health             # which surfaces are stuck / orphaned
```

### Create / focus / arrange

```bash
cmux new-window
cmux focus-window --window window:1
cmux close-window --window window:1

cmux new-workspace --name "scratch" --cwd ~/code
cmux select-workspace --workspace workspace:5
cmux rename-workspace --workspace workspace:5 "new title"
cmux move-workspace-to-window --workspace workspace:5 --window window:2
cmux reorder-workspace --workspace workspace:5 --before workspace:3
cmux close-workspace --workspace workspace:5

cmux new-split right --panel pane:1      # split a pane
cmux new-pane --type terminal --direction down
cmux new-surface --type terminal --pane pane:1     # add a tab to a pane
cmux focus-pane  --pane pane:5
cmux move-surface  --surface surface:7 --pane pane:2 --focus true
cmux split-off     --surface surface:7 right       # peel a tab off into a new split
cmux reorder-surface --surface surface:7 --before surface:3
cmux close-surface --surface surface:7
cmux rename-tab --tab tab:7 "build logs"
cmux trigger-flash --surface surface:7             # attention cue
```

### Drive a terminal surface

```bash
# read what's on screen (defaults to caller's surface if no handle)
cmux read-screen --workspace workspace:6 --surface surface:9 --lines 30
cmux read-screen --scrollback --lines 200

# inject input
cmux send     --surface surface:9 "ls -la"
cmux send-key --surface surface:9 Enter
cmux send-key --surface surface:9 C-c            # Ctrl-C
```

`send` and `send-key` also have `-panel` variants (`send-panel`, `send-key-panel`) that target a pane's currently-selected surface instead of a specific tab.

### Open files / URLs into a workspace

```bash
cmux <path>                                       # one-shot: open dir in a new workspace
cmux open ~/code/foo --workspace workspace:5      # route into an existing workspace
cmux open https://example.com --pane pane:5       # opens in a browser surface
```

### Browser surfaces (Playwright-style automation)

If a surface's `surface_type` is `browser`, you can drive it with `cmux browser ...`. The surface handle can be passed positionally or as `--surface`.

```bash
cmux browser open https://example.com               # creates a browser surface
cmux browser --surface surface:8 goto https://news.ycombinator.com
cmux browser --surface surface:8 snapshot --compact # accessibility tree, agent-friendly
cmux browser --surface surface:8 click  --selector "a.storylink"
cmux browser --surface surface:8 fill   --selector "input[name=q]" --text "cmux"
cmux browser --surface surface:8 press  --key Enter
cmux browser --surface surface:8 screenshot --out /tmp/page.png
cmux browser --surface surface:8 eval 'document.title'
cmux browser --surface surface:8 wait --selector "#results" --timeout 10
```

`cmux browser --help` lists the full surface API (cookies, storage, dialogs, find-by-role/text/label, etc.).

### Config & docs

```bash
cmux docs                       # topic index
cmux docs settings|shortcuts|api|browser|agents|dock
cmux settings path              # all config locations + schema URL
cmux config doctor              # validate config files
cmux reload-config              # reload cmux.json AND ~/.config/ghostty/config
cmux settings                   # open Settings UI
cmux settings cmux-json         # open cmux.json in editor
cmux shortcuts                  # list current keybindings
```

Settings live at `~/.config/cmux/cmux.json` (primary). Legacy files at `~/.config/cmux/settings.json` and `~/Library/Application Support/com.cmuxterm.app/settings.json` are read only as a fallback. **Always copy any existing `cmux.json` to a timestamped `.bak` before editing**, then `cmux reload-config` (no app restart needed).

Terminal-rendering settings (font, theme, cursor, transparency `background-opacity`, blur `background-blur`, scrollback) belong in **Ghostty config** at `~/.config/ghostty/config`, not cmux.json. `cmux reload-config` picks up both.

### Agent hook integrations

```bash
cmux hooks setup                              # install for every supported agent on PATH
cmux hooks <agent> install                    # install one
cmux hooks <agent> uninstall
cmux hooks feed --source <agent>              # Feed approval bridge
```

Supported agents: `codex, grok, opencode, pi, amp, cursor, gemini, rovodev (rovo), hermes-agent, copilot, codebuddy, factory, qoder`. Claude Code hooks are injected automatically by the cmux Claude wrapper — no manual install.

### Cloud / VM (requires login)

```bash
cmux auth status
cmux auth login                 # opens browser to sign in
cmux vm ls | new | rm | exec | shell | ssh
```

Verified: `cmux auth status` → `Not signed in.` on this machine. The `vm`/`cloud` subcommands need auth before they do anything.

### Events stream (for long-running automation)

```bash
cmux events --reconnect                       # tail all events
cmux events --name surface.focused --limit 5  # filter
cmux events --category workspace
```

## Idioms

- **Self-target from a script:** omit handles entirely. Most commands default to `caller`. So a script running inside a cmux terminal can do `cmux read-screen --lines 20` and get its own pane.
- **Target the focused surface:** `cmux identify --json | jq -r .focused.surface_ref`, then pass that ref.
- **Make sure cmux is reachable before scripting:** `cmux ping >/dev/null || { echo "cmux not running"; exit 1; }`.
- **Discover what an RPC method takes:** `cmux capabilities` lists every method; `cmux rpc <method> '{...}'` calls one directly when the CLI shape doesn't fit.

## Gotchas

- **Handle indexes are not stable.** `workspace:5` is "the 5th workspace right now," not a durable ID. Capture the UUID (`--id-format both`) if a script may outlive a reorder/close.
- **`cmux <path>` (no subcommand) is a special form** — it opens a directory in a new workspace and launches the app if needed. Don't mistake it for a subcommand parse error.
- **`tab:<n>` is only valid in `tab-action`.** Everywhere else use `surface:<n>` for the same thing.
- **`send` does NOT press Enter.** Combine with `cmux send-key … Enter`, or your text just sits at the prompt.
- **Editing `cmux.json` requires `cmux reload-config`** — file changes are not picked up automatically. Always back up first (the docs explicitly tell agents to make a timestamped `.bak`).
- **Ghostty config is separate.** Font/theme/transparency go in `~/.config/ghostty/config`. Putting them in `cmux.json` does nothing.
- **`vm`/`cloud` and `feedback` need `cmux auth login` first.** `cmux auth status` will say `Not signed in.` until then.
- **The Claude Code hook is auto-installed** by the cmux Claude wrapper. Don't run `cmux hooks claude install` — it's not in the agent list. Other agents (`codex`, `opencode`, etc.) do need manual `cmux hooks <agent> install`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `cmux ping` hangs or errors | App not running. Open `/Applications/cmux.app`, then retry. Check `~/Library/Application Support/cmux/cmux.sock` exists. |
| `auth required` on a command | `cmux auth login` (vm/cloud/feedback paths). For socket auth, set `CMUX_SOCKET_PASSWORD` or pass `--password`. |
| Settings edit had no effect | You edited `~/.config/cmux/settings.json` (legacy). Move the keys to `~/.config/cmux/cmux.json`, then `cmux reload-config`. |
| Terminal font/theme change didn't apply | Wrong file. Edit `~/.config/ghostty/config`, then `cmux reload-config`. |
| Handle `surface:7` suddenly points at a different tab | Indexes shifted after a close/reorder. Re-run `cmux identify --json` / `cmux tree` and capture the UUID with `--id-format uuids`. |

## Reference URLs (for fetching latest docs / schema)

```bash
curl -fsSL https://raw.githubusercontent.com/manaflow-ai/cmux/main/skills/cmux/SKILL.md
curl -fsSL https://raw.githubusercontent.com/manaflow-ai/cmux/main/docs/cli-contract.md
curl -fsSL https://raw.githubusercontent.com/manaflow-ai/cmux/main/web/data/cmux.schema.json
curl -fsSL https://raw.githubusercontent.com/manaflow-ai/cmux/main/web/data/cmux-shortcuts.ts
curl -fsSL https://raw.githubusercontent.com/manaflow-ai/cmux/main/docs/agent-hooks.md
curl -fsSL https://raw.githubusercontent.com/manaflow-ai/cmux/main/docs/feed.md
curl -fsSL https://raw.githubusercontent.com/manaflow-ai/cmux/main/docs/notifications.md
curl -fsSL https://raw.githubusercontent.com/manaflow-ai/cmux/main/docs/dock.md
curl -fsSL https://raw.githubusercontent.com/manaflow-ai/cmux/main/skills/cmux-browser/SKILL.md
```

`cmux docs <topic>` prints these URLs along with the relevant `useful commands` for each area — run it instead of guessing.
