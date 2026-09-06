import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { findCommand, type CommandContext } from "../src/commands/index.js";
import { buildSystemPrompt } from "../src/prompts/system.js";
import { setPlanMode } from "../src/planmode.js";
import { listMemories } from "../src/memory/index.js";
import type { ClawConfig } from "../src/config.js";

let tmp: string;
let config: ClawConfig;
let logged: string[];
let originalLog: typeof console.log;

const ctx = (over: Partial<CommandContext> = {}): CommandContext =>
  ({
    agent: { refreshSystemPrompt() {}, pushUser() {}, conversation: [] } as any,
    config,
    permissions: { mode: config.permissionMode, setMode(m: any) { config.permissionMode = m; } } as any,
    exit() {},
    ...over,
  }) as CommandContext;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-cmds-"));
  fs.mkdirSync(path.join(tmp, "memory"), { recursive: true });
  config = {
    workdir: tmp,
    homeDir: tmp,
    projectDir: tmp,
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
  };
  logged = [];
  originalLog = console.log;
  console.log = (...a: any[]) => logged.push(a.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("/remember", () => {
  it("reports a missing name instead of throwing out of the dispatcher", async () => {
    // `/remember project :: d :: b` threw "invalid memory name" all the way
    // past the REPL loop and the TUI submit handler.
    const cmd = findCommand("remember", config)!;
    expect(() => cmd.run("project :: some description :: some body", ctx())).not.toThrow();
    expect(logged.join(" ")).toContain("the name is missing");
    expect(listMemories(config)).toEqual([]);
  });

  it("rejects a name that reduces to nothing", async () => {
    const cmd = findCommand("remember", config)!;
    expect(() => cmd.run("project --- :: d :: b", ctx())).not.toThrow();
    expect(listMemories(config)).toEqual([]);
  });

  it("saves a well-formed memory", async () => {
    const cmd = findCommand("remember", config)!;
    await cmd.run("feedback Prefers Tabs :: indentation :: use tabs", ctx());
    const entries = listMemories(config);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("prefers-tabs");
  });
});

describe("plan mode", () => {
  it("appears in the system prompt only while it is on", () => {
    setPlanMode(config, true);
    expect(buildSystemPrompt({ config, tools: [] })).toContain("PLAN MODE");
    setPlanMode(config, false);
    expect(buildSystemPrompt({ config, tools: [] })).not.toContain("PLAN MODE");
  });

  it("returns to the mode it was switched on from", () => {
    // Leaving plan mode used to drop everyone to "ask", discarding an
    // acceptEdits or bypassPermissions session.
    config.permissionMode = "acceptEdits";
    setPlanMode(config, true, "acceptEdits");
    expect(config.permissionMode).toBe("plan");
    setPlanMode(config, false);
    expect(config.permissionMode).toBe("acceptEdits");
  });

  it("falls back to ask when it was switched on from plan somehow", () => {
    setPlanMode(config, true, "plan");
    setPlanMode(config, false);
    expect(config.permissionMode).toBe("ask");
  });
});

describe("command lookup", () => {
  it("finds builtins and reports unknown names as absent", () => {
    expect(findCommand("help", config)).toBeTruthy();
    expect(findCommand("definitely-not-a-command", config)).toBeUndefined();
  });

  it("does not expose project skills until the project is trusted", () => {
    const skill = path.join(tmp, ".claw", "skills", "deploy");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: deploy\ndescription: d\n---\n\nbody\n");
    expect(findCommand("deploy", config)).toBeUndefined();
    expect(findCommand("deploy", { ...config, trustProjectDefinitions: true })).toBeTruthy();
  });
});
