import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Agent } from "../agent.js";
import { getAllTools } from "../tools/index.js";
import { PermissionManager } from "../permissions/index.js";
import { loadConfig } from "../config.js";
import { runSubagent } from "../subagent.js";
/** Default wall-clock budget per case. */
const DEFAULT_CASE_TIMEOUT_MS = 300_000;
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
/** relpath -> sha256 of content, for every file under `dir` except .git. */
export function snapshotDir(dir) {
    const out = {};
    const walk = (current) => {
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (e.name === ".git")
                continue;
            const full = path.join(current, e.name);
            if (e.isDirectory()) {
                walk(full);
                continue;
            }
            if (!e.isFile())
                continue;
            try {
                out[path.relative(dir, full)] = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
            }
            catch { }
        }
    };
    walk(dir);
    return out;
}
/**
 * Evaluate a case's expectations against the finished sandbox. Pure apart from
 * reading the sandbox and running `shell_passes`, so the whole expectation
 * vocabulary is testable without spending a model call.
 */
export function checkExpectations(sandbox, expectations = {}, obs, allowErrors = false) {
    const failures = [];
    const toolsUsed = new Set(obs.toolsUsed);
    const toolsDenied = new Set(obs.toolsDenied);
    if (!allowErrors && obs.errors.length > 0) {
        failures.push(`agent reported ${obs.errors.length} error(s): ${obs.errors.join(" | ")}`);
    }
    for (const f of expectations.files_exist ?? []) {
        if (!fs.existsSync(path.join(sandbox, f)))
            failures.push(`expected file missing: ${f}`);
    }
    for (const f of expectations.files_missing ?? []) {
        if (fs.existsSync(path.join(sandbox, f)))
            failures.push(`expected absence but file exists: ${f}`);
    }
    for (const m of expectations.file_matches ?? []) {
        const fp = path.join(sandbox, m.path);
        if (!fs.existsSync(fp)) {
            failures.push(`file_matches target missing: ${m.path}`);
            continue;
        }
        if (!new RegExp(m.pattern, "m").test(fs.readFileSync(fp, "utf8"))) {
            failures.push(`file ${m.path} does not match /${m.pattern}/`);
        }
    }
    for (const m of expectations.file_not_matches ?? []) {
        const fp = path.join(sandbox, m.path);
        if (!fs.existsSync(fp)) {
            failures.push(`file_not_matches target missing: ${m.path}`);
            continue;
        }
        if (new RegExp(m.pattern, "m").test(fs.readFileSync(fp, "utf8"))) {
            failures.push(`file ${m.path} still matches /${m.pattern}/`);
        }
    }
    for (const cmd of expectations.shell_passes ?? []) {
        const r = spawnSync("bash", ["-c", cmd], { cwd: sandbox, encoding: "utf8" });
        if (r.status !== 0) {
            failures.push(`shell_passes failed (exit ${r.status}): ${cmd}\n${r.stderr || r.stdout}`);
        }
    }
    for (const t of expectations.tools_used ?? []) {
        if (!toolsUsed.has(t))
            failures.push(`tool not used: ${t}`);
    }
    for (const t of expectations.tools_not_used ?? []) {
        if (toolsUsed.has(t))
            failures.push(`tool should not have been used: ${t}`);
    }
    for (const t of expectations.tools_denied ?? []) {
        if (!toolsDenied.has(t)) {
            failures.push(`expected ${t} to be denied, but no denial was recorded`);
        }
    }
    if (expectations.no_new_files) {
        const after = snapshotDir(sandbox);
        const created = Object.keys(after).filter((f) => !(f in obs.before));
        if (created.length > 0)
            failures.push(`unexpected new file(s): ${created.join(", ")}`);
    }
    for (const f of expectations.files_unchanged ?? []) {
        const fp = path.join(sandbox, f);
        if (!fs.existsSync(fp)) {
            failures.push(`files_unchanged target missing: ${f}`);
            continue;
        }
        const now = createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
        if (obs.before[f] !== now)
            failures.push(`file changed but should not have: ${f}`);
    }
    if (expectations.max_turns_used !== undefined && obs.turns > expectations.max_turns_used) {
        failures.push(`took ${obs.turns} turns, expected at most ${expectations.max_turns_used}`);
    }
    if (expectations.compacted && obs.compactions === 0) {
        failures.push("expected the context to be compacted at least once, but it never was");
    }
    if (expectations.warned && obs.warnings.length === 0) {
        failures.push("expected a warning event, but none was emitted");
    }
    return failures;
}
async function runOne(c) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `claw-eval-${c.id}-`));
    const homes = [];
    const failures = [];
    const errors = [];
    const toolsUsed = new Set();
    const toolsDenied = new Set();
    const warnings = [];
    let compactions = 0;
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
        const before = snapshotDir(sandbox);
        // Hermetic home: without this a case reads the developer's own
        // ~/.openai-claw settings, memories and MCP servers, so the same case
        // passes on one machine and fails on another for reasons nothing records.
        const evalHome = fs.mkdtempSync(path.join(os.tmpdir(), `claw-evalhome-${c.id}-`));
        homes.push(evalHome);
        const config = loadConfig({
            workdir: sandbox,
            homeDir: evalHome,
            projectDir: evalHome,
            memoryDir: path.join(evalHome, "memory"),
            permissionMode: c.permissionMode ?? "bypassPermissions",
            maxTurns: c.maxTurns ?? 30,
            allowedTools: c.allowedTools ?? [],
            deniedTools: c.deniedTools ?? [],
            ...(c.contextWindow !== undefined ? { contextWindow: c.contextWindow } : {}),
            ...(c.compactThreshold !== undefined ? { compactThreshold: c.compactThreshold } : {}),
            ...(c.maxTokens !== undefined ? { maxTokens: c.maxTokens } : {}),
        });
        const tools = getAllTools(config);
        // Scripted prompter: evals never have a human, and a case that exercises a
        // denial needs the answer to be deterministic rather than a hung stdin read.
        const permissions = new PermissionManager(config, async () => c.promptAnswer ?? "no");
        const agent = new Agent({
            config,
            tools,
            permissionCheck: (t, i, m) => permissions.check(t, i, m),
            spawnSubagent: (req, signal) => runSubagent(config, (t, i, m) => permissions.check(t, i, m), req, undefined, signal),
        });
        agent.pushUser(c.prompt);
        const timeoutMs = c.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            await agent.run((evt) => {
                if (evt.type === "tool_call") {
                    const d = evt.data;
                    toolsUsed.add(d.name);
                }
                if (evt.type === "usage")
                    turns++;
                if (evt.type === "error")
                    errors.push(String(evt.data));
                if (evt.type === "warning")
                    warnings.push(String(evt.data));
                if (evt.type === "compaction") {
                    const d = evt.data;
                    if (!d?.skipped)
                        compactions++;
                }
                if (evt.type === "tool_result") {
                    const d = evt.data;
                    if (d.isError && d.content.startsWith(`Permission denied for ${d.name}`)) {
                        toolsDenied.add(d.name);
                    }
                }
            }, controller.signal);
        }
        finally {
            clearTimeout(timer);
        }
        if (controller.signal.aborted) {
            failures.push(`timed out after ${timeoutMs}ms (${turns} turn(s) completed)`);
        }
        failures.push(...checkExpectations(sandbox, c.expect, {
            toolsUsed: Array.from(toolsUsed),
            toolsDenied: Array.from(toolsDenied),
            compactions,
            warnings,
            turns,
            errors,
            before,
        }, c.allow_errors));
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
        for (const h of homes) {
            try {
                fs.rmSync(h, { recursive: true, force: true });
            }
            catch { }
        }
    }
    function finalize(costUSD = 0, totalTokens = 0) {
        return {
            id: c.id,
            passed: failures.length === 0,
            turns,
            toolsUsed: Array.from(toolsUsed),
            toolsDenied: Array.from(toolsDenied),
            compactions,
            warnings,
            durationMs: Date.now() - start,
            costUSD,
            totalTokens,
            errors,
            failures,
        };
    }
}
/**
 * Run every case in `dir`, reporting each result as it lands.
 *
 * `onResult` exists because a suite of real model calls takes minutes and costs
 * money: printing only at the end means an interrupted run shows nothing at all
 * for work already paid for.
 */
export async function runEvalSuite(dir, onResult) {
    const cases = loadEvalCases(dir);
    const results = [];
    for (const [i, c] of cases.entries()) {
        const result = await runOne(c);
        results.push(result);
        onResult?.(result, i, cases.length);
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