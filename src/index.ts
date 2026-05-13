#!/usr/bin/env node
import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import chalk from "chalk";
import { loadConfig } from "./config.js";

// Load .env files before anything else reads process.env.
// Order (later wins): bundled project .env, ~/.openai-claw/.env, cwd .env, cwd .env.local.
const here = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.resolve(here, "..");
const cwd = process.cwd();
const userHomeEnv = path.join(process.env.HOME ?? "", ".openai-claw", ".env");
const envCandidates = [
  path.join(projectRoot, ".env"),
  path.join(projectRoot, ".env.local"),
  userHomeEnv,
  ...(cwd !== projectRoot ? [path.join(cwd, ".env"), path.join(cwd, ".env.local")] : []),
];
for (const file of envCandidates) {
  if (fs.existsSync(file)) dotenv.config({ path: file, override: false });
}
import { Agent } from "./agent.js";
import { getAllTools } from "./tools/index.js";
import { PermissionManager } from "./permissions/index.js";
import { runSubagent } from "./subagent.js";
import { startRepl } from "./ui/repl.js";
import { startTui } from "./ui/tui/index.js";
import { saveSession } from "./session.js";
import { loadMcpServerSpecs, startMcpServers, disconnectAll } from "./mcp/index.js";
import { prepareUserMessage } from "./input.js";

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("claw")
    .option("model", { type: "string", describe: "Model to use (overrides config)" })
    .option("workdir", { type: "string", describe: "Working directory (defaults to cwd)" })
    .option("mode", {
      type: "string",
      choices: ["ask", "acceptEdits", "bypassPermissions", "plan"] as const,
      describe: "Permission mode",
    })
    .option("prompt", { alias: "p", type: "string", describe: "Run a single prompt non-interactively and exit" })
    .option("tui", { type: "boolean", default: true, describe: "Use the ink TUI (default). --no-tui falls back to readline." })
    .help()
    .parseAsync();

  let config;
  try {
    config = loadConfig({
      ...(argv.model ? { model: argv.model } : {}),
      ...(argv.workdir ? { workdir: argv.workdir } : {}),
      ...(argv.mode ? { permissionMode: argv.mode as any } : {}),
    });
  } catch (e: any) {
    console.error(chalk.red(e.message));
    process.exit(1);
  }

  const mcpSpecs = loadMcpServerSpecs(config);
  const mcpTools = mcpSpecs.length > 0 ? await startMcpServers(mcpSpecs) : [];
  if (mcpTools.length > 0) {
    console.error(chalk.dim(`[mcp] loaded ${mcpTools.length} tool(s) from ${mcpSpecs.length} server(s)`));
  }
  const tools = [...getAllTools(), ...mcpTools];
  const permissions = new PermissionManager(config);


  const agent = new Agent({
    config,
    tools,
    permissionCheck: (tool, input) => permissions.check(tool, input),
    spawnSubagent: (req) => runSubagent(config, (t, i) => permissions.check(t, i), req),
  });

  if (argv.prompt) {
    agent.pushUser(prepareUserMessage(argv.prompt, config).content);
    await agent.run((evt) => {
      if (evt.type === "text_delta") process.stdout.write(evt.data as string);
      if (evt.type === "tool_call") {
        const d = evt.data as { name: string; preview?: string };
        process.stderr.write("\n" + chalk.blue(`▸ ${d.preview ?? d.name}`) + "\n");
      }
      if (evt.type === "tool_result") {
        const d = evt.data as { content: string; isError?: boolean };
        if (d.isError) process.stderr.write(chalk.red(d.content.slice(0, 4000)) + "\n");
      }
      if (evt.type === "error") process.stderr.write(chalk.red(String(evt.data)) + "\n");
    });
    process.stdout.write("\n");
    try { saveSession(config, agent.conversation); } catch {}
    await disconnectAll();
    return;
  }

  if (argv.tui) {
    await startTui({ agent, config, permissions });
  } else {
    await startRepl({ agent, config, permissions });
  }
  await disconnectAll();
}

main().catch((e) => {
  console.error(chalk.red(e?.stack ?? e?.message ?? String(e)));
  process.exit(1);
});
