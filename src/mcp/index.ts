import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ClawConfig } from "../config.js";
import { type Tool, ok, err } from "../tools/types.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpServerSpec {
  name: string;
  config: McpServerConfig;
}

interface ConnectedServer {
  name: string;
  client: Client;
  tools: Tool[];
}

let connected: ConnectedServer[] = [];

export function loadMcpServerSpecs(config: ClawConfig): McpServerSpec[] {
  const user = readJson(path.join(config.homeDir, "settings.json"));
  const proj = readJson(path.join(config.workdir, ".claw", "settings.json"));
  const merged: Record<string, McpServerConfig> = {
    ...(user.mcpServers ?? {}),
    ...(proj.mcpServers ?? {}),
  };
  return Object.entries(merged).map(([name, cfg]) => ({ name, config: cfg }));
}

export async function startMcpServers(specs: McpServerSpec[]): Promise<Tool[]> {
  await disconnectAll();
  for (const spec of specs) {
    try {
      const server = await connectOne(spec);
      connected.push(server);
    } catch (e: any) {
      console.error(`MCP server '${spec.name}' failed to start: ${e?.message ?? e}`);
    }
  }
  return connected.flatMap((c) => c.tools);
}

export async function disconnectAll(): Promise<void> {
  for (const s of connected) {
    try {
      await s.client.close();
    } catch {}
  }
  connected = [];
}

async function connectOne(spec: McpServerSpec): Promise<ConnectedServer> {
  const transport = new StdioClientTransport({
    command: spec.config.command,
    args: spec.config.args ?? [],
    env: { ...process.env, ...(spec.config.env ?? {}) } as Record<string, string>,
    cwd: spec.config.cwd,
  });
  const client = new Client({ name: "openai-claw", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const list = await client.listTools();
  const tools: Tool[] = list.tools.map((t: any) => wrapTool(spec.name, client, t));
  return { name: spec.name, client, tools };
}

function wrapTool(serverName: string, client: Client, remote: any): Tool {
  const localName = `mcp__${serverName}__${remote.name}`;
  return {
    name: localName,
    description: `[MCP:${serverName}] ${remote.description ?? remote.name}`,
    needsPermission: true,
    mutates: true,
    parameters: normalizeSchema(remote.inputSchema),
    async run(input) {
      try {
        const res = await client.callTool({ name: remote.name, arguments: input as any });
        const parts = (res.content as any[] | undefined) ?? [];
        const text = parts
          .map((p) => {
            if (p.type === "text") return p.text;
            if (p.type === "resource") return `[resource ${p.resource?.uri ?? ""}]`;
            return JSON.stringify(p);
          })
          .join("\n");
        if (res.isError) return err(text || "(MCP tool returned isError)");
        return ok(text || "(no output)");
      } catch (e: any) {
        return err(`MCP call failed: ${e?.message ?? String(e)}`);
      }
    },
    preview: (input) => `${localName} ${JSON.stringify(input).slice(0, 80)}`,
  };
}

function normalizeSchema(schema: any): Tool["parameters"] {
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

function readJson(p: string): any {
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}
