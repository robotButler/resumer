import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome } from "./paths.ts";

export type ResumerConfig = {
  codex?: {
    args?: string[];
  };
  claude?: {
    args?: string[];
  };
};

function defaultConfig(): ResumerConfig {
  return {
    codex: { args: ["--yolo"] },
    claude: { args: ["--dangerously-skip-permissions"] },
  };
}

export function getConfigFilePath(): string {
  const override = process.env.RESUMER_CONFIG?.trim();
  if (override) return path.resolve(expandHome(override));

  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base =
    xdg ||
    (process.platform === "win32"
      ? process.env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming")
      : path.join(os.homedir(), ".config"));

  return path.join(base, "resumer", "config.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function parseArgsEnv(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed;
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

export function loadConfigOrDefault(): ResumerConfig {
  const filePath = getConfigFilePath();
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!stat) return defaultConfig();
  if (!stat.isFile()) throw new Error(`Config path is not a file: ${filePath}`);

  const raw = fs.readFileSync(filePath, { encoding: "utf8" });
  const parsed = JSON.parse(raw) as unknown;
  if (!isObject(parsed)) throw new Error(`Invalid config file: ${filePath}`);

  const out: ResumerConfig = {};
  const codex = isObject(parsed.codex) ? parsed.codex : null;
  const claude = isObject(parsed.claude) ? parsed.claude : null;
  if (codex) {
    const args = Array.isArray(codex.args) ? codex.args : undefined;
    if (args && !args.every((v) => typeof v === "string")) throw new Error(`Invalid config file: ${filePath}`);
    out.codex = { args: args?.slice() };
  }
  if (claude) {
    const args = Array.isArray(claude.args) ? claude.args : undefined;
    if (args && !args.every((v) => typeof v === "string")) throw new Error(`Invalid config file: ${filePath}`);
    out.claude = { args: args?.slice() };
  }
  return { ...defaultConfig(), ...out, codex: { ...defaultConfig().codex, ...out.codex }, claude: { ...defaultConfig().claude, ...out.claude } };
}

export function getCodexDefaultArgs(config: ResumerConfig): string[] {
  const env =
    process.env.RESUMER_CODEX_ARGS?.trim() ||
    process.env.RESUMER_CODEX_DEFAULT_ARGS?.trim() ||
    process.env.RES_CODEX_ARGS?.trim();
  const rawArgs = env ? parseArgsEnv(env) : (config.codex?.args ?? defaultConfig().codex!.args!);
  return rawArgs.flatMap((a) => (a === "--yolo" ? ["--dangerously-bypass-approvals-and-sandbox"] : [a])).filter(Boolean);
}

export function getClaudeDefaultArgs(config: ResumerConfig): string[] {
  const env =
    process.env.RESUMER_CLAUDE_ARGS?.trim() ||
    process.env.RESUMER_CLAUDE_DEFAULT_ARGS?.trim() ||
    process.env.RES_CLAUDE_ARGS?.trim();
  const rawArgs = env ? parseArgsEnv(env) : (config.claude?.args ?? defaultConfig().claude!.args!);
  return rawArgs.filter(Boolean);
}

