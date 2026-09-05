import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  slugify,
  buildPrBody,
  createAutoPrWorktree,
  removeAutoPrWorktree,
} from "../src/autopr/index.js";
import type { ClawConfig } from "../src/config.js";

let repo: string;
let projectDir: string;

const git = (args: string[], cwd: string) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

const cfg = (): ClawConfig => ({
  workdir: repo,
  homeDir: projectDir,
  projectDir,
  memoryDir: projectDir,
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
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "claw-autopr-"));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-autopr-proj-"));
  git(["init", "-q", "."], repo);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "committed content\n");
  git(["add", "."], repo);
  git(["commit", "-qm", "init"], repo);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("slugify", () => {
  it("produces a branch-safe slug", () => {
    expect(slugify("Fix the Login Bug!")).toBe("fix-the-login-bug");
  });
  it("falls back for input with nothing usable", () => {
    expect(slugify("!!!")).toBe("task");
  });
  it("bounds the length", () => {
    expect(slugify("a".repeat(200)).length).toBeLessThanOrEqual(50);
  });
});

describe("auto-PR worktree isolation", () => {
  it("runs somewhere other than the user's checkout", () => {
    const r = createAutoPrWorktree(cfg(), "add a feature");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.worktree.path.startsWith(projectDir)).toBe(true);
    expect(r.worktree.path.startsWith(repo)).toBe(false);
    expect(r.worktree.branch).toMatch(/^claw\/add-a-feature-/);
    expect(fs.existsSync(path.join(r.worktree.path, "tracked.txt"))).toBe(true);
  });

  it("leaves uncommitted work in the user's tree untouched", () => {
    // The old in-place `checkout -b` + `add -A` swept whatever was sitting in
    // the tree into the agent's commit and pushed it to a PR.
    fs.writeFileSync(path.join(repo, "wip-secret.txt"), "unfinished private work\n");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "locally modified\n");
    const r = createAutoPrWorktree(cfg(), "add a feature");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The worktree sees the committed state, not the user's working copy.
    expect(fs.existsSync(path.join(r.worktree.path, "wip-secret.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(r.worktree.path, "tracked.txt"), "utf8")).toBe("committed content\n");

    // And the user's tree still has its changes, on its original branch.
    expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("locally modified\n");
    expect(fs.existsSync(path.join(repo, "wip-secret.txt"))).toBe(true);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repo).stdout.trim()).not.toMatch(/^claw\//);
  });

  it("`git add -A` in the worktree only picks up the agent's work", () => {
    fs.writeFileSync(path.join(repo, "unrelated.txt"), "not mine\n");
    const r = createAutoPrWorktree(cfg(), "task");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    fs.writeFileSync(path.join(r.worktree.path, "agent-made.txt"), "from the agent\n");
    spawnSync("git", ["add", "-A"], { cwd: r.worktree.path });
    const staged = git(["diff", "--cached", "--name-only"], r.worktree.path).stdout.trim().split("\n");
    expect(staged).toEqual(["agent-made.txt"]);
  });

  it("cleanup removes the worktree and can drop an unpushed branch", () => {
    const r = createAutoPrWorktree(cfg(), "throwaway");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    removeAutoPrWorktree(cfg(), r.worktree, true);
    expect(fs.existsSync(r.worktree.path)).toBe(false);
    const branches = git(["branch", "--list", r.worktree.branch], repo).stdout.trim();
    expect(branches).toBe("");
  });

  it("cleanup keeps a branch that was pushed", () => {
    const r = createAutoPrWorktree(cfg(), "keep me");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    removeAutoPrWorktree(cfg(), r.worktree, false);
    expect(fs.existsSync(r.worktree.path)).toBe(false);
    expect(git(["branch", "--list", r.worktree.branch], repo).stdout).toContain("claw/keep-me");
  });
});

describe("PR body", () => {
  it("always tells the reviewer an agent wrote it", () => {
    expect(buildPrBody("do a thing", "I did the thing")).toContain("opened by `claw pr`");
  });

  it("cites the attestation sidecar when the run was signed", () => {
    const body = buildPrBody("do a thing", "summary", "/x/y/2026-01-01.attest.json");
    expect(body).toContain("2026-01-01.attest.json");
    expect(body).toContain("claw audit verify");
  });

  it("says nothing about attestation when the run was not signed", () => {
    expect(buildPrBody("do a thing", "summary", null)).not.toContain("Attested run");
  });
});
