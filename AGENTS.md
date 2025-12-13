# Agent Guide (ChatGPT 5.2 / Codex CLI)

This repo is a Bun + TypeScript CLI/TUI called **`res`** that manages **tmux sessions per project directory**.

## Quick start (local dev)
- Install deps: `bun install`
- Run CLI/TUI: `bun run res`
- Tests: `bun test`
- Typecheck: `bun run typecheck`
- Build standalone binary: `bun run build` (outputs `dist/res`)

## Repo layout
- `bin/res.ts` — CLI entrypoint (prints nice errors)
- `src/main.ts` — argument parsing + main behavior
- `src/state.ts` — state file read/write + helpers (`$XDG_STATE_HOME/resumer/state.json`)
- `src/tmux.ts` — tmux wrapper (create/kill/list/attach/capture, env vars)
- `src/ui/tui.ts` — main TUI (project mode + tmux mode)
- `src/ui/picker.ts` — small interactive picker UI
- `src/ui/term.ts` — TERM overrides for blessed
- `src/ui/blessed.ts` — blessed widget imports (see “Bun compile constraints”)

## Bun compile constraints (important)
This project is meant to ship as a **single Bun `--compile` binary**.

- **Do not** `import blessed from "blessed"` or `require("blessed")`.
  - Blessed dynamically requires many widgets and breaks Bun bundling.
  - Instead, import widgets via `src/ui/blessed.ts` and add new widget imports there if needed.
  - If you add widgets, also update `src/blessed-internals.d.ts` types.
- Keep the build excludes in `package.json`:
  - `bun build ... --compile -e term.js -e pty.js`
  - These exclude internal blessed deps referenced by the unused `Terminal` widget.

## Terminal/TUI constraints
- The TUI requires a TTY: `process.stdin.isTTY && process.stdout.isTTY`.
- **Ghostty:** `TERM=xterm-ghostty` includes a terminfo capability blessed can’t compile (`Setulc`).
  - Always create blessed screens with `terminal: getBlessedTerminalOverride()` (see `src/ui/term.ts`).
  - Users can override via `RESUMER_TUI_TERM` / `RESUMER_BLESSED_TERM` / `RES_TUI_TERM`.

## tmux constraints
- `tmux attach-session` must run with inherited stdio (TTY). If you pipe stdio, tmux fails with `open terminal failed: not a terminal`.
- When the TUI triggers an attach/switch, it must `screen.destroy()` first, then attach.

## State discipline (do not annoy users)
- Never add “demo”/“seed” projects or sessions automatically.
- Only write to the user’s state file as a direct result of an explicit user action/command.
- Prefer reconciling with tmux via session env vars instead of inventing data.

## Definition of done for changes
- `bun test` passes.
- `bun run typecheck` passes.
- If you changed UI/build/runtime behavior, ensure `bun run build` still works.
- If CLI flags or TUI keys change, update `README.md`.
