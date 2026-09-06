import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadEnvFiles } from "../src/env.js";

let tmp: string;
let originalCwd: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-env-"));
  originalCwd = process.cwd();
  for (const k of ["CLAW_ENV_PROBE", "CLAW_ENV_EXPORTED"]) saved[k] = process.env[k];
  delete process.env.CLAW_ENV_PROBE;
  delete process.env.CLAW_ENV_EXPORTED;
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("loadEnvFiles", () => {
  it("loads a .env from the working directory", () => {
    fs.writeFileSync(path.join(tmp, ".env"), "CLAW_ENV_PROBE=from-cwd\n");
    process.chdir(tmp);
    const loaded = loadEnvFiles();
    expect(loaded.some((f) => f.startsWith(tmp) || f.includes(fs.realpathSync(tmp)))).toBe(true);
    expect(process.env.CLAW_ENV_PROBE).toBe("from-cwd");
  });

  it("does not override a variable already in the environment", () => {
    process.env.CLAW_ENV_EXPORTED = "from-shell";
    fs.writeFileSync(path.join(tmp, ".env"), "CLAW_ENV_EXPORTED=from-file\n");
    process.chdir(tmp);
    loadEnvFiles();
    expect(process.env.CLAW_ENV_EXPORTED).toBe("from-shell");
  });

  it("is a no-op when there is nothing to load", () => {
    process.chdir(tmp);
    expect(() => loadEnvFiles()).not.toThrow();
  });
});

describe("non-interactive invocation", () => {
  const cli = path.join(process.cwd(), "dist", "index.js");

  it("explains itself instead of throwing a React stack trace", async () => {
    // ink puts stdin in raw mode; without a TTY it threw from inside a React
    // effect, so `claw` in a pipeline printed a component stack and nothing
    // about what to do instead.
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [cli], { input: "", encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not a TTY");
    expect(r.stderr).toContain("claw -p");
    expect(r.stderr).not.toMatch(/Raw mode is not supported|react-reconciler/);
  });
});
