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

export function unsetTmuxEnv(sessionName: string, keys: string[]): void {
  for (const key of keys) {
    try {
      runTmuxRaw(["set-environment", "-t", sessionName, "-u", key]);
    } catch (err) {
      if (err instanceof TmuxError && /unknown variable/i.test(err.stderr)) continue;
      throw err;
    }
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

export type TmuxSessionInfo = {
  name: string;
  attached: number;
  windows: number;
  paneId?: string;
  currentCommand?: string;
  currentPath?: string;
};

export function listTmuxSessionInfo(): TmuxSessionInfo[] {
  try {
    const sessionsRaw = runTmuxRaw(["list-sessions", "-F", "#{session_name}\t#{session_attached}\t#{session_windows}"])
      .stdout.split("\n")
      .map((l) => l.trimEnd())
      .filter(Boolean);

    const byName = new Map<string, TmuxSessionInfo>();
    for (const line of sessionsRaw) {
      const [name, attachedRaw, windowsRaw] = line.split("\t");
      if (!name) continue;
      byName.set(name, {
        name,
        attached: Number.parseInt(attachedRaw ?? "0", 10) || 0,
        windows: Number.parseInt(windowsRaw ?? "0", 10) || 0,
      });
    }

    const panesRaw = runTmuxRaw([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{window_active}\t#{pane_active}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}",
    ])
      .stdout.split("\n")
      .map((l) => l.trimEnd())
      .filter(Boolean);

    const bestPaneBySession = new Map<string, { paneId: string; cmd: string; cwd: string }>();
    for (const line of panesRaw) {
      const [session, winActive, paneActive, paneId, cmd, cwd] = line.split("\t");
      if (!session || !paneId) continue;
      const isBest = winActive === "1" && paneActive === "1";
      if (isBest || !bestPaneBySession.has(session)) {
        bestPaneBySession.set(session, { paneId, cmd: cmd ?? "", cwd: cwd ?? "" });
      }
    }

    for (const [name, info] of byName.entries()) {
      const pane = bestPaneBySession.get(name);
      if (pane) {
        info.paneId = pane.paneId;
        info.currentCommand = pane.cmd;
        info.currentPath = pane.cwd;
      }
    }

    return Array.from(byName.values()).sort((a, b) => {
      if (a.attached !== b.attached) return b.attached - a.attached;
      return a.name.localeCompare(b.name);
    });
  } catch (err) {
    if (isNoServerError(err)) return [];
    throw err;
  }
}

export function getActivePaneIdForSession(sessionName: string): string | null {
  try {
    const rows = runTmuxRaw(["list-panes", "-t", sessionName, "-F", "#{window_active}\t#{pane_active}\t#{pane_id}"])
      .stdout.split("\n")
      .map((l) => l.trimEnd())
      .filter(Boolean);

    let fallback: string | null = null;
    for (const row of rows) {
      const [winActive, paneActive, paneId] = row.split("\t");
      if (!paneId) continue;
      if (!fallback) fallback = paneId;
      if (winActive === "1" && paneActive === "1") return paneId;
    }
    return fallback;
  } catch (err) {
    if (isNoServerError(err)) return null;
    if (err instanceof TmuxError) return null;
    throw err;
  }
}

export function captureTmuxPane(target: string, lines = 2000): string {
  const { stdout } = runTmuxRaw(["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", target]);
  return stdout;
}

export function setTmuxBuffer(bufferName: string, data: string): void {
  runTmuxRaw(["set-buffer", "-b", bufferName, data]);
}
