import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { Agent } from "../agent.js";
import { getAllTools } from "../tools/index.js";
import { PermissionManager } from "../permissions/index.js";
import { loadConfig } from "../config.js";
import { runSubagent } from "../subagent.js";
import type { ClawConfig } from "../config.js";

export interface EvalCase {
  /** Stable id used to key result files. */
  id: string;
  description?: string;
  /** Optional shell commands to set up the sandbox repo before the agent runs. */
  setup?: string[];
  /** The user prompt the agent receives. */
  prompt: string;
  /** Expected outcomes. All must hold for the case to pass. */
  expect?: {
    /** File paths (relative to the sandbox) that must exist after the run. */
    files_exist?: string[];
    /** File paths that must NOT exist (e.g. you asked the agent to delete them). */
    files_missing?: string[];
    /** For each (path, regex) pair the file's content must match the regex. */
    file_matches?: { path: string; pattern: string }[];
    /** Shell command(s) that must exit 0 (e.g. `npm test`). */
    shell_passes?: string[];
    /** Tool names that should have been called at least once. */
    tools_used?: string[];
  };
  /** Max agent turns before we fail the case. */
  maxTurns?: number;
}

export interface EvalResult {
  id: string;
  passed: boolean;
  turns: number;
  toolsUsed: string[];
  durationMs: number;
  costUSD: number;
  totalTokens: number;
  failures: string[];
}

export interface EvalReport {
  ranAt: string;
  cases: number;
  passed: number;
  totalCostUSD: number;
  results: EvalResult[];
}

export function loadEvalCases(dir: string): EvalCase[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const cases: EvalCase[] = [];
  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as EvalCase;
      if (!c.id) c.id = path.basename(f, ".json");
      cases.push(c);
    } catch {}
  }
  return cases;
}

async function runOne(c: EvalCase): Promise<EvalResult> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `claw-eval-${c.id}-`));
  const failures: string[] = [];
  const toolsUsed = new Set<string>();
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

    const config: ClawConfig = loadConfig({
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
        const d = evt.data as { name: string };
        toolsUsed.add(d.name);
      }
      if (evt.type === "usage") turns++;
    });

    // Evaluate expectations.
    const exp = c.expect ?? {};
    for (const f of exp.files_exist ?? []) {
      if (!fs.existsSync(path.join(sandbox, f))) failures.push(`expected file missing: ${f}`);
    }
    for (const f of exp.files_missing ?? []) {
      if (fs.existsSync(path.join(sandbox, f))) failures.push(`expected absence but file exists: ${f}`);
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
      if (r.status !== 0) failures.push(`shell_passes failed (exit ${r.status}): ${cmd}\n${r.stderr || r.stdout}`);
    }
    for (const t of exp.tools_used ?? []) {
      if (!toolsUsed.has(t)) failures.push(`tool not used: ${t}`);
    }

    return finalize(agent.usage.totalCostUSD, agent.usage.totalTokens);
  } catch (e: any) {
    failures.push(`exception: ${e?.message ?? String(e)}`);
    return finalize();
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
  }

  function finalize(costUSD = 0, totalTokens = 0): EvalResult {
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

export async function runEvalSuite(dir: string): Promise<EvalReport> {
  const cases = loadEvalCases(dir);
  const results: EvalResult[] = [];
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
