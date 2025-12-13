#!/usr/bin/env bun
import { main } from "../src/main.ts";
import { TmuxError } from "../src/tmux.ts";

try {
  await main(process.argv.slice(2));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  const stderr = err instanceof TmuxError ? err.stderr.trim() : "";
  process.stderr.write(`res: ${message}\n`);
  if (stderr) process.stderr.write(stderr + "\n");
  process.exit(1);
}
