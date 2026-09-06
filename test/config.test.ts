import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/config.js";

let tmp: string;
let home: string;
let work: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-config-"));
  home = path.join(tmp, "home");
  work = path.join(tmp, "work");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(work, ".claw"), { recursive: true });
  for (const k of ["OPENAI_API_KEY", "OPENAI_CLAW_MODEL", "OPENAI_BASE_URL"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.OPENAI_CLAW_MODEL;
  delete process.env.OPENAI_BASE_URL;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const writeUser = (obj: unknown) =>
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify(obj));
const writeProject = (obj: unknown) =>
  fs.writeFileSync(path.join(work, ".claw", "settings.json"), JSON.stringify(obj));
const load = () => loadConfig({ workdir: work, homeDir: home, projectDir: tmp, memoryDir: tmp });

describe("settings precedence", () => {
  it("project settings win over user settings for model", () => {
    writeUser({ model: "from-user" });
    writeProject({ model: "from-project" });
    expect(load().model).toBe("from-project");
  });

  it("project settings win over user settings for baseURL", () => {
    writeUser({ baseURL: "https://user.example" });
    writeProject({ baseURL: "https://project.example" });
    expect(load().baseURL).toBe("https://project.example");
  });

  it("falls back to user settings when the project says nothing", () => {
    writeUser({ model: "from-user", baseURL: "https://user.example" });
    writeProject({ maxTurns: 7 });
    const cfg = load();
    expect(cfg.model).toBe("from-user");
    expect(cfg.baseURL).toBe("https://user.example");
    expect(cfg.maxTurns).toBe(7);
  });

  it("the environment still overrides both", () => {
    process.env.OPENAI_CLAW_MODEL = "from-env";
    writeUser({ model: "from-user" });
    writeProject({ model: "from-project" });
    expect(load().model).toBe("from-env");
  });

  it("allow/deny lists merge from both files", () => {
    writeUser({ allowedTools: ["Read"] });
    writeProject({ allowedTools: ["Bash(npm:*)"] });
    expect(load().allowedTools).toEqual(["Read", "Bash(npm:*)"]);
  });

  it("requires an API key", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => load()).toThrow(/OPENAI_API_KEY/);
  });
});
