import { describe, it, expect } from "vitest";
import { canonicalJSON, hashPayload, hashLeaf } from "../src/attest/leaf.js";
import { merkleRoot, merkleProof, verifyMerkleProof } from "../src/attest/merkle.js";

describe("canonicalJSON", () => {
  it("sorts object keys", () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJSON({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it("preserves array order", () => {
    expect(canonicalJSON([3, 1, 2])).toBe("[3,1,2]");
  });

  it("strips undefined values but keeps null", () => {
    expect(canonicalJSON({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("produces byte-identical output across permutations", () => {
    const a = canonicalJSON({ x: 1, y: [1, 2, { c: 3, a: 4 }] });
    const b = canonicalJSON({ y: [1, 2, { a: 4, c: 3 }], x: 1 });
    expect(a).toBe(b);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => canonicalJSON(NaN)).toThrow();
    expect(() => canonicalJSON(Infinity)).toThrow();
  });
});

describe("hashing", () => {
  it("hashPayload is stable for equivalent objects", () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
  });

  it("hashLeaf includes the seq, so reordering changes the hash", () => {
    const base = { v: 1 as const, seq: 0, ts: "2026-01-01T00:00:00Z", kind: "tool_call" as const, payloadHash: "deadbeef" };
    const h0 = hashLeaf(base);
    const h1 = hashLeaf({ ...base, seq: 1 });
    expect(h0).not.toBe(h1);
  });
});

describe("merkleRoot", () => {
  it("empty → all-zero root", () => {
    expect(merkleRoot([])).toBe("0".repeat(64));
  });

  it("single leaf → leaf is the root", () => {
    const h = "a".repeat(64);
    expect(merkleRoot([h])).toBe(h);
  });

  it("is deterministic", () => {
    const leaves = ["aa", "bb", "cc", "dd", "ee"].map((s) => s.repeat(32));
    expect(merkleRoot(leaves)).toBe(merkleRoot(leaves));
  });

  it("changes when any leaf changes", () => {
    const a = ["aa", "bb", "cc"].map((s) => s.repeat(32));
    const b = ["aa", "bb", "cd"].map((s) => s.repeat(32));
    expect(merkleRoot(a)).not.toBe(merkleRoot(b));
  });
});

describe("merkle proofs", () => {
  const leaves = Array.from({ length: 7 }, (_, i) => (i.toString(16).padStart(2, "0")).repeat(32));
  const root = merkleRoot(leaves);

  it("every leaf has a valid inclusion proof", () => {
    for (let i = 0; i < leaves.length; i++) {
      const steps = merkleProof(leaves, i);
      expect(verifyMerkleProof(leaves[i], steps, root)).toBe(true);
    }
  });

  it("a tampered leaf fails verification", () => {
    const steps = merkleProof(leaves, 3);
    const bad = "ff".repeat(32);
    expect(verifyMerkleProof(bad, steps, root)).toBe(false);
  });

  it("a tampered root fails verification", () => {
    const steps = merkleProof(leaves, 0);
    expect(verifyMerkleProof(leaves[0], steps, "0".repeat(64))).toBe(false);
  });
});
