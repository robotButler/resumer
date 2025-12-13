import { spawnSync } from "node:child_process";

export class TmuxError extends Error {
  code: number;
  stderr: string;
  constructor(message: string, code: number, stderr: string) {
    super(message);
    this.name = "TmuxError";
    this.code = code;
    this.stderr = stderr;
  }
}

function runTmuxRaw(args: string[], opts?: { cwd?: string }): { stdout: string; stderr: string } {
  const res = spawnSync("tmux", args, { encoding: "utf8", cwd: opts?.cwd });
  if (res.error) {
    throw res.error;
  }
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  if (res.status !== 0) {
    throw new TmuxError(`tmux ${args.join(" ")} failed`, res.status ?? 1, stderr);
  }
  return { stdout, stderr };
}

function runTmuxInteractive(args: string[], opts?: { cwd?: string }): void {
  const res = spawnSync("tmux", args, {
    cwd: opts?.cwd,
    stdio: ["inherit", "inherit", "pipe"],
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const stderr = res.stderr ?? "";
    throw new TmuxError(`tmux ${args.join(" ")} failed`, res.status ?? 1, stderr);
  }
}

export function isTmuxInstalled(): boolean {
  const res = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  return !res.error && res.status === 0;
}

function isNoServerError(err: unknown): boolean {
  if (!(err instanceof TmuxError)) return false;
  return /no server running/i.test(err.stderr);
}

export function listTmuxSessions(): string[] {
  try {
    const { stdout } = runTmuxRaw(["list-sessions", "-F", "#{session_name}"]);
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    if (isNoServerError(err)) return [];
    throw err;
  }
}

export function hasTmuxSession(name: string): boolean {
  try {
    runTmuxRaw(["has-session", "-t", name]);
    return true;
  } catch (err) {
    if (isNoServerError(err)) return false;
    if (err instanceof TmuxError) return false;
    throw err;
  }
}

export function createTmuxSession(args: {
  name: string;
  cwd: string;
  windowName?: string;
  command?: string[];
}): void {
  const cmd = ["new-session", "-d", "-s", args.name, "-c", args.cwd];
  if (args.windowName) cmd.push("-n", args.windowName);
  if (args.command?.length) cmd.push(...args.command);
  runTmuxRaw(cmd);
}

export function killTmuxSession(name: string): void {
  runTmuxRaw(["kill-session", "-t", name]);
}

export function attachOrSwitchTmuxSession(name: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Cannot attach to tmux without a TTY (session: ${name}).`);
  }
  if (process.env.TMUX && process.env.TMUX_PANE) {
    runTmuxInteractive(["switch-client", "-t", name]);
    return;
  }
  runTmuxInteractive(["attach-session", "-t", name]);
}

export function setTmuxEnv(sessionName: string, vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    runTmuxRaw(["set-environment", "-t", sessionName, key, value]);
  }
}

export function getTmuxEnv(sessionName: string, key: string): string | null {
  try {
    const { stdout } = runTmuxRaw(["show-environment", "-t", sessionName, key]);
    const line = stdout.trim();
    if (!line) return null;
    if (line.startsWith(`-${key}`)) return null;
    const prefix = `${key}=`;
    if (!line.startsWith(prefix)) return null;
    return line.slice(prefix.length);
  } catch (err) {
    if (err instanceof TmuxError) return null;
    throw err;
  }
}
