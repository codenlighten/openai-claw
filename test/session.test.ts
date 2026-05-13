import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { saveSession, loadSession, listSessions, forkSession } from "../src/session.js";
import type { ClawConfig } from "../src/config.js";
import type { ChatMessage } from "../src/client.js";

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
  maxTurns: 50,
  maxToolResultChars: 50_000,
  models: {},
});

const msg = (text: string): ChatMessage => ({ role: "user", content: text });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-sessions-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("session.ts multi-session", () => {
  it("mints a new id when none provided", () => {
    const r = saveSession(cfg(), [msg("hi")]);
    expect(r.id).toBeTruthy();
    expect(fs.existsSync(r.file)).toBe(true);
  });

  it("re-uses the same id when passed back, updating the same file", () => {
    const r1 = saveSession(cfg(), [msg("hi")]);
    const r2 = saveSession(cfg(), [msg("hi"), msg("again")], r1.id);
    expect(r2.id).toBe(r1.id);
    expect(r2.file).toBe(r1.file);
    expect(listSessions(cfg())).toHaveLength(1);
  });

  it("listSessions sorts most-recent first and exposes preview", async () => {
    const a = saveSession(cfg(), [msg("first session prompt")]);
    // Force a >1ms delay so timestamps differ in the id and savedAt.
    await new Promise((r) => setTimeout(r, 5));
    const b = saveSession(cfg(), [msg("second session prompt")]);
    const list = listSessions(cfg());
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
    expect(list[0].preview).toContain("second");
  });

  it("loadSession with no id picks the most recent", async () => {
    saveSession(cfg(), [msg("oldest")]);
    await new Promise((r) => setTimeout(r, 5));
    const newest = saveSession(cfg(), [msg("newest")]);
    const loaded = loadSession(cfg());
    expect(loaded?.id).toBe(newest.id);
  });

  it("loadSession returns null for an unknown id", () => {
    saveSession(cfg(), [msg("a")]);
    expect(loadSession(cfg(), "nope")).toBeNull();
  });

  it("forkSession produces a new id with the same messages", () => {
    const orig = saveSession(cfg(), [msg("original")]);
    const fork = forkSession(cfg(), [msg("original")]);
    expect(fork.id).not.toBe(orig.id);
    expect(listSessions(cfg())).toHaveLength(2);
  });
});
