import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createIdentity,
  SessionAttestor,
  verifyAttestation,
} from "../src/attest/index.js";
import type { ClawConfig } from "../src/config.js";
import type { McpFingerprint } from "../src/mcp/fingerprint.js";

let home: string;
const cfg = (): ClawConfig => ({
  workdir: home,
  homeDir: home,
  projectDir: home,
  memoryDir: home,
  model: "test",
  apiKey: "x",
  allowedTools: [],
  deniedTools: [],
  contextWindow: 0,
  compactThreshold: 1,
  permissionMode: "ask",
  maxTurns: 50,
  maxToolResultChars: 50_000,
  models: {},
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "claw-mcp-attest-"));
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function fakeFingerprint(name: string): McpFingerprint {
  return {
    transport: "stdio",
    name,
    endpoint: `/usr/local/bin/${name}-mcp`,
    binarySha256: "a".repeat(64),
    args: ["--mode", "stdio"],
    envNames: ["HOME", "PATH"],
    serverVersion: "1.2.3",
    fingerprintId: name.slice(0, 16).padEnd(16, "x"),
  };
}

describe("SessionAttestor.recordMcpServers", () => {
  it("emits attach + offer + consent leaves per server", async () => {
    await createIdentity(cfg());
    const sa = new SessionAttestor(cfg(), { quietWhenNoIdentity: true });
    expect(sa.enabled).toBe(true);

    sa.recordMcpServers(
      [
        {
          name: "alpha",
          fingerprint: fakeFingerprint("alpha"),
          toolOfferings: [
            {
              serverName: "alpha",
              serverFingerprintId: "alphaxxxxxxxxxxxx",
              toolName: "query",
              schemaSha256: "b".repeat(64),
              descriptionSha256: "c".repeat(64),
            },
            {
              serverName: "alpha",
              serverFingerprintId: "alphaxxxxxxxxxxxx",
              toolName: "write",
              schemaSha256: "d".repeat(64),
              descriptionSha256: "e".repeat(64),
            },
          ],
        },
      ],
      true
    );

    // Expected: 1 attach + 2 offers + 1 consent = 4 leaves.
    expect(sa.leafCount).toBe(4);

    const sidecarPath = await sa.writeSidecar("s1");
    expect(sidecarPath).toBeTruthy();
    const attestation = JSON.parse(fs.readFileSync(sidecarPath!, "utf8"));
    const kinds = attestation.leaves.map((l: any) => l.kind);
    expect(kinds).toEqual(["mcp_attach", "mcp_tool_offered", "mcp_tool_offered", "permission_decision"]);

    const report = await verifyAttestation(attestation, { strict: true });
    expect(report.ok).toBe(true);
  });

  it("records consent=no when project trust was denied", async () => {
    await createIdentity(cfg());
    const sa = new SessionAttestor(cfg(), { quietWhenNoIdentity: true });
    sa.recordMcpServers(
      [
        {
          name: "untrusted",
          fingerprint: fakeFingerprint("untrusted"),
          toolOfferings: [],
        },
      ],
      false
    );
    // 1 attach + 0 offers + 1 consent = 2 leaves.
    expect(sa.leafCount).toBe(2);
  });

  it("is a no-op when no identity is configured", async () => {
    const sa = new SessionAttestor(cfg(), { quietWhenNoIdentity: true });
    expect(sa.enabled).toBe(false);
    sa.recordMcpServers([{ name: "x", fingerprint: fakeFingerprint("x"), toolOfferings: [] }], true);
    expect(sa.leafCount).toBe(0);
  });
});
