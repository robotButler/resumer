# Claude Guide (Claude 4.5)

You are working in the **`resumer`** repo: a Bun + TypeScript CLI/TUI (`res`) for managing **tmux sessions per project directory**.

## What to do first
- Read `README.md` for user-facing behavior and flags.
- Use `rg` to find existing patterns before adding new code.

## Commands
- Install: `bun install`
- Run: `bun run res`
- Tests: `bun test`
- Typecheck: `bun run typecheck`
- Build binary: `bun run build` → `dist/res`

## Architecture (where changes go)
- CLI entry: `bin/res.ts`
- Main logic: `src/main.ts`
- State file + helpers: `src/state.ts` (`$XDG_STATE_HOME/resumer/state.json`)
- tmux wrapper: `src/tmux.ts`
- TUI: `src/ui/tui.ts`
- Picker UI: `src/ui/picker.ts`
- TERM handling: `src/ui/term.ts`
- Blessed imports: `src/ui/blessed.ts`

## Hard constraints (do not break these)
- **Bun `--compile` must keep working.**
  - Do **not** import blessed as a whole (`import "blessed"` / `require("blessed")`).
  - Only import the blessed widgets you use via `src/ui/blessed.ts`.
  - If you introduce a new blessed widget, add it to `src/ui/blessed.ts` and update `src/blessed-internals.d.ts`.
  - Keep `bun build ... -e term.js -e pty.js` in `package.json` (these are excluded bundler deps).
- **TUI requires a TTY.** Avoid running attach/capture flows from non-interactive contexts.
- **tmux attach requires inherited stdio.** Don’t pipe stdio when attaching/switching.

## Known terminal edge case
- Ghostty sets `TERM=xterm-ghostty` and blessed can crash compiling an extended terminfo capability.
  - Always pass `terminal: getBlessedTerminalOverride()` when creating blessed screens (see `src/ui/term.ts`).

## Don’ts
- Don’t generate or persist sample projects/sessions.
- Don’t “fix” unrelated style or refactor broadly.
- Don’t add dependencies unless necessary (prefer small, local code).

## When you’re done
- Run `bun test` and `bun run typecheck`.
- If you touched runtime behavior, also run `bun run build`.
- Update `README.md` if user-visible behavior changed.
