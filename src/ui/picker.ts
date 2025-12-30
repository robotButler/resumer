import { blessed } from "./blessed.ts";
import { getBlessedTerminalOverride } from "./term.ts";

// Mode colors for branding
const modeColors = {
  res: "#2a9d8f",       // teal
  tmux: "#f4a261",      // orange
  codex: "#e9c46a",     // gold
  claude: "#e63946",    // red
};

const colors = {
  accent: "#2a9d8f",    // default teal
  border: "#457b9d",
};

// Colored "resumer" title: r(teal) e(orange) s(gold) u(red) mer(white)
const coloredTitle =
  `{${modeColors.res}-fg}r{/}` +
  `{${modeColors.tmux}-fg}e{/}` +
  `{${modeColors.codex}-fg}s{/}` +
  `{${modeColors.claude}-fg}u{/}` +
  `{bold}mer{/bold}`;

export type PickerItem<T> = {
  label: string;
  value: T;
  hint?: string;
};

function styledKey(key: string): string {
  return `{#2a9d8f-fg}{bold}${key}{/bold}{/}`;
}

function styledHelp(items: Array<[string, string]>): string {
  return items
    .map(([key, desc]) => `${styledKey(key)}{gray-fg}:${desc}{/gray-fg}`)
    .join(" {gray-fg}·{/gray-fg} ");
}

export async function runPicker<T>(args: {
  title: string;
  items: PickerItem<T>[];
  help?: string;
}): Promise<T | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive picker requires a TTY.");
  }

  return await new Promise<T | null>((resolve) => {
    const term = getBlessedTerminalOverride();
    const screen = blessed.screen({ smartCSR: true, title: args.title, terminal: term });

    const header = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      height: 1,
      width: "100%",
      content: ` ${coloredTitle} {gray-fg}·{/gray-fg} {bold}${args.title}{/bold}`,
      tags: true,
      style: { bg: "default" },
    });

    const MIN_HEIGHT = 6;
    const termHeight = (screen as any).height || 24;
    const maxHeight = Math.max(MIN_HEIGHT, Math.floor((termHeight - 2) * 0.85));
    const contentHeight = args.items.length + 3;
    const listHeight = Math.min(Math.max(MIN_HEIGHT, contentHeight), maxHeight);

    const list = blessed.list({
      parent: screen,
      top: 1,
      left: 0,
      width: "100%",
      height: listHeight,
      keys: true,
      vi: true,
      mouse: true,
      border: "line",
      label: ` {#2a9d8f-fg}{bold}${args.title}{/bold}{/} `,
      style: {
        border: { fg: colors.border },
        selected: { bg: colors.accent, fg: "black", bold: true },
      },
      items: args.items.map((it) => {
        const label = `{bold}${it.label}{/bold}`;
        return it.hint ? `${label} {gray-fg}${it.hint}{/gray-fg}` : label;
      }),
      tags: true,
      scrollbar: {
        style: { bg: colors.accent },
      },
    });

    const defaultHelp = styledHelp([
      ["Enter", "select"],
      ["Esc", "cancel"],
      ["q", "cancel"],
    ]);

    const help = blessed.box({
      parent: screen,
      bottom: 0,
      left: 0,
      height: 1,
      width: "100%",
      content: args.help ?? defaultHelp,
      tags: true,
      style: { fg: "gray" },
    });

    function done(value: T | null) {
      screen.destroy();
      resolve(value);
    }

    screen.on("resize", () => {
      const h = (screen as any).height || 24;
      const maxH = Math.max(MIN_HEIGHT, Math.floor((h - 2) * 0.85));
      const contentH = args.items.length + 3;
      list.height = Math.min(Math.max(MIN_HEIGHT, contentH), maxH);
      screen.render();
    });

    screen.key(["escape", "q", "C-c"], () => done(null));
    list.on("select", (_: unknown, idx: number) => done(args.items[idx]?.value ?? null));

    list.focus();
    help.setFront();
    header.setFront();
    screen.render();
  });
}
