import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { Agent } from "../agent.js";
import { getAllTools } from "../tools/index.js";
import { PermissionManager } from "../permissions/index.js";
import { loadConfig } from "../config.js";
import { runSubagent } from "../subagent.js";
export function loadEvalCases(dir) {
    if (!fs.existsSync(dir))
        return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const cases = [];
    for (const f of files) {
        try {
            const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
            if (!c.id)
                c.id = path.basename(f, ".json");
            cases.push(c);
        }
        catch { }
    }
    return cases;
}
async function runOne(c) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `claw-eval-${c.id}-`));
    const failures = [];
    const toolsUsed = new Set();
    let turns = 0;
    const start = Date.now();
    try {
        // Initialize as a git repo so worktree-based agents have something to work with.
        spawnSync("git", ["init", "-q"], { cwd: sandbox });
        spawnSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: sandbox });
        for (const cmd of c.setup ?? []) {
            const r = spawnSync("bash", ["-c", cmd], { cwd: sandbox, encoding: "utf8" });
            if (r.status !== 0) {
                failures.push(`setup failed: ${cmd}\n${r.stderr || r.stdout}`);
                return finalize();
            }
        }
        const config = loadConfig({
            workdir: sandbox,
            permissionMode: "bypassPermissions",
            maxTurns: c.maxTurns ?? 30,
        });
        const tools = getAllTools(config);
        const permissions = new PermissionManager(config);
        const agent = new Agent({
            config,
            tools,
            permissionCheck: (t, i) => permissions.check(t, i),
            spawnSubagent: (req) => runSubagent(config, (t, i) => permissions.check(t, i), req),
        });
        agent.pushUser(c.prompt);
        await agent.run((evt) => {
            if (evt.type === "tool_call") {
                const d = evt.data;
                toolsUsed.add(d.name);
            }
            if (evt.type === "usage")
                turns++;
        });
        // Evaluate expectations.
        const exp = c.expect ?? {};
        for (const f of exp.files_exist ?? []) {
            if (!fs.existsSync(path.join(sandbox, f)))
                failures.push(`expected file missing: ${f}`);
        }
        for (const f of exp.files_missing ?? []) {
            if (fs.existsSync(path.join(sandbox, f)))
                failures.push(`expected absence but file exists: ${f}`);
        }
        for (const m of exp.file_matches ?? []) {
            const fp = path.join(sandbox, m.path);
            if (!fs.existsSync(fp)) {
                failures.push(`file_matches target missing: ${m.path}`);
                continue;
            }
            const body = fs.readFileSync(fp, "utf8");
            if (!new RegExp(m.pattern, "m").test(body)) {
                failures.push(`file ${m.path} does not match /${m.pattern}/`);
            }
        }
        for (const cmd of exp.shell_passes ?? []) {
            const r = spawnSync("bash", ["-c", cmd], { cwd: sandbox, encoding: "utf8" });
            if (r.status !== 0)
                failures.push(`shell_passes failed (exit ${r.status}): ${cmd}\n${r.stderr || r.stdout}`);
        }
        for (const t of exp.tools_used ?? []) {
            if (!toolsUsed.has(t))
                failures.push(`tool not used: ${t}`);
        }
        return finalize(agent.usage.totalCostUSD, agent.usage.totalTokens);
    }
    catch (e) {
        failures.push(`exception: ${e?.message ?? String(e)}`);
        return finalize();
    }
    finally {
        try {
            fs.rmSync(sandbox, { recursive: true, force: true });
        }
        catch { }
    }
    function finalize(costUSD = 0, totalTokens = 0) {
        return {
            id: c.id,
            passed: failures.length === 0,
            turns,
            toolsUsed: Array.from(toolsUsed),
            durationMs: Date.now() - start,
            costUSD,
            totalTokens,
            failures,
        };
    }
}
export async function runEvalSuite(dir) {
    const cases = loadEvalCases(dir);
    const results = [];
    for (const c of cases) {
        results.push(await runOne(c));
    }
    return {
        ranAt: new Date().toISOString(),
        cases: cases.length,
        passed: results.filter((r) => r.passed).length,
        totalCostUSD: results.reduce((s, r) => s + r.costUSD, 0),
        results,
    };
}
//# sourceMappingURL=index.js.map