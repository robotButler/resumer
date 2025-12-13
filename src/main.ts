import {
  computeProjectId,
  findProject,
  formatNewSessionName,
  listSessionsForProject,
  loadStateOrDefault,
  normalizeAndEnsureProject,
  removeProject,
  removeSession,
  touchSessionAttached,
  upsertSession,
  writeState,
} from "./state.ts";
import type { Project, SessionRecord, StateV1 } from "./types.ts";
import { nowIso } from "./time.ts";
import { isTmuxInstalled, listTmuxSessions, createTmuxSession, killTmuxSession, attachOrSwitchTmuxSession, setTmuxEnv, getTmuxEnv } from "./tmux.ts";
import { runMainTui } from "./ui/tui.ts";
import { runPicker } from "./ui/picker.ts";

type CliOptions = {
  help: boolean;
  create: boolean;
  del: boolean;
  delAll: boolean;
  session?: string;
  unregister: boolean;
  reset: boolean;
  yes: boolean;
};

function usage(): string {
  return [
    "resumer (res) - tmux sessions per project",
    "",
    "Usage:",
    "  res                           Open TUI",
    "  res <path>                    Register/open project session",
    "  res <path> <command...>        Match/create session by command (partial match)",
    "",
    "Options:",
    "  -c, --create                   Force new session creation",
    "  -d, --delete                   Delete session(s) (interactive unless -s used)",
    "  -a, --all                      With -d and <path>, delete all project sessions",
    "  -s, --session <name>           Target tmux session (for -d)",
    "  -u, --unregister               Remove project + kill its sessions",
    "      --reset                    Remove all projects/sessions (requires --yes)",
    "  -y, --yes                      Skip confirmation for destructive ops",
    "  -h, --help                     Show help",
    "",
  ].join("\n");
}

function parseArgs(argv: string[]): { opts: CliOptions; positionals: string[] } {
  const opts: CliOptions = {
    help: false,
    create: false,
    del: false,
    delAll: false,
    unregister: false,
    reset: false,
    yes: false,
  };
  const positionals: string[] = [];

  let stop = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!stop && arg === "--") {
      stop = true;
      continue;
    }
    if (!stop && (arg === "-h" || arg === "--help")) {
      opts.help = true;
      continue;
    }
    if (!stop && (arg === "-c" || arg === "--create")) {
      opts.create = true;
      continue;
    }
    if (!stop && (arg === "-d" || arg === "--delete" || arg === "--del")) {
      opts.del = true;
      continue;
    }
    if (!stop && (arg === "-a" || arg === "--all")) {
      opts.delAll = true;
      continue;
    }
    if (!stop && (arg === "-u" || arg === "--unregister")) {
      opts.unregister = true;
      continue;
    }
    if (!stop && arg === "--reset") {
      opts.reset = true;
      continue;
    }
    if (!stop && (arg === "-y" || arg === "--yes")) {
      opts.yes = true;
      continue;
    }
    if (!stop && (arg === "-s" || arg === "--session")) {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      opts.session = value;
      i++;
      continue;
    }
    positionals.push(arg);
  }

  return { opts, positionals };
}

function normalizeCommandArgs(commandArgs: string[]): string | undefined {
  if (!commandArgs.length) return undefined;
  const joined = commandArgs.join(" ").trim();
  return joined.length ? joined : undefined;
}

function reconcileStateWithTmux(state: StateV1): void {
  const liveNames = new Set(listTmuxSessions());

  for (const name of Object.keys(state.sessions)) {
    if (!liveNames.has(name)) delete state.sessions[name];
  }

  for (const name of liveNames) {
    if (state.sessions[name]) continue;
    if (!name.startsWith("res_")) continue;
    const projectPath = getTmuxEnv(name, "RESUMER_PROJECT_PATH");
    if (!projectPath) continue;
    const projectId = getTmuxEnv(name, "RESUMER_PROJECT_ID") ?? computeProjectId(projectPath);
    const cmd = getTmuxEnv(name, "RESUMER_COMMAND") ?? undefined;
    const createdAt = getTmuxEnv(name, "RESUMER_CREATED_AT") ?? nowIso();

    const projectName = projectPath.split("/").filter(Boolean).at(-1) ?? projectPath;
    const project: Project = state.projects[projectId] ?? {
      id: projectId,
      path: projectPath,
      name: projectName,
      createdAt,
      lastUsedAt: createdAt,
    };
    state.projects[projectId] = project;

    state.sessions[name] = {
      name,
      projectId,
      projectPath,
      createdAt,
      command: cmd,
    };
  }
}

function makeSessionCommandScript(command: string): string {
  const trimmed = command.trim();
  if (!trimmed.length) return `exec \"${process.env.SHELL ?? "bash"}\"`;
  return [
    trimmed,
    "code=$?",
    'echo ""',
    'echo "[resumer] command exited ($code). Starting shell..."',
    `exec \"${process.env.SHELL ?? "bash"}\"`,
  ].join("; ");
}

function createResumerSession(state: StateV1, project: Project, command?: string): SessionRecord {
  const name = formatNewSessionName(project.name, project.id);
  const windowName = project.name.slice(0, 30);

  const cmdArray = command
    ? ["bash", "-lc", makeSessionCommandScript(command)]
    : undefined;

  createTmuxSession({
    name,
    cwd: project.path,
    windowName,
    command: cmdArray,
  });

  setTmuxEnv(name, {
    RESUMER_MANAGED: "1",
    RESUMER_PROJECT_ID: project.id,
    RESUMER_PROJECT_PATH: project.path,
    RESUMER_COMMAND: command ?? "",
    RESUMER_CREATED_AT: nowIso(),
  });

  const record: SessionRecord = {
    name,
    projectId: project.id,
    projectPath: project.path,
    createdAt: nowIso(),
    command,
  };
  upsertSession(state, record);
  return record;
}

function attachSession(state: StateV1, name: string): void {
  touchSessionAttached(state, name);
  writeState(state);
  attachOrSwitchTmuxSession(name);
}

function sessionMatchesCommand(session: SessionRecord, needle: string): boolean {
  const hay = (session.command ?? "").toLowerCase();
  return hay.includes(needle.toLowerCase());
}

async function pickAndAttach(state: StateV1, sessions: SessionRecord[], title: string): Promise<void> {
  const picked = await runPicker<string>({
    title,
    items: sessions.map((s) => ({
      label: s.name,
      value: s.name,
      hint: (s.command?.trim().length ? s.command.trim() : "(shell)") as string,
    })),
  });
  if (!picked) return;
  attachSession(state, picked);
}

async function handleOpenPath(args: {
  state: StateV1;
  inputPath: string;
  command?: string;
  forceCreate: boolean;
}): Promise<void> {
  const project = normalizeAndEnsureProject(args.state, args.inputPath, process.cwd());
  reconcileStateWithTmux(args.state);

  const liveSessions = listSessionsForProject(args.state, project.id);

  if (args.forceCreate) {
    const sess = createResumerSession(args.state, project, args.command);
    writeState(args.state);
    attachSession(args.state, sess.name);
    return;
  }

  if (args.command) {
    const matches = liveSessions.filter((s) => sessionMatchesCommand(s, args.command!));
    if (matches.length === 0) {
      const sess = createResumerSession(args.state, project, args.command);
      writeState(args.state);
      attachSession(args.state, sess.name);
      return;
    }
    if (matches.length === 1) {
      attachSession(args.state, matches[0]!.name);
      return;
    }
    await pickAndAttach(args.state, matches, `Pick session (${project.name})`);
    return;
  }

  if (liveSessions.length === 0) {
    const sess = createResumerSession(args.state, project);
    writeState(args.state);
    attachSession(args.state, sess.name);
    return;
  }

  if (liveSessions.length === 1) {
    attachSession(args.state, liveSessions[0]!.name);
    return;
  }

  await pickAndAttach(args.state, liveSessions, `Pick session (${project.name})`);
}

async function handleDelete(args: {
  state: StateV1;
  inputPath?: string;
  sessionName?: string;
  deleteAll: boolean;
}): Promise<void> {
  reconcileStateWithTmux(args.state);

  if (args.sessionName) {
    killTmuxSession(args.sessionName);
    removeSession(args.state, args.sessionName);
    writeState(args.state);
    return;
  }

  if (args.inputPath) {
    const project = findProject(args.state, args.inputPath, process.cwd());
    if (!project) throw new Error(`Project not registered: ${args.inputPath}`);
    const sessions = listSessionsForProject(args.state, project.id);
    if (!sessions.length) return;

    if (args.deleteAll) {
      for (const sess of sessions) {
        try {
          killTmuxSession(sess.name);
        } catch {
          // ignore
        }
        removeSession(args.state, sess.name);
      }
      writeState(args.state);
      return;
    }

    if (sessions.length === 1) {
      try {
        killTmuxSession(sessions[0]!.name);
      } catch {
        // ignore
      }
      removeSession(args.state, sessions[0]!.name);
      writeState(args.state);
      return;
    }

    const picked = await runPicker<string>({
      title: `Delete session (${project.name})`,
      items: sessions.map((s) => ({
        label: s.name,
        value: s.name,
        hint: s.command?.trim().length ? s.command.trim() : "(shell)",
      })),
      help: "Enter: delete · Esc/q: cancel",
    });
    if (!picked) return;
    try {
      killTmuxSession(picked);
    } catch {
      // ignore
    }
    removeSession(args.state, picked);
    writeState(args.state);
    return;
  }

  const all = Object.values(args.state.sessions);
  if (!all.length) return;
  const picked = await runPicker<string>({
    title: "Delete session",
    items: all.map((s) => ({
      label: s.name,
      value: s.name,
      hint: `${args.state.projects[s.projectId]?.name ?? "?"} · ${s.command?.trim().length ? s.command.trim() : "(shell)"}`,
    })),
    help: "Enter: delete · Esc/q: cancel",
  });
  if (!picked) return;
  try {
    killTmuxSession(picked);
  } catch {
    // ignore
  }
  removeSession(args.state, picked);
  writeState(args.state);
}

async function handleUnregister(args: { state: StateV1; selector: string }): Promise<void> {
  reconcileStateWithTmux(args.state);
  const project = findProject(args.state, args.selector, process.cwd());
  if (!project) throw new Error(`Project not registered: ${args.selector}`);

  const sessions = listSessionsForProject(args.state, project.id);
  for (const sess of sessions) {
    try {
      killTmuxSession(sess.name);
    } catch {
      // ignore
    }
    removeSession(args.state, sess.name);
  }
  removeProject(args.state, project.id);
  writeState(args.state);
}

async function handleReset(args: { state: StateV1; yes: boolean }): Promise<void> {
  if (!args.yes) {
    throw new Error("Refusing to reset without --yes.");
  }
  reconcileStateWithTmux(args.state);
  for (const name of Object.keys(args.state.sessions)) {
    try {
      killTmuxSession(name);
    } catch {
      // ignore
    }
    removeSession(args.state, name);
  }
  for (const id of Object.keys(args.state.projects)) {
    delete args.state.projects[id];
  }
  writeState(args.state);
}

export async function main(argv: string[]): Promise<void> {
  const { opts, positionals } = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(usage());
    return;
  }

  if (!isTmuxInstalled()) {
    throw new Error("tmux is not installed or not on PATH.");
  }

  const state = loadStateOrDefault();
  reconcileStateWithTmux(state);
  writeState(state);

  const inputPath = positionals[0];
  const command = normalizeCommandArgs(positionals.slice(1));

  if (opts.reset) {
    await handleReset({ state, yes: opts.yes });
    return;
  }

  if (opts.unregister) {
    if (!inputPath) throw new Error("--unregister requires a project path or id.");
    await handleUnregister({ state, selector: inputPath });
    return;
  }

  if (opts.del) {
    await handleDelete({ state, inputPath, sessionName: opts.session, deleteAll: opts.delAll });
    return;
  }

  if (!inputPath) {
    await runMainTui({
      state,
      actions: {
        refreshLiveSessions: () => reconcileStateWithTmux(state),
        createSession: (project, cmd) => createResumerSession(state, project, cmd),
        deleteSession: (sessionName) => {
          try {
            killTmuxSession(sessionName);
          } catch {
            // ignore
          }
          removeSession(state, sessionName);
        },
        attachSession: (sessionName) => attachSession(state, sessionName),
      },
    });
    return;
  }

  await handleOpenPath({ state, inputPath, command, forceCreate: opts.create });
}
