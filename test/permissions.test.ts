import { describe, it, expect } from "vitest";
import { PermissionManager } from "../src/permissions/index.js";
import type { ClawConfig } from "../src/config.js";

function cfg(overrides: Partial<ClawConfig> = {}): ClawConfig {
  return {
    workdir: "/tmp",
    homeDir: "/tmp",
    projectDir: "/tmp",
    memoryDir: "/tmp",
    model: "test",
    apiKey: "x",
    allowedTools: [],
    deniedTools: [],
    contextWindow: 0,
    compactThreshold: 1,
    permissionMode: "ask",
    ...overrides,
  };
}

describe("PermissionManager", () => {
  it("bypass mode allows everything", async () => {
    const pm = new PermissionManager(cfg({ permissionMode: "bypassPermissions" }));
    const r = await pm.check("Bash", { command: "rm -rf /" });
    expect(r.allow).toBe(true);
  });

  it("denylist trumps allowlist", async () => {
    const pm = new PermissionManager(
      cfg({ allowedTools: ["Bash"], deniedTools: ["Bash(rm:*)"] })
    );
    const r = await pm.check("Bash", { command: "rm -rf /" });
    expect(r.allow).toBe(false);
  });

  it("Bash(prefix:*) pattern matches commands", async () => {
    const pm = new PermissionManager(cfg({ allowedTools: ["Bash(git:*)"] }));
    const r = await pm.check("Bash", { command: "git status" });
    expect(r.allow).toBe(true);
    const r2 = await pm.check("Bash", { command: "git log" });
    expect(r2.allow).toBe(true);
  });

  it("plain tool name pattern matches", async () => {
    const pm = new PermissionManager(cfg({ allowedTools: ["Read"] }));
    const r = await pm.check("Read", { file_path: "/etc/passwd" });
    expect(r.allow).toBe(true);
  });

  it("acceptEdits mode auto-allows Write and Edit", async () => {
    const pm = new PermissionManager(cfg({ permissionMode: "acceptEdits" }));
    const r1 = await pm.check("Write", { file_path: "/tmp/x", content: "" });
    const r2 = await pm.check("Edit", {});
    expect(r1.allow).toBe(true);
    expect(r2.allow).toBe(true);
  });

  it("plan mode denies all mutating tools", async () => {
    const pm = new PermissionManager(cfg({ permissionMode: "plan" }));
    const r = await pm.check("Bash", { command: "ls" });
    expect(r.allow).toBe(false);
  });

  it("ask mode calls the injected prompter", async () => {
    const pm = new PermissionManager(cfg());
    pm.setPrompter(async () => "yes");
    const r = await pm.check("Bash", { command: "ls" });
    expect(r.allow).toBe(true);
  });
});
