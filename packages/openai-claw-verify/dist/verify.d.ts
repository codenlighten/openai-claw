import type { Attestation, VerifyOptions, VerifyReport } from "./types.js";
/**
 * Verifier for openai-claw attestation sidecars.
 *
 *   1. Header format and suite must be supported (strict mode only).
 *   2. Leaves are sequenced 0..N-1.
 *   3. Recomputed Merkle root from `attestation.leaves` matches `header.merkleRoot`.
 *   4. The signature verifies under the embedded public key over
 *      canonical-JSON(header).
 *   5. If `sessionMessages` is supplied, each user_prompt / assistant_text /
 *      tool_call payload found in the session must have a matching leaf
 *      payloadHash. Tool results are not currently aligned because claw
 *      truncates them before persisting — fix tracked upstream.
 */
export declare function verifyAttestation(attestation: Attestation, opts?: VerifyOptions): Promise<VerifyReport>;
//# sourceMappingURL=verify.d.ts.map