import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Agent } from "./agent.js";
import type { ClawConfig } from "./config.js";
import { getSubagentTools, getAllTools } from "./tools/index.js";
import type { SubagentRequest, ToolContext } from "./tools/types.js";
import { buildSystemPrompt } from "./prompts/system.js";
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
  onStatus?: (event: string) => void
): Promise<string> {
  const kind = req.subagent_type ?? "general-purpose";
  const def = findSubagent(config, kind);

  // Pick the tool set. Order of resolution:
  //   1. Registry def with explicit `tools:` frontmatter wins.
  //   2. Builtin "explore" gets the read-only set via getSubagentTools.
  //   3. Default to general-purpose tools (everything except Task).
  let tools;
  if (def?.tools) {
    const all = getAllTools();
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
  const systemPrompt = buildSystemPrompt({ config, tools, variant, extras: baseExtras });

  // Worktree isolation: spin up a temp git worktree and run the subagent there.
  let runConfig = config;
  let worktreePath: string | null = null;
  let branchName: string | null = null;
  if (req.isolation === "worktree") {
    const setup = createWorktree(config, req.description);
    if (!setup.ok) return `Worktree setup failed: ${setup.error}`;
    runConfig = { ...config, workdir: setup.path };
    worktreePath = setup.path;
    branchName = setup.branch;
    onStatus?.(`[worktree] ${worktreePath}`);
  }

  const agent = new Agent({
    config: runConfig,
    tools,
    permissionCheck,
    spawnSubagent: undefined,
    systemPromptExtras: [],
  });
  agent.conversation[0] = { role: "system", content: systemPrompt };
  if (def?.modelRole) {
    agent.setNextRole(def.modelRole);
  }
  agent.pushUser(req.prompt);

  let result = "";
  onStatus?.(`[subagent:${kind}] ${req.description}`);
  await agent.run((evt) => {
    if (evt.type === "text") result = evt.data as string;
    if (evt.type === "error") {
      result = `Subagent error: ${evt.data}`;
    }
  });

  if (worktreePath) {
    const rawDiff = collectWorktreeDiff(worktreePath);
    if (rawDiff.trim() === "") {
      // No changes — clean up immediately.
      removeWorktree(config.workdir, worktreePath, branchName);
      result = `${result}\n\n[worktree had no diff — auto-cleaned]`;
    } else {
      const { diff: filtered, redacted } = redactSensitiveHunks(rawDiff);
      const { text: shown, dropped } = truncateDiff(filtered, 50_000);
      const banner = `[worktree retained: ${worktreePath}]\n[branch: ${branchName}]`;
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
): { ok: true; path: string; branch: string } | { ok: false; error: string } {
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
  return { ok: true, path: wtDir, branch };
}

function collectWorktreeDiff(worktreePath: string): string {
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: worktreePath,
    encoding: "utf8",
  });
  if (status.status !== 0 || !status.stdout.trim()) {
    // Maybe the agent committed; fall back to diff against HEAD~1.
    const log = spawnSync("git", ["log", "--oneline", "@{u}..HEAD"], { cwd: worktreePath, encoding: "utf8" });
    if (log.status === 0 && log.stdout.trim()) {
      const diff = spawnSync("git", ["diff", "@{u}", "HEAD"], { cwd: worktreePath, encoding: "utf8" });
      return diff.stdout ?? "";
    }
    return status.stdout?.trim() ? status.stdout : "";
  }
  // Stage and diff everything so untracked files show up too.
  spawnSync("git", ["add", "-N", "."], { cwd: worktreePath });
  const diff = spawnSync("git", ["diff"], { cwd: worktreePath, encoding: "utf8" });
  return diff.stdout ?? "";
}

function removeWorktree(mainWorkdir: string, worktreePath: string, branch: string | null): void {
  spawnSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: mainWorkdir });
  if (branch) {
    spawnSync("git", ["branch", "-D", branch], { cwd: mainWorkdir });
  }
}
