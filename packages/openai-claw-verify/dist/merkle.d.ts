/**
 * Deterministic binary Merkle tree over hex-encoded sha256 leaf hashes.
 *
 * - Empty input → all-zero root (so a zero-leaf attestation is still well-defined).
 * - Odd levels duplicate the last node (Bitcoin/RFC 6962 style) so the structure
 *   is deterministic without padding leaves.
 * - Internal-node hash is sha256(concat of raw left||right bytes), NOT of their
 *   hex strings.
 */
export declare function merkleRoot(leafHashesHex: string[]): string;
export interface MerkleStep {
    side: "left" | "right";
    hashHex: string;
}
export declare function merkleProof(leafHashesHex: string[], index: number): MerkleStep[];
export declare function verifyMerkleProof(leafHex: string, steps: MerkleStep[], rootHex: string): boolean;
//# sourceMappingURL=merkle.d.ts.map