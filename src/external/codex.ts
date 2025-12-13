import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CodexSessionSummary = {
  id: string;
  cwd?: string;
  startedAt?: string;
  lastActivityAt?: string;
  lastPrompt?: string;
  cliVersion?: string;
  model?: string;
  sessionFile?: string;
};

type CodexHistoryLine = {
  session_id?: unknown;
  ts?: unknown;
  text?: unknown;
};

type CodexSessionMetaLine = {
  type?: unknown;
  timestamp?: unknown;
  payload?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isoFromUnixSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
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

function safeJsonParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function walkFiles(root: string, out: string[], maxFiles: number): void {
  if (out.length >= maxFiles) return;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const ent of entries) {
    if (out.length >= maxFiles) return;
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      walkFiles(full, out, maxFiles);
    } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

function getCodexHomeDir(): string {
  const override = process.env.CODEX_HOME?.trim() || process.env.RESUMER_CODEX_HOME?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".codex");
}

function buildLastPromptIndex(codexHome: string): Map<string, { ts: number; text: string }> {
  const map = new Map<string, { ts: number; text: string }>();
  const historyPath = path.join(codexHome, "history.jsonl");
  if (!fs.existsSync(historyPath)) return map;

  const raw = fs.readFileSync(historyPath, "utf8");
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = safeJsonParse(trimmed) as CodexHistoryLine | null;
    if (!parsed || !isObject(parsed)) continue;
    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : null;
    const ts = typeof parsed.ts === "number" ? parsed.ts : null;
    const text = typeof parsed.text === "string" ? parsed.text : null;
    if (!sessionId || !ts || !text) continue;
    const prev = map.get(sessionId);
    if (!prev || ts >= prev.ts) map.set(sessionId, { ts, text });
  }
  return map;
}

function parseCodexSessionFile(filePath: string): Omit<CodexSessionSummary, "lastActivityAt" | "lastPrompt"> | null {
  // Session logs can be large. Only parse the start of the file for metadata.
  const head = readFileHead(filePath, 256 * 1024);
  const lines = head.split("\n");

  let id: string | undefined;
  let cwd: string | undefined;
  let startedAt: string | undefined;
  let cliVersion: string | undefined;
  let model: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = safeJsonParse(line) as CodexSessionMetaLine | null;
    if (!parsed || !isObject(parsed)) continue;

    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type === "session_meta" && isObject(parsed.payload)) {
      const payload = parsed.payload;
      const pid = typeof payload.id === "string" ? payload.id : undefined;
      const pcwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
      const pts = typeof payload.timestamp === "string" ? payload.timestamp : undefined;
      const pcli = typeof payload.cli_version === "string" ? payload.cli_version : undefined;
      id = id ?? pid;
      cwd = cwd ?? pcwd;
      startedAt = startedAt ?? pts ?? (typeof parsed.timestamp === "string" ? parsed.timestamp : undefined);
      cliVersion = cliVersion ?? pcli;
      continue;
    }

    if (type === "turn_context" && isObject(parsed.payload)) {
      const payload = parsed.payload;
      const m = typeof payload.model === "string" ? payload.model : undefined;
      model = model ?? m;
      continue;
    }

    if (id && cwd && startedAt && cliVersion && model) break;
  }

  if (!id) return null;
  return { id, cwd, startedAt, cliVersion, model, sessionFile: filePath };
}

export function listCodexSessions(): CodexSessionSummary[] {
  const codexHome = getCodexHomeDir();
  const sessionsRoot = path.join(codexHome, "sessions");
  if (!fs.existsSync(sessionsRoot) || !fs.statSync(sessionsRoot).isDirectory()) return [];

  const lastPrompt = buildLastPromptIndex(codexHome);

  const sessionFiles: string[] = [];
  walkFiles(sessionsRoot, sessionFiles, 5000);

  const out: CodexSessionSummary[] = [];
  for (const filePath of sessionFiles) {
    const parsed = parseCodexSessionFile(filePath);
    if (!parsed) continue;
    const last = lastPrompt.get(parsed.id);
    const lastActivityAt = last ? isoFromUnixSeconds(last.ts) : undefined;
    out.push({
      ...parsed,
      lastActivityAt,
      lastPrompt: last?.text,
    });
  }

  out.sort((a, b) => {
    const aKey = a.lastActivityAt ?? a.startedAt ?? "";
    const bKey = b.lastActivityAt ?? b.startedAt ?? "";
    return bKey.localeCompare(aKey);
  });
  return out;
}

export function formatCodexSessionDetails(session: CodexSessionSummary): string {
  const lines: string[] = [];
  lines.push(`id: ${session.id}`);
  if (session.cwd) lines.push(`cwd: ${session.cwd}`);
  if (session.startedAt) lines.push(`started: ${session.startedAt}`);
  if (session.lastActivityAt) lines.push(`last activity: ${session.lastActivityAt}`);
  if (session.cliVersion) lines.push(`cli version: ${session.cliVersion}`);
  if (session.model) lines.push(`model: ${session.model}`);
  if (session.sessionFile) lines.push(`session log: ${session.sessionFile}`);
  if (session.lastPrompt?.trim()) {
    lines.push("");
    lines.push("last prompt:");
    lines.push(session.lastPrompt.trim());
  }
  return lines.join("\n");
}

