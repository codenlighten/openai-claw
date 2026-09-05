import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { grepTool } from "../src/tools/grep.js";
import { globTool } from "../src/tools/glob.js";
import { lsTool } from "../src/tools/ls.js";
import type { ToolContext } from "../src/tools/types.js";

let tmp: string;
const ctx = (): ToolContext => ({
  config: {
    workdir: tmp,
    homeDir: tmp,
    projectDir: tmp,
    memoryDir: tmp,
    model: "x",
    apiKey: "x",
    allowedTools: [],
    deniedTools: [],
    contextWindow: 0,
    compactThreshold: 1,
    permissionMode: "ask",
    maxTurns: 50,
    maxToolResultChars: 50_000,
    models: {},
  },
  permissionCheck: async () => ({ allow: true }),
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-search-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("Grep", () => {
  it("finds a plain string", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "needle here\n");
    fs.writeFileSync(path.join(tmp, "b.txt"), "nothing\n");
    const r = await grepTool.run({ pattern: "needle" }, ctx());
    expect(r.content).toContain("a.txt");
    expect(r.content).not.toContain("b.txt");
  });

  it("treats a flag-shaped pattern as a pattern", async () => {
    // Passed positionally, ripgrep consumed "--files" as its own flag and
    // listed every file, so a search for flag-like text matched everything.
    fs.writeFileSync(path.join(tmp, "has.txt"), "config has --files inside\n");
    fs.writeFileSync(path.join(tmp, "hasnt.txt"), "unrelated content\n");
    const r = await grepTool.run({ pattern: "--files" }, ctx());
    expect(r.content).toContain("has.txt");
    expect(r.content).not.toContain("hasnt.txt");
  });

  it("handles a pattern that starts with a single dash", async () => {
    fs.writeFileSync(path.join(tmp, "dash.txt"), "flag -n appears here\n");
    fs.writeFileSync(path.join(tmp, "other.txt"), "nope\n");
    const r = await grepTool.run({ pattern: "-n appears" }, ctx());
    expect(r.content).toContain("dash.txt");
    expect(r.content).not.toContain("other.txt");
  });

  it("reports no matches distinctly from an error", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "nothing relevant\n");
    const r = await grepTool.run({ pattern: "zzz-absent-zzz" }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("(no matches)");
  });

  it("caps a huge result set instead of buffering it all", async () => {
    // 4000 files x ~120 chars of matching content each.
    for (let i = 0; i < 4000; i++) {
      fs.writeFileSync(path.join(tmp, `f${i}.txt`), `${"match ".repeat(20)}\n`);
    }
    const r = await grepTool.run({ pattern: "match", output_mode: "content" }, ctx());
    expect(r.content.length).toBeLessThan(400_000);
    expect(r.content).toContain("truncated");
  });

  it("respects head_limit", async () => {
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(tmp, `f${i}.txt`), "match\n");
    const r = await grepTool.run({ pattern: "match", head_limit: 3 }, ctx());
    expect(r.content.split("\n")).toHaveLength(3);
  });
});

describe("Glob", () => {
  it("matches and sorts by mtime, newest first", async () => {
    fs.writeFileSync(path.join(tmp, "old.ts"), "1");
    fs.writeFileSync(path.join(tmp, "new.ts"), "2");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(tmp, "old.ts"), past, past);
    const r = await globTool.run({ pattern: "*.ts", path: tmp }, ctx());
    const lines = r.content.split("\n");
    expect(lines[0]).toContain("new.ts");
    expect(lines[1]).toContain("old.ts");
  });

  it("survives a broken symlink rather than throwing out of the tool", async () => {
    fs.writeFileSync(path.join(tmp, "real.ts"), "1");
    fs.symlinkSync(path.join(tmp, "gone.ts"), path.join(tmp, "dangling.ts"));
    const r = await globTool.run({ pattern: "*.ts", path: tmp }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("real.ts");
  });

  it("reports no matches", async () => {
    const r = await globTool.run({ pattern: "*.nothing", path: tmp }, ctx());
    expect(r.content).toBe("(no matches)");
  });
});

describe("LS", () => {
  it("marks directories and applies ignore globs", async () => {
    fs.mkdirSync(path.join(tmp, "sub"));
    fs.writeFileSync(path.join(tmp, "keep.txt"), "1");
    fs.writeFileSync(path.join(tmp, "skip.log"), "1");
    const r = await lsTool.run({ path: tmp, ignore: ["*.log"] }, ctx());
    expect(r.content).toContain("sub/");
    expect(r.content).toContain("keep.txt");
    expect(r.content).not.toContain("skip.log");
  });

  it("errors on a missing path", async () => {
    const r = await lsTool.run({ path: path.join(tmp, "nope") }, ctx());
    expect(r.isError).toBe(true);
  });
});
