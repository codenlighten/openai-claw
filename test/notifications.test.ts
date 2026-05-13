import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock fetch so Slack/ntfy paths never touch the network.
const fetchCalls: { url: string; init?: any }[] = [];
beforeEach(() => {
  fetchCalls.length = 0;
  (globalThis as any).fetch = async (url: string, init?: any) => {
    fetchCalls.push({ url, init });
    return { ok: true } as any;
  };
});

import { notify } from "../src/notifications/index.js";
import type { ClawConfig } from "../src/config.js";

let tmp: string;
const cfg = (overrides: Partial<ClawConfig> = {}): ClawConfig => ({
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
  ...overrides,
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-notify-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("notify", () => {
  it("is a no-op when no notifications config is present", async () => {
    await notify(cfg(), { kind: "Stop", title: "x", body: "y" });
    expect(fetchCalls).toHaveLength(0);
  });

  it("posts to a configured Slack webhook", async () => {
    fs.writeFileSync(
      path.join(tmp, "settings.json"),
      JSON.stringify({
        notifications: { slack: { webhook: "https://hooks.example/abc" }, minDurationSec: 0 },
      })
    );
    await notify(cfg(), { kind: "Stop", title: "done", body: "hi", durationSec: 1 });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://hooks.example/abc");
    expect(fetchCalls[0].init.body).toContain("done");
  });

  it("respects minDurationSec gate", async () => {
    fs.writeFileSync(
      path.join(tmp, "settings.json"),
      JSON.stringify({
        notifications: { slack: { webhook: "https://hooks.example/abc" }, minDurationSec: 30 },
      })
    );
    await notify(cfg(), { kind: "Stop", title: "done", body: "hi", durationSec: 1 });
    expect(fetchCalls).toHaveLength(0);
  });

  it("posts to ntfy when configured", async () => {
    fs.writeFileSync(
      path.join(tmp, "settings.json"),
      JSON.stringify({
        notifications: { ntfy: { url: "https://ntfy.sh/test", priority: "high" }, minDurationSec: 0 },
      })
    );
    await notify(cfg(), { kind: "Stop", title: "t", body: "b", durationSec: 1 });
    expect(fetchCalls.some((c) => c.url === "https://ntfy.sh/test")).toBe(true);
    const ntfy = fetchCalls.find((c) => c.url === "https://ntfy.sh/test")!;
    expect(ntfy.init.headers.Priority).toBe("high");
  });
});
