import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadEvalCases } from "../src/eval/index.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-eval-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("loadEvalCases", () => {
  it("loads all .json fixtures", () => {
    fs.writeFileSync(
      path.join(tmp, "alpha.json"),
      JSON.stringify({ id: "alpha", prompt: "do alpha" })
    );
    fs.writeFileSync(
      path.join(tmp, "beta.json"),
      JSON.stringify({ id: "beta", prompt: "do beta" })
    );
    fs.writeFileSync(path.join(tmp, "ignored.txt"), "not a fixture");
    const cases = loadEvalCases(tmp);
    expect(cases).toHaveLength(2);
    expect(cases.map((c) => c.id).sort()).toEqual(["alpha", "beta"]);
  });

  it("falls back id to filename when absent", () => {
    fs.writeFileSync(path.join(tmp, "named.json"), JSON.stringify({ prompt: "x" }));
    const cases = loadEvalCases(tmp);
    expect(cases[0].id).toBe("named");
  });

  it("returns empty list when dir missing", () => {
    expect(loadEvalCases(path.join(tmp, "nope"))).toEqual([]);
  });
});
