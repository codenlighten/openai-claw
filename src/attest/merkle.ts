import { createHash } from "node:crypto";

/**
 * Deterministic binary Merkle tree over hex-encoded sha256 leaf hashes.
 *
 * - Empty input → all-zero root (so a zero-leaf attestation is still well-defined).
 * - Odd levels duplicate the last node (Bitcoin/RFC 6962 style) so the structure
 *   is deterministic without padding leaves.
 * - Internal-node hash is sha256(concat of raw left||right bytes), NOT of their
 *   hex string. Matches what other Merkle implementations do.
 *
 * Returns the hex-encoded root.
 */
export function merkleRoot(leafHashesHex: string[]): string {
  if (leafHashesHex.length === 0) return "0".repeat(64);
  let level = leafHashesHex.map(hexToBytes);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(hashPair(left, right));
    }
    level = next;
  }
  return bytesToHex(level[0]);
}

/**
 * Inclusion proof for a given leaf index. Returns an ordered list of
 * `{ side, hashHex }` siblings; a verifier reconstructs the root by
 * repeatedly hashing in the given order.
 */
export interface MerkleStep {
  side: "left" | "right";
  hashHex: string;
}

export function merkleProof(leafHashesHex: string[], index: number): MerkleStep[] {
  if (index < 0 || index >= leafHashesHex.length) {
    throw new Error(`merkleProof: index ${index} out of range [0, ${leafHashesHex.length})`);
  }
  const steps: MerkleStep[] = [];
  let level = leafHashesHex.map(hexToBytes);
  let idx = index;
  while (level.length > 1) {
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : Math.min(idx + 1, level.length - 1);
    steps.push({ side: isRight ? "left" : "right", hashHex: bytesToHex(level[siblingIdx]) });
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(hashPair(left, right));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return steps;
}

export function verifyMerkleProof(leafHex: string, steps: MerkleStep[], rootHex: string): boolean {
  let cur = hexToBytes(leafHex);
  for (const s of steps) {
    const sib = hexToBytes(s.hashHex);
    cur = s.side === "left" ? hashPair(sib, cur) : hashPair(cur, sib);
  }
  return bytesToHex(cur) === rootHex;
}

function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const h = createHash("sha256");
  h.update(Buffer.from(a));
  h.update(Buffer.from(b));
  return new Uint8Array(h.digest());
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) {
    out += b[i].toString(16).padStart(2, "0");
  }
  return out;
}
