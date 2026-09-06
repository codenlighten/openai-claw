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
export declare function merkleRoot(leafHashesHex: string[]): string;
export interface MerkleStep {
    side: "left" | "right";
    hashHex: string;
}
export declare function merkleProof(leafHashesHex: string[], index: number): MerkleStep[];
/**
 * Number of proof steps a tree of `treeSize` leaves produces — i.e. its depth.
 */
export declare function merkleProofLength(treeSize: number): number;
/**
 * Verify an inclusion proof. Pass `position` whenever it is known: without it
 * a caller can present an internal node as a leaf and hand over the shorter
 * proof that sits above it (the classic second-preimage attack on an
 * un-domain-separated tree). With it, the proof must have exactly the depth
 * the declared tree size implies and each step must sit on the side that
 * leaf's index dictates.
 */
export declare function verifyMerkleProof(leafHex: string, steps: MerkleStep[], rootHex: string, position?: {
    index: number;
    treeSize: number;
}): boolean;
//# sourceMappingURL=merkle.d.ts.map