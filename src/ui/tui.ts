import { blessed } from "./blessed.ts";
import type { Widgets } from "blessed";
import type { Project, SessionRecord, StateV1 } from "../types.ts";
import { listProjects, listSessionsForProject, normalizeAndEnsureProject, writeState } from "../state.ts";
import { nowIso } from "../time.ts";

export type TuiActions = {
  refreshLiveSessions(): void;
  createSession(project: Project, command?: string): SessionRecord;
  deleteSession(sessionName: string): void;
  attachSession(sessionName: string): void;
};

function sessionLabel(s: SessionRecord): string {
  const cmd = s.command?.trim().length ? s.command.trim() : "(shell)";
  return `${s.name} {gray-fg}${cmd}{/}`;
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
    const screen = blessed.screen({ smartCSR: true, title: "resumer" });

    const projectsBox = blessed.list({
      parent: screen,
      top: 0,
      left: 0,
      width: "45%",
      height: "100%-1",
      keys: true,
      vi: true,
      mouse: true,
      border: "line",
      label: " Projects ",
      style: { selected: { bg: "blue", fg: "white" } },
      scrollbar: { style: { bg: "blue" } },
      tags: true,
    });

    const sessionsBox = blessed.list({
      parent: screen,
      top: 0,
      left: "45%",
      width: "55%",
      height: "100%-1",
      keys: true,
      vi: true,
      mouse: true,
      border: "line",
      label: " Sessions ",
      style: { selected: { bg: "blue", fg: "white" } },
      scrollbar: { style: { bg: "blue" } },
      tags: true,
    });

    const footer = blessed.box({
      parent: screen,
      bottom: 0,
      left: 0,
      height: 1,
      width: "100%",
      content:
        "Tab: focus · Enter: attach · c: create · d: delete · a: add · x: remove · r: refresh · q: quit",
      style: { fg: "gray" },
    });

    const prompt = blessed.prompt({
      parent: screen,
      border: "line",
      height: 7,
      width: "80%",
      top: "center",
      left: "center",
      label: " Input ",
      tags: true,
      hidden: true,
    });

    const question = blessed.question({
      parent: screen,
      border: "line",
      height: 7,
      width: "80%",
      top: "center",
      left: "center",
      label: " Confirm ",
      tags: true,
      hidden: true,
    });

    let focused: "projects" | "sessions" = "projects";
    let projects: Project[] = [];
    let sessions: SessionRecord[] = [];
    let selectedProject: Project | null = null;
    let selectedProjectIndex = 0;

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

    function refresh() {
      try {
        args.actions.refreshLiveSessions();
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
        return;
      }
      projects = listProjects(args.state);
      const items = projects.map((p) => `${p.name} {gray-fg}${p.path}{/}`);
      projectsBox.setItems(items);

      selectedProjectIndex = Math.min(selectedProjectIndex, Math.max(0, projects.length - 1));
      projectsBox.select(selectedProjectIndex);

      selectedProject = projects[selectedProjectIndex] ?? null;
      refreshSessionsForSelectedProject();
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

    screen.key(["q", "C-c"], () => done());
    screen.key(["tab"], () => {
      focused = focused === "projects" ? "sessions" : "projects";
      (focused === "projects" ? projectsBox : sessionsBox).focus();
      screen.render();
    });

    screen.key(["r"], () => refresh());
    screen.key(["a"], () => addProject());
    screen.key(["c"], () => createSessionForSelectedProject());
    screen.key(["d"], () => deleteSelectedSession());
    screen.key(["x"], () => deleteSelectedProject());

    projectsBox.on("select", (_: unknown, idx: number) => {
      selectedProjectIndex = idx;
      selectedProject = projects[idx] ?? null;
      refreshSessionsForSelectedProject();
      screen.render();
    });

    sessionsBox.key(["enter"], () => attachSelectedSession());
    projectsBox.key(["enter"], () => {
      focused = "sessions";
      sessionsBox.focus();
      screen.render();
    });

    projectsBox.focus();
    footer.setFront();
    refresh();
  });
}
