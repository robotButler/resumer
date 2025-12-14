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
import { copyToSystemClipboard } from "./clipboard.ts";
import { formatCodexSessionDetails, listCodexSessions, type CodexSessionSummary } from "./external/codex.ts";
import { formatClaudeSessionDetails, listClaudeSessions, type ClaudeSessionSummary } from "./external/claude.ts";
import { getClaudeDefaultArgs, getCodexDefaultArgs, loadConfigOrDefault } from "./config.ts";
import { shJoin } from "./shell.ts";
import {
  attachOrSwitchTmuxSession,
  captureTmuxPane,
  createTmuxSession,
  getActivePaneIdForSession,
  getTmuxEnv,
  hasTmuxSession,
  isTmuxInstalled,
  killTmuxSession,
  listTmuxSessionInfo,
  listTmuxSessions,
  setTmuxEnv,
  setTmuxBuffer,
  unsetTmuxEnv,
} from "./tmux.ts";
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
  link: boolean;
};

function usage(): string {
  return [
    "resumer (res) - tmux sessions per project",
    "",
    "Usage:",
    "  res                           Open TUI",
    "  res <path>                    Register/open project session",
    "  res <path> <command...>        Match/create session by command (partial match)",
    "  res --link <path> -s <name>    Associate an existing tmux session with a project",
    "",
    "Options:",
    "  -c, --create                   Force new session creation",
    "  -d, --delete                   Delete session(s) (interactive unless -s used)",
    "  -a, --all                      With -d and <path>, delete all project sessions",
    "  -s, --session <name>           Target tmux session (for -d)",
    "  -u, --unregister               Remove project + kill its sessions",
    "  -l, --link                     Associate an existing tmux session with a project",
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
    link: false,
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
    if (!stop && (arg === "-l" || arg === "--link")) {
      opts.link = true;
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
    const projectPath = getTmuxEnv(name, "RESUMER_PROJECT_PATH");
    if (!projectPath) continue;
    const projectId = getTmuxEnv(name, "RESUMER_PROJECT_ID") ?? computeProjectId(projectPath);
    const cmdRaw = getTmuxEnv(name, "RESUMER_COMMAND");
    const cmd = cmdRaw && cmdRaw.trim().length ? cmdRaw : undefined;
    const createdAt = getTmuxEnv(name, "RESUMER_CREATED_AT") ?? nowIso();
    const managed = getTmuxEnv(name, "RESUMER_MANAGED") === "1";

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
      kind: managed ? "managed" : "linked",
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
    kind: "managed",
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

async function handleLink(args: {
  state: StateV1;
  inputPath: string;
  sessionName?: string;
  yes: boolean;
}): Promise<void> {
  const project = normalizeAndEnsureProject(args.state, args.inputPath, process.cwd());
  reconcileStateWithTmux(args.state);

  let name = args.sessionName?.trim();
  if (!name) {
    const live = listTmuxSessions();
    if (!live.length) throw new Error("No tmux sessions found.");

    const picked = await runPicker<string>({
      title: `Link tmux session → ${project.name}`,
      items: live.map((s) => {
        const existing = args.state.sessions[s];
        const existingProject =
          existing && args.state.projects[existing.projectId]
            ? args.state.projects[existing.projectId]!.name
            : existing
              ? existing.projectId
              : "";
        return {
          label: s,
          value: s,
          hint: existingProject ? `currently: ${existingProject}` : undefined,
        };
      }),
      help: "Enter: link · Esc/q: cancel",
    });
    if (!picked) return;
    name = picked;
  } else {
    if (!hasTmuxSession(name)) throw new Error(`tmux session not found: ${name}`);
  }

  const existing = args.state.sessions[name];
  if (existing && existing.projectId !== project.id && !args.yes) {
    const existingProject = args.state.projects[existing.projectId]?.name ?? existing.projectId;
    throw new Error(
      `tmux session '${name}' is already associated with ${existingProject}. Re-run with --yes to move it.`,
    );
  }

  const createdAt = existing?.createdAt ?? nowIso();
  setTmuxEnv(name, {
    RESUMER_MANAGED: existing?.kind === "managed" ? "1" : "0",
    RESUMER_ASSOCIATED: "1",
    RESUMER_PROJECT_ID: project.id,
    RESUMER_PROJECT_PATH: project.path,
    RESUMER_COMMAND: existing?.command ?? "",
    RESUMER_CREATED_AT: createdAt,
  });

  const record: SessionRecord = {
    name,
    projectId: project.id,
    projectPath: project.path,
    createdAt,
    command: existing?.command,
    kind: existing?.kind === "managed" ? "managed" : "linked",
    lastAttachedAt: existing?.lastAttachedAt,
  };
  upsertSession(args.state, record);
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

  const config = loadConfigOrDefault();
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

  if (opts.link) {
    if (!inputPath) throw new Error("--link requires a project path.");
    await handleLink({ state, inputPath, sessionName: opts.session, yes: opts.yes });
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
        listTmuxSessions: () => listTmuxSessionInfo(),
        listCodexSessions: () => listCodexSessions(),
        codexSessionDetails: (session: CodexSessionSummary) => formatCodexSessionDetails(session),
        codexResumeCommand: (sessionId: string) => shJoin(["codex", ...getCodexDefaultArgs(config), "resume", sessionId]),
        listClaudeSessions: () => listClaudeSessions(),
        claudeSessionDetails: (session: ClaudeSessionSummary) => formatClaudeSessionDetails(session),
        claudeResumeCommand: (sessionId: string) =>
          shJoin(["claude", ...getClaudeDefaultArgs(config), "--resume", sessionId]),
        createSession: (project, cmd) => createResumerSession(state, project, cmd),
        deleteSession: (sessionName) => {
          try {
            killTmuxSession(sessionName);
          } catch {
            // ignore
          }
          removeSession(state, sessionName);
        },
        unassociateSession: (sessionName) => {
          if (!hasTmuxSession(sessionName)) throw new Error(`tmux session not found: ${sessionName}`);
          unsetTmuxEnv(sessionName, [
            "RESUMER_MANAGED",
            "RESUMER_ASSOCIATED",
            "RESUMER_PROJECT_ID",
            "RESUMER_PROJECT_PATH",
            "RESUMER_COMMAND",
            "RESUMER_CREATED_AT",
          ]);
          removeSession(state, sessionName);
        },
        captureSessionPane: (sessionName) => {
          const paneId = getActivePaneIdForSession(sessionName);
          if (!paneId) throw new Error(`Could not find an active pane for session: ${sessionName}`);
          return captureTmuxPane(paneId);
        },
        copyText: (text) => {
          const res = copyToSystemClipboard(text);
          if (res.ok) return { method: res.method };
          try {
            setTmuxBuffer("resumer", text);
            return { method: "tmux-buffer(resumer)" };
          } catch {
            throw new Error(res.error);
          }
        },
        linkSession: (project, sessionName, yes) => {
          if (!hasTmuxSession(sessionName)) throw new Error(`tmux session not found: ${sessionName}`);
          const existing = state.sessions[sessionName];
          if (existing && existing.projectId !== project.id && !yes) {
            const existingProject = state.projects[existing.projectId]?.name ?? existing.projectId;
            throw new Error(
              `tmux session '${sessionName}' is already associated with ${existingProject}. Re-run with --yes to move it.`,
            );
          }
          const createdAt = existing?.createdAt ?? nowIso();
          setTmuxEnv(sessionName, {
            RESUMER_MANAGED: existing?.kind === "managed" ? "1" : "0",
            RESUMER_ASSOCIATED: "1",
            RESUMER_PROJECT_ID: project.id,
            RESUMER_PROJECT_PATH: project.path,
            RESUMER_COMMAND: existing?.command ?? "",
            RESUMER_CREATED_AT: createdAt,
          });
          upsertSession(state, {
            name: sessionName,
            projectId: project.id,
            projectPath: project.path,
            createdAt,
            command: existing?.command,
            kind: existing?.kind === "managed" ? "managed" : "linked",
            lastAttachedAt: existing?.lastAttachedAt,
          });
        },
        attachSession: (sessionName) => attachSession(state, sessionName),
      },
    });
    return;
  }

  await handleOpenPath({ state, inputPath, command, forceCreate: opts.create });
}
