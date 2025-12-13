import { blessed } from "./blessed.ts";
import { getBlessedTerminalOverride } from "./term.ts";

export type PickerItem<T> = {
  label: string;
  value: T;
  hint?: string;
};

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

    const list = blessed.list({
      parent: screen,
      top: 1,
      left: 0,
      width: "100%",
      height: "100%-2",
      keys: true,
      vi: true,
      mouse: true,
      border: "line",
      label: ` ${args.title} `,
      style: {
        selected: { bg: "blue", fg: "white" },
      },
      items: args.items.map((it) => (it.hint ? `${it.label} {gray-fg}${it.hint}{/}` : it.label)),
      tags: true,
      scrollbar: {
        style: { bg: "blue" },
      },
    });

    const help = blessed.box({
      parent: screen,
      bottom: 0,
      left: 0,
      height: 1,
      width: "100%",
      content: args.help ?? "Enter: select · Esc/q: cancel",
      style: { fg: "gray" },
    });

    function done(value: T | null) {
      screen.destroy();
      resolve(value);
    }

    screen.key(["escape", "q", "C-c"], () => done(null));
    list.on("select", (_: unknown, idx: number) => done(args.items[idx]?.value ?? null));

    list.focus();
    help.setFront();
    screen.render();
  });
}
