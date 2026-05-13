import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { Agent } from "../agent.js";
import { getAllTools } from "../tools/index.js";
import { PermissionManager } from "../permissions/index.js";
import { runSubagent } from "../subagent.js";
import { HookRunner } from "../hooks/index.js";
import type { ClawConfig } from "../config.js";

function hasGh(): boolean {
  const r = spawnSync("gh", ["--version"], { stdio: "ignore" });
  return r.status === 0;
}

function isGitRepo(cwd: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "ignore" });
  return r.status === 0;
}

function currentBranch(cwd: string): string {
  return spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "task";
}

export async function runAutoPr(config: ClawConfig, task: string): Promise<boolean> {
  if (!isGitRepo(config.workdir)) {
    console.error(chalk.red("not inside a git repository"));
    return false;
  }
  if (!hasGh()) {
    console.error(chalk.red("`gh` (GitHub CLI) is not installed or not in PATH"));
    return false;
  }

  const base = currentBranch(config.workdir);
  const branch = `claw/${slugify(task)}-${Date.now().toString(36)}`;

  // Create a fresh branch off HEAD for the work.
  const checkout = spawnSync("git", ["checkout", "-b", branch], { cwd: config.workdir, encoding: "utf8" });
  if (checkout.status !== 0) {
    console.error(chalk.red(`git checkout failed: ${checkout.stderr || checkout.stdout}`));
    return false;
  }

  const hookRunner = new HookRunner(config);
  const permissions = new PermissionManager(config);
  const tools = getAllTools(config);
  const agent = new Agent({
    config,
    tools,
    permissionCheck: (t, i) => permissions.check(t, i),
    spawnSubagent: (req) => runSubagent(config, (t, i) => permissions.check(t, i), req),
    runHook: (event, payload) => hookRunner.run(event, payload),
  });

  agent.pushUser(
    `You are running in --auto-pr mode. Complete this task end to end:\n\n${task}\n\nGuidelines:\n` +
      `- Use the tools available to read, edit, and run tests as needed.\n` +
      `- Keep the change minimal and focused on the task.\n` +
      `- Do not commit or push — the wrapper will commit and open a PR.\n` +
      `- End with a one-paragraph summary describing what changed and how to verify.`
  );

  console.error(chalk.dim(`[auto-pr] branch=${branch} base=${base}`));
  let summary = "";
  let sawError = false;
  await agent.run((evt) => {
    if (evt.type === "text") summary = evt.data as string;
    if (evt.type === "tool_call") {
      const d = evt.data as { name: string; preview?: string };
      console.error("\n" + chalk.blue(`▸ ${d.preview ?? d.name}`));
    }
    if (evt.type === "tool_result") {
      const d = evt.data as { content: string; isError?: boolean };
      if (d.isError) console.error(chalk.red(d.content.slice(0, 2000)));
    }
    if (evt.type === "error") {
      console.error(chalk.red(String(evt.data)));
      sawError = true;
    }
  });

  if (sawError) {
    console.error(chalk.red("agent reported an error — leaving branch in place for inspection"));
    return false;
  }

  // Stage and commit any diff the agent produced.
  spawnSync("git", ["add", "-A"], { cwd: config.workdir });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: config.workdir, encoding: "utf8" });
  if (!status.stdout.trim()) {
    console.error(chalk.yellow("agent produced no diff — aborting PR creation"));
    spawnSync("git", ["checkout", base], { cwd: config.workdir });
    spawnSync("git", ["branch", "-D", branch], { cwd: config.workdir });
    return false;
  }

  const commitMsg = buildCommitMessage(task, summary);
  const commit = spawnSync("git", ["commit", "-m", commitMsg], { cwd: config.workdir, encoding: "utf8" });
  if (commit.status !== 0) {
    console.error(chalk.red(`git commit failed: ${commit.stderr || commit.stdout}`));
    return false;
  }

  const push = spawnSync("git", ["push", "-u", "origin", branch], { cwd: config.workdir, encoding: "utf8" });
  if (push.status !== 0) {
    console.error(chalk.red(`git push failed: ${push.stderr || push.stdout}`));
    return false;
  }

  const prBody = buildPrBody(task, summary);
  const pr = spawnSync(
    "gh",
    ["pr", "create", "--base", base, "--head", branch, "--title", truncate(task, 70), "--body", prBody, "--draft"],
    { cwd: config.workdir, encoding: "utf8" }
  );
  if (pr.status !== 0) {
    console.error(chalk.red(`gh pr create failed: ${pr.stderr || pr.stdout}`));
    return false;
  }
  console.error(chalk.green(pr.stdout.trim()));
  return true;
}

function buildCommitMessage(task: string, summary: string): string {
  const subject = truncate(task, 72);
  const body = summary ? `\n\n${summary.trim()}` : "";
  return `${subject}${body}`;
}

function buildPrBody(task: string, summary: string): string {
  return [
    "## Summary",
    summary.trim() || `Automated agent change for: ${task}`,
    "",
    "## Test plan",
    "- [ ] Review the diff",
    "- [ ] Run the relevant tests in your environment",
    "",
    "_(opened by `claw pr` — an agent ran in this branch; please review carefully)_",
  ].join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
