import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createIdentity, loadIdentity } from "../src/attest/identity.js";
import { Attestor } from "../src/attest/attestor.js";
import { verifyAttestation } from "../src/attest/verify.js";
import type { ClawConfig } from "../src/config.js";

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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "claw-attest-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("attestation round-trip", () => {
  it("creates an identity, signs an attestation, and verifies it", async () => {
    const id = await createIdentity(cfg());
    expect(id.suiteId).toBe("ml-dsa-65");
    expect(id.publicKey.length).toBeGreaterThan(100);
    const reloaded = loadIdentity(cfg());
    expect(reloaded?.publicKeyId).toBe(id.publicKeyId);

    const att = new Attestor(id);
    att.record("user_prompt", { content: "hi" });
    att.onAgentEvent({ type: "tool_call", data: { name: "Read", input: { file_path: "/x" }, callId: "c1" } });
    att.onAgentEvent({ type: "tool_result", data: { name: "Read", content: "ok", callId: "c1" } });
    att.onAgentEvent({ type: "text", data: "done" });
    const attestation = await att.finalize("s1");

    expect(attestation.header.sessionId).toBe("s1");
    expect(attestation.header.leafCount).toBe(4);
    expect(attestation.leaves).toHaveLength(4);
    expect(attestation.signature.length).toBeGreaterThan(100);

    const report = await verifyAttestation(attestation, { strict: true });
    expect(report.ok).toBe(true);
    expect(report.checks.signature).toBe(true);
    expect(report.checks.merkleRoot).toBe(true);
    expect(report.checks.leafContinuity).toBe(true);
  });

  it("a tampered leaf is detected by Merkle mismatch", async () => {
    const id = await createIdentity(cfg());
    const att = new Attestor(id);
    att.record("user_prompt", { content: "hi" });
    att.record("assistant_text", { content: "hello" });
    const attestation = await att.finalize("s2");

    attestation.leaves[1].payloadHash = "0".repeat(64);
    const report = await verifyAttestation(attestation);
    expect(report.ok).toBe(false);
    expect(report.checks.merkleRoot).toBe(false);
    expect(report.reasons.join(" ")).toMatch(/merkle root mismatch/);
  });

  it("a tampered header (after the fact) breaks the signature", async () => {
    const id = await createIdentity(cfg());
    const att = new Attestor(id);
    att.record("user_prompt", { content: "hi" });
    const attestation = await att.finalize("s3");

    // Sneakily rewrite the sessionId.
    attestation.header.sessionId = "FORGED";
    const report = await verifyAttestation(attestation);
    expect(report.ok).toBe(false);
    expect(report.checks.signature).toBe(false);
  });

  it("createIdentity refuses to overwrite an existing identity", async () => {
    await createIdentity(cfg());
    await expect(createIdentity(cfg())).rejects.toThrow(/already exists/);
  });

  it("identity file is mode 0600", async () => {
    await createIdentity(cfg());
    const file = path.join(home, "keys", "attestor.json");
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
