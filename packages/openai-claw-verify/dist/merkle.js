import { createHash } from "node:crypto";
/**
 * Deterministic binary Merkle tree over hex-encoded sha256 leaf hashes.
 *
 * - Empty input → all-zero root (so a zero-leaf attestation is still well-defined).
 * - Odd levels duplicate the last node (Bitcoin style) so the structure is
 *   deterministic without padding leaves.
 * - Internal-node hash is sha256(concat of raw left||right bytes), NOT of their
 *   hex strings.
 *
 * KNOWN PROPERTY: leaves and internal nodes are hashed identically (no RFC 6962
 * 0x00/0x01 domain separation), and the duplicate-last rule means [A,B,C] and
 * [A,B,C,C] share a root. Inside an attestation neither is exploitable — the
 * signed header commits to `leafCount` alongside `merkleRoot`, so a substituted
 * leaf list fails the signature. Standalone proof verification is NOT protected
 * by that, so `verifyMerkleProof` takes the tree's size and the leaf's index and
 * refuses proofs of the wrong shape. Adding domain separation would change every
 * root and needs a format version bump.
 */
export function merkleRoot(leafHashesHex) {
    if (leafHashesHex.length === 0)
        return "0".repeat(64);
    let level = leafHashesHex.map(hexToBytes);
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            const left = level[i];
            const right = i + 1 < level.length ? level[i + 1] : level[i];
            next.push(hashPair(left, right));
        }
        level = next;
    }
    return bytesToHex(level[0]);
}
export function merkleProof(leafHashesHex, index) {
    if (index < 0 || index >= leafHashesHex.length) {
        throw new Error(`merkleProof: index ${index} out of range [0, ${leafHashesHex.length})`);
    }
    const steps = [];
    let level = leafHashesHex.map(hexToBytes);
    let idx = index;
    while (level.length > 1) {
        const isRight = idx % 2 === 1;
        const siblingIdx = isRight ? idx - 1 : Math.min(idx + 1, level.length - 1);
        steps.push({ side: isRight ? "left" : "right", hashHex: bytesToHex(level[siblingIdx]) });
        const next = [];
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
/**
 * Number of proof steps a tree of `treeSize` leaves produces — i.e. its depth.
 */
export function merkleProofLength(treeSize) {
    let levels = 0;
    let n = treeSize;
    while (n > 1) {
        n = Math.ceil(n / 2);
        levels++;
    }
    return levels;
}
/**
 * Verify an inclusion proof. Pass `position` whenever it is known: without it
 * a caller can present an internal node as a leaf and hand over the shorter
 * proof that sits above it (the classic second-preimage attack on an
 * un-domain-separated tree). With it, the proof must have exactly the depth
 * the declared tree size implies and each step must sit on the side that
 * leaf's index dictates.
 */
export function verifyMerkleProof(leafHex, steps, rootHex, position) {
    if (position) {
        const { index, treeSize } = position;
        if (!Number.isInteger(index) || !Number.isInteger(treeSize))
            return false;
        if (treeSize < 1 || index < 0 || index >= treeSize)
            return false;
        if (steps.length !== merkleProofLength(treeSize))
            return false;
        let idx = index;
        for (const s of steps) {
            const expectedSide = idx % 2 === 1 ? "left" : "right";
            if (s.side !== expectedSide)
                return false;
            idx = Math.floor(idx / 2);
        }
    }
    let cur = hexToBytes(leafHex);
    for (const s of steps) {
        const sib = hexToBytes(s.hashHex);
        cur = s.side === "left" ? hashPair(sib, cur) : hashPair(cur, sib);
    }
    return bytesToHex(cur) === rootHex;
}
function hashPair(a, b) {
    const h = createHash("sha256");
    h.update(Buffer.from(a));
    h.update(Buffer.from(b));
    return new Uint8Array(h.digest());
}
function hexToBytes(hex) {
    if (hex.length % 2 !== 0)
        throw new Error("hex length must be even");
    // parseInt would turn "zz" into NaN and then into a 0 byte, quietly turning
    // a malformed hash into a valid-looking one.
    if (!/^[0-9a-fA-F]*$/.test(hex))
        throw new Error("hex contains non-hex characters");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
}
function bytesToHex(b) {
    let out = "";
    for (let i = 0; i < b.length; i++) {
        out += b[i].toString(16).padStart(2, "0");
    }
    return out;
}
//# sourceMappingURL=merkle.js.map