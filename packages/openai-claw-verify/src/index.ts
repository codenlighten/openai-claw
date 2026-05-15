export {
  canonicalJSON,
  hashPayload,
  hashLeaf,
  sha256Hex,
} from "./leaf.js";

export {
  merkleRoot,
  merkleProof,
  verifyMerkleProof,
} from "./merkle.js";

export { verifyAttestation } from "./verify.js";

export type {
  Leaf,
  LeafKind,
  Attestation,
  AttestationHeader,
  SessionMessage,
  VerifyOptions,
  VerifyReport,
} from "./types.js";

export type { MerkleStep } from "./merkle.js";
