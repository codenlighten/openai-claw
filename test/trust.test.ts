import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  isProjectTrusted,
  markProjectTrusted,
  resolveProjectTrust,
  type TrustPrompter,
} from "../src/trust.js";
import type { ClawConfig } from "../src/config.js";

let home: string;
let work: string;
const cfg = (): ClawConfig => ({
  workdir: work,
  homeDir: home,
  projectDir: home,
  memoryDir: home,
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "claw-trust-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "claw-trust-work-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

const writeProjectSettings = (obj: unknown) => {
  fs.mkdirSync(path.join(work, ".claw"), { recursive: true });
  fs.writeFileSync(path.join(work, ".claw", "settings.json"), JSON.stringify(obj));
};

describe("project trust store", () => {
  it("isProjectTrusted is false by default", () => {
    expect(isProjectTrusted(cfg())).toBe(false);
  });

  it("markProjectTrusted persists the workdir", () => {
    markProjectTrusted(cfg());
    expect(isProjectTrusted(cfg())).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));
    expect(saved.trustedProjects).toContain(path.resolve(work));
  });

  it("markProjectTrusted is idempotent", () => {
    markProjectTrusted(cfg());
    markProjectTrusted(cfg());
    const saved = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));
    expect(saved.trustedProjects.filter((p: string) => p === path.resolve(work))).toHaveLength(1);
  });
});

describe("resolveProjectTrust", () => {
  it("auto-allows when project has no hooks or MCP", async () => {
    const out = await resolveProjectTrust(cfg(), { interactive: true });
    expect(out).toEqual({ trustHooks: true, trustMcp: true });
  });

  it("auto-allows once project is trusted", async () => {
    writeProjectSettings({ hooks: { PreToolUse: [{ command: "echo x" }] } });
    markProjectTrusted(cfg());
    const out = await resolveProjectTrust(cfg(), { interactive: true });
    expect(out).toEqual({ trustHooks: true, trustMcp: true });
  });

  it("denies non-interactive runs with project-level hooks", async () => {
    writeProjectSettings({ hooks: { PreToolUse: [{ command: "echo x" }] } });
    const out = await resolveProjectTrust(cfg(), { interactive: false });
    expect(out).toEqual({ trustHooks: false, trustMcp: false });
    expect(isProjectTrusted(cfg())).toBe(false);
  });

  it("yes answer persists trust", async () => {
    writeProjectSettings({ hooks: { PreToolUse: [{ command: "echo x" }] } });
    const prompter: TrustPrompter = async () => "yes";
    const out = await resolveProjectTrust(cfg(), { interactive: true, prompter });
    expect(out).toEqual({ trustHooks: true, trustMcp: true });
    expect(isProjectTrusted(cfg())).toBe(true);
  });

  it("once answer grants this session but does not persist", async () => {
    writeProjectSettings({ mcpServers: { srv: { command: "x" } } });
    const prompter: TrustPrompter = async () => "once";
    const out = await resolveProjectTrust(cfg(), { interactive: true, prompter });
    expect(out).toEqual({ trustHooks: true, trustMcp: true });
    expect(isProjectTrusted(cfg())).toBe(false);
  });

  it("no answer denies and does not persist", async () => {
    writeProjectSettings({ mcpServers: { srv: { command: "x" } } });
    const prompter: TrustPrompter = async () => "no";
    const out = await resolveProjectTrust(cfg(), { interactive: true, prompter });
    expect(out).toEqual({ trustHooks: false, trustMcp: false });
    expect(isProjectTrusted(cfg())).toBe(false);
  });

  it("handles malformed project settings without throwing", async () => {
    fs.mkdirSync(path.join(work, ".claw"), { recursive: true });
    fs.writeFileSync(path.join(work, ".claw", "settings.json"), "{not json");
    const out = await resolveProjectTrust(cfg(), { interactive: false });
    // Malformed → treat as no project-level entries (auto-allow).
    expect(out).toEqual({ trustHooks: true, trustMcp: true });
  });
});
