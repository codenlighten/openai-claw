import { describe, it, expect } from "vitest";
import { MlDsa65Suite } from "@smartledger/crypto";
import { createHash } from "node:crypto";
import {
  canonicalJSON,
  hashLeaf,
  hashPayload,
  merkleRoot,
  merkleProof,
  verifyMerkleProof,
  verifyAttestation,
  type Attestation,
  type Leaf,
  type AnchorProof,
} from "../src/index.js";

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function makeSignedAttestation(): Promise<{ attestation: Attestation; pub: Uint8Array; priv: Uint8Array }> {
  const suite = new MlDsa65Suite();
  const kp = await suite.generateKeypair();
  const leaves: Leaf[] = [
    { v: 1, seq: 0, ts: "2026-01-01T00:00:00Z", kind: "user_prompt", payloadHash: hashPayload({ content: "hi" }) },
  ];
  const root = merkleRoot(leaves.map(hashLeaf));
  const header = {
    v: 1 as const,
    format: "openai-claw.attestation.v1" as const,
    sessionId: "s-anchor",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:01Z",
    leafCount: 1,
    merkleRoot: root,
    suiteId: "ml-dsa-65",
    publicKey: Buffer.from(kp.publicKey).toString("base64"),
    publicKeyId: "test-key",
  };
  const sig = await suite.sign(kp.privateKey, Buffer.from(canonicalJSON(header), "utf8"));
  return {
    attestation: { header, leaves, signature: Buffer.from(sig).toString("base64") },
    pub: kp.publicKey,
    priv: kp.privateKey,
  };
}

describe("canonicalJSON", () => {
  it("sorts object keys", () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it("strips undefined but keeps null", () => {
    expect(canonicalJSON({ a: undefined, b: null })).toBe('{"b":null}');
  });
  it("rejects NaN and Infinity", () => {
    expect(() => canonicalJSON(NaN)).toThrow();
    expect(() => canonicalJSON(Infinity)).toThrow();
  });
  it("is order-insensitive across object permutations", () => {
    const a = canonicalJSON({ x: 1, y: [1, 2, { c: 3, a: 4 }] });
    const b = canonicalJSON({ y: [1, 2, { a: 4, c: 3 }], x: 1 });
    expect(a).toBe(b);
  });
});

describe("merkle", () => {
  it("empty input → all-zero root", () => {
    expect(merkleRoot([])).toBe("0".repeat(64));
  });
  it("single leaf → leaf is root", () => {
    const h = "a".repeat(64);
    expect(merkleRoot([h])).toBe(h);
  });
  it("inclusion proofs verify for every leaf", () => {
    const leaves = Array.from({ length: 9 }, (_, i) => i.toString(16).padStart(2, "0").repeat(32));
    const root = merkleRoot(leaves);
    for (let i = 0; i < leaves.length; i++) {
      expect(verifyMerkleProof(leaves[i], merkleProof(leaves, i), root)).toBe(true);
    }
  });
});

describe("verifyAttestation end-to-end", () => {
  it("verifies a freshly built attestation", async () => {
    const suite = new MlDsa65Suite();
    const kp = await suite.generateKeypair();
    const leaves: Leaf[] = [
      { v: 1, seq: 0, ts: "2026-01-01T00:00:00Z", kind: "user_prompt", payloadHash: hashPayload({ content: "hi" }) },
      { v: 1, seq: 1, ts: "2026-01-01T00:00:01Z", kind: "assistant_text", payloadHash: hashPayload({ content: "hello" }) },
    ];
    const root = merkleRoot(leaves.map(hashLeaf));
    const header = {
      v: 1 as const,
      format: "openai-claw.attestation.v1" as const,
      sessionId: "s-test",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:02Z",
      leafCount: leaves.length,
      merkleRoot: root,
      suiteId: "ml-dsa-65",
      publicKey: Buffer.from(kp.publicKey).toString("base64"),
      publicKeyId: "test-key",
    };
    const sig = await suite.sign(kp.privateKey, Buffer.from(canonicalJSON(header), "utf8"));
    const attestation: Attestation = {
      header,
      leaves,
      signature: Buffer.from(sig).toString("base64"),
    };
    const report = await verifyAttestation(attestation, { strict: true });
    expect(report.ok).toBe(true);
    expect(report.checks.signature).toBe(true);
    expect(report.checks.merkleRoot).toBe(true);
    expect(report.checks.leafContinuity).toBe(true);
  });

  it("detects a tampered leaf via Merkle mismatch", async () => {
    const suite = new MlDsa65Suite();
    const kp = await suite.generateKeypair();
    const leaves: Leaf[] = [
      { v: 1, seq: 0, ts: "2026-01-01T00:00:00Z", kind: "user_prompt", payloadHash: hashPayload({ content: "hi" }) },
    ];
    const root = merkleRoot(leaves.map(hashLeaf));
    const header = {
      v: 1 as const,
      format: "openai-claw.attestation.v1" as const,
      sessionId: "s-test",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:01Z",
      leafCount: 1,
      merkleRoot: root,
      suiteId: "ml-dsa-65",
      publicKey: Buffer.from(kp.publicKey).toString("base64"),
      publicKeyId: "test-key",
    };
    const sig = await suite.sign(kp.privateKey, Buffer.from(canonicalJSON(header), "utf8"));
    const attestation: Attestation = {
      header,
      leaves: [{ ...leaves[0], payloadHash: "0".repeat(64) }],
      signature: Buffer.from(sig).toString("base64"),
    };
    const report = await verifyAttestation(attestation);
    expect(report.ok).toBe(false);
    expect(report.checks.merkleRoot).toBe(false);
  });

  it("reports absent anchor without failing the overall check", async () => {
    const { attestation } = await makeSignedAttestation();
    const report = await verifyAttestation(attestation);
    expect(report.ok).toBe(true);
    expect(report.anchor?.present).toBe(false);
    expect(report.checks.anchorDigest).toBeUndefined();
  });

  it("accepts a well-formed anchor and reports it", async () => {
    const { attestation } = await makeSignedAttestation();
    const digest = sha256Hex(canonicalJSON(attestation.header));
    const anchor: AnchorProof = {
      type: "opentimestamps-pending",
      digest,
      submittedAt: "2026-01-02T00:00:00Z",
      calendars: [
        { url: "https://alice.btc.calendar.opentimestamps.org", ok: true, response: "AAAA" },
        { url: "https://bob.btc.calendar.opentimestamps.org", ok: false, error: "HTTP 503" },
      ],
    };
    const report = await verifyAttestation({ ...attestation, anchor });
    expect(report.ok).toBe(true);
    expect(report.checks.anchorDigest).toBe(true);
    expect(report.anchor?.present).toBe(true);
    expect(report.anchor?.acceptedBy).toEqual(["https://alice.btc.calendar.opentimestamps.org"]);
  });

  it("rejects an anchor whose digest does not match the header", async () => {
    const { attestation } = await makeSignedAttestation();
    const anchor: AnchorProof = {
      type: "opentimestamps-pending",
      digest: "0".repeat(64),
      submittedAt: "2026-01-02T00:00:00Z",
      calendars: [],
    };
    const report = await verifyAttestation({ ...attestation, anchor });
    expect(report.ok).toBe(false);
    expect(report.checks.anchorDigest).toBe(false);
    expect(report.reasons.join(" ")).toMatch(/anchor digest does not match/);
  });

  it("detects a tampered header by failed signature", async () => {
    const suite = new MlDsa65Suite();
    const kp = await suite.generateKeypair();
    const leaves: Leaf[] = [
      { v: 1, seq: 0, ts: "2026-01-01T00:00:00Z", kind: "user_prompt", payloadHash: hashPayload({ content: "hi" }) },
    ];
    const root = merkleRoot(leaves.map(hashLeaf));
    const header = {
      v: 1 as const,
      format: "openai-claw.attestation.v1" as const,
      sessionId: "s-original",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:01Z",
      leafCount: 1,
      merkleRoot: root,
      suiteId: "ml-dsa-65",
      publicKey: Buffer.from(kp.publicKey).toString("base64"),
      publicKeyId: "test-key",
    };
    const sig = await suite.sign(kp.privateKey, Buffer.from(canonicalJSON(header), "utf8"));
    const attestation: Attestation = {
      header: { ...header, sessionId: "FORGED" },
      leaves,
      signature: Buffer.from(sig).toString("base64"),
    };
    const report = await verifyAttestation(attestation);
    expect(report.ok).toBe(false);
    expect(report.checks.signature).toBe(false);
  });
});
