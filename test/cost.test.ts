import { describe, it, expect } from "vitest";
import { computeCostUSD, priceFor } from "../src/cost.js";

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
    // gpt-5-nano: $0.05/Mtok input, $0.40/Mtok output
    // 1M input + 1M output = $0.05 + $0.40 = $0.45
    expect(computeCostUSD("gpt-5-nano", 1_000_000, 1_000_000)).toBeCloseTo(0.45, 4);
  });

  it("zero cost for unknown model (no surprise charges)", () => {
    expect(computeCostUSD("mystery", 1_000_000, 1_000_000)).toBe(0);
  });
});
