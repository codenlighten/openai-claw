import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ClawConfig } from "../config.js";
import { type Tool, ok, err } from "../tools/types.js";
import { computeFingerprint, type McpFingerprint } from "./fingerprint.js";

export interface McpStdioConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpServerSpec {
  name: string;
  config: McpServerConfig;
}

interface ConnectedServer {
  name: string;
  client: Client;
  tools: Tool[];
  resources: { uri: string; name?: string; description?: string }[];
  prompts: { name: string; description?: string }[];
  /** Server fingerprint captured at attach time (v0.6.0+). */
  fingerprint: McpFingerprint;
  /** Per-tool schema fingerprints (v0.6.0+). One entry per tool offered. */
  toolOfferings: McpToolOffering[];
}

export interface McpToolOffering {
  serverName: string;
  serverFingerprintId: string;
  toolName: string;
  /** sha256 hex of the canonical JSON of the tool's inputSchema. */
  schemaSha256: string;
  /** sha256 hex of the tool's description string. */
  descriptionSha256: string;
}

let connected: ConnectedServer[] = [];

export function loadMcpServerSpecs(
  config: ClawConfig,
  opts: { includeProject?: boolean } = {}
): McpServerSpec[] {
  const includeProject = opts.includeProject ?? true;
  const user = readJson(path.join(config.homeDir, "settings.json"));
  const proj = includeProject ? readJson(path.join(config.workdir, ".claw", "settings.json")) : {};
  const projNames = Object.keys(proj.mcpServers ?? {});
  if (!includeProject && projNames.length > 0) {
    console.warn(
      `[claw] skipping ${projNames.length} project-level MCP server(s) (untrusted project): ${projNames.join(", ")}`
    );
  }
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
  const transport =
    spec.config.type === "http"
      ? new StreamableHTTPClientTransport(new URL(spec.config.url), {
          requestInit: { headers: spec.config.headers },
        })
      : new StdioClientTransport({
          command: spec.config.command,
          args: spec.config.args ?? [],
          env: { ...process.env, ...(spec.config.env ?? {}) } as Record<string, string>,
          cwd: spec.config.cwd,
        });
  const client = new Client({ name: "openai-claw", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  // Fingerprint the server now that we've connected — the SDK's getServerVersion()
  // gives us version info from the initialize handshake.
  const serverVersion = (() => {
    try {
      return (client as any).getServerVersion?.()?.version as string | undefined;
    } catch {
      return undefined;
    }
  })();
  const fingerprint = computeFingerprint({
    name: spec.name,
    config: spec.config,
    serverInfo: { version: serverVersion },
  });

  const list = await client.listTools();
  const toolOfferings: McpToolOffering[] = list.tools.map((t: any) => ({
    serverName: spec.name,
    serverFingerprintId: fingerprint.fingerprintId,
    toolName: t.name,
    schemaSha256: sha256Canon(t.inputSchema ?? {}),
    descriptionSha256: sha256Canon(t.description ?? ""),
  }));
  const tools: Tool[] = list.tools.map((t: any) => wrapTool(spec.name, client, t));

  // Resources and prompts are optional; servers may not implement them.
  // -32601 = JSON-RPC "Method not found"; expected from servers that opt out.
  let resources: ConnectedServer["resources"] = [];
  let prompts: ConnectedServer["prompts"] = [];
  try {
    const r = await client.listResources();
    resources = (r.resources ?? []).map((x: any) => ({
      uri: x.uri,
      name: x.name,
      description: x.description,
    }));
  } catch (e: any) {
    if (e?.code !== -32601) {
      console.warn(`[claw] MCP '${spec.name}' listResources failed: ${e?.message ?? e}`);
    }
  }
  try {
    const p = await client.listPrompts();
    prompts = (p.prompts ?? []).map((x: any) => ({
      name: x.name,
      description: x.description,
    }));
  } catch (e: any) {
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
export function getConnectedServers(): Array<{
  name: string;
  fingerprint: McpFingerprint;
  toolOfferings: McpToolOffering[];
}> {
  return connected.map((c) => ({
    name: c.name,
    fingerprint: c.fingerprint,
    toolOfferings: c.toolOfferings,
  }));
}

function sha256Canon(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJSON(value), "utf8")
    .digest("hex");
}

// Minimal canonical-JSON suitable for hashing tool schemas/descriptions.
// Mirrors the verify package's canonical form; deliberately not imported so
// claw's MCP layer stays standalone if the verify dep is ever swapped.
function canonicalJSON(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`canonicalJSON: non-finite ${v}`);
    return JSON.stringify(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJSON).join(",") + "]";
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") + "}";
  }
  throw new Error(`canonicalJSON: unsupported ${typeof v}`);
}

export function getMcpDirectory(): {
  resources: { server: string; uri: string; name?: string; description?: string }[];
  prompts: { server: string; name: string; description?: string }[];
} {
  return {
    resources: connected.flatMap((c) =>
      c.resources.map((r) => ({ server: c.name, ...r }))
    ),
    prompts: connected.flatMap((c) =>
      c.prompts.map((p) => ({ server: c.name, ...p }))
    ),
  };
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
