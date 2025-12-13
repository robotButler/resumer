import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ClaudeSessionSummary = {
  id: string;
  projectPath?: string;
  cwd?: string;
  lastActivityAt?: string;
  lastPrompt?: string;
  model?: string;
  version?: string;
  gitBranch?: string;
  sessionFile?: string;
};

type ClaudeHistoryLine = {
  sessionId?: unknown;
  project?: unknown;
  timestamp?: unknown;
  display?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function safeJsonParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isoFromUnixMs(ms: number): string {
  return new Date(ms).toISOString();
}

function readFileHead(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, bytes).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function encodeClaudeProjectDir(projectPath: string): string {
  // Claude stores projects under ".claude/projects" using a path-derived directory name like:
  // "/home/user/proj" -> "-home-user-proj"
  // We keep this heuristic intentionally simple and fall back if it doesn't exist.
  return projectPath.replace(/[\\/]+/g, "-");
}

function getClaudeHomeDir(): string | null {
  const override = process.env.CLAUDE_HOME?.trim() || process.env.RESUMER_CLAUDE_HOME?.trim();
  const candidates = [
    override,
    path.join(os.homedir(), ".claude"),
    path.join(os.homedir(), ".local", "share", "claude"),
    path.join(os.homedir(), ".local", "state", "claude"),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    try {
      const stat = fs.statSync(dir, { throwIfNoEntry: false });
      if (!stat?.isDirectory()) continue;
      const history = path.join(dir, "history.jsonl");
      if (fs.existsSync(history)) return dir;
    } catch {
      // ignore
    }
  }

  return null;
}

function findClaudeSessionFile(claudeHome: string, projectPath: string | undefined, sessionId: string): string | undefined {
  const projectsRoot = path.join(claudeHome, "projects");
  if (!projectPath) return undefined;

  const encoded = encodeClaudeProjectDir(projectPath);
  const direct = path.join(projectsRoot, encoded, `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;

  // Fallback: scan project directories that start with the encoded prefix.
  if (!fs.existsSync(projectsRoot)) return undefined;
  try {
    const dirs = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of dirs) {
      if (!d.name.startsWith(encoded)) continue;
      const candidate = path.join(projectsRoot, d.name, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore
  }

  return undefined;
}

function parseClaudeSessionFile(filePath: string): Pick<ClaudeSessionSummary, "cwd" | "model" | "version" | "gitBranch"> {
  const head = readFileHead(filePath, 256 * 1024);
  const lines = head.split("\n");

  let cwd: string | undefined;
  let model: string | undefined;
  let version: string | undefined;
  let gitBranch: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = safeJsonParse(line);
    if (!parsed || !isObject(parsed)) continue;

    const type = typeof parsed.type === "string" ? parsed.type : "";
    if ((type === "user" || type === "assistant") && typeof parsed.cwd === "string") {
      cwd = cwd ?? parsed.cwd;
    }
    if ((type === "user" || type === "assistant") && typeof parsed.version === "string") {
      version = version ?? parsed.version;
    }
    if ((type === "user" || type === "assistant") && typeof parsed.gitBranch === "string") {
      gitBranch = gitBranch ?? parsed.gitBranch;
    }

    if (type === "assistant" && isObject(parsed.message)) {
      const msg = parsed.message;
      const m = typeof msg.model === "string" ? msg.model : undefined;
      model = model ?? m;
    }

    if (cwd && model && version && gitBranch) break;
  }

  return { cwd, model, version, gitBranch };
}

export function listClaudeSessions(): ClaudeSessionSummary[] {
  const claudeHome = getClaudeHomeDir();
  if (!claudeHome) return [];

  const historyPath = path.join(claudeHome, "history.jsonl");
  if (!fs.existsSync(historyPath)) return [];

  const raw = fs.readFileSync(historyPath, "utf8");
  const lines = raw.split("\n");

  const byId = new Map<
    string,
    {
      projectPath?: string;
      lastTs: number;
      lastPrompt?: string;
      count: number;
    }
  >();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = safeJsonParse(trimmed) as ClaudeHistoryLine | null;
    if (!parsed || !isObject(parsed)) continue;

    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : null;
    const projectPath = typeof parsed.project === "string" ? parsed.project : undefined;
    const ts = typeof parsed.timestamp === "number" ? parsed.timestamp : null;
    const display = typeof parsed.display === "string" ? parsed.display : undefined;
    if (!sessionId || !ts) continue;

    const prev = byId.get(sessionId);
    if (!prev) {
      byId.set(sessionId, { projectPath, lastTs: ts, lastPrompt: display, count: 1 });
      continue;
    }
    prev.count++;
    if (ts >= prev.lastTs) {
      prev.lastTs = ts;
      if (projectPath) prev.projectPath = projectPath;
      if (display) prev.lastPrompt = display;
    }
  }

  const out: ClaudeSessionSummary[] = [];
  for (const [id, info] of byId.entries()) {
    const sessionFile = findClaudeSessionFile(claudeHome, info.projectPath, id);
    const extra = sessionFile ? parseClaudeSessionFile(sessionFile) : {};
    out.push({
      id,
      projectPath: info.projectPath,
      lastActivityAt: isoFromUnixMs(info.lastTs),
      lastPrompt: info.lastPrompt,
      sessionFile,
      ...extra,
    });
  }

  out.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
  return out;
}

export function formatClaudeSessionDetails(session: ClaudeSessionSummary): string {
  const lines: string[] = [];
  lines.push(`id: ${session.id}`);
  if (session.projectPath) lines.push(`project: ${session.projectPath}`);
  if (session.cwd) lines.push(`cwd: ${session.cwd}`);
  if (session.lastActivityAt) lines.push(`last activity: ${session.lastActivityAt}`);
  if (session.version) lines.push(`cli version: ${session.version}`);
  if (session.gitBranch) lines.push(`git branch: ${session.gitBranch}`);
  if (session.model) lines.push(`model: ${session.model}`);
  if (session.sessionFile) lines.push(`session log: ${session.sessionFile}`);
  if (session.lastPrompt?.trim()) {
    lines.push("");
    lines.push("last prompt:");
    lines.push(session.lastPrompt.trim());
  }
  return lines.join("\n");
}

