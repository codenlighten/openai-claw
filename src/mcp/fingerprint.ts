import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { McpServerConfig } from "./index.js";

/**
 * Deterministic fingerprint of an MCP server, computed at attach time. The
 * fingerprint becomes the payload of an `mcp_attach` attestation leaf and
 * keys the consent store, so identical fingerprints across sessions are
 * treated as the same trusted server. Any difference — binary content,
 * version, command line, env-var name set, URL — invalidates consent and
 * requires fresh prompting.
 *
 * The fields recorded by the fingerprint are NOT the leaf payload directly;
 * they're hashed into the payloadHash via canonicalJSON in the Attestor.
 * They are also returned in cleartext to the caller for display purposes
 * (e.g. `claw mcp list`) and for the consent prompt.
 */
export interface McpFingerprint {
  /** "stdio" or "http" — different transports have different fingerprint surfaces. */
  transport: "stdio" | "http";
  /** Logical server name from settings.json. */
  name: string;
  /** stdio: absolute command path. http: full URL. */
  endpoint: string;
  /** stdio only: sha256 of the binary on disk at attach time. */
  binarySha256?: string;
  /** stdio only: argv minus the command. */
  args?: string[];
  /** Sorted list of env var NAMES the server inherits (values not recorded). */
  envNames?: string[];
  /** http only: sha256 of the TLS server certificate, if we can fetch it. */
  tlsCertSha256?: string;
  /** Server's self-reported version (from initialize response), if any. */
  serverVersion?: string;
  /** Short stable id derived from the rest of the fingerprint. */
  fingerprintId: string;
}

export interface McpFingerprintInput {
  name: string;
  config: McpServerConfig;
  /** Optional: the result of MCP `initialize` (so we can pick up serverInfo). */
  serverInfo?: { name?: string; version?: string };
}

export function computeFingerprint(input: McpFingerprintInput): McpFingerprint {
  if (input.config.type === "http") {
    const fp: McpFingerprint = {
      transport: "http",
      name: input.name,
      endpoint: input.config.url,
      serverVersion: input.serverInfo?.version,
      fingerprintId: "",
    };
    fp.fingerprintId = idFor(fp);
    return fp;
  }

  // stdio
  const stdioConfig = input.config;
  const resolved = resolveBinary(stdioConfig.command);
  const binarySha256 = resolved ? sha256OfFile(resolved) ?? undefined : undefined;
  const envNames = Object.keys({
    ...process.env,
    ...(stdioConfig.env ?? {}),
  }).sort();
  const fp: McpFingerprint = {
    transport: "stdio",
    name: input.name,
    endpoint: resolved ?? stdioConfig.command,
    binarySha256,
    args: stdioConfig.args ?? [],
    envNames,
    serverVersion: input.serverInfo?.version,
    fingerprintId: "",
  };
  fp.fingerprintId = idFor(fp);
  return fp;
}

/**
 * Resolve a stdio command to an absolute path. If the command is already
 * absolute we use it as-is; otherwise consult `which` via the shell.
 */
function resolveBinary(command: string): string | null {
  if (command.startsWith("/")) {
    return fs.existsSync(command) ? command : null;
  }
  try {
    const out = execFileSync("/bin/sh", ["-c", `command -v ${shellQuote(command)}`], {
      encoding: "utf8",
      timeout: 1000,
    }).trim();
    return out.length > 0 && fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

function sha256OfFile(path: string): string | null {
  try {
    const buf = fs.readFileSync(path);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

/**
 * 16-char base64url fingerprint over the entire deterministic record. This
 * is what the consent store uses as a key and what `claw mcp list` shows.
 */
function idFor(fp: Omit<McpFingerprint, "fingerprintId">): string {
  const canonical = JSON.stringify(
    {
      transport: fp.transport,
      endpoint: fp.endpoint,
      binarySha256: fp.binarySha256 ?? null,
      args: fp.args ?? null,
      envNames: fp.envNames ?? null,
      serverVersion: fp.serverVersion ?? null,
    },
    (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = (value as any)[k]; return acc; }, {})
        : value
  );
  return createHash("sha256")
    .update(canonical)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
    .slice(0, 16);
}

function shellQuote(s: string): string {
  // Conservative — only allow [A-Za-z0-9._/-]; reject anything else by
  // returning a non-resolvable token. Avoids passing shell metacharacters
  // into `command -v`.
  return /^[A-Za-z0-9._/-]+$/.test(s) ? s : "__claw_invalid_command__";
}
