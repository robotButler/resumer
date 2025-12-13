import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { expandHome, projectDisplayName, resolveProjectPath } from "./paths.ts";
import type { Project, ProjectId, SessionRecord, StateV1 } from "./types.ts";
import { nowIso } from "./time.ts";

function getStateDir(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  if (xdgStateHome) return path.join(xdgStateHome, "resumer");
  return path.join(os.homedir(), ".local", "state", "resumer");
}

export function getStateFilePath(): string {
  return path.join(getStateDir(), "state.json");
}

function defaultState(): StateV1 {
  return { version: 1, projects: {}, sessions: {} };
}

export function loadState(): StateV1 {
  const filePath = getStateFilePath();
  const raw = fs.readFileSync(filePath, { encoding: "utf8", flag: "r" });
  const parsed = JSON.parse(raw) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as StateV1).version !== 1 ||
    typeof (parsed as StateV1).projects !== "object" ||
    typeof (parsed as StateV1).sessions !== "object"
  ) {
    throw new Error(`Invalid state file: ${filePath}`);
  }
  return parsed as StateV1;
}

export function loadStateOrDefault(): StateV1 {
  try {
    return loadState();
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as any).code === "ENOENT") return defaultState();
    throw err;
  }
}

export function writeState(state: StateV1): void {
  const filePath = getStateFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8" });
  fs.renameSync(tmpPath, filePath);
}

export function computeProjectId(projectPath: string): ProjectId {
  return createHash("sha1").update(projectPath).digest("hex").slice(0, 10);
}

function resolvePathForLookup(inputPath: string, cwd: string): string {
  return path.resolve(cwd, expandHome(inputPath));
}

export function normalizeAndEnsureProject(
  state: StateV1,
  inputPath: string,
  cwd: string,
): Project {
  const absPath = resolveProjectPath(inputPath, cwd);
  const id = computeProjectId(absPath);
  const existing = state.projects[id];
  const name = projectDisplayName(absPath);

  if (existing) {
    if (existing.path !== absPath) existing.path = absPath;
    if (existing.name !== name) existing.name = name;
    existing.lastUsedAt = nowIso();
    return existing;
  }

  const project: Project = {
    id,
    path: absPath,
    name,
    createdAt: nowIso(),
    lastUsedAt: nowIso(),
  };
  state.projects[id] = project;
  return project;
}

export function findProject(state: StateV1, selector: string, cwd: string): Project | null {
  const byId = state.projects[selector];
  if (byId) return byId;

  const resolved = resolvePathForLookup(selector, cwd);
  const direct = Object.values(state.projects).find((p) => p.path === resolved);
  if (direct) return direct;

  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    const real = fs.realpathSync(resolved);
    const byReal = Object.values(state.projects).find((p) => p.path === real);
    if (byReal) return byReal;
  }

  return null;
}

export function listProjects(state: StateV1): Project[] {
  return Object.values(state.projects).sort((a, b) => {
    const aKey = a.lastUsedAt ?? a.createdAt;
    const bKey = b.lastUsedAt ?? b.createdAt;
    return bKey.localeCompare(aKey);
  });
}

export function listSessionsForProject(state: StateV1, projectId: ProjectId): SessionRecord[] {
  return Object.values(state.sessions)
    .filter((s) => s.projectId === projectId)
    .sort((a, b) => {
      const aKey = a.lastAttachedAt ?? a.createdAt;
      const bKey = b.lastAttachedAt ?? b.createdAt;
      return bKey.localeCompare(aKey);
    });
}

export function upsertSession(state: StateV1, session: SessionRecord): void {
  const existing = state.sessions[session.name];
  state.sessions[session.name] = { ...existing, ...session };
}

export function removeSession(state: StateV1, tmuxSessionName: string): void {
  delete state.sessions[tmuxSessionName];
}

export function removeProject(state: StateV1, projectId: ProjectId): void {
  delete state.projects[projectId];
  for (const [name, sess] of Object.entries(state.sessions)) {
    if (sess.projectId === projectId) delete state.sessions[name];
  }
}

export function touchSessionAttached(state: StateV1, tmuxSessionName: string): void {
  const sess = state.sessions[tmuxSessionName];
  if (!sess) return;
  sess.lastAttachedAt = nowIso();
  const project = state.projects[sess.projectId];
  if (project) project.lastUsedAt = nowIso();
}

export function formatNewSessionName(projectName: string, projectId: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 18);
  const suffix = randomBytes(3).toString("hex");
  const safeSlug = slug.length ? slug : "project";
  return `res_${safeSlug}_${projectId}_${suffix}`;
}
