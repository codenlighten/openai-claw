/**
 * Wire types for an openai-claw attestation sidecar. These are the only
 * inputs the verifier needs — the verifier has no dependency on claw's
 * source, on OpenAI, or on the model that produced the session.
 *
 * Bumping the format involves bumping `AttestationHeader.v` and
 * `AttestationHeader.format`; older verifiers will then refuse the new
 * sidecar with a clear "unsupported format" reason.
 */

export type LeafKind =
  | "user_prompt"
  | "assistant_text"
  | "tool_call"
  | "tool_result"
  | "permission_decision"
  | "compaction"
  | "error";

export interface Leaf {
  v: 1;
  seq: number;
  ts: string;
  kind: LeafKind;
  /** hex sha256 of canonical-JSON(payload) */
  payloadHash: string;
}

export interface AttestationHeader {
  v: 1;
  format: "openai-claw.attestation.v1";
  sessionId: string;
  startedAt: string;
  endedAt: string;
  leafCount: number;
  merkleRoot: string;
  suiteId: string;
  /** base64-encoded public key bytes */
  publicKey: string;
  /** short fingerprint */
  publicKeyId: string;
}

/**
 * Anchor data added by `claw attest anchor`. Optional — sidecars produced by
 * the in-session attestation flow do not carry one until anchoring is run.
 * The verifier does not check the anchor against Bitcoin (use standard OTS
 * tooling for that); it only reports the anchor's presence and digest match.
 */
export interface AnchorCalendarResponse {
  url: string;
  ok: boolean;
  response?: string;
  error?: string;
}

export interface AnchorProof {
  type: "opentimestamps-pending";
  /** Hex sha256 — the digest that was submitted; must equal sha256(canonical-JSON(header)). */
  digest: string;
  submittedAt: string;
  calendars: AnchorCalendarResponse[];
}

export interface Attestation {
  header: AttestationHeader;
  leaves: Leaf[];
  /** base64-encoded signature over canonical-JSON(header) */
  signature: string;
  /** Present after `claw attest anchor` has been run on this session. */
  anchor?: AnchorProof;
}

/**
 * Minimal structural shape the verifier needs from a session file. claw's
 * own ChatMessage is structurally assignable to this; we redefine it here
 * so the verify package does not depend on claw's source.
 */
export interface SessionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface VerifyOptions {
  /**
   * If supplied, the verifier also recomputes each leaf's payloadHash from
   * the session content and reports a `sessionAlignment` check.
   */
  sessionMessages?: SessionMessage[];
  /** Reject unknown suite ids and formats. Off by default for forward-compat. */
  strict?: boolean;
}

export interface VerifyReport {
  ok: boolean;
  reasons: string[];
  checks: {
    format: boolean;
    signature: boolean;
    merkleRoot: boolean;
    leafContinuity: boolean;
    sessionAlignment?: boolean;
    /** Anchor digest matches sha256(canonical-JSON(header)). Skipped when no anchor. */
    anchorDigest?: boolean;
  };
  /** Surfaced for downstream tools that want to display anchor status. */
  anchor?: {
    present: boolean;
    type?: string;
    submittedAt?: string;
    acceptedBy?: string[];
  };
}
