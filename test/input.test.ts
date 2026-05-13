import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { prepareUserMessage } from "../src/input.js";
import type { ClawConfig } from "../src/config.js";

const tmp = path.join(os.tmpdir(), `claw-input-${Date.now()}`);

beforeAll(() => {
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, "hello.txt"), "hello world\n");
  fs.writeFileSync(path.join(tmp, "tiny.png"), Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  ]));
  fs.mkdirSync(path.join(tmp, "subdir"));
  fs.writeFileSync(path.join(tmp, "subdir", "a.txt"), "a");
});

function cfg(): ClawConfig {
  return {
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
  };
}

describe("prepareUserMessage", () => {
  it("returns plain string when no @refs", () => {
    const r = prepareUserMessage("hello", cfg());
    expect(r.content).toBe("hello");
    expect(r.attachments).toEqual([]);
  });

  it("inlines text files", () => {
    const r = prepareUserMessage("read this @hello.txt", cfg());
    expect(typeof r.content).toBe("string");
    expect(r.content as string).toContain("<file");
    expect(r.content as string).toContain("hello world");
    expect(r.attachments[0]).toMatch(/hello\.txt/);
  });

  it("attaches images as content parts", () => {
    const r = prepareUserMessage("look @tiny.png", cfg());
    expect(Array.isArray(r.content)).toBe(true);
    const parts = r.content as any[];
    expect(parts.length).toBe(2);
    expect(parts[0].type).toBe("text");
    expect(parts[1].type).toBe("image_url");
    expect(parts[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(r.attachments[0]).toMatch(/tiny\.png/);
  });

  it("handles missing files gracefully", () => {
    const r = prepareUserMessage("see @nonexistent.txt", cfg());
    expect(r.content as string).toContain("error=\"not found\"");
  });

  it("lists directories", () => {
    const r = prepareUserMessage("explore @subdir", cfg());
    expect(r.content as string).toContain("<directory");
    expect(r.content as string).toContain("a.txt");
  });

  it("deduplicates repeated refs", () => {
    const r = prepareUserMessage("compare @hello.txt and @hello.txt again", cfg());
    const matches = (r.content as string).match(/<file/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
