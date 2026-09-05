import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { Agent } from "../agent.js";
import { getAllTools } from "../tools/index.js";
import { PermissionManager } from "../permissions/index.js";
import { runSubagent } from "../subagent.js";
import { HookRunner } from "../hooks/index.js";
import { resolveProjectTrust } from "../trust.js";
import { saveSession } from "../session.js";
function hasGh() {
    const r = spawnSync("gh", ["--version"], { stdio: "ignore" });
    return r.status === 0;
}
function isGitRepo(cwd) {
    const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "ignore" });
    return r.status === 0;
}
function currentBranch(cwd) {
    return spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();
}
export function slugify(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "task";
}
/**
 * Run the agent in its own git worktree rather than the user's checkout.
 *
 * This used to `git checkout -b` in place and later `git add -A`, which meant
 * any uncommitted work sitting in the tree was swept into the agent's commit
 * and pushed to a PR — including anything untracked that .gitignore did not
 * happen to cover. A worktree also makes `add -A` safe, because everything in
 * it came from the agent, and it is what the README always claimed happened.
 */
export function createAutoPrWorktree(config, task) {
    const stamp = Date.now().toString(36);
    const slug = slugify(task);
    const branch = `claw/${slug}-${stamp}`;
    const dir = path.join(config.projectDir, "autopr", `${slug}-${stamp}`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const res = spawnSync("git", ["worktree", "add", "-b", branch, dir], {
        cwd: config.workdir,
        encoding: "utf8",
    });
    if (res.status !== 0) {
        return { ok: false, error: (res.stderr || res.stdout || "git worktree add failed").trim() };
    }
    return { ok: true, worktree: { path: dir, branch } };
}
/** Remove the worktree. `deleteBranch` only when nothing was pushed. */
export function removeAutoPrWorktree(config, worktree, deleteBranch) {
    spawnSync("git", ["worktree", "remove", "--force", worktree.path], { cwd: config.workdir });
    if (deleteBranch) {
        spawnSync("git", ["branch", "-D", worktree.branch], { cwd: config.workdir });
    }
}
export async function runAutoPr(config, task, opts = {}) {
    if (!isGitRepo(config.workdir)) {
        console.error(chalk.red("not inside a git repository"));
        return false;
    }
    if (!hasGh()) {
        console.error(chalk.red("`gh` (GitHub CLI) is not installed or not in PATH"));
        return false;
    }
    // `claw pr` is dispatched before main()'s trust gate, so without this it ran
    // a project's hooks — arbitrary shell — with no prompt at all.
    const interactive = opts.interactive ?? !!process.stdin.isTTY;
    const trust = await resolveProjectTrust(config, { interactive });
    const base = currentBranch(config.workdir);
    const setup = createAutoPrWorktree(config, task);
    if (!setup.ok) {
        console.error(chalk.red(`worktree setup failed: ${setup.error}`));
        return false;
    }
    const { path: wtDir, branch } = setup.worktree;
    const runConfig = { ...config, workdir: wtDir };
    const hookRunner = new HookRunner(runConfig, { includeProject: trust.trustHooks });
    const permissions = new PermissionManager(runConfig);
    const tools = getAllTools(runConfig);
    const agent = new Agent({
        config: runConfig,
        tools,
        permissionCheck: (t, i, m) => permissions.check(t, i, m),
        spawnSubagent: (req) => runSubagent(runConfig, (t, i, m) => permissions.check(t, i, m), req),
        runHook: (event, payload) => hookRunner.run(event, payload),
    });
    // An agent-authored PR is exactly the artifact this project exists to make
    // auditable, so the run is attested like any other session when an identity
    // is configured.
    const { SessionAttestor } = await import("../attest/index.js");
    const attestor = new SessionAttestor(runConfig, { quietWhenNoIdentity: true });
    attestor.recordUserPrompt(task);
    agent.pushUser(`You are running in --auto-pr mode. Complete this task end to end:\n\n${task}\n\nGuidelines:\n` +
        `- Use the tools available to read, edit, and run tests as needed.\n` +
        `- Keep the change minimal and focused on the task.\n` +
        `- Do not commit or push — the wrapper will commit and open a PR.\n` +
        `- End with a one-paragraph summary describing what changed and how to verify.`);
    console.error(chalk.dim(`[auto-pr] worktree=${wtDir}`));
    console.error(chalk.dim(`[auto-pr] branch=${branch} base=${base}`));
    let summary = "";
    let sawError = false;
    await agent.run((evt) => {
        attestor.onAgentEvent(evt);
        if (evt.type === "text")
            summary = evt.data;
        if (evt.type === "tool_call") {
            const d = evt.data;
            console.error("\n" + chalk.blue(`▸ ${d.preview ?? d.name}`));
        }
        if (evt.type === "tool_result") {
            const d = evt.data;
            if (d.isError)
                console.error(chalk.red(d.content.slice(0, 2000)));
        }
        if (evt.type === "warning")
            console.error(chalk.yellow(`! ${evt.data}`));
        if (evt.type === "error") {
            console.error(chalk.red(String(evt.data)));
            sawError = true;
        }
    });
    let sidecar = null;
    try {
        const saved = saveSession(runConfig, agent.conversation);
        if (attestor.enabled) {
            sidecar = await attestor.writeSidecar(saved.id);
            if (sidecar) {
                console.error(chalk.dim(`[attest] signed ${attestor.leafCount} leaf(s) → ${path.basename(sidecar)}`));
            }
        }
    }
    catch {
        // an unsaved session must not stop the PR
    }
    if (sawError) {
        console.error(chalk.red(`agent reported an error — worktree left at ${wtDir} for inspection`));
        return false;
    }
    // Everything here came from the agent: the worktree started clean.
    spawnSync("git", ["add", "-A"], { cwd: wtDir });
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: wtDir, encoding: "utf8" });
    if (!status.stdout.trim()) {
        console.error(chalk.yellow("agent produced no diff — aborting PR creation"));
        removeAutoPrWorktree(config, setup.worktree, true);
        return false;
    }
    const commitMsg = buildCommitMessage(task, summary);
    const commit = spawnSync("git", ["commit", "-m", commitMsg], { cwd: wtDir, encoding: "utf8" });
    if (commit.status !== 0) {
        console.error(chalk.red(`git commit failed: ${commit.stderr || commit.stdout}`));
        console.error(chalk.dim(`worktree left at ${wtDir}`));
        return false;
    }
    const push = spawnSync("git", ["push", "-u", "origin", branch], { cwd: wtDir, encoding: "utf8" });
    if (push.status !== 0) {
        console.error(chalk.red(`git push failed: ${push.stderr || push.stdout}`));
        console.error(chalk.dim(`worktree left at ${wtDir} — the commit is safe on ${branch}`));
        return false;
    }
    const prBody = buildPrBody(task, summary, sidecar);
    const pr = spawnSync("gh", ["pr", "create", "--base", base, "--head", branch, "--title", truncate(task, 70), "--body", prBody, "--draft"], { cwd: wtDir, encoding: "utf8" });
    if (pr.status !== 0) {
        console.error(chalk.red(`gh pr create failed: ${pr.stderr || pr.stdout}`));
        console.error(chalk.dim(`worktree left at ${wtDir} — the commit is pushed to ${branch}`));
        return false;
    }
    console.error(chalk.green(pr.stdout.trim()));
    // The branch is pushed; the local worktree has served its purpose.
    removeAutoPrWorktree(config, setup.worktree, false);
    return true;
}
function buildCommitMessage(task, summary) {
    const subject = truncate(task, 72);
    const body = summary ? `\n\n${summary.trim()}` : "";
    return `${subject}${body}`;
}
export function buildPrBody(task, summary, sidecar) {
    const lines = [
        "## Summary",
        summary.trim() || `Automated agent change for: ${task}`,
        "",
        "## Test plan",
        "- [ ] Review the diff",
        "- [ ] Run the relevant tests in your environment",
        "",
        "_(opened by `claw pr` — an agent ran in this branch; please review carefully)_",
    ];
    if (sidecar) {
        lines.push("", `_Attested run: \`${path.basename(sidecar)}\` — verify with \`claw audit verify <session-id>\`._`);
    }
    return lines.join("\n");
}
function truncate(s, n) {
    return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
//# sourceMappingURL=index.js.map