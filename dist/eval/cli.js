#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import chalk from "chalk";
import { runEvalSuite } from "./index.js";
async function main() {
    const dir = process.argv[2] ?? path.resolve(process.cwd(), "test", "evals");
    if (!fs.existsSync(dir)) {
        console.error(chalk.red(`eval dir not found: ${dir}`));
        process.exit(2);
    }
    console.error(chalk.dim(`running evals from ${dir}…`));
    const report = await runEvalSuite(dir);
    for (const r of report.results) {
        const status = r.passed ? chalk.green("✓") : chalk.red("✗");
        const cost = r.costUSD > 0 ? ` $${r.costUSD.toFixed(4)}` : "";
        console.log(`${status} ${r.id}  turns=${r.turns}  ${r.durationMs}ms${cost}`);
        if (!r.passed)
            for (const f of r.failures)
                console.log(`    ${chalk.red(f)}`);
    }
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
//# sourceMappingURL=cli.js.map