import { blessed } from "./blessed.ts";
import type { Widgets } from "blessed";
import type { Project, SessionRecord, StateV1 } from "../types.ts";
import { listProjects, listSessionsForProject, normalizeAndEnsureProject, writeState } from "../state.ts";
import { nowIso } from "../time.ts";
import type { TmuxSessionInfo } from "../tmux.ts";
import { getBlessedTerminalOverride } from "./term.ts";
import type { CodexSessionSummary } from "../external/codex.ts";
import type { ClaudeSessionSummary } from "../external/claude.ts";

// Mode-specific colors
const modeColors = {
  res: "#44AADA",       // blue
  tmux: "#6AB244",      // green
  codex: "#E88E2D",     // orange
  claude: "#DFD33F",    // yellow
};

const colors = {
  secondary: "#44AADA",   // blue
  error: "#CD3731",       // red
  selectedDim: {
    bg: "#374151",
    fg: "#9ca3af",
  },
  border: "#6AB244",      // green (not blue since res uses blue)
  borderDim: "#4b5563",
};

function getModeColor(mode: keyof typeof modeColors): string {
  return modeColors[mode];
}

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
  const kind = s.kind === "linked" ? `{${modeColors.tmux}-fg}linked{/}` : s.kind === "managed" ? `{${modeColors.res}-fg}managed{/}` : "";
  const suffix = kind ? ` {gray-fg}·{/gray-fg} ${kind}` : "";
  return `{bold}${s.name}{/bold} {gray-fg}${cmd}{/gray-fg}${suffix}`;
}

function tmuxSessionLabel(info: TmuxSessionInfo, state: StateV1): string {
  const tracked = state.sessions[info.name];
  const project = tracked ? state.projects[tracked.projectId] : undefined;
  const trackedCmd = tracked?.command?.trim().length ? tracked.command.trim() : "";
  const cmd = trackedCmd || info.currentCommand?.trim() || "(unknown)";
  const projectHint = project ? ` {gray-fg}·{/gray-fg} {${colors.secondary}-fg}${project.name}{/}` : "";
  const attachedHint = info.attached ? ` {gray-fg}·{/gray-fg} {${modeColors.codex}-fg}attached:${info.attached}{/}` : "";
  return `{bold}${info.name}{/bold} {gray-fg}${cmd}{/gray-fg}${projectHint}${attachedHint}`;
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + "…";
}

function codexSessionLabel(info: CodexSessionSummary): string {
  const cwd = info.cwd ? ` {gray-fg}${info.cwd}{/gray-fg}` : "";
  const when = info.lastActivityAt ? ` {gray-fg}·{/gray-fg} {${modeColors.res}-fg}${info.lastActivityAt}{/}` : "";
  const prompt = info.lastPrompt ? ` {gray-fg}·{/gray-fg} {gray-fg}${truncate(info.lastPrompt, 80)}{/gray-fg}` : "";
  const id = info.id.length > 12 ? info.id.slice(0, 12) : info.id;
  return `{bold}${id}{/bold}${cwd}${when}${prompt}`;
}

function claudeSessionLabel(info: ClaudeSessionSummary): string {
  const project = info.projectPath ? ` {gray-fg}${info.projectPath}{/gray-fg}` : "";
  const when = info.lastActivityAt ? ` {gray-fg}·{/gray-fg} {${modeColors.res}-fg}${info.lastActivityAt}{/}` : "";
  const model = info.model ? ` {gray-fg}·{/gray-fg} {${colors.secondary}-fg}${info.model}{/}` : "";
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
      mouse: true,
      style: { bg: "default" },
    });

    const siteUrl = "https://dvroom.dev";
    const headerUrl = blessed.box({
      parent: screen,
      top: 0,
      right: 0,
      height: 1,
      width: siteUrl.length + 1,
      content: `{gray-fg}${siteUrl}{/gray-fg}`,
      tags: true,
      mouse: true,
      style: { bg: "default" },
    });

    headerUrl.on("mouseover", () => {
      headerUrl.setContent(`{underline}{white-fg}${siteUrl}{/white-fg}{/underline}`);
      screen.render();
    });
    headerUrl.on("mouseout", () => {
      headerUrl.setContent(`{gray-fg}${siteUrl}{/gray-fg}`);
      screen.render();
    });
    headerUrl.on("click", () => {
      // Try common openers - xdg-open (Linux), open (macOS)
      try {
        Bun.spawn(["xdg-open", siteUrl], { stdio: ["ignore", "ignore", "ignore"] });
      } catch {
        try {
          Bun.spawn(["open", siteUrl], { stdio: ["ignore", "ignore", "ignore"] });
        } catch {
          // Silently fail if no opener available
        }
      }
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
      label: " Projects ",
      style: {
        border: { fg: colors.border },
        selected: { bg: modeColors.res, fg: "black", bold: true },
      },
      scrollbar: { style: { bg: modeColors.res } },
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
      label: " Sessions ",
      style: {
        border: { fg: colors.border },
        selected: { bg: colors.selectedDim.bg, fg: colors.selectedDim.fg, bold: true },
      },
      scrollbar: { style: { bg: colors.borderDim } },
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
      label: " Sessions ",
      style: {
        border: { fg: colors.border },
        selected: { bg: modeColors.tmux, fg: "black", bold: true },
      },
      scrollbar: { style: { bg: modeColors.tmux } },
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
      label: " Input ",
      tags: true,
      hidden: true,
      style: { border: { fg: colors.secondary } },
    });

    const question = blessed.question({
      parent: screen,
      border: "line",
      height: 7,
      width: "60%",
      top: "center",
      left: "center",
      label: " Confirm ",
      tags: true,
      hidden: true,
      style: { border: { fg: colors.secondary } },
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

    // Tab definitions with their positions for mouse click detection
    const tabs = ["res", "tmux", "codex", "claude"] as const;
    let tabPositions: Array<{ start: number; end: number; mode: typeof tabs[number] }> = [];
    let hoveredTab: typeof tabs[number] | null = null;

    function updateHeader() {
      // Colored "resumer" title: res(blue) u(green) m(orange) e(yellow) r(red)
      const coloredTitle =
        `{${modeColors.res}-fg}{bold}res{/bold}{/}` +
        `{${modeColors.tmux}-fg}{bold}u{/bold}{/}` +
        `{${modeColors.codex}-fg}{bold}m{/bold}{/}` +
        `{${modeColors.claude}-fg}{bold}e{/bold}{/}` +
        `{${colors.error}-fg}{bold}r{/bold}{/}`;

      // Build tabs with position tracking
      let content = ` ${coloredTitle} {gray-fg}│{/gray-fg}`;
      let pos = 12; // " resumer │" = 12 chars
      tabPositions = [];

      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        const tabColor = modeColors[tab];
        const num = i + 1;
        const isActive = mode === tab;
        const isHovered = hoveredTab === tab && !isActive;
        const start = pos;
        const label = `(${num}) ${tab}`;

        if (isActive) {
          content += `{${tabColor}-bg}{black-fg}{bold} ${label} {/bold}{/black-fg}{/}`;
        } else if (isHovered) {
          content += `{${tabColor}-fg}{underline} ${label} {/underline}{/}`;
        } else {
          content += `{gray-fg} ${label} {/gray-fg}`;
        }

        // Calculate position (label + 2 spaces padding)
        pos += label.length + 2;
        tabPositions.push({ start, end: pos, mode: tab });
      }

      header.setContent(content);
    }

    // Handle mouse clicks on header tabs
    header.on("click", (_mouse: any) => {
      const x = _mouse.x;
      for (const tab of tabPositions) {
        if (x >= tab.start && x < tab.end) {
          setMode(tab.mode);
          return;
        }
      }
    });

    // Handle mouse hover on header tabs
    header.on("mousemove", (_mouse: any) => {
      const x = _mouse.x;
      let newHovered: typeof tabs[number] | null = null;
      for (const tab of tabPositions) {
        if (x >= tab.start && x < tab.end) {
          newHovered = tab.mode;
          break;
        }
      }
      if (newHovered !== hoveredTab) {
        hoveredTab = newHovered;
        updateHeader();
        screen.render();
      }
    });

    header.on("mouseout", () => {
      if (hoveredTab !== null) {
        hoveredTab = null;
        updateHeader();
        screen.render();
      }
    });

    function updateFooter() {
      updateHeader();
      if (mode === "tmux") {
        footer.setContent(
          "Enter: attach · d: delete · c: capture · y: copy name · l: associate · u: unassociate · r: refresh · q: quit",
        );
        return;
      }
      if (mode === "codex") {
        footer.setContent(
          "Enter: view · c: tmux · y: copy id · r: refresh · q: quit",
        );
        return;
      }
      if (mode === "claude") {
        footer.setContent(
          "Enter: view · c: tmux · y: copy id · r: refresh · q: quit",
        );
        return;
      }
      footer.setContent(
        "Tab: focus · Enter: attach · c: create · d: delete · l: link · a: add · x: remove · r: refresh · q: quit",
      );
    }

    function updateFocusedStyles() {
      const modeColor = getModeColor(mode);

      if (mode !== "res") {
        // For non-res modes, update tmuxBox styling
        (tmuxBox as any).style.border.fg = modeColor;
        (tmuxBox as any).style.selected.bg = modeColor;
        (tmuxBox as any).style.selected.fg = "black";
        (tmuxBox as any).style.scrollbar.bg = modeColor;
        return;
      }

      // Update border colors based on focus
      const projectsBorderColor = focused === "projects" ? modeColor : colors.borderDim;
      const sessionsBorderColor = focused === "sessions" ? modeColor : colors.borderDim;

      (projectsBox as any).style.border.fg = projectsBorderColor;
      (sessionsBox as any).style.border.fg = sessionsBorderColor;

      // Update selected item styles based on focus
      const focusedSelected = { bg: modeColor, fg: "black" };
      const projectsSelected = focused === "projects" ? focusedSelected : colors.selectedDim;
      const sessionsSelected = focused === "sessions" ? focusedSelected : colors.selectedDim;

      (projectsBox as any).style.selected.bg = projectsSelected.bg;
      (projectsBox as any).style.selected.fg = projectsSelected.fg;
      (sessionsBox as any).style.selected.bg = sessionsSelected.bg;
      (sessionsBox as any).style.selected.fg = sessionsSelected.fg;

      // Update scrollbar colors
      (projectsBox as any).style.scrollbar.bg = focused === "projects" ? modeColor : colors.borderDim;
      (sessionsBox as any).style.scrollbar.bg = focused === "sessions" ? modeColor : colors.borderDim;

      // Update labels with focus indicator
      const projectsLabel = focused === "projects"
        ? ` {${modeColor}-fg}{bold}> Projects{/bold}{/} `
        : " {gray-fg}Projects{/gray-fg} ";
      const sessionsLabel = focused === "sessions"
        ? ` {${modeColor}-fg}{bold}> Sessions{/bold}{/} `
        : " {gray-fg}Sessions{/gray-fg} ";

      projectsBox.setLabel(projectsLabel);
      sessionsBox.setLabel(sessionsLabel);
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
      tmuxBox.setLabel(` {${modeColors.tmux}-fg}{bold}tmux Sessions{/bold}{/} `);
      tmuxBox.setItems(items.length ? items : ["(no tmux sessions)"]);
      selectedTmuxIndex = Math.min(selectedTmuxIndex, Math.max(0, tmuxSessions.length - 1));
      tmuxBox.select(selectedTmuxIndex);
    }

    function refreshCodexMode() {
      codexSessions = args.actions.listCodexSessions();
      tmuxBox.setLabel(` {${modeColors.codex}-fg}{bold}Codex Sessions{/bold}{/} `);
      const items = codexSessions.map((s) => codexSessionLabel(s));
      tmuxBox.setItems(items.length ? items : ["(no Codex sessions found)"]);
      selectedCodexIndex = Math.min(selectedCodexIndex, Math.max(0, codexSessions.length - 1));
      tmuxBox.select(selectedCodexIndex);
    }

    function refreshClaudeMode() {
      claudeSessions = args.actions.listClaudeSessions();
      tmuxBox.setLabel(` {${modeColors.claude}-fg}{bold}Claude Sessions{/bold}{/} `);
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
      updateFocusedStyles();
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
      updateFocusedStyles();
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
      const modeColor = getModeColor(mode);
      const confirmBox = blessed.box({
        parent: screen,
        top: "center",
        left: "center",
        width: "60%",
        height: 7,
        border: "line",
        label: ` {${modeColor}-fg}{bold}Confirm{/bold}{/} `,
        tags: true,
        style: {
          border: { fg: modeColor },
        },
        content: text,
      });

      const confirmFooter = blessed.box({
        parent: confirmBox,
        bottom: 0,
        left: 0,
        width: "100%-2",
        height: 1,
        tags: true,
        style: {
          bg: "#374151",
          fg: "white",
        },
        content: " Enter: confirm · Esc: cancel",
      });

      confirmBox.focus();
      screen.render();

      function close(result: boolean) {
        confirmBox.destroy();
        screen.render();
        cb(result);
      }

      confirmBox.key(["enter"], () => close(true));
      confirmBox.key(["escape", "q"], () => close(false));
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
        updateFocusedStyles();
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

    function showHelp() {
      const modeColor = getModeColor(mode);

      const globalKeys = [
        ["1-4", "Switch to mode (res/tmux/codex/claude)"],
        ["r", "Refresh data"],
        ["q", "Quit"],
        ["?", "Show this help"],
      ];

      const resKeys = [
        ["Tab", "Switch focus between Projects and Sessions"],
        ["Enter", "Attach to selected session (or switch to Sessions panel)"],
        ["c", "Create new tmux session for selected project"],
        ["d", "Delete selected session (kills tmux session)"],
        ["l", "Link unlinked tmux session to selected project"],
        ["u", "Unlink session from project (keeps tmux running)"],
        ["a", "Add new project by path"],
        ["x", "Remove project and kill all its sessions"],
      ];

      const tmuxKeys = [
        ["Enter", "Attach to selected tmux session"],
        ["d", "Delete (kill) selected tmux session"],
        ["c", "Capture pane content from selected session"],
        ["y", "Copy session name to clipboard"],
        ["l", "Associate session with a project"],
        ["u", "Unassociate session from its project"],
      ];

      const codexKeys = [
        ["Enter", "View session details"],
        ["c", "Create tmux session to resume this Codex session"],
        ["y", "Copy session ID to clipboard"],
      ];

      const claudeKeys = [
        ["Enter", "View session details"],
        ["c", "Create tmux session to resume this Claude session"],
        ["y", "Copy session ID to clipboard"],
      ];

      const formatSection = (title: string, keys: string[][], color: string) => {
        const lines = keys.map(([key, desc]) => `  {bold}${key.padEnd(8)}{/bold} ${desc}`);
        return `{${color}-fg}{bold}${title}{/bold}{/}\n${lines.join("\n")}`;
      };

      let content = formatSection("Global", globalKeys, colors.secondary) + "\n\n";

      if (mode === "res") {
        content += formatSection("Res Mode (Project Sessions)", resKeys, modeColor);
        content += "\n\n{gray-fg}Tip: 'Add' registers a project directory. 'Create' makes a new tmux session.{/gray-fg}";
      } else if (mode === "tmux") {
        content += formatSection("Tmux Mode (All Sessions)", tmuxKeys, modeColor);
        content += "\n\n{gray-fg}Tip: 'Associate' links an untracked tmux session to a project.{/gray-fg}";
      } else if (mode === "codex") {
        content += formatSection("Codex Mode (Codex CLI Sessions)", codexKeys, modeColor);
        content += "\n\n{gray-fg}Tip: View shows conversation history. Create opens in tmux.{/gray-fg}";
      } else if (mode === "claude") {
        content += formatSection("Claude Mode (Claude Code Sessions)", claudeKeys, modeColor);
        content += "\n\n{gray-fg}Tip: View shows conversation history. Create opens in tmux.{/gray-fg}";
      }

      const helpBox = blessed.box({
        parent: screen,
        top: "center",
        left: "center",
        width: "70%",
        height: "70%",
        border: "line",
        label: ` {${modeColor}-fg}{bold}Help{/bold}{/} `,
        tags: true,
        keys: true,
        vi: true,
        mouse: true,
        scrollable: true,
        alwaysScroll: true,
        scrollbar: { style: { bg: modeColor } },
        style: { border: { fg: modeColor } },
        content,
      });

      footer.setContent("Help · q/esc/?: close");
      helpBox.focus();
      screen.render();

      function close() {
        modalClose = null;
        helpBox.destroy();
        updateFooter();
        updateFocusedStyles();
        (mode === "res" ? (focused === "projects" ? projectsBox : sessionsBox) : tmuxBox).focus();
        screen.render();
      }

      modalClose = close;
      helpBox.key(["escape", "q", "?"], () => close());
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

      const modeColor = getModeColor(mode);
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
        label: ` {${modeColor}-fg}{bold}${title}{/bold}{/} `,
        style: {
          border: { fg: modeColor },
          selected: { bg: modeColor, fg: "black", bold: true },
        },
        scrollbar: { style: { bg: modeColor } },
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
        updateFocusedStyles();
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

    function unlinkSelectedSession() {
      if (!selectedProject) return;
      if (!sessions.length) return;
      const idx = getSelectedIndex(sessionsBox);
      const sess = sessions[idx];
      if (!sess) return;
      withConfirm(`Unlink "${sess.name}" from ${selectedProject.name}? (tmux keeps running)`, (ok) => {
        if (!ok) return refresh();
        try {
          args.actions.unassociateSession(sess.name);
          writeState(args.state);
          flashFooter(`Unlinked ${sess.name}`);
          refresh();
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err));
        }
      });
    }

    function linkExistingSessionToSelectedProject() {
      if (!selectedProject) return;
      const project = selectedProject;

      // Get all tmux sessions not already linked to a project
      const allTmuxSessions = args.actions.listTmuxSessions();
      const unlinkedSessions = allTmuxSessions.filter((s) => !args.state.sessions[s.name]);

      if (unlinkedSessions.length === 0) {
        flashFooter("No unlinked tmux sessions available");
        return;
      }

      const tmuxColor = modeColors.tmux; // green
      const items = unlinkedSessions.map((s) => {
        const cmd = s.currentCommand?.trim() || "(shell)";
        const path = s.currentPath ? ` {${colors.secondary}-fg}${s.currentPath}{/}` : "";
        const windows = s.windows > 1 ? ` {gray-fg}${s.windows} windows{/gray-fg}` : "";
        const attached = s.attached ? ` {${modeColors.codex}-fg}attached{/}` : "";
        return `{bold}${s.name}{/bold} {gray-fg}${cmd}{/gray-fg}${path}${windows}${attached}`;
      });

      const modalHeight = Math.min(20, Math.max(9, items.length + 6));
      const modalContainer = blessed.box({
        parent: screen,
        top: "center",
        left: "center",
        width: "80%",
        height: modalHeight,
        border: "line",
        label: ` {${tmuxColor}-fg}{bold}tmux sessions{/bold}{/} `,
        tags: true,
        style: {
          border: { fg: tmuxColor },
        },
      });

      const modalHeader = blessed.box({
        parent: modalContainer,
        top: 0,
        left: 0,
        width: "100%-2",
        height: 1,
        content: ` Select a tmux session to link to {bold}${project.name}{/bold}`,
        tags: true,
        style: {
          bg: "#374151",
          fg: "white",
        },
      });

      const picker = blessed.list({
        parent: modalContainer,
        top: 1,
        left: 0,
        width: "100%-2",
        height: "100%-3",
        keys: true,
        vi: true,
        mouse: true,
        style: {
          selected: { bg: tmuxColor, fg: "black", bold: true },
        },
        scrollbar: { style: { bg: tmuxColor } },
        tags: true,
        items,
      });

      const previousFooter = footer.getContent();
      footer.setContent(`Enter: select · Esc/q: cancel`);
      picker.focus();
      screen.render();

      function cleanup() {
        modalClose = null;
        footer.setContent(previousFooter);
        modalContainer.destroy();
        updateFooter();
        updateFocusedStyles();
        (focused === "projects" ? projectsBox : sessionsBox).focus();
        screen.render();
      }

      function cancel() {
        cleanup();
        refresh();
      }

      modalClose = cancel;
      picker.key(["escape", "q"], () => cancel());
      picker.on("select", (_: unknown, idx: number) => {
        const sess = unlinkedSessions[idx];
        if (!sess) return cancel();

        cleanup();

        try {
          args.actions.linkSession(project, sess.name, false);
          writeState(args.state);
          flashFooter(`Linked ${sess.name} → ${project.name}`);
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
      updateFocusedStyles();
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
    screen.key(["?"], () => {
      if (modalClose) return;
      showHelp();
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
      if (mode === "tmux") return unassociateSelectedTmuxSession();
      if (mode === "res") return unlinkSelectedSession();
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
      updateFocusedStyles();
      screen.render();
    });

    updateFooter();
    updateFocusedStyles();
    projectsBox.focus();
    footer.setFront();
    header.setFront();
    headerUrl.setFront();
    refresh();
  });
}
