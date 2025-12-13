import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeProjectId, formatNewSessionName, normalizeAndEnsureProject } from "../src/state.ts";

describe("state helpers", () => {
  it("computeProjectId is stable", () => {
    expect(computeProjectId("/a/b/c")).toBe(computeProjectId("/a/b/c"));
    expect(computeProjectId("/a/b/c")).not.toBe(computeProjectId("/a/b/d"));
  });

  it("formatNewSessionName includes project id and prefix", () => {
    const name = formatNewSessionName("My Project", "abcd1234");
    expect(name.startsWith("res_")).toBe(true);
    expect(name.includes("_abcd1234_")).toBe(true);
  });

  it("normalizeAndEnsureProject registers a directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resumer-test-"));
    try {
      const state = { version: 1 as const, projects: {}, sessions: {} };
      const project = normalizeAndEnsureProject(state, dir, process.cwd());
      expect(project.path).toBe(dir);
      expect(state.projects[project.id]?.path).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

