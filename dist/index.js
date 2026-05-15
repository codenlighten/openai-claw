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
    if (fs.existsSync(file))
        dotenv.config({ path: file, override: false });
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
import { HookRunner } from "./hooks/index.js";
import { loadTodos } from "./tools/todo.js";
import { resolveProjectTrust } from "./trust.js";
// Read version from package.json at runtime so we can't drift from npm.
const PKG_VERSION = (() => {
    try {
        const pkgPath = path.resolve(here, "..", "package.json");
        return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
    }
    catch {
        return "0.0.0";
    }
})();
async function main() {
    // Top-level subcommands handled before the interactive yargs parser.
    const rawArgs = process.argv.slice(2);
    if (rawArgs[0] === "install" || rawArgs[0] === "uninstall" || rawArgs[0] === "plugins") {
        return runPluginCli(rawArgs);
    }
    if (rawArgs[0] === "pr") {
        return runPrCli(rawArgs.slice(1));
    }
    if (rawArgs[0] === "dashboard") {
        return runDashboardCli(rawArgs.slice(1));
    }
    const argv = await yargs(hideBin(process.argv))
        .scriptName("claw")
        .version(PKG_VERSION)
        .option("model", { type: "string", describe: "Model to use (overrides config)" })
        .option("workdir", { type: "string", describe: "Working directory (defaults to cwd)" })
        .option("mode", {
        type: "string",
        choices: ["ask", "acceptEdits", "bypassPermissions", "plan"],
        describe: "Permission mode",
    })
        .option("prompt", { alias: "p", type: "string", describe: "Run a single prompt non-interactively and exit" })
        .option("continue", { type: "boolean", default: false, describe: "Resume the last saved session in this project" })
        .option("append-system-prompt", { type: "string", describe: "Extra text to append to the system prompt" })
        .option("dangerously-skip-permissions", {
        type: "boolean",
        default: false,
        describe: "Run with permissionMode=bypassPermissions for this session",
    })
        .option("tui", { type: "boolean", default: true, describe: "Use the ink TUI (default). --no-tui falls back to readline." })
        .help()
        .parseAsync();
    let config;
    try {
        config = loadConfig({
            ...(argv.model ? { model: argv.model } : {}),
            ...(argv.workdir ? { workdir: argv.workdir } : {}),
            ...(argv.mode ? { permissionMode: argv.mode } : {}),
            ...(argv["dangerously-skip-permissions"] ? { permissionMode: "bypassPermissions" } : {}),
        });
    }
    catch (e) {
        console.error(chalk.red(e.message));
        process.exit(1);
    }
    const trust = await resolveProjectTrust(config, { interactive: !!process.stdin.isTTY });
    const mcpSpecs = loadMcpServerSpecs(config, { includeProject: trust.trustMcp });
    const mcpTools = mcpSpecs.length > 0 ? await startMcpServers(mcpSpecs) : [];
    if (mcpTools.length > 0) {
        console.error(chalk.dim(`[mcp] loaded ${mcpTools.length} tool(s) from ${mcpSpecs.length} server(s)`));
    }
    const tools = [...getAllTools(config), ...mcpTools];
    const permissions = new PermissionManager(config);
    const hookRunner = new HookRunner(config, { includeProject: trust.trustHooks });
    loadTodos(config.memoryDir);
    const systemPromptExtras = [];
    if (typeof argv["append-system-prompt"] === "string" && argv["append-system-prompt"].length > 0) {
        systemPromptExtras.push(argv["append-system-prompt"]);
    }
    const agent = new Agent({
        config,
        tools,
        permissionCheck: (tool, input) => permissions.check(tool, input),
        spawnSubagent: (req) => runSubagent(config, (t, i) => permissions.check(t, i), req),
        runHook: (event, payload) => hookRunner.run(event, payload),
        systemPromptExtras,
    });
    let printSessionId;
    if (argv.continue) {
        try {
            const { loadSession } = await import("./session.js");
            const data = loadSession(config);
            if (data) {
                agent.replaceConversation(data.messages);
                printSessionId = data.id;
                console.error(chalk.dim(`[resumed ${data.messages.length} message(s) from session ${data.id} (${data.savedAt})]`));
            }
            else {
                console.error(chalk.dim("[no saved session to resume]"));
            }
        }
        catch (e) {
            console.error(chalk.red(`failed to resume: ${e?.message ?? e}`));
        }
    }
    // If stdin is piped and no --prompt given, read it as the single prompt.
    let promptArg = argv.prompt;
    if (!promptArg && !process.stdin.isTTY) {
        promptArg = await readStdinToEnd();
    }
    if (promptArg && promptArg.length > 0) {
        let sawError = false;
        agent.pushUser(prepareUserMessage(promptArg, config).content);
        await agent.run((evt) => {
            if (evt.type === "text_delta")
                process.stdout.write(evt.data);
            if (evt.type === "tool_call") {
                const d = evt.data;
                process.stderr.write("\n" + chalk.blue(`▸ ${d.preview ?? d.name}`) + "\n");
            }
            if (evt.type === "tool_result") {
                const d = evt.data;
                if (d.isError)
                    process.stderr.write(chalk.red(d.content.slice(0, 4000)) + "\n");
            }
            if (evt.type === "error") {
                process.stderr.write(chalk.red(String(evt.data)) + "\n");
                sawError = true;
            }
        });
        process.stdout.write("\n");
        try {
            saveSession(config, agent.conversation, printSessionId);
        }
        catch { }
        await disconnectAll();
        if (sawError)
            process.exit(1);
        return;
    }
    if (argv.tui) {
        await startTui({ agent, config, permissions });
    }
    else {
        await startRepl({ agent, config, permissions });
    }
    await disconnectAll();
}
function readStdinToEnd() {
    return new Promise((resolve) => {
        let buf = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c) => (buf += c));
        process.stdin.on("end", () => resolve(buf.trim()));
    });
}
async function runPluginCli(args) {
    const config = loadConfig();
    const { installPlugin, removePlugin, listInstalled, searchRegistry } = await import("./plugins/index.js");
    const [cmd, ...rest] = args;
    if (cmd === "install") {
        const src = rest[0];
        if (!src) {
            console.error(chalk.red("usage: claw install <name-or-git-url>"));
            process.exit(2);
        }
        console.error(chalk.dim(`installing ${src}…`));
        const r = installPlugin(config, src);
        if (!r.ok) {
            console.error(chalk.red(r.error));
            process.exit(1);
        }
        const p = r.entry;
        console.error(chalk.dim(`installed ${p.name} (${p.ref?.slice(0, 7) ?? "?"})  skills=${p.provides.skills.length} agents=${p.provides.agents.length} mcp=${p.provides.mcp.length}`));
        return;
    }
    if (cmd === "uninstall") {
        const name = rest[0];
        if (!name) {
            console.error(chalk.red("usage: claw uninstall <name>"));
            process.exit(2);
        }
        const r = removePlugin(config, name);
        if (!r.ok) {
            console.error(chalk.red(r.error));
            process.exit(1);
        }
        console.error(chalk.dim(`removed ${name}`));
        return;
    }
    if (cmd === "plugins") {
        const sub = rest[0] ?? "list";
        if (sub === "list") {
            for (const p of listInstalled(config))
                console.log(`${p.name}\t${p.source}\t${p.ref ?? ""}`);
            return;
        }
        if (sub === "search") {
            const q = rest.slice(1).join(" ");
            for (const h of searchRegistry(q))
                console.log(`${h.name}\t${h.url}\t${h.description}`);
            return;
        }
        console.error(chalk.red("usage: claw plugins [list|search <q>]"));
        process.exit(2);
    }
}
async function runPrCli(args) {
    const task = args.join(" ").trim();
    if (!task) {
        console.error(chalk.red('usage: claw pr "<task description>"'));
        process.exit(2);
    }
    const { runAutoPr } = await import("./autopr/index.js");
    const config = loadConfig();
    const ok = await runAutoPr(config, task);
    process.exit(ok ? 0 : 1);
}
async function runDashboardCli(args) {
    const portArg = args.find((a) => a.startsWith("--port="))?.split("=")[1];
    const port = parseInt(portArg ?? "3737", 10);
    const { startDashboard } = await import("./web/index.js");
    const config = loadConfig();
    await startDashboard(config, port);
}
main().catch((e) => {
    console.error(chalk.red(e?.stack ?? e?.message ?? String(e)));
    process.exit(1);
});
//# sourceMappingURL=index.js.map