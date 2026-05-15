/**
 * Claw's attestation surface.
 *
 * Verification primitives — canonical JSON, Merkle tree, signature check —
 * are re-exported from `@smartledger.technology/openai-claw-verify` so that
 * third-party auditors can install just the verifier and use the same code
 * paths claw uses to produce sidecars.
 *
 * Local additions: `Attestor` (signs sessions) and `Identity` management
 * (keypair creation / on-disk storage).
 */

export {
  canonicalJSON,
  hashPayload,
  hashLeaf,
  sha256Hex,
  merkleRoot,
  merkleProof,
  verifyMerkleProof,
  verifyAttestation,
} from "@smartledger.technology/openai-claw-verify";

export type {
  Leaf,
  LeafKind,
  Attestation,
  AttestationHeader,
  MerkleStep,
  VerifyOptions,
  VerifyReport,
  SessionMessage,
} from "@smartledger.technology/openai-claw-verify";

export {
  createIdentity,
  loadIdentity,
  identityExists,
  identityFile,
  publicView,
  ATTEST_SUITE_ID,
  type AttestorIdentity,
} from "./identity.js";

export { Attestor, ATTESTATION_FORMAT } from "./attestor.js";
