import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { serverEnvNames, buildServerEnv, computeFingerprint } from "../src/mcp/fingerprint.js";
import { loadMcpServerSpecs } from "../src/mcp/index.js";
import type { ClawConfig } from "../src/config.js";

let tmp: string;
const cfg = (): ClawConfig => ({
  workdir: path.join(tmp, "project"),
  homeDir: path.join(tmp, "home"),
  projectDir: tmp,
  memoryDir: tmp,
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-mcp-env-"));
  fs.mkdirSync(path.join(tmp, "home"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "project", ".claw"), { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.OPENAI_CLAW_MCP_ENV_PASSTHROUGH;
  delete process.env.CLAW_TEST_SECRET;
});

describe("MCP subprocess environment", () => {
  it("withholds secrets that are not on the passthrough list", () => {
    process.env.CLAW_TEST_SECRET = "super-secret";
    const env = buildServerEnv();
    expect(env.CLAW_TEST_SECRET).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("passes through what a server needs to run", () => {
    const env = buildServerEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
  });

  it("passes through values the server config declares", () => {
    const env = buildServerEnv({ GITHUB_TOKEN: "declared-value" });
    expect(env.GITHUB_TOKEN).toBe("declared-value");
  });

  it("honors an explicit opt-in", () => {
    process.env.CLAW_TEST_SECRET = "super-secret";
    process.env.OPENAI_CLAW_MCP_ENV_PASSTHROUGH = "CLAW_TEST_SECRET";
    expect(buildServerEnv().CLAW_TEST_SECRET).toBe("super-secret");
  });
});

describe("MCP fingerprint stability", () => {
  const spec = { type: "stdio" as const, command: "/bin/sh", args: ["-c", "true"] };

  it("does not change when an unrelated variable enters the environment", () => {
    const before = computeFingerprint({ name: "s", config: spec }).fingerprintId;
    process.env.CLAW_TEST_SECRET = "noise";
    const after = computeFingerprint({ name: "s", config: spec }).fingerprintId;
    expect(after).toBe(before);
  });

  it("records only the variable names the server actually receives", () => {
    process.env.CLAW_TEST_SECRET = "noise";
    const fp = computeFingerprint({ name: "s", config: spec });
    expect(fp.envNames).not.toContain("CLAW_TEST_SECRET");
    expect(fp.envNames).toEqual(serverEnvNames(undefined));
  });

  it("changes when the declared env changes", () => {
    const a = computeFingerprint({ name: "s", config: spec }).fingerprintId;
    const b = computeFingerprint({
      name: "s",
      config: { ...spec, env: { GITHUB_TOKEN: "x" } },
    }).fingerprintId;
    expect(b).not.toBe(a);
  });
});

describe("MCP server scope", () => {
  it("tags servers with the settings file that declared them", () => {
    fs.writeFileSync(
      path.join(tmp, "home", "settings.json"),
      JSON.stringify({ mcpServers: { fromUser: { command: "/bin/sh" } } })
    );
    fs.writeFileSync(
      path.join(tmp, "project", ".claw", "settings.json"),
      JSON.stringify({ mcpServers: { fromProject: { command: "/bin/sh" } } })
    );
    const specs = loadMcpServerSpecs(cfg());
    expect(specs.find((s) => s.name === "fromUser")?.scope).toBe("user");
    expect(specs.find((s) => s.name === "fromProject")?.scope).toBe("project");
  });

  it("a project override of a user server is scoped to the project", () => {
    fs.writeFileSync(
      path.join(tmp, "home", "settings.json"),
      JSON.stringify({ mcpServers: { shared: { command: "/bin/sh" } } })
    );
    fs.writeFileSync(
      path.join(tmp, "project", ".claw", "settings.json"),
      JSON.stringify({ mcpServers: { shared: { command: "/bin/echo" } } })
    );
    expect(loadMcpServerSpecs(cfg())[0].scope).toBe("project");
  });
});
