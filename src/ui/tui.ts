import { blessed } from "./blessed.ts";
import type { Widgets } from "blessed";
import type { Project, SessionRecord, StateV1 } from "../types.ts";
import { listProjects, listSessionsForProject, normalizeAndEnsureProject, writeState } from "../state.ts";
import { nowIso } from "../time.ts";
import type { TmuxSessionInfo } from "../tmux.ts";
import { getBlessedTerminalOverride } from "./term.ts";
import type { CodexSessionSummary } from "../external/codex.ts";
import type { ClaudeSessionSummary } from "../external/claude.ts";

const colors = {
  accent: "magenta",
  selected: {
    bg: "#6272a4",
    fg: "white",
  },
  border: "#6272a4",
};

export type TuiActions = {
  refreshLiveSessions(): void;
  listTmuxSessions(): TmuxSessionInfo[];
  listCodexSessions(): CodexSessionSummary[];
  codexSessionDetails(session: CodexSessionSummary): string;
  codexResumeCommand(sessionId: string): string;
  listClaudeSessions(): ClaudeSessionSummary[];
  claudeSessionDetails(session: ClaudeSessionSummary): string;
  claudeResumeCommand(sessionId: string): string;
  createSession(project: Project, command?: string): SessionRecord;
  deleteSession(sessionName: string): void;
  unassociateSession(sessionName: string): void;
  captureSessionPane(sessionName: string): string;
  copyText(text: string): { method: string };
  linkSession(project: Project, sessionName: string, yes: boolean): void;
  attachSession(sessionName: string): void;
};

function sessionLabel(s: SessionRecord): string {
  const cmd = s.command?.trim().length ? s.command.trim() : "(shell)";
  const kind = s.kind === "linked" ? "{cyan-fg}linked{/cyan-fg}" : s.kind === "managed" ? "{green-fg}managed{/green-fg}" : "";
  const suffix = kind ? ` {gray-fg}·{/gray-fg} ${kind}` : "";
  return `{bold}${s.name}{/bold} {gray-fg}${cmd}{/gray-fg}${suffix}`;
}

function tmuxSessionLabel(info: TmuxSessionInfo, state: StateV1): string {
  const tracked = state.sessions[info.name];
  const project = tracked ? state.projects[tracked.projectId] : undefined;
  const trackedCmd = tracked?.command?.trim().length ? tracked.command.trim() : "";
  const cmd = trackedCmd || info.currentCommand?.trim() || "(unknown)";
  const projectHint = project ? ` {gray-fg}·{/gray-fg} {cyan-fg}${project.name}{/cyan-fg}` : "";
  const attachedHint = info.attached ? ` {gray-fg}·{/gray-fg} {green-fg}attached:${info.attached}{/green-fg}` : "";
  return `{bold}${info.name}{/bold} {gray-fg}${cmd}{/gray-fg}${projectHint}${attachedHint}`;
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + "…";
}

function codexSessionLabel(info: CodexSessionSummary): string {
  const cwd = info.cwd ? ` {gray-fg}${info.cwd}{/gray-fg}` : "";
  const when = info.lastActivityAt ? ` {gray-fg}·{/gray-fg} {green-fg}${info.lastActivityAt}{/green-fg}` : "";
  const prompt = info.lastPrompt ? ` {gray-fg}·{/gray-fg} {gray-fg}${truncate(info.lastPrompt, 80)}{/gray-fg}` : "";
  const id = info.id.length > 12 ? info.id.slice(0, 12) : info.id;
  return `{bold}${id}{/bold}${cwd}${when}${prompt}`;
}

function claudeSessionLabel(info: ClaudeSessionSummary): string {
  const project = info.projectPath ? ` {gray-fg}${info.projectPath}{/gray-fg}` : "";
  const when = info.lastActivityAt ? ` {gray-fg}·{/gray-fg} {green-fg}${info.lastActivityAt}{/green-fg}` : "";
  const model = info.model ? ` {gray-fg}·{/gray-fg} {cyan-fg}${info.model}{/cyan-fg}` : "";
  const prompt = info.lastPrompt ? ` {gray-fg}·{/gray-fg} {gray-fg}${truncate(info.lastPrompt, 80)}{/gray-fg}` : "";
  const id = info.id.length > 12 ? info.id.slice(0, 12) : info.id;
  return `{bold}${id}{/bold}${project}${when}${model}${prompt}`;
}

function getSelectedIndex(list: Widgets.ListElement): number {
  const selected = (list as any).selected;
  return typeof selected === "number" ? selected : 0;
}

export async function runMainTui(args: {
  state: StateV1;
  actions: TuiActions;
}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("res TUI requires a TTY.");
  }

  return await new Promise<void>((resolve, reject) => {
    const term = getBlessedTerminalOverride();
    const screen = blessed.screen({ smartCSR: true, title: "resumer", terminal: term });

    const header = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      height: 1,
      width: "100%",
      content: "",
      tags: true,
      style: { bg: "default" },
    });

    const projectsBox = blessed.list({
      parent: screen,
      top: 1,
      left: 0,
      width: "45%",
      height: "100%-2",
      keys: true,
      vi: true,
      mouse: true,
      border: "line",
      label: " {magenta-fg}{bold}Projects{/bold}{/magenta-fg} ",
      style: {
        border: { fg: colors.border },
        selected: { bg: colors.selected.bg, fg: colors.selected.fg, bold: true },
        label: { fg: colors.accent },
      },
      scrollbar: { style: { bg: colors.accent } },
      tags: true,
    });

    const sessionsBox = blessed.list({
      parent: screen,
      top: 1,
      left: "45%",
      width: "55%",
      height: "100%-2",
      keys: true,
      vi: true,
      mouse: true,
      border: "line",
      label: " {magenta-fg}{bold}Sessions{/bold}{/magenta-fg} ",
      style: {
        border: { fg: colors.border },
        selected: { bg: colors.selected.bg, fg: colors.selected.fg, bold: true },
        label: { fg: colors.accent },
      },
      scrollbar: { style: { bg: colors.accent } },
      tags: true,
    });

    const tmuxBox = blessed.list({
      parent: screen,
      top: 1,
      left: 0,
      width: "100%",
      height: "100%-2",
      keys: true,
      vi: true,
      mouse: true,
      border: "line",
      label: " {magenta-fg}{bold}tmux Sessions{/bold}{/magenta-fg} ",
      style: {
        border: { fg: colors.border },
        selected: { bg: colors.selected.bg, fg: colors.selected.fg, bold: true },
        label: { fg: colors.accent },
      },
      scrollbar: { style: { bg: colors.accent } },
      tags: true,
      hidden: true,
    });

    const footer = blessed.box({
      parent: screen,
      bottom: 0,
      left: 0,
      height: 1,
      width: "100%",
      content: "",
      tags: true,
      style: { fg: "gray" },
    });

    const prompt = blessed.prompt({
      parent: screen,
      border: "line",
      height: 7,
      width: "60%",
      top: "center",
      left: "center",
      label: " {magenta-fg}{bold}Input{/bold}{/magenta-fg} ",
      tags: true,
      hidden: true,
      style: { border: { fg: colors.accent } },
    });

    const question = blessed.question({
      parent: screen,
      border: "line",
      height: 7,
      width: "60%",
      top: "center",
      left: "center",
      label: " {magenta-fg}{bold}Confirm{/bold}{/magenta-fg} ",
      tags: true,
      hidden: true,
      style: { border: { fg: colors.accent } },
    });

    let mode: "res" | "tmux" | "codex" | "claude" = "res";
    let focused: "projects" | "sessions" = "projects";
    let projects: Project[] = [];
    let sessions: SessionRecord[] = [];
    let selectedProject: Project | null = null;
    let selectedProjectIndex = 0;

    let tmuxSessions: TmuxSessionInfo[] = [];
    let selectedTmuxIndex = 0;

    let codexSessions: CodexSessionSummary[] = [];
    let selectedCodexIndex = 0;

    let claudeSessions: ClaudeSessionSummary[] = [];
    let selectedClaudeIndex = 0;

    let modalClose: (() => void) | null = null;

    let footerTimer: ReturnType<typeof setTimeout> | null = null;
    function updateHeader() {
      const projectName = selectedProject ? selectedProject.name : "";
      const projectHint = mode === "res" && projectName ? ` {gray-fg}·{/gray-fg} ${projectName}` : "";
      const modeTag =
        mode === "tmux"
          ? "{green-fg}{bold}tmux{/bold}{/green-fg}"
          : mode === "codex"
            ? "{magenta-fg}{bold}codex{/bold}{/magenta-fg}"
            : mode === "claude"
              ? "{yellow-fg}{bold}claude{/bold}{/yellow-fg}"
              : "{cyan-fg}{bold}res{/bold}{/cyan-fg}";
      header.setContent(` {magenta-fg}{bold}resumer{/bold}{/magenta-fg} {gray-fg}·{/gray-fg} ${modeTag}${projectHint}`);
    }
    function updateFooter() {
      updateHeader();
      if (mode === "tmux") {
        footer.setContent(
          "Mode: tmux (1: res, 3: codex, 4: claude) · Enter: attach · d: delete · c: capture · y: copy name · l: associate · u: unassociate · r: refresh · q: quit",
        );
        return;
      }
      if (mode === "codex") {
        footer.setContent(
          "Mode: codex (1: res, 2: tmux, 4: claude) · Enter: view · c: tmux · y: copy id · r: refresh · q: quit",
        );
        return;
      }
      if (mode === "claude") {
        footer.setContent(
          "Mode: claude (1: res, 2: tmux, 3: codex) · Enter: view · c: tmux · y: copy id · r: refresh · q: quit",
        );
        return;
      }
      footer.setContent(
        "Mode: res (2: tmux, 3: codex, 4: claude) · Tab: focus · Enter: attach · c: create · d: delete · l: link · a: add · x: remove · r: refresh · q: quit",
      );
    }

    function flashFooter(message: string, ms = 1500) {
      if (footerTimer) clearTimeout(footerTimer);
      footer.setContent(message);
      screen.render();
      footerTimer = setTimeout(() => {
        updateFooter();
        screen.render();
      }, ms);
    }

    function fail(err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        screen.destroy();
      } catch {
        // ignore
      }
      reject(new Error(message));
    }

    function showError(text: string) {
      question.ask(`Error:\n${text}\n\nOK?`, () => refresh());
    }

    function refreshResMode() {
      projects = listProjects(args.state);
      const items = projects.map((p) => `${p.name} {gray-fg}${p.path}{/}`);
      projectsBox.setItems(items);

      selectedProjectIndex = Math.min(selectedProjectIndex, Math.max(0, projects.length - 1));
      projectsBox.select(selectedProjectIndex);

      selectedProject = projects[selectedProjectIndex] ?? null;
      refreshSessionsForSelectedProject();
    }

    function refreshTmuxMode() {
      tmuxSessions = args.actions.listTmuxSessions();
      const items = tmuxSessions.map((s) => tmuxSessionLabel(s, args.state));
      tmuxBox.setLabel(" {magenta-fg}{bold}tmux Sessions{/bold}{/magenta-fg} ");
      tmuxBox.setItems(items.length ? items : ["(no tmux sessions)"]);
      selectedTmuxIndex = Math.min(selectedTmuxIndex, Math.max(0, tmuxSessions.length - 1));
      tmuxBox.select(selectedTmuxIndex);
    }

    function refreshCodexMode() {
      codexSessions = args.actions.listCodexSessions();
      tmuxBox.setLabel(" {magenta-fg}{bold}Codex Sessions{/bold}{/magenta-fg} ");
      const items = codexSessions.map((s) => codexSessionLabel(s));
      tmuxBox.setItems(items.length ? items : ["(no Codex sessions found)"]);
      selectedCodexIndex = Math.min(selectedCodexIndex, Math.max(0, codexSessions.length - 1));
      tmuxBox.select(selectedCodexIndex);
    }

    function refreshClaudeMode() {
      claudeSessions = args.actions.listClaudeSessions();
      tmuxBox.setLabel(" {magenta-fg}{bold}Claude Sessions{/bold}{/magenta-fg} ");
      const items = claudeSessions.map((s) => claudeSessionLabel(s));
      tmuxBox.setItems(items.length ? items : ["(no Claude sessions found)"]);
      selectedClaudeIndex = Math.min(selectedClaudeIndex, Math.max(0, claudeSessions.length - 1));
      tmuxBox.select(selectedClaudeIndex);
    }

    function refresh() {
      try {
        args.actions.refreshLiveSessions();
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
        return;
      }
      if (mode === "tmux") refreshTmuxMode();
      else if (mode === "codex") refreshCodexMode();
      else if (mode === "claude") refreshClaudeMode();
      else refreshResMode();
      updateHeader();
      screen.render();
    }

    function refreshSessionsForSelectedProject() {
      if (!selectedProject) {
        sessions = [];
        sessionsBox.setItems(["(no projects)"]);
        sessionsBox.select(0);
        return;
      }
      sessions = listSessionsForProject(args.state, selectedProject.id);
      if (!sessions.length) {
        sessionsBox.setItems(["(no sessions)"]);
        sessionsBox.select(0);
        return;
      }
      sessionsBox.setItems(sessions.map(sessionLabel));
      sessionsBox.select(0);
    }

    function done() {
      screen.destroy();
      resolve();
    }

    function setMode(nextMode: "res" | "tmux" | "codex" | "claude") {
      mode = nextMode;
      updateFooter();
      if (mode !== "res") {
        projectsBox.hide();
        sessionsBox.hide();
        tmuxBox.show();
        tmuxBox.focus();
      } else {
        tmuxBox.hide();
        projectsBox.show();
        sessionsBox.show();
        (focused === "projects" ? projectsBox : sessionsBox).focus();
      }
      refresh();
    }

    function withPrompt(title: string, value: string, cb: (input: string) => void) {
      prompt.setLabel(` ${title} `);
      prompt.input(title, value, (_err: unknown, input: unknown) => {
        const text = typeof input === "string" ? input.trim() : "";
        cb(text);
      });
    }

    function withConfirm(text: string, cb: (ok: boolean) => void) {
      question.ask(text, (_err: unknown, ok: unknown) => cb(Boolean(ok)));
    }

    function attachSelectedSession() {
      if (!selectedProject) return;
      if (!sessions.length) return;
      const idx = getSelectedIndex(sessionsBox);
      const sess = sessions[idx];
      if (!sess) return;

      try {
        writeState(args.state);
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
        return;
      }

      screen.destroy();
      try {
        args.actions.attachSession(sess.name);
        resolve();
      } catch (err) {
        fail(err);
      }
    }

    function attachSelectedTmuxSession() {
      const idx = getSelectedIndex(tmuxBox);
      selectedTmuxIndex = idx;
      const sess = tmuxSessions[idx];
      if (!sess) return;
      screen.destroy();
      try {
        args.actions.attachSession(sess.name);
        resolve();
      } catch (err) {
        fail(err);
      }
    }

    function deleteSelectedTmuxSession() {
      const idx = getSelectedIndex(tmuxBox);
      selectedTmuxIndex = idx;
      const sess = tmuxSessions[idx];
      if (!sess) return;
      withConfirm(`Kill tmux session?\n${sess.name}`, (ok) => {
        if (!ok) return refresh();
        try {
          args.actions.deleteSession(sess.name);
          writeState(args.state);
          refresh();
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err));
        }
      });
    }

    function copySelectedTmuxSessionName() {
      const idx = getSelectedIndex(tmuxBox);
      selectedTmuxIndex = idx;
      const sess = tmuxSessions[idx];
      if (!sess) return;
      try {
        const res = args.actions.copyText(sess.name);
        flashFooter(`Copied session name via ${res.method}`);
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      }
    }

    function openTextViewer(title: string, content: string) {
      const maxChars = 200_000;
      const truncated = content.length > maxChars;
      const visible = truncated ? content.slice(-maxChars) : content;
      const header = truncated ? "(truncated)\n\n" : "";

      const viewer = blessed.scrollableBox({
        parent: screen,
        top: 0,
        left: 0,
        width: "100%",
        height: "100%-1",
        border: "line",
        label: ` ${title} `,
        keys: true,
        vi: true,
        mouse: true,
        alwaysScroll: true,
        scrollable: true,
        scrollbar: { style: { bg: "blue" } },
        content: header + visible,
      });

      footer.setContent("View · q/esc: close · y: copy");
      viewer.focus();
      screen.render();

      function close() {
        modalClose = null;
        viewer.destroy();
        updateFooter();
        (mode === "res" ? (focused === "projects" ? projectsBox : sessionsBox) : tmuxBox).focus();
        screen.render();
      }

      modalClose = close;
      viewer.key(["escape"], () => close());
      viewer.key(["y"], () => {
        try {
          const res = args.actions.copyText(content);
          flashFooter(`Copied capture via ${res.method}`);
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err));
        }
      });
    }

    function captureSelectedTmuxSession() {
      const idx = getSelectedIndex(tmuxBox);
      selectedTmuxIndex = idx;
      const sess = tmuxSessions[idx];
      if (!sess) return;
      try {
        const captured = args.actions.captureSessionPane(sess.name);
        openTextViewer(`capture: ${sess.name}`, captured);
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      }
    }

    function viewSelectedCodexSession() {
      const idx = getSelectedIndex(tmuxBox);
      selectedCodexIndex = idx;
      const sess = codexSessions[idx];
      if (!sess) return;
      try {
        const content = args.actions.codexSessionDetails(sess);
        openTextViewer(`codex: ${sess.id}`, content);
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      }
    }

    function viewSelectedClaudeSession() {
      const idx = getSelectedIndex(tmuxBox);
      selectedClaudeIndex = idx;
      const sess = claudeSessions[idx];
      if (!sess) return;
      try {
        const content = args.actions.claudeSessionDetails(sess);
        openTextViewer(`claude: ${sess.id}`, content);
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      }
    }

    function copySelectedCodexSessionId() {
      const idx = getSelectedIndex(tmuxBox);
      selectedCodexIndex = idx;
      const sess = codexSessions[idx];
      if (!sess) return;
      try {
        const res = args.actions.copyText(sess.id);
        flashFooter(`Copied Codex session id via ${res.method}`);
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      }
    }

    function copySelectedClaudeSessionId() {
      const idx = getSelectedIndex(tmuxBox);
      selectedClaudeIndex = idx;
      const sess = claudeSessions[idx];
      if (!sess) return;
      try {
        const res = args.actions.copyText(sess.id);
        flashFooter(`Copied Claude session id via ${res.method}`);
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      }
    }

    function createTmuxFromCodexSession() {
      const idx = getSelectedIndex(tmuxBox);
      selectedCodexIndex = idx;
      const codexSession = codexSessions[idx];
      if (!codexSession) return;

      projects = listProjects(args.state);
      openProjectPicker(
        `tmux for codex ${codexSession.id.slice(0, 12)}`,
        codexSession.cwd ?? process.cwd(),
        (project) => {
          if (!project) return refresh();

          const command = args.actions.codexResumeCommand(codexSession.id);
          let sess: SessionRecord;
          try {
            sess = args.actions.createSession(project, command);
            sess.lastAttachedAt = nowIso();
            writeState(args.state);
          } catch (err) {
            showError(err instanceof Error ? err.message : String(err));
            return;
          }

          screen.destroy();
          try {
            args.actions.attachSession(sess.name);
            resolve();
          } catch (err) {
            fail(err);
          }
        },
      );
    }

    function createTmuxFromClaudeSession() {
      const idx = getSelectedIndex(tmuxBox);
      selectedClaudeIndex = idx;
      const claudeSession = claudeSessions[idx];
      if (!claudeSession) return;

      projects = listProjects(args.state);
      openProjectPicker(
        `tmux for claude ${claudeSession.id.slice(0, 12)}`,
        claudeSession.projectPath ?? claudeSession.cwd ?? process.cwd(),
        (project) => {
          if (!project) return refresh();

          const command = args.actions.claudeResumeCommand(claudeSession.id);
          let sess: SessionRecord;
          try {
            sess = args.actions.createSession(project, command);
            sess.lastAttachedAt = nowIso();
            writeState(args.state);
          } catch (err) {
            showError(err instanceof Error ? err.message : String(err));
            return;
          }

          screen.destroy();
          try {
            args.actions.attachSession(sess.name);
            resolve();
          } catch (err) {
            fail(err);
          }
        },
      );
    }

    function openProjectPicker(title: string, createPathDefault: string, onPick: (project: Project | null) => void) {
      const entries: Array<{ kind: "create" } | { kind: "project"; project: Project }> = [
        { kind: "create" },
        ...projects.map((project) => ({ kind: "project" as const, project })),
      ];

      const items = [
        "{green-fg}+{/green-fg} Create project by path…",
        ...projects.map((p) => `${p.name} {gray-fg}${p.path}{/gray-fg}`),
      ];

      const picker = blessed.list({
        parent: screen,
        top: "center",
        left: "center",
        width: "80%",
        height: Math.min(18, Math.max(7, items.length + 4)),
        keys: true,
        vi: true,
        mouse: true,
        border: "line",
        label: ` {magenta-fg}{bold}${title}{/bold}{/magenta-fg} `,
        style: {
          border: { fg: colors.accent },
          selected: { bg: colors.selected.bg, fg: colors.selected.fg, bold: true },
          label: { fg: colors.accent },
        },
        scrollbar: { style: { bg: colors.accent } },
        tags: true,
        items,
      });

      const previousFooter = footer.getContent();
      footer.setContent("Picker · Enter: select · Esc/q: cancel");
      picker.focus();
      screen.render();

      function cleanup() {
        modalClose = null;
        footer.setContent(previousFooter);
        picker.destroy();
        updateFooter();
        (mode === "res" ? (focused === "projects" ? projectsBox : sessionsBox) : tmuxBox).focus();
        screen.render();
      }

      function cancel() {
        cleanup();
        onPick(null);
      }

      modalClose = cancel;
      picker.key(["escape", "q"], () => cancel());
      picker.on("select", (_: unknown, idx: number) => {
        const entry = entries[idx];
        if (!entry) return cancel();

        cleanup();

        if (entry.kind === "create") {
          withPrompt("New project path", createPathDefault, (p) => {
            if (!p) return onPick(null);
            try {
              const project = normalizeAndEnsureProject(args.state, p, process.cwd());
              writeState(args.state);
              onPick(project);
            } catch (err) {
              showError(err instanceof Error ? err.message : String(err));
              onPick(null);
            }
          });
          return;
        }

        onPick(entry.project);
      });
    }

    function associateSelectedTmuxSession() {
      const idx = getSelectedIndex(tmuxBox);
      selectedTmuxIndex = idx;
      const sess = tmuxSessions[idx];
      if (!sess) return;

      const existing = args.state.sessions[sess.name];
      if (existing) {
        const existingProject = args.state.projects[existing.projectId]?.name ?? existing.projectId;
        flashFooter(`Already associated with ${existingProject} (use u to unassociate)`);
        return;
      }

      projects = listProjects(args.state);
      openProjectPicker(`Associate ${sess.name}`, process.cwd(), (project) => {
        if (!project) return refresh();
        try {
          args.actions.linkSession(project, sess.name, false);
          writeState(args.state);
          flashFooter(`Associated ${sess.name} → ${project.name}`);
          refresh();
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err));
        }
      });
    }

    function unassociateSelectedTmuxSession() {
      const idx = getSelectedIndex(tmuxBox);
      selectedTmuxIndex = idx;
      const sess = tmuxSessions[idx];
      if (!sess) return;

      const existing = args.state.sessions[sess.name];
      if (!existing) {
        flashFooter("Session is not associated with a project.");
        return;
      }

      const existingProject = args.state.projects[existing.projectId]?.name ?? existing.projectId;
      withConfirm(`Unassociate tmux session?\n${sess.name}\n(from ${existingProject})`, (ok) => {
        if (!ok) return refresh();
        try {
          args.actions.unassociateSession(sess.name);
          writeState(args.state);
          flashFooter(`Unassociated ${sess.name}`);
          refresh();
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err));
        }
      });
    }

    function createSessionForSelectedProject() {
      if (!selectedProject) return;
      withPrompt("Command (optional)", "", (cmd) => {
        const command = cmd.length ? cmd : undefined;
        let sess: SessionRecord;
        try {
          sess = args.actions.createSession(selectedProject!, command);
          sess.lastAttachedAt = nowIso();
          writeState(args.state);
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err));
          return;
        }

        screen.destroy();
        try {
          args.actions.attachSession(sess.name);
          resolve();
        } catch (err) {
          fail(err);
        }
      });
    }

    function deleteSelectedSession() {
      if (!selectedProject) return;
      if (!sessions.length) return;
      const idx = getSelectedIndex(sessionsBox);
      const sess = sessions[idx];
      if (!sess) return;
      withConfirm(`Kill tmux session?\n${sess.name}`, (ok) => {
        if (!ok) return refresh();
        try {
          args.actions.deleteSession(sess.name);
          writeState(args.state);
          refresh();
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err));
        }
      });
    }

    function linkExistingSessionToSelectedProject() {
      if (!selectedProject) return;
      withPrompt("Link tmux session name", "", (name) => {
        if (!name) return refresh();
        const project = selectedProject!;
        const existing = args.state.sessions[name];
        if (existing && existing.projectId !== project.id) {
          const existingProject = args.state.projects[existing.projectId]?.name ?? existing.projectId;
          withConfirm(`Session is currently associated with ${existingProject}.\nMove it to ${project.name}?`, (ok) => {
            if (!ok) return refresh();
            try {
              args.actions.linkSession(project, name, true);
              writeState(args.state);
              refresh();
            } catch (err) {
              showError(err instanceof Error ? err.message : String(err));
            }
          });
          return;
        }

        try {
          args.actions.linkSession(project, name, false);
          writeState(args.state);
          refresh();
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err));
        }
      });
    }

    function deleteSelectedProject() {
      if (!selectedProject) return;
      const project = selectedProject;
      withConfirm(`Remove project and kill all its sessions?\n${project.name}\n${project.path}`, (ok) => {
        if (!ok) return refresh();
        try {
          const projectSessions = listSessionsForProject(args.state, project.id);
          for (const s of projectSessions) args.actions.deleteSession(s.name);
          delete args.state.projects[project.id];
          writeState(args.state);
          selectedProjectIndex = Math.max(0, selectedProjectIndex - 1);
          refresh();
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err));
        }
      });
    }

    function addProject() {
      withPrompt("Add project path", process.cwd(), (p) => {
        if (!p) return refresh();
        try {
          normalizeAndEnsureProject(args.state, p, process.cwd());
          writeState(args.state);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          withConfirm(`Failed to add project:\n${msg}\n\nOK?`, () => refresh());
          return;
        }
        refresh();
      });
    }

    screen.key(["C-c"], () => done());
    screen.key(["q"], () => {
      if (modalClose) return modalClose();
      done();
    });
    screen.key(["tab"], () => {
      if (modalClose) return;
      if (mode !== "res") return;
      focused = focused === "projects" ? "sessions" : "projects";
      (focused === "projects" ? projectsBox : sessionsBox).focus();
      screen.render();
    });

    screen.key(["t"], () => {
      if (modalClose) return;
      setMode("tmux");
    });
    screen.key(["p"], () => {
      if (modalClose) return;
      setMode("res");
    });
    screen.key(["1"], () => {
      if (modalClose) return;
      setMode("res");
    });
    screen.key(["2"], () => {
      if (modalClose) return;
      setMode("tmux");
    });
    screen.key(["3"], () => {
      if (modalClose) return;
      setMode("codex");
    });
    screen.key(["4"], () => {
      if (modalClose) return;
      setMode("claude");
    });
    screen.key(["m"], () => {
      if (modalClose) return;
      setMode(mode === "tmux" ? "res" : "tmux");
    });
    screen.key(["r"], () => {
      if (modalClose) return;
      refresh();
    });
    screen.key(["a"], () => {
      if (modalClose) return;
      if (mode !== "res") return;
      addProject();
    });
    screen.key(["c"], () => {
      if (modalClose) return;
      if (mode === "tmux") return captureSelectedTmuxSession();
      if (mode === "codex") return createTmuxFromCodexSession();
      if (mode === "claude") return createTmuxFromClaudeSession();
      if (mode !== "res") return;
      createSessionForSelectedProject();
    });
    screen.key(["d"], () => {
      if (modalClose) return;
      if (mode === "tmux") return deleteSelectedTmuxSession();
      if (mode !== "res") return;
      deleteSelectedSession();
    });
    screen.key(["l"], () => {
      if (modalClose) return;
      if (mode === "tmux") return associateSelectedTmuxSession();
      if (mode !== "res") return;
      linkExistingSessionToSelectedProject();
    });
    screen.key(["u"], () => {
      if (modalClose) return;
      if (mode !== "tmux") return;
      unassociateSelectedTmuxSession();
    });
    screen.key(["x"], () => {
      if (modalClose) return;
      if (mode !== "res") return;
      deleteSelectedProject();
    });
    screen.key(["y"], () => {
      if (modalClose) return;
      if (mode === "tmux") return copySelectedTmuxSessionName();
      if (mode === "codex") return copySelectedCodexSessionId();
      if (mode === "claude") return copySelectedClaudeSessionId();
    });

    projectsBox.on("select item", (_: unknown, idx: number) => {
      selectedProjectIndex = idx;
      selectedProject = projects[idx] ?? null;
      refreshSessionsForSelectedProject();
      screen.render();
    });

    sessionsBox.key(["enter"], () => attachSelectedSession());
    tmuxBox.key(["enter"], () => {
      if (mode === "tmux") return attachSelectedTmuxSession();
      if (mode === "codex") return viewSelectedCodexSession();
      if (mode === "claude") return viewSelectedClaudeSession();
    });
    projectsBox.key(["enter"], () => {
      if (mode !== "res") return;
      focused = "sessions";
      sessionsBox.focus();
      screen.render();
    });

    updateFooter();
    projectsBox.focus();
    footer.setFront();
    header.setFront();
    refresh();
  });
}
