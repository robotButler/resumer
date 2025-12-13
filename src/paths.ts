import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

export function resolveProjectPath(inputPath: string, cwd: string): string {
  const expanded = expandHome(inputPath);
  const resolved = path.resolve(cwd, expanded);

  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat) throw new Error(`Path does not exist: ${inputPath}`);
  if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${inputPath}`);

  return fs.realpathSync(resolved);
}

export function projectDisplayName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}

