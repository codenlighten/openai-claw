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
    if (rawArgs[0] === "attest") {
        return runAttestCli(rawArgs.slice(1));
    }
    if (rawArgs[0] === "verify") {
        return runVerifyCli(rawArgs.slice(1));
    }
    if (rawArgs[0] === "audit") {
        return runAuditCli(rawArgs.slice(1));
    }
    if (rawArgs[0] === "identity") {
        return runIdentityCli(rawArgs.slice(1));
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
        const { SessionAttestor } = await import("./attest/index.js");
        const attestor = new SessionAttestor(config, {
            resumed: !!argv.continue,
            quietWhenNoIdentity: true,
        });
        attestor.recordUserPrompt(promptArg);
        agent.pushUser(prepareUserMessage(promptArg, config).content);
        await agent.run((evt) => {
            attestor.onAgentEvent(evt);
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
        let savedId;
        try {
            const r = saveSession(config, agent.conversation, printSessionId);
            savedId = r.id;
        }
        catch { }
        if (savedId && attestor.enabled) {
            const sidecar = await attestor.writeSidecar(savedId);
            if (sidecar) {
                console.error(chalk.dim(`[attest] signed ${attestor.leafCount} leaf(s) → ${path.basename(sidecar)}`));
            }
        }
        await disconnectAll();
        if (sawError)
            process.exit(1);
        return;
    }
    const { SessionAttestor } = await import("./attest/index.js");
    const sessionAttestor = new SessionAttestor(config, {
        resumed: !!argv.continue,
        quietWhenNoIdentity: true,
    });
    if (argv.tui) {
        await startTui({ agent, config, permissions, sessionAttestor });
    }
    else {
        await startRepl({ agent, config, permissions, sessionAttestor });
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
async function runAttestCli(args) {
    const [sub] = args;
    const config = loadConfig();
    const { createIdentity, loadIdentity, identityFile, identityExists } = await import("./attest/index.js");
    if (!sub || sub === "status") {
        const id = loadIdentity(config);
        if (!id) {
            console.log(chalk.yellow("no attestor identity — run `claw attest init`"));
            process.exit(0);
        }
        console.log(`suite:        ${id.suiteId}`);
        console.log(`createdAt:    ${id.createdAt}`);
        console.log(`publicKeyId:  ${id.publicKeyId}`);
        console.log(`keyFile:      ${identityFile(config)}`);
        return;
    }
    if (sub === "init") {
        if (identityExists(config)) {
            console.error(chalk.red(`identity already exists at ${identityFile(config)} — refuse to overwrite`));
            process.exit(1);
        }
        const id = await createIdentity(config);
        console.log(chalk.green("attestor identity created"));
        console.log(`suite:        ${id.suiteId}`);
        console.log(`publicKeyId:  ${id.publicKeyId}`);
        console.log(`keyFile:      ${identityFile(config)}  (mode 0600)`);
        console.log("");
        console.log(chalk.yellow("back this file up off-machine — losing it loses the identity. The private key is NOT recoverable from the public key."));
        return;
    }
    if (sub === "pubkey") {
        const id = loadIdentity(config);
        if (!id) {
            console.error(chalk.red("no identity"));
            process.exit(1);
        }
        console.log(id.publicKey);
        return;
    }
    if (sub === "anchor") {
        await runAnchor(config, args.slice(1));
        return;
    }
    if (sub === "export-ots") {
        await runExportOts(config, args.slice(1));
        return;
    }
    console.error(chalk.red("usage: claw attest [status|init|pubkey|anchor|export-ots]"));
    process.exit(2);
}
async function runExportOts(config, args) {
    const sessionId = args.find((a) => !a.startsWith("--"));
    const outDirArg = args.find((a) => a.startsWith("--out="))?.split("=")[1];
    if (!sessionId) {
        console.error(chalk.red('usage: claw attest export-ots <session-id> [--out=<dir>]'));
        process.exit(2);
    }
    const { exportOtsFiles } = await import("./attest/index.js");
    const sidecar = path.join(config.projectDir, "sessions", `${sessionId}.attest.json`);
    if (!fs.existsSync(sidecar)) {
        console.error(chalk.red(`no sidecar at ${sidecar}`));
        process.exit(1);
    }
    const attestation = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    if (!attestation.anchor) {
        console.error(chalk.red("sidecar has no anchor — run `claw attest anchor` first"));
        process.exit(1);
    }
    const outDir = outDirArg ?? path.dirname(sidecar);
    if (!fs.existsSync(outDir))
        fs.mkdirSync(outDir, { recursive: true });
    const exports = exportOtsFiles(attestation.anchor);
    if (exports.length === 0) {
        console.error(chalk.yellow("anchor has no successful calendar responses — nothing to export"));
        process.exit(1);
    }
    for (const e of exports) {
        const file = path.join(outDir, `${sessionId}.${e.shortName}.ots`);
        fs.writeFileSync(file, e.bytes);
        console.log(`  ${chalk.green("✓")} ${file}  ${chalk.dim(`(${e.bytes.length} bytes, ${e.url})`)}`);
    }
    console.log("");
    console.log(chalk.dim("Verify any of these with the standard `ots verify <file>.ots` tool"));
    console.log(chalk.dim("(install: pip install opentimestamps-client). Pending proofs become"));
    console.log(chalk.dim("Bitcoin-confirmed automatically within ~3 hours — re-run `ots upgrade`"));
    console.log(chalk.dim("then `ots verify` to chase the chain anchor."));
}
async function runAnchor(config, args) {
    const { anchorOpenTimestamps, canonicalJSON, sha256Hex } = await import("./attest/index.js");
    const sessionsDir = path.join(config.projectDir, "sessions");
    if (!fs.existsSync(sessionsDir)) {
        console.error(chalk.yellow("no sessions to anchor in this project"));
        return;
    }
    const all = args.includes("--all");
    const target = args.find((a) => !a.startsWith("--"));
    if (!all && !target) {
        console.error(chalk.red("usage: claw attest anchor <session-id> | --all"));
        process.exit(2);
    }
    // Find candidate sidecars.
    let sidecars;
    if (all) {
        sidecars = fs
            .readdirSync(sessionsDir)
            .filter((f) => f.endsWith(".attest.json"))
            .map((f) => path.join(sessionsDir, f));
    }
    else {
        const p = path.join(sessionsDir, `${target}.attest.json`);
        if (!fs.existsSync(p)) {
            console.error(chalk.red(`no sidecar found for session ${target}`));
            process.exit(1);
        }
        sidecars = [p];
    }
    if (sidecars.length === 0) {
        console.log(chalk.yellow("no attestation sidecars in this project"));
        return;
    }
    for (const sidecarPath of sidecars) {
        const attestation = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
        if (attestation.anchor && !args.includes("--force")) {
            console.log(chalk.dim(`skip (already anchored): ${path.basename(sidecarPath)}`));
            continue;
        }
        const digest = sha256Hex(canonicalJSON(attestation.header));
        console.log(chalk.dim(`anchor ${path.basename(sidecarPath)}  digest=${digest.slice(0, 16)}…`));
        const proof = await anchorOpenTimestamps(digest);
        attestation.anchor = proof;
        fs.writeFileSync(sidecarPath, JSON.stringify(attestation, null, 2));
        const ok = proof.calendars.filter((c) => c.ok).length;
        const total = proof.calendars.length;
        const tag = ok > 0 ? chalk.green(`${ok}/${total} accepted`) : chalk.red(`${ok}/${total} accepted`);
        console.log(`  ${tag}`);
        for (const c of proof.calendars) {
            const mark = c.ok ? chalk.green("✓") : chalk.red("✗");
            console.log(`  ${mark} ${c.url}${c.error ? "  " + chalk.dim(c.error) : ""}`);
        }
    }
}
async function runVerifyCli(args) {
    const sessionId = args[0];
    if (!sessionId) {
        console.error(chalk.red('usage: claw verify <session-id> [--strict]'));
        process.exit(2);
    }
    const strict = args.includes("--strict");
    const config = loadConfig();
    const sessionsDir = path.join(config.projectDir, "sessions");
    const attestFile = path.join(sessionsDir, `${sessionId}.attest.json`);
    const sessionFile = path.join(sessionsDir, `${sessionId}.json`);
    if (!fs.existsSync(attestFile)) {
        console.error(chalk.red(`no attestation sidecar found: ${attestFile}`));
        process.exit(1);
    }
    const attestation = JSON.parse(fs.readFileSync(attestFile, "utf8"));
    const sessionMessages = fs.existsSync(sessionFile)
        ? JSON.parse(fs.readFileSync(sessionFile, "utf8")).messages
        : undefined;
    const { verifyAttestation } = await import("./attest/index.js");
    const report = await verifyAttestation(attestation, { strict, sessionMessages });
    const tag = report.ok ? chalk.green("OK") : chalk.red("FAIL");
    console.log(`verify ${sessionId}: ${tag}`);
    for (const [k, v] of Object.entries(report.checks)) {
        const mark = v === true ? chalk.green("✓") : v === false ? chalk.red("✗") : chalk.dim("–");
        console.log(`  ${mark} ${k}`);
    }
    if (report.anchor?.present) {
        console.log(chalk.dim(`  anchor: ${report.anchor.type} submitted=${report.anchor.submittedAt} accepted_by=${report.anchor.acceptedBy?.length ?? 0}`));
    }
    else {
        console.log(chalk.dim("  anchor: none (run `claw attest anchor <id>` to publish)"));
    }
    for (const r of report.reasons)
        console.log(chalk.red(`  · ${r}`));
    process.exit(report.ok ? 0 : 1);
}
async function runAuditCli(args) {
    const [sub, ...rest] = args;
    if (sub !== "verify" || rest.length === 0) {
        console.error(chalk.red("usage: claw audit verify <session-id-or-sidecar-path> [--proofs <dir>] [--strict]"));
        process.exit(2);
    }
    const strict = rest.includes("--strict");
    const proofsArg = rest.find((a) => a.startsWith("--proofs="))?.split("=")[1]
        ?? (rest.includes("--proofs") ? rest[rest.indexOf("--proofs") + 1] : undefined);
    const target = rest.find((a) => !a.startsWith("--"));
    // Accept either an explicit path to a sidecar, or a bare session id.
    let attestFile;
    let sessionFile;
    let sessionId;
    if (target.endsWith(".attest.json") && fs.existsSync(target)) {
        attestFile = target;
        sessionId = path.basename(target).replace(/\.attest\.json$/, "");
        const candidate = attestFile.replace(/\.attest\.json$/, ".json");
        if (fs.existsSync(candidate))
            sessionFile = candidate;
    }
    else {
        const config = loadConfig();
        const sessionsDir = path.join(config.projectDir, "sessions");
        attestFile = path.join(sessionsDir, `${target}.attest.json`);
        sessionFile = path.join(sessionsDir, `${target}.json`);
        sessionId = target;
        if (!fs.existsSync(attestFile)) {
            console.error(chalk.red(`no attestation sidecar at ${attestFile}`));
            process.exit(1);
        }
    }
    const attestation = JSON.parse(fs.readFileSync(attestFile, "utf8"));
    const sessionMessages = sessionFile && fs.existsSync(sessionFile)
        ? JSON.parse(fs.readFileSync(sessionFile, "utf8")).messages
        : undefined;
    const { verifyAttestation } = await import("./attest/index.js");
    const report = await verifyAttestation(attestation, { strict, sessionMessages });
    const header = attestation.header;
    const labelGreen = (s) => chalk.green(s);
    const labelRed = (s) => chalk.red(s);
    console.log(chalk.bold(`Claw audit verification`));
    console.log("");
    console.log(`  Session id:         ${sessionId}`);
    console.log(`  Sidecar:            ${attestFile}`);
    console.log(`  Session transcript: ${sessionFile && fs.existsSync(sessionFile) ? sessionFile : chalk.yellow("(not available — sessionAlignment skipped)")}`);
    console.log("");
    console.log(chalk.bold("  Cryptography"));
    const f = (label, key) => {
        const v = report.checks[key];
        const mark = v === true ? labelGreen("✓") : v === false ? labelRed("✗") : chalk.dim("–");
        console.log(`    ${mark} ${label}`);
    };
    f("format               ", "format");
    f("leafContinuity       ", "leafContinuity");
    f("merkleRoot           ", "merkleRoot");
    f("ML-DSA-65 signature  ", "signature");
    f("sessionAlignment     ", "sessionAlignment");
    f("anchorDigest         ", "anchorDigest");
    console.log("");
    console.log(chalk.bold("  Identity"));
    console.log(`    publicKeyId:      ${header.publicKeyId}`);
    console.log(`    suiteId:          ${header.suiteId}`);
    console.log(`    leafCount:        ${header.leafCount}`);
    console.log(`    merkleRoot:       ${header.merkleRoot}`);
    console.log("");
    // OpenTimestamps proofs.
    console.log(chalk.bold("  OpenTimestamps proofs"));
    const proofsDir = proofsArg ?? path.dirname(attestFile);
    let proofFiles = [];
    try {
        proofFiles = fs.readdirSync(proofsDir)
            .filter((f) => f.startsWith(sessionId) && f.endsWith(".ots"));
    }
    catch { }
    // Also look one level deep under a `proofs/` subdir.
    if (proofFiles.length === 0) {
        const sub = path.join(proofsDir, "proofs");
        try {
            proofFiles = fs.readdirSync(sub).filter((f) => f.endsWith(".ots"));
            if (proofFiles.length > 0)
                proofFiles = proofFiles.map((f) => path.join("proofs", f));
        }
        catch { }
    }
    if (proofFiles.length === 0) {
        console.log(chalk.dim("    none found"));
        if (!report.anchor?.present) {
            console.log(chalk.dim("    (no anchor recorded; run `claw attest anchor <id>` and `export-ots`)"));
        }
        else {
            console.log(chalk.dim(`    (anchor present in sidecar — run \`claw attest export-ots ${sessionId} --out=<dir>\`)`));
        }
    }
    else {
        for (const rel of proofFiles) {
            const full = path.isAbsolute(rel) ? rel : path.join(proofsDir, rel);
            const status = inspectOtsFile(full);
            const mark = status.ok ? labelGreen("✓") : labelRed("✗");
            console.log(`    ${mark} ${path.basename(rel)}  ${chalk.dim(status.summary)}`);
        }
    }
    console.log("");
    if (report.ok) {
        console.log(chalk.bold(labelGreen("  Result")));
        console.log(labelGreen("    ✓ Claw-side audit trail is valid"));
        if (proofFiles.length > 0) {
            console.log(labelGreen("    ✓ OpenTimestamps proofs are well-formed"));
            console.log(chalk.dim("      Run `ots upgrade <file>.ots && ots verify <file>.ots` once Bitcoin"));
            console.log(chalk.dim("      has confirmed the calendar's batch (~3 hours after submission)."));
        }
    }
    else {
        console.log(chalk.bold(labelRed("  Result")));
        console.log(labelRed("    ✗ verification failed"));
        for (const r of report.reasons)
            console.log(labelRed(`      · ${r}`));
    }
    process.exit(report.ok ? 0 : 1);
}
/**
 * Lightweight structural check on a .ots file. We do not chase the chain
 * here — `ots verify` is the right tool for that. We only confirm the
 * header magic and that the file is at least long enough to carry a
 * digest and one operation, returning a short summary string.
 */
function inspectOtsFile(file) {
    try {
        const bytes = fs.readFileSync(file);
        // Magic = 31 bytes per the OTS spec.
        const HEADER = Buffer.from([
            0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
            0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00,
            0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
        ]);
        if (bytes.length < HEADER.length + 34)
            return { ok: false, summary: "too short" };
        if (!bytes.subarray(0, HEADER.length).equals(HEADER))
            return { ok: false, summary: "bad header magic" };
        const version = bytes[HEADER.length];
        const op = bytes[HEADER.length + 1];
        if (op !== 0x08)
            return { ok: false, summary: `unexpected file-hash op 0x${op.toString(16)}` };
        return { ok: true, summary: `v${version} sha256, ${bytes.length} bytes, pending` };
    }
    catch (e) {
        return { ok: false, summary: e?.message ?? String(e) };
    }
}
async function runIdentityCli(args) {
    const config = loadConfig();
    const { loadIdentity, identityFile } = await import("./attest/index.js");
    const id = loadIdentity(config);
    const [sub] = args;
    if (!sub || sub === "show") {
        if (!id) {
            console.log(chalk.yellow("no identity — run `claw attest init`"));
            process.exit(0);
        }
        console.log(`fingerprint:  ${id.publicKeyId}`);
        console.log(`suite:        ${id.suiteId}`);
        console.log(`created:      ${id.createdAt}`);
        console.log(`keyFile:      ${identityFile(config)}`);
        return;
    }
    if (sub === "fingerprint") {
        if (!id) {
            console.error(chalk.red("no identity"));
            process.exit(1);
        }
        console.log(id.publicKeyId);
        return;
    }
    if (sub === "export-public") {
        if (!id) {
            console.error(chalk.red("no identity"));
            process.exit(1);
        }
        console.log(id.publicKey);
        return;
    }
    console.error(chalk.red("usage: claw identity [show|fingerprint|export-public]"));
    process.exit(2);
}
main().catch((e) => {
    console.error(chalk.red(e?.stack ?? e?.message ?? String(e)));
    process.exit(1);
});
//# sourceMappingURL=index.js.map