import { MlDsa65Suite } from "@smartledger/crypto";
import { canonicalJSON, hashLeaf, hashPayload, sha256Hex } from "./leaf.js";
import { merkleRoot } from "./merkle.js";
import type {
  Attestation,
  Leaf,
  SessionMessage,
  VerifyOptions,
  VerifyReport,
} from "./types.js";

const SUPPORTED_FORMATS = new Set(["openai-claw.attestation.v1"]);
const SUPPORTED_SUITES = new Set(["ml-dsa-65"]);

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
export async function verifyAttestation(
  attestation: Attestation,
  opts: VerifyOptions = {}
): Promise<VerifyReport> {
  const reasons: string[] = [];
  const checks: VerifyReport["checks"] = {
    format: false,
    signature: false,
    merkleRoot: false,
    leafContinuity: false,
  };

  if (!SUPPORTED_FORMATS.has(attestation.header.format)) {
    reasons.push(`unsupported format: ${attestation.header.format}`);
  } else {
    checks.format = true;
  }
  if (opts.strict && !SUPPORTED_SUITES.has(attestation.header.suiteId)) {
    reasons.push(`unsupported suite: ${attestation.header.suiteId}`);
  }

  let continuous = attestation.leaves.length === attestation.header.leafCount;
  for (let i = 0; i < attestation.leaves.length; i++) {
    if (attestation.leaves[i].seq !== i) {
      continuous = false;
      break;
    }
  }
  checks.leafContinuity = continuous;
  if (!continuous) reasons.push("leaf sequence is not 0..N-1");

  const root = merkleRoot(attestation.leaves.map(hashLeaf));
  checks.merkleRoot = root === attestation.header.merkleRoot;
  if (!checks.merkleRoot) {
    reasons.push(`merkle root mismatch: got ${root}, header ${attestation.header.merkleRoot}`);
  }

  try {
    const suite = new MlDsa65Suite();
    const pub = Buffer.from(attestation.header.publicKey, "base64");
    const sig = Buffer.from(attestation.signature, "base64");
    const message = Buffer.from(canonicalJSON(attestation.header), "utf8");
    checks.signature = await suite.verify(pub, message, sig);
    if (!checks.signature) reasons.push("signature did not verify");
  } catch (e: any) {
    reasons.push(`signature verification threw: ${e?.message ?? e}`);
  }

  if (opts.sessionMessages) {
    const alignment = checkSessionAlignment(attestation.leaves, opts.sessionMessages);
    checks.sessionAlignment = alignment.ok;
    if (!alignment.ok) reasons.push(...alignment.reasons);
  }

  // Anchor presence/digest check. We don't talk to Bitcoin here — that's
  // standard OTS tooling's job — but we do verify the anchored digest is
  // what we'd submit for THIS header.
  let anchorSummary: VerifyReport["anchor"] | undefined;
  if (attestation.anchor) {
    const expected = sha256Hex(canonicalJSON(attestation.header));
    const match = expected === attestation.anchor.digest;
    checks.anchorDigest = match;
    if (!match) {
      reasons.push(`anchor digest does not match sha256(header): got ${attestation.anchor.digest}, expected ${expected}`);
    }
    anchorSummary = {
      present: true,
      type: attestation.anchor.type,
      submittedAt: attestation.anchor.submittedAt,
      acceptedBy: attestation.anchor.calendars.filter((c) => c.ok).map((c) => c.url),
    };
  } else {
    anchorSummary = { present: false };
  }

  return {
    ok: reasons.length === 0,
    reasons,
    checks,
    anchor: anchorSummary,
  };
}

function checkSessionAlignment(
  leaves: Leaf[],
  messages: SessionMessage[]
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const expected = new Map<string, string[]>();
  const push = (k: string, h: string) => {
    if (!expected.has(k)) expected.set(k, []);
    expected.get(k)!.push(h);
  };

  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") {
      push("user_prompt", hashPayload({ content: m.content }));
    }
    if (m.role === "assistant") {
      if (m.content && typeof m.content === "string") {
        push("assistant_text", hashPayload({ content: m.content }));
      }
      for (const tc of m.tool_calls ?? []) {
        let parsedInput: unknown = undefined;
        try {
          parsedInput = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          parsedInput = tc.function.arguments;
        }
        push(
          "tool_call",
          hashPayload({ name: tc.function.name, input: parsedInput, callId: tc.id })
        );
      }
    }
    // tool_result alignment intentionally skipped — see verify.ts header note.
  }

  const actual = new Map<string, string[]>();
  for (const l of leaves) {
    if (!actual.has(l.kind)) actual.set(l.kind, []);
    actual.get(l.kind)!.push(l.payloadHash);
  }

  for (const [kind, hashes] of expected) {
    const seen = actual.get(kind) ?? [];
    for (const h of hashes) {
      if (!seen.includes(h)) {
        reasons.push(`session has ${kind} payload not present in attestation: ${h.slice(0, 12)}…`);
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}
