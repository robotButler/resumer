import { blessed } from "./blessed.ts";
import { getBlessedTerminalOverride } from "./term.ts";

const colors = {
  accent: "magenta",
  selected: {
    bg: "#6272a4",
    fg: "white",
  },
  border: "#6272a4",
};

export type PickerItem<T> = {
  label: string;
  value: T;
  hint?: string;
};

function styledKey(key: string): string {
  return `{magenta-fg}{bold}${key}{/bold}{/magenta-fg}`;
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
      content: `{magenta-fg}{bold}resumer{/bold}{/magenta-fg} {gray-fg}·{/gray-fg} {bold}${args.title}{/bold}`,
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
      label: ` {magenta-fg}{bold}${args.title}{/bold}{/magenta-fg} `,
      style: {
        border: { fg: colors.border },
        selected: { bg: colors.selected.bg, fg: colors.selected.fg, bold: true },
        label: { fg: colors.accent },
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
