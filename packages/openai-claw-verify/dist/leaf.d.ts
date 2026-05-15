import type { Leaf } from "./types.js";
/**
 * Canonical JSON per RFC 8785 (JCS): keys sorted lexicographically, no
 * insignificant whitespace, undefined values stripped. We only ever attest
 * plain JSON objects/arrays/strings/finite-numbers/booleans/nulls — no Dates,
 * no BigInts, no functions — so the implementation can stay small and
 * dep-free.
 *
 * Determinism is load-bearing: a different verifier on a different machine
 * MUST produce byte-identical canonical JSON, otherwise leaf hashes drift
 * and the signature fails to verify. Don't optimize without round-trip tests.
 */
export declare function canonicalJSON(value: unknown): string;
export declare function sha256Hex(bytes: Uint8Array | string): string;
export declare function hashPayload(payload: unknown): string;
export declare function hashLeaf(leaf: Leaf): string;
//# sourceMappingURL=leaf.d.ts.map