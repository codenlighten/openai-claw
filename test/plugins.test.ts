import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { installPlugin, removePlugin, listInstalled, searchRegistry } from "../src/plugins/index.js";
import type { ClawConfig } from "../src/config.js";

let tmp: string;
let pluginSrc: string;

const cfg = (): ClawConfig => ({
  workdir: path.join(tmp, "workdir"),
  homeDir: path.join(tmp, "home"),
  projectDir: path.join(tmp, "project"),
  memoryDir: path.join(tmp, "memory"),
  model: "test",
  apiKey: "x",
  allowedTools: [],
  deniedTools: [],
  contextWindow: 0,
  compactThreshold: 1,
  permissionMode: "ask",
  maxTurns: 50,
  maxToolResultChars: 50_000,
  models: {},
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-plugins-"));
  for (const sub of ["workdir", "home", "project", "memory"]) {
    fs.mkdirSync(path.join(tmp, sub), { recursive: true });
  }
  // Build a tiny local plugin and `git init` it so `git clone <path>` works.
  pluginSrc = path.join(tmp, "src-plugin");
  fs.mkdirSync(path.join(pluginSrc, "skills", "demo"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginSrc, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: a demo skill\n---\n\ndemo body\n"
  );
  fs.mkdirSync(path.join(pluginSrc, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginSrc, "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: reviews things\n---\n\nbody\n"
  );
  spawnSync("git", ["init", "-q"], { cwd: pluginSrc });
  spawnSync("git", ["add", "."], { cwd: pluginSrc });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init", "-q"], { cwd: pluginSrc });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("plugin marketplace", () => {
  it("clones a local git source, detects skills+agents, and writes the lockfile", () => {
    const r = installPlugin(cfg(), pluginSrc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.provides.skills).toEqual(["demo"]);
    expect(r.entry.provides.agents).toEqual(["reviewer.md"]);
    expect(r.entry.ref).toMatch(/^[0-9a-f]{40}$/);

    const installed = listInstalled(cfg());
    expect(installed).toHaveLength(1);
    expect(installed[0].name).toBe(path.basename(pluginSrc));

    // Links exist in homeDir/skills and homeDir/agents.
    expect(fs.existsSync(path.join(tmp, "home", "skills", "demo"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "home", "agents", "reviewer.md"))).toBe(true);
  });

  it("refuses to install the same plugin twice", () => {
    const a = installPlugin(cfg(), pluginSrc);
    expect(a.ok).toBe(true);
    const b = installPlugin(cfg(), pluginSrc);
    expect(b.ok).toBe(false);
  });

  it("removes a plugin and its links", () => {
    installPlugin(cfg(), pluginSrc);
    const r = removePlugin(cfg(), path.basename(pluginSrc));
    expect(r.ok).toBe(true);
    expect(listInstalled(cfg())).toHaveLength(0);
    expect(fs.existsSync(path.join(tmp, "home", "skills", "demo"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "home", "agents", "reviewer.md"))).toBe(false);
  });

  it("searchRegistry finds registry entries by substring", () => {
    expect(searchRegistry("pdf").map((h) => h.name)).toContain("pdf-skill");
    expect(searchRegistry("nonexistent-term")).toEqual([]);
  });
});
