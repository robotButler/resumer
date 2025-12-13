# resumer (`res`)
Track tmux sessions per project directory, with a simple CLI + TUI.

## Quick install

### From GitHub Releases (recommended)
```bash
curl -fsSL https://raw.githubusercontent.com/robotButler/resumer/main/install.sh | bash
```

### From source (requires Bun)
```bash
./scripts/install-local.sh
```

## Install (from this repo)
- `bun install`
- Run locally: `bun run bin/res.ts --help`
- Optional: add a shell alias: `alias res='bun run /path/to/resumer/bin/res.ts'`

## Standalone binary
Build a single executable for your current OS/arch:
- `bun run build`

Install it somewhere on your `PATH` (example):
```bash
install -m 755 ./dist/res ~/.local/bin/res
```

Notes:
- The compiled binary is OS/arch-specific; build again for other machines.
- You still need `tmux` installed on the target machine.

## Usage

### Open the project/session TUI
```bash
res
```

TUI modes:
- **res mode** (default): per-project sessions
  - `t` switches to tmux mode
- **tmux mode**: all tmux sessions
  - `p` switches back to res mode
  - `Enter` attach · `d` delete · `c` capture pane · `y` copy session name · `l` associate → project · `u` unassociate
- **codex mode** (read-only): local Codex CLI sessions
  - `3` switches to codex mode
  - `Enter` view · `y` copy session id
- **claude mode** (read-only): local Claude sessions
  - `4` switches to claude mode
  - `Enter` view · `y` copy session id

Mode switching (from anywhere):
- `1` res · `2` tmux · `3` codex · `4` claude

### Open a project (registers if needed)
```bash
res /path/to/project
```

### Open a project session matching a command (partial matches)
```bash
res /path/to/project "bun run dev"
```

### Force a new tmux session
```bash
res -c /path/to/project
res -c /path/to/project "bun run dev"
```

### Delete sessions
```bash
res -d                    # interactive picker (all projects)
res -d /path/to/project   # interactive picker (project only)
res -d -s <tmuxSession>   # delete by tmux session name
res -d -a /path/to/project  # delete all sessions for project
```

### Associate an existing tmux session with a project
```bash
res -l /path/to/project -s mysession
res -l /path/to/project            # interactive picker
```

### Remove projects
```bash
res -u /path/to/project     # unregister project (kills its sessions)
res --reset --yes           # wipe all resumer state (kills all tracked sessions)
```

## Data location
State is stored in:
- `$XDG_STATE_HOME/resumer/state.json`, or
- `~/.local/state/resumer/state.json`
