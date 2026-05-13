import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { startDashboard } from "../src/web/index.js";
import { saveSession } from "../src/session.js";
import { appendCostLog } from "../src/cost.js";
import type { ClawConfig } from "../src/config.js";
import type { ChatMessage } from "../src/client.js";

let tmp: string;
let server: { close: () => Promise<void> } | null;
let port: number;

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

function get(p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://localhost:${port}${p}`, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      })
      .on("error", reject);
  });
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-dashboard-"));
  // Pick an ephemeral port and override startDashboard's blocking wait.
  port = 39000 + Math.floor(Math.random() * 1000);
  // Race startDashboard against a 100ms wait; we never call its blocking promise.
  const ready = new Promise<void>((resolve) => {
    const origCreate = http.createServer;
    const wrapped = (...args: any[]) => {
      const s = origCreate.apply(http, args as any);
      const origListen = s.listen.bind(s);
      (s as any).listen = (p: number, cb?: () => void) =>
        origListen(p, () => {
          server = { close: () => new Promise<void>((r) => s.close(() => r())) };
          cb?.();
          resolve();
        });
      return s;
    };
    (http as any).createServer = wrapped;
    void startDashboard(cfg(), port);
  });
  await ready;
});

afterEach(async () => {
  if (server) await server.close();
  server = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("dashboard HTTP API", () => {
  it("serves /api/meta", async () => {
    const r = await get("/api/meta");
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.workdir).toBe(tmp);
  });

  it("serves the index HTML", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.body).toContain("openai-claw");
  });

  it("lists sessions and serves a specific one", async () => {
    const { id } = saveSession(cfg(), [{ role: "user", content: "hello" }] as ChatMessage[]);
    const list = JSON.parse((await get("/api/sessions")).body);
    expect(list.find((s: any) => s.id === id)).toBeTruthy();
    const detail = JSON.parse((await get(`/api/sessions/${encodeURIComponent(id)}`)).body);
    expect(detail.messages?.[0]?.content).toBe("hello");
  });

  it("aggregates the cost log", async () => {
    appendCostLog(cfg(), { model: "gpt-5-nano", prompt_tokens: 100, cached_tokens: 50, completion_tokens: 20, costUSD: 0.001 });
    const data = JSON.parse((await get("/api/cost")).body);
    expect(data.entries).toHaveLength(1);
    expect(data.byModel[0].model).toBe("gpt-5-nano");
  });

  it("returns {} for evals when no report file exists", async () => {
    const data = JSON.parse((await get("/api/evals")).body);
    expect(data).toEqual({});
  });
});
