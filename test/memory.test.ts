import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { listMemories, writeMemory, deleteMemory } from "../src/memory/index.js";
import type { ClawConfig } from "../src/config.js";

let tmp: string;
const cfg = (): ClawConfig => ({
  workdir: tmp,
  homeDir: tmp,
  projectDir: tmp,
  memoryDir: tmp,
  model: "test",
  apiKey: "x",
  allowedTools: [],
  deniedTools: [],
  contextWindow: 0,
  compactThreshold: 1,
  permissionMode: "ask",
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-memory-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("memory", () => {
  it("writes and lists a memory", () => {
    writeMemory(cfg(), {
      name: "test-note",
      description: "a test memory",
      type: "user",
      body: "user prefers concise responses",
    });
    const entries = listMemories(cfg());
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("test-note");
    expect(entries[0].type).toBe("user");
    expect(entries[0].body).toContain("concise");
  });

  it("updates MEMORY.md index after writing", () => {
    writeMemory(cfg(), {
      name: "x",
      description: "x desc",
      type: "project",
      body: "x body",
    });
    const idx = fs.readFileSync(path.join(tmp, "MEMORY.md"), "utf8");
    expect(idx).toContain("[x]");
    expect(idx).toContain("x desc");
  });

  it("deletes a memory", () => {
    writeMemory(cfg(), { name: "del-me", description: "d", type: "user", body: "b" });
    const ok = deleteMemory(cfg(), "del-me");
    expect(ok).toBe(true);
    expect(listMemories(cfg())).toHaveLength(0);
  });

  it("delete returns false for missing memory", () => {
    expect(deleteMemory(cfg(), "nope")).toBe(false);
  });
});
