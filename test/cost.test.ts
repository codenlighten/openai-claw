import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  computeCostUSD,
  priceFor,
  appendCostLog,
  readCostLog,
  costByDay,
  costByModel,
} from "../src/cost.js";
import type { ClawConfig } from "../src/config.js";

describe("cost", () => {
  it("looks up known model prices", () => {
    expect(priceFor("gpt-5-nano")).toBeTruthy();
    expect(priceFor("gpt-4o")).toBeTruthy();
  });

  it("falls back to family prefix", () => {
    expect(priceFor("gpt-4o-2024-08-06")).toBeTruthy();
  });

  it("returns undefined for unknown models", () => {
    expect(priceFor("not-a-real-model")).toBeUndefined();
  });

  it("computes cost from token counts", () => {
    expect(computeCostUSD("gpt-5-nano", 1_000_000, 1_000_000)).toBeCloseTo(0.45, 4);
  });

  it("zero cost for unknown model (no surprise charges)", () => {
    expect(computeCostUSD("mystery", 1_000_000, 1_000_000)).toBe(0);
  });

  it("discounts cached prompt tokens at 50%", () => {
    // gpt-5-nano: $0.05/Mtok input → 1M cached = $0.025; 0M output cost
    expect(computeCostUSD("gpt-5-nano", 1_000_000, 0, 1_000_000)).toBeCloseTo(0.025, 4);
  });
});

describe("cost log", () => {
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

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-cost-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("appendCostLog writes JSONL and readCostLog parses it", () => {
    appendCostLog(cfg(), {
      model: "gpt-5-nano",
      prompt_tokens: 100,
      cached_tokens: 50,
      completion_tokens: 20,
      costUSD: 0.001,
    });
    const entries = readCostLog(cfg());
    expect(entries).toHaveLength(1);
    expect(entries[0].model).toBe("gpt-5-nano");
    expect(entries[0].cached_tokens).toBe(50);
  });

  it("aggregates by day and by model", () => {
    const c = cfg();
    appendCostLog(c, { model: "gpt-5-nano", prompt_tokens: 100, cached_tokens: 0, completion_tokens: 10, costUSD: 0.001 });
    appendCostLog(c, { model: "gpt-5", prompt_tokens: 200, cached_tokens: 100, completion_tokens: 50, costUSD: 0.005 });
    const entries = readCostLog(c);
    const byDay = costByDay(entries);
    expect(byDay.length).toBeGreaterThanOrEqual(1);
    expect(byDay[0].costUSD).toBeCloseTo(0.006, 4);
    const byModel = costByModel(entries);
    expect(byModel.map((m) => m.model)).toContain("gpt-5");
    expect(byModel.map((m) => m.model)).toContain("gpt-5-nano");
  });
});
