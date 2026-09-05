import { describe, it, expect } from "vitest";
import { MlDsa65Suite } from "@smartledger/crypto";
import { createHash } from "node:crypto";
import {
  canonicalJSON,
  hashLeaf,
  hashPayload,
  merkleRoot,
  merkleProof,
  merkleProofLength,
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

  it("mcpProvenance is skipped when the session uses no MCP tools", async () => {
    const { attestation } = await makeSignedAttestation();
    // makeSignedAttestation builds a one-leaf attestation: user_prompt("hi").
    // Match the session messages exactly so sessionAlignment passes too.
    const report = await verifyAttestation(attestation, {
      sessionMessages: [{ role: "user", content: "hi" }],
    });
    expect(report.ok).toBe(true);
    expect(report.checks.mcpProvenance).toBeUndefined();
    expect(report.mcp).toBeUndefined();
  });

  it("mcpProvenance passes when attach/offer/consent leaves precede each mcp tool_call", async () => {
    const suite = new MlDsa65Suite();
    const kp = await suite.generateKeypair();
    const callId = "c1";
    const tcPayload = { name: "mcp__alpha__query", input: { q: "x" }, callId };
    const leaves: Leaf[] = [
      { v: 1, seq: 0, ts: "2026-01-01T00:00:00Z", kind: "user_prompt", payloadHash: hashPayload({ content: "do it" }) },
      { v: 1, seq: 1, ts: "2026-01-01T00:00:01Z", kind: "mcp_attach", payloadHash: hashPayload({ server: "alpha", binarySha256: "a".repeat(64) }) },
      { v: 1, seq: 2, ts: "2026-01-01T00:00:02Z", kind: "mcp_tool_offered", payloadHash: hashPayload({ tool: "query", schemaSha256: "b".repeat(64) }) },
      { v: 1, seq: 3, ts: "2026-01-01T00:00:03Z", kind: "permission_decision", payloadHash: hashPayload({ server: "alpha", consent: "yes" }) },
      { v: 1, seq: 4, ts: "2026-01-01T00:00:04Z", kind: "tool_call", payloadHash: hashPayload(tcPayload) },
    ];
    const root = merkleRoot(leaves.map(hashLeaf));
    const header = {
      v: 1 as const,
      format: "openai-claw.attestation.v1" as const,
      sessionId: "mcp-good",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:04Z",
      leafCount: leaves.length,
      merkleRoot: root,
      suiteId: "ml-dsa-65",
      publicKey: Buffer.from(kp.publicKey).toString("base64"),
      publicKeyId: "test-key",
    };
    const sig = await suite.sign(kp.privateKey, Buffer.from(canonicalJSON(header), "utf8"));
    const attestation: Attestation = { header, leaves, signature: Buffer.from(sig).toString("base64") };
    const sessionMessages = [
      { role: "user" as const, content: "do it" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: callId, function: { name: "mcp__alpha__query", arguments: JSON.stringify({ q: "x" }) } }],
      },
    ];
    const report = await verifyAttestation(attestation, { sessionMessages });
    expect(report.ok).toBe(true);
    expect(report.checks.mcpProvenance).toBe(true);
    expect(report.mcp).toEqual({
      serversSeen: 1,
      toolCallsSignedWithProvenance: 1,
      toolCallsMissingProvenance: 0,
      structural: true,
    });
  });

  it("mcpProvenance fails when attach/offer/consent leaves are missing", async () => {
    const suite = new MlDsa65Suite();
    const kp = await suite.generateKeypair();
    const callId = "c2";
    const tcPayload = { name: "mcp__beta__write", input: {}, callId };
    // Missing mcp_attach + mcp_tool_offered, no permission_decision.
    const leaves: Leaf[] = [
      { v: 1, seq: 0, ts: "2026-01-01T00:00:00Z", kind: "user_prompt", payloadHash: hashPayload({ content: "do it" }) },
      { v: 1, seq: 1, ts: "2026-01-01T00:00:01Z", kind: "tool_call", payloadHash: hashPayload(tcPayload) },
    ];
    const root = merkleRoot(leaves.map(hashLeaf));
    const header = {
      v: 1 as const,
      format: "openai-claw.attestation.v1" as const,
      sessionId: "mcp-bad",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:02Z",
      leafCount: leaves.length,
      merkleRoot: root,
      suiteId: "ml-dsa-65",
      publicKey: Buffer.from(kp.publicKey).toString("base64"),
      publicKeyId: "test-key",
    };
    const sig = await suite.sign(kp.privateKey, Buffer.from(canonicalJSON(header), "utf8"));
    const attestation: Attestation = { header, leaves, signature: Buffer.from(sig).toString("base64") };
    const sessionMessages = [
      { role: "user" as const, content: "do it" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: callId, function: { name: "mcp__beta__write", arguments: "{}" } }],
      },
    ];
    const report = await verifyAttestation(attestation, { sessionMessages });
    expect(report.ok).toBe(false);
    expect(report.checks.mcpProvenance).toBe(false);
    expect(report.reasons.join(" ")).toMatch(/lacks mcp_attach, mcp_tool_offered, permission_decision/);
    expect(report.mcp?.toolCallsMissingProvenance).toBe(1);
    expect(report.mcp?.serversSeen).toBe(1);
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

/** Build a signed attestation over an arbitrary leaf list. */
async function sign(leaves: Leaf[]): Promise<Attestation> {
  const suite = new MlDsa65Suite();
  const kp = await suite.generateKeypair();
  const header = {
    v: 1 as const,
    format: "openai-claw.attestation.v1" as const,
    sessionId: "s-align",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:09Z",
    leafCount: leaves.length,
    merkleRoot: merkleRoot(leaves.map(hashLeaf)),
    suiteId: "ml-dsa-65",
    publicKey: Buffer.from(kp.publicKey).toString("base64"),
    publicKeyId: "test-key",
  };
  const sig = await suite.sign(kp.privateKey, Buffer.from(canonicalJSON(header), "utf8"));
  return { header, leaves, signature: Buffer.from(sig).toString("base64") };
}

const leaf = (seq: number, kind: Leaf["kind"], payload: unknown): Leaf => ({
  v: 1,
  seq,
  ts: `2026-01-01T00:00:0${seq}Z`,
  kind,
  payloadHash: hashPayload(payload),
});

describe("session alignment", () => {
  it("passes when the transcript and the leaves agree", async () => {
    const attestation = await sign([
      leaf(0, "user_prompt", { content: "hi" }),
      leaf(1, "assistant_text", { content: "hello" }),
    ]);
    const report = await verifyAttestation(attestation, {
      sessionMessages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(report.checks.sessionAlignment).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("counts repeats instead of matching one leaf many times", async () => {
    // Three identical prompts, one leaf. A set-based check called this aligned.
    const attestation = await sign([leaf(0, "user_prompt", { content: "continue" })]);
    const report = await verifyAttestation(attestation, {
      sessionMessages: [
        { role: "user", content: "continue" },
        { role: "user", content: "continue" },
        { role: "user", content: "continue" },
      ],
    });
    expect(report.checks.sessionAlignment).toBe(false);
  });

  it("detects a message deleted from the transcript", async () => {
    const attestation = await sign([
      leaf(0, "user_prompt", { content: "delete the prod database" }),
      leaf(1, "assistant_text", { content: "done" }),
    ]);
    const report = await verifyAttestation(attestation, {
      // The incriminating prompt has been edited out of session.json.
      sessionMessages: [{ role: "assistant", content: "done" }],
    });
    expect(report.checks.sessionAlignment).toBe(false);
    expect(report.reasons.join(" ")).toContain("missing from the session transcript");
  });

  it("tolerates a shortened transcript when the session was compacted", async () => {
    const attestation = await sign([
      leaf(0, "user_prompt", { content: "old turn" }),
      leaf(1, "compaction", { beforeTokens: 100, afterTokens: 10 }),
      leaf(2, "user_prompt", { content: "new turn" }),
    ]);
    const report = await verifyAttestation(attestation, {
      sessionMessages: [{ role: "user", content: "new turn" }],
    });
    expect(report.checks.sessionAlignment).toBe(true);
  });

  it("still reports transcript content the attestation never saw", async () => {
    const attestation = await sign([leaf(0, "user_prompt", { content: "hi" })]);
    const report = await verifyAttestation(attestation, {
      sessionMessages: [
        { role: "user", content: "hi" },
        { role: "user", content: "an inserted instruction" },
      ],
    });
    expect(report.checks.sessionAlignment).toBe(false);
    expect(report.reasons.join(" ")).toContain("does not record");
  });
});

describe("merkle proof bounds", () => {
  const leaves = Array.from({ length: 9 }, (_, i) => i.toString(16).padStart(2, "0").repeat(32));

  it("accepts a correct proof with its declared position", () => {
    const root = merkleRoot(leaves);
    for (let i = 0; i < leaves.length; i++) {
      expect(
        verifyMerkleProof(leaves[i], merkleProof(leaves, i), root, { index: i, treeSize: leaves.length })
      ).toBe(true);
    }
  });

  it("proof length matches the tree depth", () => {
    expect(merkleProofLength(1)).toBe(0);
    expect(merkleProofLength(2)).toBe(1);
    expect(merkleProofLength(9)).toBe(4);
    expect(merkleProof(leaves, 0)).toHaveLength(merkleProofLength(leaves.length));
  });

  it("rejects an internal node presented as a leaf", () => {
    // Without domain separation an internal node hashes like a leaf, so the
    // proof that sits ABOVE it also verifies — unless the declared tree size
    // forces a full-depth path.
    const root = merkleRoot(leaves);
    const full = merkleProof(leaves, 0);
    const shortened = full.slice(1);
    const internalNode = hashPairHex(leaves[0], leaves[1]);
    expect(verifyMerkleProof(internalNode, shortened, root)).toBe(true);
    expect(
      verifyMerkleProof(internalNode, shortened, root, { index: 0, treeSize: leaves.length })
    ).toBe(false);
  });

  it("rejects an out-of-range or mis-sided position", () => {
    const root = merkleRoot(leaves);
    const proof = merkleProof(leaves, 3);
    expect(verifyMerkleProof(leaves[3], proof, root, { index: 3, treeSize: leaves.length })).toBe(true);
    expect(verifyMerkleProof(leaves[3], proof, root, { index: 99, treeSize: leaves.length })).toBe(false);
    expect(verifyMerkleProof(leaves[3], proof, root, { index: 2, treeSize: leaves.length })).toBe(false);
  });

  it("rejects malformed hex instead of reading it as zero bytes", () => {
    expect(() => merkleRoot(["zz".repeat(32)])).toThrow();
  });
});

function hashPairHex(aHex: string, bHex: string): string {
  const h = createHash("sha256");
  h.update(Buffer.from(aHex, "hex"));
  h.update(Buffer.from(bHex, "hex"));
  return h.digest("hex");
}
