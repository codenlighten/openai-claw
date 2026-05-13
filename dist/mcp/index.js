import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ok, err } from "../tools/types.js";
let connected = [];
export function loadMcpServerSpecs(config) {
    const user = readJson(path.join(config.homeDir, "settings.json"));
    const proj = readJson(path.join(config.workdir, ".claw", "settings.json"));
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
    const list = await client.listTools();
    const tools = list.tools.map((t) => wrapTool(spec.name, client, t));
    // Resources and prompts are optional; servers may not implement them.
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
    catch { }
    try {
        const p = await client.listPrompts();
        prompts = (p.prompts ?? []).map((x) => ({
            name: x.name,
            description: x.description,
        }));
    }
    catch { }
    return { name: spec.name, client, tools, resources, prompts };
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