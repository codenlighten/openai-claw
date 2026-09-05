#!/usr/bin/env node
import { loadEnvFiles } from "../env.js";
import path from "node:path";
import fs from "node:fs";
import chalk from "chalk";
import { runEvalSuite } from "./index.js";

loadEnvFiles();

async function main() {
  const dir = process.argv[2] ?? path.resolve(process.cwd(), "test", "evals");
  if (!fs.existsSync(dir)) {
    console.error(chalk.red(`eval dir not found: ${dir}`));
    process.exit(2);
  }
  console.error(chalk.dim(`running evals from ${dir}…`));
  const report = await runEvalSuite(dir, (r, i, total) => {
    const status = r.passed ? chalk.green("✓") : chalk.red("✗");
    const cost = r.costUSD > 0 ? ` $${r.costUSD.toFixed(4)}` : "";
    const tools = r.toolsUsed.length > 0 ? `  [${r.toolsUsed.join(" ")}]` : "";
    const counter = chalk.dim(`[${i + 1}/${total}]`);
    console.log(
      `${counter} ${status} ${r.id}  turns=${r.turns}  ${(r.durationMs / 1000).toFixed(1)}s${cost}${chalk.dim(tools)}`
    );
    if (!r.passed) for (const f of r.failures) console.log(`    ${chalk.red(f)}`);
  });
  const summary = `${report.passed}/${report.cases} passed`;
  const out = report.passed === report.cases ? chalk.green(summary) : chalk.red(summary);
  console.log(`\n${out}  total cost: $${report.totalCostUSD.toFixed(4)}`);
  fs.writeFileSync(path.join(dir, "..", "eval-report.json"), JSON.stringify(report, null, 2));
  process.exit(report.passed === report.cases ? 0 : 1);
}

main().catch((e) => {
  console.error(chalk.red(e?.stack ?? e?.message ?? String(e)));
  process.exit(1);
});
