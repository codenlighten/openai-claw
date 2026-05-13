import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readTool } from "../src/tools/read.js";
import { writeTool } from "../src/tools/write.js";
import { editTool } from "../src/tools/edit.js";
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
  },
  permissionCheck: async () => ({ allow: true }),
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-tools-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Read", () => {
  it("returns line-numbered content", async () => {
    const p = path.join(tmp, "a.txt");
    fs.writeFileSync(p, "alpha\nbeta\ngamma\n");
    const r = await readTool.run({ file_path: p }, ctx());
    expect(r.content).toContain("\talpha");
    expect(r.content).toContain("\tbeta");
  });

  it("refuses to read image files", async () => {
    const p = path.join(tmp, "x.png");
    fs.writeFileSync(p, Buffer.from([0x89, 0x50]));
    const r = await readTool.run({ file_path: p }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/image file/i);
  });

  it("errors on nonexistent file", async () => {
    const r = await readTool.run({ file_path: path.join(tmp, "nope.txt") }, ctx());
    expect(r.isError).toBe(true);
  });
});

describe("Write", () => {
  it("creates a new file with a diff display", async () => {
    const p = path.join(tmp, "new.txt");
    const r = await writeTool.run({ file_path: p, content: "hello\n" }, ctx());
    expect(fs.readFileSync(p, "utf8")).toBe("hello\n");
    expect(r.display).toBeDefined();
    expect(r.display).toMatch(/\+hello/);
  });
});

describe("Edit", () => {
  it("performs an exact single-occurrence replacement", async () => {
    const p = path.join(tmp, "e.txt");
    fs.writeFileSync(p, "before\nmiddle\nafter\n");
    const r = await editTool.run(
      { file_path: p, old_string: "middle", new_string: "MIDDLE" },
      ctx()
    );
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, "utf8")).toContain("MIDDLE");
  });

  it("fails when old_string is not unique", async () => {
    const p = path.join(tmp, "dup.txt");
    fs.writeFileSync(p, "a\na\n");
    const r = await editTool.run(
      { file_path: p, old_string: "a", new_string: "b" },
      ctx()
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not unique/);
  });

  it("replace_all bypasses uniqueness", async () => {
    const p = path.join(tmp, "all.txt");
    fs.writeFileSync(p, "a\na\n");
    const r = await editTool.run(
      { file_path: p, old_string: "a", new_string: "b", replace_all: true },
      ctx()
    );
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, "utf8")).toBe("b\nb\n");
  });

  it("rejects when new_string == old_string", async () => {
    const p = path.join(tmp, "same.txt");
    fs.writeFileSync(p, "x");
    const r = await editTool.run(
      { file_path: p, old_string: "x", new_string: "x" },
      ctx()
    );
    expect(r.isError).toBe(true);
  });
});
