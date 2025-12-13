export function getBlessedTerminalOverride(): string | undefined {
  const override =
    process.env.RESUMER_TUI_TERM?.trim() ||
    process.env.RESUMER_BLESSED_TERM?.trim() ||
    process.env.RES_TUI_TERM?.trim();
  if (override) return override;

  const term = (process.env.TERM ?? "").toLowerCase();
  if (term.includes("ghostty")) return "xterm-256color";

  return undefined;
}

