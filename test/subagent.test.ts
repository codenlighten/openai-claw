import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { redactSensitiveHunks, collectWorktreeDiff, countCommitsSince } from "../src/subagent.js";

describe("subagent worktree diff redaction", () => {
  const benign = `diff --git a/src/foo.ts b/src/foo.ts
index 111..222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new
`;
  const secret = `diff --git a/.env b/.env
new file mode 100644
--- /dev/null
+++ b/.env
@@ -0,0 +1 @@
+OPENAI_API_KEY=sk-leak
`;

  it("drops .env hunks and reports them", () => {
    const { diff, redacted } = redactSensitiveHunks(benign + secret);
    expect(diff).toContain("src/foo.ts");
    expect(diff).not.toContain("OPENAI_API_KEY");
    expect(diff).not.toContain(".env");
    expect(redacted).toEqual([".env"]);
  });

  it("drops nested .env.production and id_rsa hunks", () => {
    const nested = `diff --git a/config/.env.production b/config/.env.production
+++ b/config/.env.production
@@
+SECRET=1
diff --git a/keys/id_rsa b/keys/id_rsa
+++ b/keys/id_rsa
@@
+ssh-key
`;
    const { diff, redacted } = redactSensitiveHunks(benign + nested);
    expect(redacted.sort()).toEqual(["config/.env.production", "keys/id_rsa"]);
    expect(diff).toContain("src/foo.ts");
    expect(diff).not.toContain("SECRET=1");
    expect(diff).not.toContain("ssh-key");
  });

  it("returns the input unchanged when nothing is sensitive", () => {
    const { diff, redacted } = redactSensitiveHunks(benign);
    expect(diff).toBe(benign);
    expect(redacted).toEqual([]);
  });

  it("handles empty input", () => {
    expect(redactSensitiveHunks("")).toEqual({ diff: "", redacted: [] });
  });
});

describe("subagent worktree diff collection", () => {
  let repo: string;
  let worktree: string;
  let base: string;

  const git = (args: string[], cwd: string) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "claw-wt-"));
    git(["init", "-q", "."], repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(["add", "."], repo);
    git(["commit", "-qm", "init"], repo);
    worktree = path.join(repo, "wt");
    git(["worktree", "add", "-q", "-b", "claw/test", worktree], repo);
    base = git(["rev-parse", "HEAD"], worktree).stdout.trim();
  });

  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("sees work the subagent committed", () => {
    // A committed worktree has a CLEAN tree. Diffing only the working tree
    // reported nothing here, and the caller then deleted the branch.
    fs.writeFileSync(path.join(worktree, "b.txt"), "b\n");
    git(["add", "."], worktree);
    git(["commit", "-qm", "subagent work"], worktree);
    expect(git(["status", "--porcelain"], worktree).stdout.trim()).toBe("");

    const diff = collectWorktreeDiff(worktree, base);
    expect(diff).toContain("b.txt");
    expect(countCommitsSince(worktree, base)).toBe(1);
  });

  it("sees uncommitted work, including untracked files", () => {
    fs.writeFileSync(path.join(worktree, "c.txt"), "c\n");
    const diff = collectWorktreeDiff(worktree, base);
    expect(diff).toContain("c.txt");
    expect(countCommitsSince(worktree, base)).toBe(0);
  });

  it("sees committed and uncommitted work together", () => {
    fs.writeFileSync(path.join(worktree, "b.txt"), "b\n");
    git(["add", "."], worktree);
    git(["commit", "-qm", "committed"], worktree);
    fs.writeFileSync(path.join(worktree, "c.txt"), "c\n");
    const diff = collectWorktreeDiff(worktree, base);
    expect(diff).toContain("b.txt");
    expect(diff).toContain("c.txt");
  });

  it("reports nothing for an untouched worktree", () => {
    expect(collectWorktreeDiff(worktree, base).trim()).toBe("");
    expect(countCommitsSince(worktree, base)).toBe(0);
  });
});
