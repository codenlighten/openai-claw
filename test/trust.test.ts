import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  isProjectTrusted,
  markProjectTrusted,
  resolveProjectTrust,
  countProjectDefinitions,
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
    expect(out).toEqual({ trustHooks: true, trustMcp: true, trustDefinitions: true });
  });

  it("auto-allows once project is trusted", async () => {
    writeProjectSettings({ hooks: { PreToolUse: [{ command: "echo x" }] } });
    markProjectTrusted(cfg());
    const out = await resolveProjectTrust(cfg(), { interactive: true });
    expect(out).toEqual({ trustHooks: true, trustMcp: true, trustDefinitions: true });
  });

  it("denies non-interactive runs with project-level hooks", async () => {
    writeProjectSettings({ hooks: { PreToolUse: [{ command: "echo x" }] } });
    const out = await resolveProjectTrust(cfg(), { interactive: false });
    expect(out).toEqual({ trustHooks: false, trustMcp: false, trustDefinitions: false });
    expect(isProjectTrusted(cfg())).toBe(false);
  });

  it("yes answer persists trust", async () => {
    writeProjectSettings({ hooks: { PreToolUse: [{ command: "echo x" }] } });
    const prompter: TrustPrompter = async () => "yes";
    const out = await resolveProjectTrust(cfg(), { interactive: true, prompter });
    expect(out).toEqual({ trustHooks: true, trustMcp: true, trustDefinitions: true });
    expect(isProjectTrusted(cfg())).toBe(true);
  });

  it("once answer grants this session but does not persist", async () => {
    writeProjectSettings({ mcpServers: { srv: { command: "x" } } });
    const prompter: TrustPrompter = async () => "once";
    const out = await resolveProjectTrust(cfg(), { interactive: true, prompter });
    expect(out).toEqual({ trustHooks: true, trustMcp: true, trustDefinitions: true });
    expect(isProjectTrusted(cfg())).toBe(false);
  });

  it("no answer denies and does not persist", async () => {
    writeProjectSettings({ mcpServers: { srv: { command: "x" } } });
    const prompter: TrustPrompter = async () => "no";
    const out = await resolveProjectTrust(cfg(), { interactive: true, prompter });
    expect(out).toEqual({ trustHooks: false, trustMcp: false, trustDefinitions: false });
    expect(isProjectTrusted(cfg())).toBe(false);
  });

  it("fails closed on malformed project settings", async () => {
    fs.mkdirSync(path.join(work, ".claw"), { recursive: true });
    fs.writeFileSync(path.join(work, ".claw", "settings.json"), "{not json");
    const out = await resolveProjectTrust(cfg(), { interactive: false });
    // A trust gate must not grant trust on its own error path.
    expect(out).toEqual({ trustHooks: false, trustMcp: false, trustDefinitions: false });
  });
});

describe("project agent and skill definitions", () => {
  const writeAgent = (name: string, body: string) => {
    const dir = path.join(work, ".claw", "agents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.md`), body);
  };
  const writeSkill = (name: string, body: string) => {
    const dir = path.join(work, ".claw", "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  };

  it("counts them alongside hooks and MCP servers", () => {
    writeAgent("helper", "---\nname: helper\ndescription: d\n---\nbody\n");
    writeSkill("deploy", "---\nname: deploy\ndescription: d\n---\nbody\n");
    expect(countProjectDefinitions(work)).toBe(2);
  });

  it("prompts for a project that only defines an agent", async () => {
    // The agent's description lands in the main agent's system prompt via the
    // Task catalog, so it needs consent even with no hooks or MCP servers.
    writeAgent("helper", "---\nname: helper\ndescription: injected text\n---\nbody\n");
    let asked = 0;
    const prompter: TrustPrompter = async (req) => {
      asked++;
      expect(req.definitions).toBe(1);
      return "no";
    };
    const out = await resolveProjectTrust(cfg(), { interactive: true, prompter });
    expect(asked).toBe(1);
    expect(out.trustDefinitions).toBe(false);
  });

  it("grants definitions along with the rest on yes", async () => {
    writeAgent("helper", "---\nname: helper\ndescription: d\n---\nbody\n");
    const out = await resolveProjectTrust(cfg(), { interactive: true, prompter: async () => "yes" });
    expect(out).toEqual({ trustHooks: true, trustMcp: true, trustDefinitions: true });
  });

  it("denies definitions on a non-interactive run", async () => {
    writeAgent("helper", "---\nname: helper\ndescription: d\n---\nbody\n");
    const out = await resolveProjectTrust(cfg(), { interactive: false });
    expect(out.trustDefinitions).toBe(false);
  });

  it("does not prompt when the project defines nothing", async () => {
    const out = await resolveProjectTrust(cfg(), { interactive: true, prompter: async () => "no" });
    expect(out.trustDefinitions).toBe(true);
  });
});
