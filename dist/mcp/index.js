import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ok, err } from "../tools/types.js";
import { computeFingerprint } from "./fingerprint.js";
let connected = [];
export function loadMcpServerSpecs(config, opts = {}) {
    const includeProject = opts.includeProject ?? true;
    const user = readJson(path.join(config.homeDir, "settings.json"));
    const proj = includeProject ? readJson(path.join(config.workdir, ".claw", "settings.json")) : {};
    const projNames = Object.keys(proj.mcpServers ?? {});
    if (!includeProject && projNames.length > 0) {
        console.warn(`[claw] skipping ${projNames.length} project-level MCP server(s) (untrusted project): ${projNames.join(", ")}`);
    }
    const merged = {
        ...(user.mcpServers ?? {}),
        ...(proj.mcpServers ?? {}),
    };
    return Object.entries(merged).map(([name, cfg]) => ({ name, config: cfg }));
}
export async function startMcpServers(specs) {
    await disconnectAll();
    for (const spec of specs) {
        try {
            const server = await connectOne(spec);
            connected.push(server);
        }
        catch (e) {
            console.error(`MCP server '${spec.name}' failed to start: ${e?.message ?? e}`);
        }
    }
    return connected.flatMap((c) => c.tools);
}
export async function disconnectAll() {
    for (const s of connected) {
        try {
            await s.client.close();
        }
        catch { }
    }
    connected = [];
}
async function connectOne(spec) {
    const transport = spec.config.type === "http"
        ? new StreamableHTTPClientTransport(new URL(spec.config.url), {
            requestInit: { headers: spec.config.headers },
        })
        : new StdioClientTransport({
            command: spec.config.command,
            args: spec.config.args ?? [],
            env: { ...process.env, ...(spec.config.env ?? {}) },
            cwd: spec.config.cwd,
        });
    const client = new Client({ name: "openai-claw", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    // Fingerprint the server now that we've connected — the SDK's getServerVersion()
    // gives us version info from the initialize handshake.
    const serverVersion = (() => {
        try {
            return client.getServerVersion?.()?.version;
        }
        catch {
            return undefined;
        }
    })();
    const fingerprint = computeFingerprint({
        name: spec.name,
        config: spec.config,
        serverInfo: { version: serverVersion },
    });
    const list = await client.listTools();
    const toolOfferings = list.tools.map((t) => ({
        serverName: spec.name,
        serverFingerprintId: fingerprint.fingerprintId,
        toolName: t.name,
        schemaSha256: sha256Canon(t.inputSchema ?? {}),
        descriptionSha256: sha256Canon(t.description ?? ""),
    }));
    const tools = list.tools.map((t) => wrapTool(spec.name, client, t));
    // Resources and prompts are optional; servers may not implement them.
    // -32601 = JSON-RPC "Method not found"; expected from servers that opt out.
    let resources = [];
    let prompts = [];
    try {
        const r = await client.listResources();
        resources = (r.resources ?? []).map((x) => ({
            uri: x.uri,
            name: x.name,
            description: x.description,
        }));
    }
    catch (e) {
        if (e?.code !== -32601) {
            console.warn(`[claw] MCP '${spec.name}' listResources failed: ${e?.message ?? e}`);
        }
    }
    try {
        const p = await client.listPrompts();
        prompts = (p.prompts ?? []).map((x) => ({
            name: x.name,
            description: x.description,
        }));
    }
    catch (e) {
        if (e?.code !== -32601) {
            console.warn(`[claw] MCP '${spec.name}' listPrompts failed: ${e?.message ?? e}`);
        }
    }
    return { name: spec.name, client, tools, resources, prompts, fingerprint, toolOfferings };
}
/**
 * Inspect the currently-connected MCP servers. Used by the Attestor and CLI
 * to emit attestation leaves and to drive `claw mcp list`. The returned
 * objects expose fingerprint and tool-offering data captured at attach
 * time; they do not mutate after attach.
 */
export function getConnectedServers() {
    return connected.map((c) => ({
        name: c.name,
        fingerprint: c.fingerprint,
        toolOfferings: c.toolOfferings,
    }));
}
function sha256Canon(value) {
    return createHash("sha256")
        .update(canonicalJSON(value), "utf8")
        .digest("hex");
}
// Minimal canonical-JSON suitable for hashing tool schemas/descriptions.
// Mirrors the verify package's canonical form; deliberately not imported so
// claw's MCP layer stays standalone if the verify dep is ever swapped.
function canonicalJSON(v) {
    if (v === null)
        return "null";
    if (typeof v === "boolean")
        return v ? "true" : "false";
    if (typeof v === "number") {
        if (!Number.isFinite(v))
            throw new Error(`canonicalJSON: non-finite ${v}`);
        return JSON.stringify(v);
    }
    if (typeof v === "string")
        return JSON.stringify(v);
    if (Array.isArray(v))
        return "[" + v.map(canonicalJSON).join(",") + "]";
    if (typeof v === "object") {
        const obj = v;
        const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
        return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") + "}";
    }
    throw new Error(`canonicalJSON: unsupported ${typeof v}`);
}
export function getMcpDirectory() {
    return {
        resources: connected.flatMap((c) => c.resources.map((r) => ({ server: c.name, ...r }))),
        prompts: connected.flatMap((c) => c.prompts.map((p) => ({ server: c.name, ...p }))),
    };
}
function wrapTool(serverName, client, remote) {
    const localName = `mcp__${serverName}__${remote.name}`;
    return {
        name: localName,
        description: `[MCP:${serverName}] ${remote.description ?? remote.name}`,
        needsPermission: true,
        mutates: true,
        parameters: normalizeSchema(remote.inputSchema),
        async run(input) {
            try {
                const res = await client.callTool({ name: remote.name, arguments: input });
                const parts = res.content ?? [];
                const text = parts
                    .map((p) => {
                    if (p.type === "text")
                        return p.text;
                    if (p.type === "resource")
                        return `[resource ${p.resource?.uri ?? ""}]`;
                    return JSON.stringify(p);
                })
                    .join("\n");
                if (res.isError)
                    return err(text || "(MCP tool returned isError)");
                return ok(text || "(no output)");
            }
            catch (e) {
                return err(`MCP call failed: ${e?.message ?? String(e)}`);
            }
        },
        preview: (input) => `${localName} ${JSON.stringify(input).slice(0, 80)}`,
    };
}
function normalizeSchema(schema) {
    if (!schema || typeof schema !== "object") {
        return { type: "object", properties: {}, additionalProperties: true };
    }
    return {
        type: "object",
        properties: schema.properties ?? {},
        required: schema.required,
        additionalProperties: schema.additionalProperties ?? true,
    };
}
function readJson(p) {
    try {
        if (!fs.existsSync(p))
            return {};
        return JSON.parse(fs.readFileSync(p, "utf8"));
    }
    catch {
        return {};
    }
}
//# sourceMappingURL=index.js.map