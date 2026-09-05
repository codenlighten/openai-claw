import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// Mock OpenAI so we never reach the network — deterministic toy embeddings
// keyed off the chunk text length + a per-call counter.
const { mockState } = vi.hoisted(() => ({
  mockState: { shortenBy: 0, embedCalls: 0 },
}));
vi.mock("openai", () => ({
  default: class {
    embeddings = {
      create: async ({ input }: { input: string[] }) => {
        mockState.embedCalls += (input as string[]).length;
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

import { buildIndex, semanticSearch, loadIndex, chunkText, _resetIndexCache } from "../src/rag/index.js";
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
  _resetIndexCache();
  mockState.embedCalls = 0;
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

describe("incremental indexing", () => {
  const write = (rel: string, body: string) => {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };

  it("re-embeds nothing when no file changed", async () => {
    write("a.ts", "export const auth = 1;");
    write("b.ts", "export const math = 2;");
    const first = await buildIndex(cfg());
    expect(first.reusedChunks).toBe(0);
    const embeddedFirst = mockState.embedCalls;
    expect(embeddedFirst).toBeGreaterThan(0);

    mockState.embedCalls = 0;
    const second = await buildIndex(cfg());
    expect(second.chunks).toBe(first.chunks);
    expect(second.reusedChunks).toBe(first.chunks);
    expect(mockState.embedCalls).toBe(0);
  });

  it("re-embeds only the file that changed", async () => {
    write("a.ts", "export const auth = 1;");
    write("b.ts", "export const math = 2;");
    await buildIndex(cfg());

    mockState.embedCalls = 0;
    write("b.ts", "export const math = 3; // changed");
    const r = await buildIndex(cfg());
    expect(mockState.embedCalls).toBe(1);
    expect(r.reusedChunks).toBe(r.chunks - 1);
  });

  it("drops chunks for a deleted file", async () => {
    write("a.ts", "export const auth = 1;");
    write("gone.ts", "export const login = 2;");
    await buildIndex(cfg());
    fs.rmSync(path.join(tmp, "gone.ts"));
    const r = await buildIndex(cfg());
    expect(r.index.chunks.some((c) => c.file === "gone.ts")).toBe(false);
  });

  it("does not index git-ignored files", async () => {
    write("keep.ts", "export const auth = 1;");
    write("secrets.json", '{"token":"sk-live-abc"}');
    fs.writeFileSync(path.join(tmp, ".gitignore"), "secrets.json\n");
    spawnSync("git", ["init", "-q", "."], { cwd: tmp });
    const r = await buildIndex(cfg());
    const indexed = r.index.chunks.map((c) => c.file);
    expect(indexed).toContain("keep.ts");
    expect(indexed).not.toContain("secrets.json");
  });

  it("never indexes dotfiles", async () => {
    write("keep.ts", "export const auth = 1;");
    fs.writeFileSync(path.join(tmp, ".env"), "OPENAI_API_KEY=sk-live-abc");
    const r = await buildIndex(cfg());
    expect(r.index.chunks.some((c) => c.file.includes(".env"))).toBe(false);
  });
});

describe("index caching", () => {
  it("parses the index once across repeated searches", async () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), "export const auth = 1;");
    await buildIndex(cfg());
    const spy = vi.spyOn(fs, "readFileSync");
    await semanticSearch(cfg(), "auth", 1);
    await semanticSearch(cfg(), "auth", 1);
    await semanticSearch(cfg(), "auth", 1);
    const indexReads = spy.mock.calls.filter((c) => String(c[0]).endsWith("index.json"));
    expect(indexReads).toHaveLength(0);
    spy.mockRestore();
  });

  it("picks up an index rebuilt underneath it", async () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), "export const auth = 1;");
    await buildIndex(cfg());
    expect(loadIndex(cfg())!.chunks).toHaveLength(1);
    fs.writeFileSync(path.join(tmp, "b.ts"), "export const login = 2;");
    await buildIndex(cfg());
    expect(loadIndex(cfg())!.chunks).toHaveLength(2);
  });

  it("treats an index from an older version as absent", async () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), "export const auth = 1;");
    await buildIndex(cfg());
    _resetIndexCache();
    const file = path.join(tmp, "index.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.version = 1;
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(loadIndex(cfg())).toBeNull();
  });
});

describe("chunking", () => {
  it("keeps a function whole rather than cutting through it", () => {
    const fn = (n: number) =>
      `export function fn${n}(a, b) {\n  const x = a + b;\n  return x * ${n};\n}\n`;
    const src = Array.from({ length: 150 }, (_, i) => fn(i)).join("\n");
    const chunks = chunkText(src, "src/math.ts");
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const opens = (c.match(/\{/g) ?? []).length;
      const closes = (c.match(/\}/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it("prefixes every chunk with the file path", () => {
    const chunks = chunkText("export const a = 1;\n", "src/deep/thing.ts");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startsWith("// src/deep/thing.ts\n")).toBe(true);
  });

  it("splits markdown on headings", () => {
    const md = Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\n${"body ".repeat(60)}\n`).join("\n");
    const chunks = chunkText(md, "doc.md");
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk should begin mid-paragraph — each starts at a heading.
    for (const c of chunks) {
      const firstLine = c.split("\n")[1] ?? "";
      expect(firstLine.startsWith("## Section")).toBe(true);
    }
  });

  it("falls back to windowing for a single oversized unit", () => {
    const huge = `export function big() {\n${"  const line = 1;\n".repeat(1200)}}\n`;
    const chunks = chunkText(huge, "big.ts");
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000 + 20);
  });

  it("never returns an empty chunk", () => {
    for (const src of ["", "\n\n\n", "x"]) {
      for (const c of chunkText(src, "f.ts")) expect(c.trim().length).toBeGreaterThan(0);
    }
  });

  it("path context makes a file findable by its location", async () => {
    fs.mkdirSync(path.join(tmp, "auth"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "auth", "login.ts"), "export const check = (u) => !!u;\n");
    fs.writeFileSync(path.join(tmp, "unrelated.ts"), "export const add = (a, b) => a + b;\n");
    await buildIndex(cfg());
    const hits = await semanticSearch(cfg(), "auth login", 1);
    expect(hits[0].file).toBe(path.join("auth", "login.ts"));
  });
});
