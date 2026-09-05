import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Agent } from "./agent.js";
import type { ClawConfig } from "./config.js";
import { getSubagentTools, getAllTools } from "./tools/index.js";
import { createSubagentTodoTool } from "./tools/todo.js";
import type { SubagentRequest, ToolContext } from "./tools/types.js";
import { findSubagent } from "./subagents/index.js";

/**
 * Spawn a subagent. Subagents have their own conversation but share the parent's
 * config + permission manager. Their result is a single text string returned to
 * the parent's Task tool call.
 */
export async function runSubagent(
  config: ClawConfig,
  permissionCheck: ToolContext["permissionCheck"],
  req: SubagentRequest,
  onStatus?: (event: string) => void,
  abortSignal?: AbortSignal
): Promise<string> {
  if (abortSignal?.aborted) return "Subagent not started: aborted.";
  const kind = req.subagent_type ?? "general-purpose";
  const def = findSubagent(config, kind);

  // Pick the tool set. Order of resolution:
  //   1. Registry def with explicit `tools:` frontmatter wins.
  //   2. Builtin "explore" gets the read-only set via getSubagentTools.
  //   3. Default to general-purpose tools (everything except Task).
  let tools;
  if (def?.tools) {
    // Same substitution getSubagentTools makes: a registered subagent that asks
    // for TodoWrite gets its own list, not the parent's.
    const all = getAllTools()
      .filter((t) => t.name !== "TodoWrite")
      .concat(createSubagentTodoTool());
    tools = all.filter((t) => def.tools!.includes(t.name));
  } else if (kind === "explore") {
    tools = getSubagentTools("explore");
  } else {
    tools = getSubagentTools("general-purpose");
  }

  // System prompt: a registered subagent's frontmatter body is appended to the
  // standard subagent prompt. For the builtin types use the existing variants.
  let variant: "main" | "subagent-general" | "subagent-explore" = "subagent-general";
  if (kind === "explore") variant = "subagent-explore";
  const baseExtras: string[] = [];
  if (def && def.body) {
    baseExtras.push(`# Subagent role\n${def.body}`);
  }

  // Worktree isolation: spin up a temp git worktree and run the subagent there.
  let runConfig = config;
  let worktreePath: string | null = null;
  let branchName: string | null = null;
  let baseCommit: string | null = null;
  if (req.isolation === "worktree") {
    const setup = createWorktree(config, req.description);
    if (!setup.ok) return `Worktree setup failed: ${setup.error}`;
    runConfig = { ...config, workdir: setup.path };
    worktreePath = setup.path;
    branchName = setup.branch;
    baseCommit = setup.base;
    onStatus?.(`[worktree] ${worktreePath}`);
  }

  const agent = new Agent({
    config: runConfig,
    tools,
    permissionCheck,
    spawnSubagent: undefined,
    systemPromptExtras: baseExtras,
    systemPromptVariant: variant,
    // Standing, not one-shot: a "reasoning" subagent that reverted to the
    // default model after its first API call was silently downgraded for the
    // rest of its run.
    modelRole: def?.modelRole,
  });
  agent.pushUser(req.prompt);

  let result = "";
  onStatus?.(`[subagent:${kind}] ${req.description}`);
  // Without the signal a subagent runs to its own turn limit no matter what
  // the caller does: Ctrl-C, or an eval's per-case timeout, could not stop a
  // Task once it had been dispatched.
  await agent.run((evt) => {
    if (evt.type === "text") result = evt.data as string;
    if (evt.type === "error") {
      result = `Subagent error: ${evt.data}`;
    }
  }, abortSignal);

  if (worktreePath) {
    const rawDiff = collectWorktreeDiff(worktreePath, baseCommit);
    const commits = countCommitsSince(worktreePath, baseCommit);
    if (rawDiff.trim() === "" && commits === 0) {
      // Nothing to keep. The commit count is checked as well as the diff: a
      // subagent that commits its work leaves a clean tree, and auto-cleaning
      // on an empty diff alone force-deleted the branch those commits lived on.
      removeWorktree(config.workdir, worktreePath, branchName);
      result = `${result}\n\n[worktree had no diff — auto-cleaned]`;
    } else {
      const { diff: filtered, redacted } = redactSensitiveHunks(rawDiff);
      const { text: shown, dropped } = truncateDiff(filtered, 50_000);
      const commitNote = commits > 0 ? `\n[${commits} commit(s) on the branch]` : "";
      const banner = `[worktree retained: ${worktreePath}]\n[branch: ${branchName}]${commitNote}`;
      const redactNote = redacted.length
        ? `\n[diff: redacted ${redacted.length} hunk(s) touching sensitive paths: ${redacted.join(", ")}]`
        : "";
      const truncNote = dropped > 0
        ? `\n[diff truncated: ${dropped} chars omitted — pull the worktree to see the rest]`
        : "";
      result = `${result}\n\n${banner}${redactNote}\n\n--- BEGIN DIFF ---\n${shown}${truncNote}\n--- END DIFF ---`;
    }
  }
  return result || "(subagent returned no output)";
}

// File patterns that should never round-trip through the parent agent's
// conversation (and from there, potentially into model providers/logs).
const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..+)?$/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\..+)?$/,
  /(^|\/)credentials\.json$/,
  /(^|\/)secrets\.json$/,
  /\.sqlite$/,
];

function isSensitivePath(p: string): boolean {
  return SENSITIVE_PATTERNS.some((rx) => rx.test(p));
}

export function redactSensitiveHunks(diff: string): { diff: string; redacted: string[] } {
  if (!diff) return { diff, redacted: [] };
  // Split on the start of each "diff --git" block, keeping the prefix (if any).
  const parts = diff.split(/(?=^diff --git )/m);
  const kept: string[] = [];
  const redacted: string[] = [];
  for (const block of parts) {
    if (!block.startsWith("diff --git ")) {
      kept.push(block);
      continue;
    }
    // "diff --git a/<path> b/<path>" — pull both sides.
    const m = block.match(/^diff --git a\/(\S+) b\/(\S+)/);
    const paths = m ? [m[1], m[2]] : [];
    if (paths.some(isSensitivePath)) {
      redacted.push(paths[1] ?? paths[0] ?? "<unknown>");
      continue;
    }
    kept.push(block);
  }
  return { diff: kept.join(""), redacted };
}

function truncateDiff(diff: string, cap: number): { text: string; dropped: number } {
  if (diff.length <= cap) return { text: diff, dropped: 0 };
  return { text: diff.slice(0, cap), dropped: diff.length - cap };
}

function createWorktree(
  config: ClawConfig,
  description: string
): { ok: true; path: string; branch: string; base: string } | { ok: false; error: string } {
  const slug = description.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30).replace(/^-|-$/g, "");
  const stamp = Date.now().toString(36);
  const branch = `claw/${slug || "task"}-${stamp}`;
  const wtDir = path.join(config.projectDir, "worktrees", `${slug || "task"}-${stamp}`);
  fs.mkdirSync(path.dirname(wtDir), { recursive: true });
  const res = spawnSync("git", ["worktree", "add", "-b", branch, wtDir], {
    cwd: config.workdir,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || "git worktree add failed").trim() };
  }
  // The commit the branch forked from. Everything the subagent does is measured
  // against it, so committed work is as visible as uncommitted work.
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: wtDir, encoding: "utf8" });
  return { ok: true, path: wtDir, branch, base: (head.stdout ?? "").trim() };
}

/** Commits the subagent added on top of the base. */
export function countCommitsSince(worktreePath: string, base: string | null): number {
  if (!base) return 0;
  const res = spawnSync("git", ["rev-list", "--count", `${base}..HEAD`], {
    cwd: worktreePath,
    encoding: "utf8",
  });
  if (res.status !== 0) return 0;
  return parseInt((res.stdout ?? "0").trim(), 10) || 0;
}

/**
 * Everything the subagent changed, committed or not, as one diff against the
 * commit the worktree forked from.
 *
 * The previous version diffed the working tree and, when it was clean, fell
 * back to `@{u}..HEAD` — but a freshly created `claw/…` branch has no upstream,
 * so that always failed and a subagent that COMMITTED its work reported an
 * empty diff and had its branch deleted.
 */
export function collectWorktreeDiff(worktreePath: string, base: string | null): string {
  // Intent-to-add so untracked files appear in the diff.
  spawnSync("git", ["add", "-N", "."], { cwd: worktreePath });
  if (base) {
    const diff = spawnSync("git", ["diff", base], { cwd: worktreePath, encoding: "utf8" });
    if (diff.status === 0) return diff.stdout ?? "";
  }
  const fallback = spawnSync("git", ["diff"], { cwd: worktreePath, encoding: "utf8" });
  return fallback.stdout ?? "";
}

function removeWorktree(mainWorkdir: string, worktreePath: string, branch: string | null): void {
  spawnSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: mainWorkdir });
  if (branch) {
    spawnSync("git", ["branch", "-D", branch], { cwd: mainWorkdir });
  }
}
