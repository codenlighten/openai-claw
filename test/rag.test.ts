import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock OpenAI so we never reach the network — deterministic toy embeddings
// keyed off the chunk text length + a per-call counter.
const { mockState } = vi.hoisted(() => ({
  mockState: { shortenBy: 0 },
}));
vi.mock("openai", () => ({
  default: class {
    embeddings = {
      create: async ({ input }: { input: string[] }) => {
        const inputs = mockState.shortenBy > 0
          ? (input as string[]).slice(0, Math.max(0, input.length - mockState.shortenBy))
          : (input as string[]);
        const data = inputs.map((text) => {
          // Content-only toy embedding: one dimension per probe keyword. Cosine
          // ranking then mirrors lexical overlap, which is enough to assert the
          // pipeline routes the query to the most-relevant chunk.
          const t = text.toLowerCase();
          const e = [
            t.includes("auth") ? 1 : 0,
            t.includes("login") ? 1 : 0,
            t.includes("token") ? 1 : 0,
            t.includes("add") ? 1 : 0,
            t.includes("math") ? 1 : 0,
            t.includes("readme") ? 1 : 0,
            t.includes("library") ? 1 : 0,
            0.01, // tiny constant so zero-vectors don't divide by zero
          ];
          return { embedding: e };
        });
        return { data };
      },
    };
  },
}));

import { buildIndex, semanticSearch, loadIndex } from "../src/rag/index.js";
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
  maxTurns: 50,
  maxToolResultChars: 50_000,
  models: {},
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-rag-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("RAG index", () => {
  it("indexes allowed files and skips ignored dirs", async () => {
    fs.writeFileSync(path.join(tmp, "auth.ts"), "function authenticate(user) { /* login flow */ }");
    fs.writeFileSync(path.join(tmp, "math.ts"), "function add(a, b) { return a + b; }");
    fs.mkdirSync(path.join(tmp, "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "node_modules", "x", "ignored.ts"), "ignored content");

    const r = await buildIndex(cfg());
    expect(r.filesIndexed).toBe(2);
    expect(r.chunks).toBe(2);
    const idx = loadIndex(cfg());
    expect(idx?.chunks.map((c) => c.file).sort()).toEqual(["auth.ts", "math.ts"]);
  });

  it("ranks semantically relevant chunks higher", async () => {
    fs.writeFileSync(path.join(tmp, "auth.ts"), "function authenticate(user) { check login token }");
    fs.writeFileSync(path.join(tmp, "math.ts"), "function add(a, b) { return a + b; }");
    fs.writeFileSync(path.join(tmp, "readme.md"), "# Project\nA general utility library.");
    await buildIndex(cfg());
    const hits = await semanticSearch(cfg(), "auth check", 3);
    expect(hits[0].file).toBe("auth.ts");
  });

  it("semanticSearch errors when no index exists", async () => {
    await expect(semanticSearch(cfg(), "x", 5)).rejects.toThrow(/No semantic index/);
  });

  it("throws on embedding count mismatch instead of corrupting the index", async () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), "alpha");
    fs.writeFileSync(path.join(tmp, "b.ts"), "beta");
    mockState.shortenBy = 1;
    try {
      await expect(buildIndex(cfg())).rejects.toThrow(/embedding count mismatch/);
    } finally {
      mockState.shortenBy = 0;
    }
  });
});
