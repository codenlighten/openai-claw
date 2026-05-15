import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createIdentity,
  SessionAttestor,
  verifyAttestation,
} from "../src/attest/index.js";
import type { ClawConfig } from "../src/config.js";

let home: string;
const cfg = (): ClawConfig => ({
  workdir: home,
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "claw-sess-att-"));
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("SessionAttestor", () => {
  it("is a no-op when no identity is configured", async () => {
    const sa = new SessionAttestor(cfg(), { quietWhenNoIdentity: true });
    expect(sa.enabled).toBe(false);
    expect(sa.status).toBe("no-identity");
    sa.recordUserPrompt("hi");
    sa.onAgentEvent({ type: "text", data: "hello" });
    expect(sa.leafCount).toBe(0);
    expect(await sa.writeSidecar("s1")).toBeNull();
  });

  it("is a no-op when forced off via opts.disabled", async () => {
    await createIdentity(cfg());
    const sa = new SessionAttestor(cfg(), { disabled: true });
    expect(sa.enabled).toBe(false);
    expect(sa.status).toBe("disabled");
  });

  it("warns and goes no-op on resumed sessions, leaving any existing sidecar untouched", async () => {
    await createIdentity(cfg());
    // Plant an existing sidecar — must survive a resumed-session run.
    const existing = path.join(home, "sessions", "s2.attest.json");
    fs.writeFileSync(existing, '{"existing":true}');
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const sa = new SessionAttestor(cfg(), { resumed: true });
    expect(sa.enabled).toBe(false);
    expect(sa.status).toBe("resumed");
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/resumed session/);
    sa.recordUserPrompt("would-be-leaf");
    sa.onAgentEvent({ type: "text", data: "ignored" });
    expect(sa.leafCount).toBe(0);
    expect(await sa.writeSidecar("s2")).toBeNull();
    expect(fs.readFileSync(existing, "utf8")).toBe('{"existing":true}');
    warn.mockRestore();
  });

  it("collects leaves across multiple writeSidecar calls — sidecar reflects cumulative state", async () => {
    await createIdentity(cfg());
    const sa = new SessionAttestor(cfg(), { quietWhenNoIdentity: true });
    expect(sa.enabled).toBe(true);
    sa.recordUserPrompt("turn 1");
    sa.onAgentEvent({ type: "text", data: "reply 1" });
    const path1 = await sa.writeSidecar("multi");
    expect(path1).toBeTruthy();
    const first = JSON.parse(fs.readFileSync(path1!, "utf8"));
    expect(first.header.leafCount).toBe(2);

    sa.recordUserPrompt("turn 2");
    sa.onAgentEvent({ type: "text", data: "reply 2" });
    const path2 = await sa.writeSidecar("multi");
    expect(path2).toBe(path1); // same file
    const second = JSON.parse(fs.readFileSync(path2!, "utf8"));
    expect(second.header.leafCount).toBe(4);
    expect(second.header.merkleRoot).not.toBe(first.header.merkleRoot);

    const report = await verifyAttestation(second, { strict: true });
    expect(report.ok).toBe(true);
  });

  it("survives a finalize failure without crashing the caller", async () => {
    await createIdentity(cfg());
    const sa = new SessionAttestor(cfg(), { quietWhenNoIdentity: true });
    sa.recordUserPrompt("hi");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    try {
      const r = await sa.writeSidecar("err");
      expect(r).toBeNull();
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/could not write attestation/);
    } finally {
      writeSpy.mockRestore();
      warn.mockRestore();
    }
  });
});
